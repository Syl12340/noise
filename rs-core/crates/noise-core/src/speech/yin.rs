//! YIN fundamental-frequency estimation (de Cheveigné & Kawahara, 2002).
//!
//! Line-by-line numerical port of `utils/phonetic/yin-pitch.js`. Every branch, ordering
//! decision and tolerance below exists because the baseline makes it; none of them are
//! "improvements". In particular this port preserves:
//!
//! - centered fixed-length comparison windows (`offset = floor((len - halfLen - tau) / 2)`),
//! - the support-energy gate `comparedEnergy >= frameEnergy * 1e-6`,
//! - the CMNDF recurrence with its `runningSum > 1e-30` guard and `cmndf[0] = 1`,
//! - local-minimum acceptance including the `s1 === s0 && s1 === s2` rejection,
//! - the *raw difference* parabola (never the CMNDF values), with its `1e-12` denominator
//!   guard, `[-0.5, 0.5]` clamp and `8 * EPSILON * tau` dead zone,
//! - first-tie-wins candidate selection (`inRange.find(...)` is a forward scan),
//! - the `aperiodicity > 0.3` rejection when no candidate passes the threshold,
//! - the out-of-range fallback that reports only the *first* qualifying outside candidate,
//! - the shorter-period (octave) exclusion using `Math.round` on the period ratio,
//! - the asymmetric range test: `f0 >= fmin - numericTolerance` but `f0 <= fmax + upperTolerance`,
//! - the final clamp to `[fmin, fmax]` with `rangeBoundaryAdjusted` / `numericToleranceHz`
//!   reported **only** when the clamp actually changed the value.
//!
//! All arithmetic is ordered `f64`. The Float64Array stores in the baseline are modelled by
//! `Vec<f64>`, which is the same binary64 storage, so no rounding is introduced or removed.

/// Result of [`yin_pitch_frame`] for a single frame.
///
/// Field presence mirrors the baseline's optional-property construction. In JavaScript the
/// returned object is built by `{...}` spreads, so a property is either present or absent —
/// it is never present-but-`undefined`. The Rust `Option` fields reproduce that exactly:
/// `None` means "property absent", `Some` means "property present with this value".
///
/// | JS property             | Rust field                | Present when |
/// |-------------------------|---------------------------|--------------|
/// | `f0`                    | [`PitchFrame::f0`]        | always |
/// | `aperiodicity`          | [`PitchFrame::aperiodicity`] | always |
/// | `rawF0`                 | [`PitchFrame::raw_f0`]    | a candidate was chosen (any branch) |
/// | `reason`                | [`PitchFrame::reason`]    | out-of-range / boundary-uncertain rejects |
/// | `range`                 | [`PitchFrame::range`]     | `boundary-uncertain` only |
/// | `rangeBoundaryAdjusted` | [`PitchFrame::range_boundary_adjusted`] | clamp changed the value |
/// | `numericToleranceHz`    | [`PitchFrame::numeric_tolerance_hz`] | clamp changed the value |
///
/// Note that `f0` is `0.0` for every rejected frame, and that `aperiodicity` is the raw
/// (unparabolized) CMNDF valley `min(1, s1)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchFrame {
    /// Reported fundamental in Hz, clamped to `[fmin, fmax]`; `0.0` when rejected.
    pub f0: f64,
    /// Aperiodicity evidence. `1.0` for silent/short/unsupported frames, otherwise the
    /// CMNDF valley of the chosen candidate capped at `1.0`.
    pub aperiodicity: f64,
    /// Unclamped candidate `f0`, lower-octave candidate, or the first outside-range
    /// candidate depending on the return branch. Absent for silence/short-frame returns.
    pub raw_f0: Option<f64>,
    /// `Some("out-of-range")` or `Some("boundary-uncertain")`; absent on success and on
    /// silence/short-frame returns.
    pub reason: Option<&'static str>,
    /// `Some((fmin, fmax))`, reported only with `boundary-uncertain`.
    pub range: Option<(f64, f64)>,
    /// `Some(true)` only when the final clamp altered `chosen.f0`.
    pub range_boundary_adjusted: Option<bool>,
    /// The `numericTolerance` used by the range test, reported only alongside a clamp.
    pub numeric_tolerance_hz: Option<f64>,
}

/// One element of a pitch track: [`PitchFrame`] plus the frame's center time in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchPoint {
    /// `(start + frameSize / 2) / fs`, computed in the baseline's order.
    pub time: f64,
    /// The per-frame YIN result.
    pub frame: PitchFrame,
}

/// Internal candidate record mirroring the baseline's `{period, f0, aperiodicity}` objects.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    period: f64,
    f0: f64,
    aperiodicity: f64,
}

/// Returns the two-field silence/short-frame result: `{ f0: 0, aperiodicity: 1 }`.
///
/// Both call sites in the baseline return this object, so it is factored here to keep the
/// two branches bit-identical by construction.
#[inline]
fn no_pitch() -> PitchFrame {
    PitchFrame {
        f0: 0.0,
        aperiodicity: 1.0,
        raw_f0: None,
        reason: None,
        range: None,
        range_boundary_adjusted: None,
        numeric_tolerance_hz: None,
    }
}

/// `Math.min(a, b)` with JavaScript NaN and signed-zero semantics.
///
/// Rust's `f64::min` returns the *other* operand when one side is NaN, but JavaScript's
/// `Math.min` propagates NaN. The baseline relies on that propagation, so the ordered
/// comparisons are written out explicitly instead of using `f64::min`.
///
/// For equal operands JavaScript keeps `-0.0` when either side is `-0.0`
/// (`Math.min(0, -0) === -0`), which is not what either `f64::min` or a naive return of
/// `a` would give, so that case is handled explicitly.
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else if b < a {
        b
    } else if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        // Equal finite values. Only the zero pair has two distinct bit patterns, and
        // Math.min prefers the negative one.
        if a == 0.0 && b == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) {
            -0.0
        } else {
            a
        }
    }
}

/// `Math.max(a, b)` with JavaScript NaN and signed-zero semantics. See [`js_min`].
///
/// For equal operands JavaScript keeps `+0.0` unless *both* sides are `-0.0`
/// (`Math.max(0, -0) === 0`, `Math.max(-0, -0) === -0`).
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else if b > a {
        b
    } else if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        // Equal finite values: prefer +0.0 unless both operands are negative zero.
        if a == 0.0 && b == 0.0 && !(a.is_sign_negative() && b.is_sign_negative()) {
            0.0
        } else {
            a
        }
    }
}

/// Performs YIN fundamental-frequency detection on a single unwindowed frame.
///
/// Direct port of `yinPitchFrame(frame, sampleRate, threshold, fmin, fmax)` including its
/// default-free call contract: the baseline defaults are `threshold = 0.1`, `fmin = 60`,
/// `fmax = 500`, but the exported Rust signature requires explicit values so that no
/// hidden default can drift from the frozen reference.
///
/// `frame` must be the frame content; the baseline receives a `Float64Array`, so callers
/// holding Float32 signal data must widen through [`pitch_track`] (or widen themselves) to
/// preserve the baseline's exact values.
///
/// Returns
/// - `{f0: 0, aperiodicity: 1}` when `tauMax <= 2` or the configuration is invalid
///   (`!(fs > 0 && fmin > 0 && fmax >= fmin)`, which is also true for any NaN),
/// - `{f0: 0, aperiodicity: 1}` when mean frame energy is below `1e-10`,
/// - `{f0: 0, rawF0, aperiodicity, reason: "out-of-range"}` when only an outside-range
///   candidate has acceptable evidence, or when a shorter qualifying period excludes the
///   chosen lower-octave interpretation,
/// - `{f0: 0, rawF0, aperiodicity, reason: "boundary-uncertain", range}` when the chosen
///   candidate sits above `fmax + numericTolerance` but within the 0.5% search band,
/// - otherwise the clamped `f0` with `rawF0`, and the adjustment flags only if clamping
///   moved the value.
pub fn yin_pitch_frame(frame: &[f64], fs: f64, threshold: f64, fmin: f64, fmax: f64) -> PitchFrame {
    // Baseline: Math.floor(frame.length / 2); frame.length is a nonnegative integer so the
    // f64 floor is exact and the narrowing is lossless on every supported target.
    let half_len = frame.len() / 2;
    // Baseline: const tauMax = halfLen - 1. halfLen is a nonnegative integer, so the only
    // way `halfLen - 1` can go negative is halfLen == 0, which the guard below rejects
    // (`tauMax <= 2`). Saturating at 0 keeps the value comparable to the guard without
    // relying on wrapping arithmetic.
    let tau_max = half_len.saturating_sub(1);

    // Baseline rejects short frames and invalid configuration up front. `!(a > b)` is
    // written as a negated conjunction so NaN inputs reject exactly as in JavaScript.
    if tau_max <= 2 || !(fs > 0.0 && fmin > 0.0 && fmax >= fmin) {
        return no_pitch();
    }

    // Baseline: frameEnergy += frame[i] * frame[i] over the whole frame, then the mean.
    let mut frame_energy = 0.0f64;
    for i in 0..frame.len() {
        frame_energy += frame[i] * frame[i];
    }
    if frame_energy / (frame.len() as f64) < 1e-10 {
        return no_pitch();
    }

    // 1. Difference function d(tau) = sum( (x[j] - x[j+tau])^2 ) plus the support gate.
    let mut diff = vec![0.0f64; tau_max + 1];
    let mut supported = vec![false; tau_max + 1];
    for tau in 1..=tau_max {
        let mut sum = 0.0f64;
        let mut compared_energy = 0.0f64;
        // Delay both ends around the same frame center so track time does not move with F0.
        // Baseline: Math.floor((frame.length - halfLen - tau) / 2).
        //
        // This must be a *true* floor, not truncating integer division: the numerator is
        // `floor(n/2) + ceil(n/2) - tau` = `n - halfLen - tau`, which is `>= 1` for every
        // `tau <= tauMax = halfLen - 1`, so it is never negative here. The explicit
        // floor-division form below is written out anyway so the port cannot silently change
        // behavior if the numerator ever becomes negative (JS Math.floor rounds toward
        // -Infinity; Rust `/` truncates toward zero).
        let numerator = frame.len() - half_len - tau;
        let offset = numerator.div_euclid(2);
        for j in 0..half_len {
            let left = frame[offset + j];
            let right = frame[offset + j + tau];
            let d = left - right;
            sum += d * d;
            compared_energy += left * left + right * right;
        }
        diff[tau] = sum;
        // A transient can fall entirely outside the compared span, in which case d(tau) = 0
        // does not indicate periodicity. Only allow the delay as a candidate when the
        // compared span actually covers this frame's energy.
        supported[tau] = compared_energy >= frame_energy * 1e-6;
    }

    // 2. Cumulative mean normalized difference function (CMNDF).
    let mut cmndf = vec![0.0f64; tau_max + 1];
    cmndf[0] = 1.0;
    let mut running_sum = 0.0f64;
    for tau in 1..=tau_max {
        running_sum += diff[tau];
        cmndf[tau] = if running_sum > 1e-30 {
            diff[tau] * (tau as f64) / running_sum
        } else {
            1.0
        };
    }

    // 3. Keep local valleys inside and outside the range; a valley still descending at the
    //    search boundary must not be truncated.
    //
    // The baseline collects candidates with `push` in ascending tau order; a Vec preserves
    // that order, which is what makes every later `find` a first-tie/短周期 decision.
    let mut candidates: Vec<Candidate> = Vec::new();
    for tau in 2..tau_max {
        if !supported[tau] {
            continue;
        }
        let s0 = cmndf[tau - 1];
        let s1 = cmndf[tau];
        let s2 = cmndf[tau + 1];
        if s1 > s0 || s1 > s2 || (s1 == s0 && s1 == s2) {
            continue;
        }
        // Period evidence uses the actually computed CMNDF valley. Parabolically
        // interpolating an asymmetric or discontinuous three-point valley can produce a
        // negative shift, which must not be clamped to 0 (a false perfect period). Only the
        // final period is interpolated, on the raw difference valley; interpolation never
        // manufactures confidence. This also stops the normalization denominator's slope
        // from systematically pushing short periods to too-high frequencies.
        let raw_denom = diff[tau - 1] - 2.0 * diff[tau] + diff[tau + 1];
        let mut period_shift = if raw_denom > 1e-12 {
            let raw = 0.5 * (diff[tau - 1] - diff[tau + 1]) / raw_denom;
            // Baseline: Math.max(-0.5, Math.min(0.5, raw)) — inner clamp first, then outer.
            js_max(-0.5, js_min(0.5, raw))
        } else {
            0.0
        };
        // Remove floating-point operation noise only; do not clamp to the configured
        // frequency bounds.
        if period_shift.abs() < 8.0 * f64::EPSILON * (tau as f64) {
            period_shift = 0.0;
        }
        let period = (tau as f64) + period_shift;
        candidates.push(Candidate {
            period,
            f0: fs / period,
            // Baseline: Math.min(1, s1); NaN from a non-finite frame must propagate.
            aperiodicity: js_min(1.0, s1),
        });
    }

    // Prefer the shortest period within the threshold; weaker out-of-range spurious valleys
    // do not block later valid candidates. Keep candidate evidence near the upper bound;
    // explicitly reject interpolated out-of-range instead of clamping to a valid boundary.
    let upper_tolerance = fmax * 0.005;
    // Sub-microhertz floating/resampling error at an exact configured boundary must not
    // discard a valid frame. This is not the 0.5% search band.
    let numeric_tolerance = 1e-6f64.max(fmin.max(fmax) * 1e-9);
    let in_range: Vec<Candidate> = candidates
        .iter()
        .copied()
        .filter(|candidate| {
            candidate.f0 >= fmin - numeric_tolerance && candidate.f0 <= fmax + upper_tolerance
        })
        .collect();

    // Baseline: inRange.find(c => c.aperiodicity < threshold) — forward scan, first tie wins.
    let mut chosen = in_range
        .iter()
        .copied()
        .find(|candidate| candidate.aperiodicity < threshold);
    if chosen.is_none() {
        // Baseline: inRange.reduce((best, c) => (!best || c.aperiodicity < best.aperiodicity) ? c : best, null)
        // A strict `<` keeps the earliest candidate on ties, and the accumulator seeds from
        // the first element.
        let mut best: Option<Candidate> = None;
        for candidate in in_range.iter().copied() {
            let replace = match best {
                None => true,
                Some(current) => candidate.aperiodicity < current.aperiodicity,
            };
            if replace {
                best = Some(candidate);
            }
        }
        chosen = best;
        // When the threshold is missed, only moderate periodicity evidence is allowed;
        // higher CMNDF valleys are easily produced in transients and noise by "pick the
        // minimum out of many delays".
        if let Some(candidate) = chosen {
            if candidate.aperiodicity > 0.3 {
                chosen = None;
            }
        }
    }
    let chosen = match chosen {
        Some(candidate) => candidate,
        None => {
            // Baseline: candidates.find(c => (c.f0 < fmin || c.f0 > fmax) && c.aperiodicity < threshold)
            let outside = candidates.iter().copied().find(|candidate| {
                (candidate.f0 < fmin || candidate.f0 > fmax) && candidate.aperiodicity < threshold
            });
            return match outside {
                Some(candidate) => PitchFrame {
                    f0: 0.0,
                    aperiodicity: candidate.aperiodicity,
                    raw_f0: Some(candidate.f0),
                    reason: Some("out-of-range"),
                    range: None,
                    range_boundary_adjusted: None,
                    numeric_tolerance_hz: None,
                },
                None => no_pitch(),
            };
        }
    };

    // If a shorter above-ceiling period also satisfies the absolute period threshold, its
    // integer multiple must not be back-filled as a lower octave. Discrete CMNDF sampling
    // error is larger at short periods, so a 0.01 gap to the long-period valley must not be
    // required; when two period-doubling interpretations both pass the threshold, reporting
    // out-of-range is the conservative choice.
    let shorter = candidates.iter().copied().find(|candidate| {
        if candidate.f0 <= fmax + numeric_tolerance || candidate.aperiodicity >= threshold {
            return false;
        }
        let ratio = chosen.period / candidate.period;
        // Math.round chooses the nearest integer, with exact ties toward +Infinity.
        // Adding 0.5 first can round a just-below-half input to the wrong integer.
        let floor = ratio.floor();
        let multiple = if ratio - floor < 0.5 {
            floor
        } else {
            floor + 1.0
        };
        multiple >= 2.0 && (ratio - multiple).abs() <= 0.05
    });
    if let Some(candidate) = shorter {
        return PitchFrame {
            f0: 0.0,
            aperiodicity: candidate.aperiodicity,
            raw_f0: Some(candidate.f0),
            reason: Some("out-of-range"),
            range: None,
            range_boundary_adjusted: None,
            numeric_tolerance_hz: None,
        };
    }
    if chosen.f0 > fmax + numeric_tolerance {
        return PitchFrame {
            f0: 0.0,
            aperiodicity: chosen.aperiodicity,
            raw_f0: Some(chosen.f0),
            reason: Some("boundary-uncertain"),
            range: Some((fmin, fmax)),
            range_boundary_adjusted: None,
            numeric_tolerance_hz: None,
        };
    }
    // Baseline: const f0 = Math.max(fmin, Math.min(fmax, chosen.f0)) — inner clamp first.
    // js_max/js_min keep JavaScript's NaN propagation, which matters because a
    // non-finite frame makes candidate f0 values non-finite too.
    let f0 = js_max(fmin, js_min(fmax, chosen.f0));
    // The adjustment flags are present only when the clamp actually moved the value; the
    // spread `...(f0 !== chosen.f0 ? {...} : {})` makes their absence observable.
    let adjusted = f0 != chosen.f0;
    PitchFrame {
        f0,
        aperiodicity: chosen.aperiodicity,
        raw_f0: Some(chosen.f0),
        reason: None,
        range: None,
        range_boundary_adjusted: if adjusted { Some(true) } else { None },
        numeric_tolerance_hz: if adjusted {
            Some(numeric_tolerance)
        } else {
            None
        },
    }
}

/// Iterates pitch frames over a whole signal, yielding one [`PitchPoint`] per frame.
///
/// Direct port of the `iteratePitch` generator body:
/// ```text
/// for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
///   frame[i] = signal[start + i];              // Float64Array widened from Float32Array
///   time = (start + frameSize / 2) / sampleRate;
/// }
/// ```
///
/// The frame objects are caller-visible results rather than lazily generated state, so this
/// port collects them eagerly like `yinPitchTrack` does; the frame count, times and payloads
/// are identical because the generator has no other observable side effects.
///
/// # Errors
///
/// Returns `Err` with a static reason instead of hanging or producing a meaningless track:
/// - `frame_size == 0` or `hop == 0` — `"frame_size and hop must be positive"`; the baseline
///   would spin forever on `hopSize = 0` and emit empty frames on `frameSize = 0`.
/// - `!fs.is_finite() || fs <= 0.0` — `"sample rate must be finite and positive"`; the
///   baseline would emit frames with `Infinity`/`NaN` times.
/// - `frame_size` or `hop` larger than `2^53` — `"frame size and hop exceed addressable
///   range"`; such values cannot be represented exactly in the baseline's `f64` loop
///   arithmetic, so the port refuses rather than silently rounding.
///
/// These rejections are the documented bounded API difference described in
/// [`crate::speech`]. Valid configurations are never rejected, so no valid comparison case
/// is affected.
pub fn iterate_pitch(
    signal: &[f32],
    fs: f64,
    frame_size: usize,
    hop: usize,
    threshold: f64,
    fmin: f64,
    fmax: f64,
) -> Result<Vec<PitchPoint>, &'static str> {
    if frame_size == 0 || hop == 0 {
        return Err("frame_size and hop must be positive");
    }
    if !fs.is_finite() || fs <= 0.0 {
        return Err("sample rate must be finite and positive");
    }
    // Guard the loop arithmetic before it can lose precision: integers above 2^53 are not
    // exactly representable as f64, so `frame_size / 2` and the accumulated `start` would
    // silently round. Valid speech configurations are nowhere near this bound.
    if frame_size as u128 > (1u128 << 53) || hop as u128 > (1u128 << 53) {
        return Err("frame size and hop exceed addressable range");
    }
    let frame_size_f = frame_size as f64;

    let mut track: Vec<PitchPoint> = Vec::new();
    let mut start: usize = 0;
    // Baseline loop condition: start + frameSize <= signal.length. `checked_add` reproduces
    // the fact that this can never overflow for `start <= signal.len()`, and keeps the loop
    // terminating instead of wrapping.
    while start
        .checked_add(frame_size)
        .is_some_and(|end| end <= signal.len())
    {
        // YIN consumes the raw frame; windowing would change the amplitude envelope at
        // different delays. Baseline copies through Float64Array, i.e. exact f32 -> f64.
        let frame: Vec<f64> = signal[start..start + frame_size]
            .iter()
            .map(|&sample| sample as f64)
            .collect();
        // Baseline: (start + frameSize / 2) / sampleRate — the halving is exact for any
        // exactly representable frameSize, and the addition/division order is preserved.
        let time = ((start as f64) + frame_size_f / 2.0) / fs;
        let frame_result = yin_pitch_frame(&frame, fs, threshold, fmin, fmax);
        track.push(PitchPoint {
            time,
            frame: frame_result,
        });
        match start.checked_add(hop) {
            Some(next) => start = next,
            None => break, // No further frame can fit after an overflowing offset.
        }
    }

    Ok(track)
}

/// Extracts a pitch track from a whole signal.
///
/// Alias of [`iterate_pitch`] matching the baseline's `yinPitchTrack` entry point. Both names
/// are exported so callers can mirror either the generator (`iteratePitch`) or the collected
/// (`yinPitchTrack`) baseline API while executing the same code.
///
/// # Errors
///
/// Identical to [`iterate_pitch`]. See that function and [`crate::speech`] for the documented
/// bounded API difference from the JavaScript baseline.
pub fn pitch_track(
    signal: &[f32],
    fs: f64,
    frame_size: usize,
    hop: usize,
    threshold: f64,
    fmin: f64,
    fmax: f64,
) -> Result<Vec<PitchPoint>, &'static str> {
    iterate_pitch(signal, fs, frame_size, hop, threshold, fmin, fmax)
}
