//! Frame-wise HNR (harmonics-to-noise ratio) estimation.
//!
//! Faithful ordered-`f64` port of `utils/phonetic/harmonicity.js`
//! (`iterateHarmonicity` / `estimateHarmonicity` / `summarizeHarmonicity`) and of
//! `calculateHNR` from `utils/phonetic/voice-metrics.js`.
//!
//! # Scope
//!
//! HNR here is an **acoustic periodicity estimate, not a diagnostic classifier**. The port
//! reproduces the frozen baseline definitions; it performs no new scientific validation and
//! repairs no upstream limitation. See `phase4/PORT_CONTRACT.md`.
//!
//! # Numeric contract
//!
//! Every ordered arithmetic step is preserved in `f64`: the de-meaning accumulation, the
//! running prefix-energy recurrence, the twice-forward power-spectrum autocorrelation, the
//! integer-lag overlap normalization, the peak/bracket/parabola arithmetic, the fractional
//! refinement call, the `calculateHNR` clamp order, and the summary's accumulation, coverage
//! ratio and duration comparison. There is no fused multiply-add, no reassociation and no
//! extra rounding. The signal's `f32` stores are widened exactly (`f32 -> f64`), and the
//! centered frame is stored as `f64`, so no narrowing is introduced.
//!
//! # Bound: FFT, window and sine are supplied
//!
//! * Autocorrelation uses `generic_fft::fft`, whose sizes are bounded to `512..=8192` with the
//!   already frozen rotation table; no FFT is implemented here.
//! * The fractional kernel uses the frozen `hnr_tables::window()` 129-sample Blackman window;
//!   it is never rebuilt, because that would need the baseline's exact `Math.cos`.
//! * The scalar sine is an explicit `&impl Fn(f64) -> f64` callback. There is deliberately no
//!   built-in `sin` call in this file.
//!
//! # Bound: validation instead of the baseline's silent behaviour
//!
//! The baseline derives `fftSize` by doubling until `fftSize >= 2 * frameSize`, which can
//! exceed the frozen 8192-point table, and it will loop forever on a nonpositive `hopSize`.
//! This port **rejects** such configurations up front with static reasons instead. Valid
//! speech configurations are never rejected, so no valid comparison case changes.

use crate::speech::fractional::{HALF, Refinement, WorkBudget, refine_correlation_peak};
use crate::speech::generic_fft::fft;
use crate::speech::hnr_tables::window;

/// Whole-core input bound for one call (samples), matching `speech_api::INPUT_CAPACITY`.
pub const MAX_INPUT_SAMPLES: usize = 262144;
/// Smallest accepted frame size.
pub const MIN_FRAME_SIZE: usize = 256;
/// Largest accepted frame size (the frozen rotation table tops out at 8192 points).
pub const MAX_FRAME_SIZE: usize = 4096;
/// Reason reported by [`calculate_hnr`] when its input is not a valid correlation.
pub const INVALID_CORRELATION: &str = "correlation must be finite and in (0, 1]";
/// Error returned when the call-level pair budget would be exceeded.
///
/// Re-exported from [`crate::speech::fractional`] so a caller can match on one constant.
pub const WORK_BUDGET_EXCEEDED: &str = "work budget exceeded";

/// Default frame size in samples (85.3 ms at 12 kHz).
pub const DEFAULT_FRAME_SIZE: usize = 1024;
/// Default hop in samples (10 ms at 12 kHz). Duration counts hops, not overlapping windows.
pub const DEFAULT_HOP: usize = 120;
/// Default lowest fundamental in Hz.
pub const DEFAULT_FMIN: f64 = 40.0;
/// Default highest fundamental in Hz.
pub const DEFAULT_FMAX: f64 = 1200.0;
/// Default `require_pitch` (`false`: a standalone periodicity estimate is allowed).
pub const DEFAULT_REQUIRE_PITCH: bool = false;
/// Default minimum accepted peak correlation.
pub const DEFAULT_MIN_PEAK_CORRELATION: f64 = 0.2;
/// Default relative pitch-range widening.
pub const DEFAULT_MAX_PITCH_DEVIATION: f64 = 0.15;
/// Aperiodicity above which pitch evidence counts as unvoiced-or-uncertain.
const PITCH_APERIODICITY_LIMIT: f64 = 0.3;
/// The correlation method reported by the baseline.
pub const CORRELATION_METHOD: &str = "normalized-fractional-delay-sinc-129";

/// One pitch-evidence row supplied by the caller (the YIN track).
///
/// Mirrors the baseline's `{time, f0, aperiodicity}` triple. `f0 == 0.0` with
/// `aperiodicity == 1.0` is YIN's silence/short-frame/rejected marker, which this port reads
/// exactly as the baseline does.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchEvidence {
    /// Frame centre time in seconds.
    pub time: f64,
    /// Reported fundamental in Hz; `0.0` when YIN rejected the frame.
    pub f0: f64,
    /// YIN aperiodicity (CMNDF valley), `0.0..=1.0`.
    pub aperiodicity: f64,
}

/// HNR estimator configuration.
///
/// Field names mirror the baseline's destructured options. The baseline's `pitchTrack`
/// (default `[]`) is *not* an option here: it is the explicit `pitch` argument of
/// [`estimate_harmonicity`], which is the same `[]` default when empty.
///
/// The baseline also accepts a `hopSize` alias; the contract assigns option-name resolution
/// and rejection of unknown/conflicting options to the wiring layer, so this type exposes the
/// single resolved `hop` field.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HarmonicityOptions {
    /// Analysis frame length in samples (baseline `frameSize`), `256..=4096`.
    pub frame_size: usize,
    /// Analysis hop in samples (baseline `hopSize`), `> 0`.
    pub hop: usize,
    /// Lowest fundamental in Hz, `> 0`.
    pub fmin: f64,
    /// Highest fundamental in Hz, `>= fmin` and `<= fs / 2`.
    pub fmax: f64,
    /// Reject pitch-free frames with `unvoiced-or-uncertain` instead of estimating anyway.
    pub require_pitch: bool,
    /// Minimum accepted peak correlation, `0.0..=1.0`.
    pub min_peak_correlation: f64,
    /// Relative widening of the pitch-derived lag bracket, `0.0..=1.0`.
    pub max_pitch_deviation: f64,
}

impl Default for HarmonicityOptions {
    fn default() -> Self {
        Self {
            frame_size: DEFAULT_FRAME_SIZE,
            hop: DEFAULT_HOP,
            fmin: DEFAULT_FMIN,
            fmax: DEFAULT_FMAX,
            require_pitch: DEFAULT_REQUIRE_PITCH,
            min_peak_correlation: DEFAULT_MIN_PEAK_CORRELATION,
            max_pitch_deviation: DEFAULT_MAX_PITCH_DEVIATION,
        }
    }
}

/// One HNR track row.
///
/// Field presence mirrors the baseline's per-branch object construction: a property is either
/// present or absent, never present-and-`undefined`, so `None` means "property absent".
///
/// | Branch | `db` | `reason` | other fields |
/// |---|---|---|---|
/// | low energy | `None` | `Some("low-energy")` | all absent |
/// | pitch required but absent | `None` | `Some("unvoiced-or-uncertain")` | all absent |
/// | peak rejected | `None` | `Some("low-periodicity")` / `Some("no-periodic-peak")` | `peak_correlation` present |
/// | accepted | `Some(db)` | absent | all four measured fields present |
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HnrRow {
    /// `(start + frame_size / 2) / fs`, computed in the baseline's order.
    pub time: f64,
    /// HNR in dB, or absent when the frame produced no estimate.
    pub db: Option<f64>,
    /// Rejection reason; absent on accepted frames.
    pub reason: Option<&'static str>,
    /// Best normalized correlation. Present on rejected frames as the raw (possibly `0.0`)
    /// value and on accepted frames as `min(best, 1.0)`.
    pub peak_correlation: Option<f64>,
    /// Refined lag in samples; accepted frames only.
    pub lag_samples: Option<f64>,
    /// Refinement comparison-window sample count; accepted frames only.
    pub comparison_samples: Option<usize>,
    /// Always `Some(CORRELATION_METHOD)` on accepted frames.
    pub correlation_method: Option<&'static str>,
    /// Always `Some(true)` on accepted frames: only converged refinements are kept.
    pub refinement_converged: Option<bool>,
}

/// Shared by whole-recording and selection summaries.
///
/// `active_frames` counts eligible frames; `valid_frames` counts eligible frames carrying a
/// finite `db`. Coverage is relative to eligible frames, not to all non-silent frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HnrSummary {
    /// Frames not excluded by reason.
    pub active_frames: usize,
    /// Eligible frames with a finite `db`.
    pub valid_frames: usize,
    /// `valid_frames / active_frames`, or `0.0` when nothing is eligible.
    pub coverage: f64,
    /// `valid_frames * hop_seconds`.
    pub valid_duration_seconds: f64,
    /// The caller's minimum duration threshold.
    pub min_duration_seconds: f64,
    /// Ordered mean of the valid `db` values, or absent when nothing is valid.
    pub partial_mean_hnr: Option<f64>,
    /// `partial_mean_hnr` when coverage and duration both pass, otherwise absent.
    pub avg_hnr: Option<f64>,
}

/// Whole-result HNR estimate.
#[derive(Debug, Clone, PartialEq)]
pub struct HnrResult {
    /// One row per analysis frame, in ascending frame order.
    pub track: Vec<HnrRow>,
    /// Frames that passed the energy gate (baseline `signalFrames`).
    pub signal_frames: usize,
    /// Frames whose peak correlation reached `1 - 1e-6` (baseline `cappedFrames`).
    pub capped_frames: usize,
    /// Reported correlation method.
    pub correlation_method: &'static str,
    /// Interpolation half width in samples.
    pub interpolation_half_samples: usize,
    /// The baseline's `summarizeHarmonicity(track, hop / fs)` fields, inlined.
    pub summary: HnrSummary,
}

/// Converts a normalized autocorrelation peak to HNR in dB.
///
/// Direct port of `calculateHNR`:
/// ```text
/// if (!Number.isFinite(correlation) || correlation <= 0 || correlation > 1) return null;
/// const r = Math.min(correlation, 1 - 1e-6);
/// return 10 * Math.log10(r / (1 - r));
/// ```
///
/// Only the **upper** clamp exists. The baseline has no lower clamp, so a tiny positive
/// correlation is accepted and yields a large negative dB value; adding a lower clamp would
/// change results and is therefore forbidden.
///
/// Returns `None` for `NaN`, `±Infinity`, `correlation <= 0.0` and `correlation > 1.0`,
/// matching the baseline's `null`. Note that `-0.0 <= 0.0` holds, so negative zero is rejected
/// exactly like JavaScript's `-0 <= 0`.
pub fn calculate_hnr(correlation: f64) -> Option<f64> {
    if !correlation.is_finite() || correlation <= 0.0 || correlation > 1.0 {
        return None;
    }
    let r = correlation.min(1.0 - 1e-6);
    Some(10.0 * (r / (1.0 - r)).log10())
}

/// Aggregates a track into HNR summary statistics.
///
/// Direct port of `summarizeHarmonicity(track, hopSeconds, {minDurationSeconds})`:
/// * exactly three reasons exclude a frame — `low-energy`, `unvoiced-or-uncertain` and
///   `capture-gap-boundary`; every other reason (including `low-periodicity`,
///   `no-periodic-peak` and any caller-supplied string) stays eligible,
/// * a row is valid when `db` is present **and finite** (JavaScript's `Number.isFinite`), so
///   `NaN`/`±Infinity` are excluded from the mean while still counting as eligible,
/// * `coverage` is `0` when nothing is eligible,
/// * `avg_hnr` additionally requires `coverage >= 0.5` and
///   `valid_duration_seconds + 1e-9 >= min_duration_seconds`.
///
/// The baseline's default `hopSeconds` is `.01` and its default `minDurationSeconds` is `.1`;
/// this port takes both explicitly so the caller's configured hop is never silently replaced.
pub fn summarize_harmonicity(
    rows: &[HnrRow],
    hop_seconds: f64,
    min_duration_seconds: f64,
) -> HnrSummary {
    let mut active_frames = 0usize;
    let mut valid_frames = 0usize;
    let mut sum = 0.0f64;

    for row in rows {
        // `['low-energy','unvoiced-or-uncertain','capture-gap-boundary'].includes(reason)`:
        // a JS row without `reason` has `undefined`, which is not in the list and therefore
        // stays eligible — the same as `None` here.
        let excluded = matches!(
            row.reason,
            Some("low-energy") | Some("unvoiced-or-uncertain") | Some("capture-gap-boundary")
        );
        if excluded {
            continue;
        }
        active_frames += 1;
        // JavaScript: Number.isFinite(row.db) — present and finite.
        if let Some(db) = row.db {
            if db.is_finite() {
                valid_frames += 1;
                sum += db;
            }
        }
    }

    let coverage = if active_frames != 0 {
        valid_frames as f64 / active_frames as f64
    } else {
        0.0
    };
    let valid_duration_seconds = valid_frames as f64 * hop_seconds;
    let partial_mean_hnr = if valid_frames != 0 {
        Some(sum / valid_frames as f64)
    } else {
        None
    };
    let avg_hnr = if coverage >= 0.5 && valid_duration_seconds + 1e-9 >= min_duration_seconds {
        partial_mean_hnr
    } else {
        None
    };

    HnrSummary {
        active_frames,
        valid_frames,
        coverage,
        valid_duration_seconds,
        min_duration_seconds,
        partial_mean_hnr,
        avg_hnr,
    }
}

/// Frame-local state for the baseline's `correlation(lag)` closure.
///
/// `autocorrelation` is the baseline's `re` array after the inverse transform — the *forward*
/// transform of the power spectrum, which equals the autocorrelation scaled by `fftSize`.
/// `energies` is the running prefix energy of the centered frame.
struct FrameCorrelation<'a> {
    autocorrelation: &'a [f64],
    energies: &'a [f64],
    frame_size: usize,
    fft_size: f64,
}

impl FrameCorrelation<'_> {
    /// Mirrors `correlation(lag)`:
    /// ```text
    /// const denominator = Math.sqrt(energies[frameSize - lag] * (energies[frameSize] - energies[lag]));
    /// return denominator > 1e-20 ? re[lag] / fftSize / denominator : 0;
    /// ```
    ///
    /// The division by `fftSize` happens **before** the division by the denominator; those two
    /// divide-and-round steps are not interchangeable with one combined division. Only
    /// `lag + 1 <= frame_size / 2 + 1` is ever requested, so every index is in range.
    fn value(&self, lag: usize) -> f64 {
        let denominator = (self.energies[self.frame_size - lag]
            * (self.energies[self.frame_size] - self.energies[lag]))
            .sqrt();
        if denominator > 1e-20 {
            self.autocorrelation[lag] / self.fft_size / denominator
        } else {
            0.0
        }
    }
}

/// Validates every bounded-API precondition before any DSP runs.
///
/// Checked in the order the contract lists them. `pitch` is validated as chronological with
/// finite `time >= 0`, finite `f0 >= 0` and `aperiodicity` in `[0, 1]`.
fn validate(
    signal: &[f32],
    fs: f64,
    options: &HarmonicityOptions,
    pitch: &[PitchEvidence],
) -> Result<(), &'static str> {
    if !fs.is_finite() || fs <= 0.0 {
        return Err("sample rate must be finite and positive");
    }
    if options.frame_size < MIN_FRAME_SIZE || options.frame_size > MAX_FRAME_SIZE {
        return Err("frame size must be between 256 and 4096");
    }
    if options.hop == 0 {
        return Err("hop must be positive");
    }
    if signal.len() > MAX_INPUT_SAMPLES {
        return Err("input exceeds 262144 samples");
    }
    if !options.fmin.is_finite() || options.fmin <= 0.0 {
        return Err("fmin must be finite and positive");
    }
    if !options.fmax.is_finite() || options.fmax < options.fmin {
        return Err("fmax must be finite and at least fmin");
    }
    if options.fmax > fs / 2.0 {
        return Err("fmax must not exceed the Nyquist frequency");
    }
    if !options.min_peak_correlation.is_finite()
        || options.min_peak_correlation < 0.0
        || options.min_peak_correlation > 1.0
    {
        return Err("min peak correlation must be between 0 and 1");
    }
    if !options.max_pitch_deviation.is_finite()
        || options.max_pitch_deviation < 0.0
        || options.max_pitch_deviation > 1.0
    {
        return Err("max pitch deviation must be between 0 and 1");
    }
    let mut previous_time = f64::NEG_INFINITY;
    for point in pitch {
        if !point.time.is_finite() || point.time < 0.0 {
            return Err("pitch evidence time must be finite and non-negative");
        }
        if !point.f0.is_finite() || point.f0 < 0.0 {
            return Err("pitch evidence f0 must be finite and non-negative");
        }
        if point.f0 > 0.0 && !(fs / point.f0).is_finite() {
            return Err("pitch evidence lag must be finite");
        }
        if !point.aperiodicity.is_finite() || point.aperiodicity < 0.0 || point.aperiodicity > 1.0 {
            return Err("pitch evidence aperiodicity must be between 0 and 1");
        }
        if point.time < previous_time {
            return Err("pitch evidence must be chronological");
        }
        previous_time = point.time;
    }
    // `sampleRate / fmin` and `sampleRate / fmax` are finite for every accepted pair; checked
    // explicitly because they feed the baseline's `Math.max`/`Math.min` bracket arithmetic.
    if !(fs / options.fmin).is_finite() {
        return Err("sample rate divided by fmin must be finite");
    }
    Ok(())
}

/// Estimates frame-wise HNR over a whole signal.
///
/// Direct port of `estimateHarmonicity(signal, sampleRate, options)` — the collected form of
/// `iterateHarmonicity`. The generator's `yield` points carried no values, so draining it
/// eagerly produces the same object.
///
/// # Returns
///
/// `signal_frames` counts frames that passed the energy gate; `capped_frames` counts accepted
/// frames whose peak correlation reached `1 - 1e-6`. The summary is computed over the final
/// track with `hop / fs` as the hop duration.
///
/// # Errors
///
/// * `"work budget exceeded"` when a fractional evaluation cannot be charged. No partial
///   result is returned: the caller gets no `HnrResult` at all.
/// * Static validation reasons for `fs`, `frame_size`, `hop`, input length, `fmin`, `fmax`,
///   the two unit-interval options, or malformed/non-chronological pitch evidence.
pub struct FrameDiagnostics<'a> {
    pub mean: f64,
    pub centered: &'a [f64],
    pub energies: &'a [f64],
    pub fft_size: usize,
    pub stage1_re: Option<&'a [f64]>,
    pub stage1_im: Option<&'a [f64]>,
    pub autocorrelation_re: Option<&'a [f64]>,
}

pub fn estimate_harmonicity(
    signal: &[f32],
    fs: f64,
    options: &HarmonicityOptions,
    pitch: &[PitchEvidence],
    sin: &impl Fn(f64) -> f64,
    budget: &mut WorkBudget,
) -> Result<HnrResult, &'static str> {
    estimate_harmonicity_observed(signal, fs, options, pitch, sin, budget, None)
}

/// Verification observer exposes the actual HNR path; absent in ordinary calls.
pub fn estimate_harmonicity_observed(
    signal: &[f32],
    fs: f64,
    options: &HarmonicityOptions,
    pitch: &[PitchEvidence],
    sin: &impl Fn(f64) -> f64,
    budget: &mut WorkBudget,
    mut observer: Option<&mut dyn FnMut(FrameDiagnostics<'_>)>,
) -> Result<HnrResult, &'static str> {
    validate(signal, fs, options, pitch)?;

    let frame_size = options.frame_size;
    let hop = options.hop;

    // Baseline: let fftSize = 1; while (fftSize < 2 * frameSize) fftSize *= 2;
    let mut fft_size = 1usize;
    while fft_size < 2 * frame_size {
        fft_size *= 2;
    }
    // Bounded-API difference: the frozen rotation table only covers 512..=8192 points.
    // frame_size <= 4096 implies fft_size <= 8192, so this is a defence-in-depth check.
    if !(512..=8192).contains(&fft_size) {
        return Err("fft size must be between 512 and 8192");
    }

    let frame_size_f = frame_size as f64;
    let fft_size_f = fft_size as f64;

    // All scratch buffers are allocated before the frame loop, and this module never unwinds,
    // so a budget failure cannot strand a partially filled result.
    let mut re: Vec<f64> = vec![0.0; fft_size];
    let mut im: Vec<f64> = vec![0.0; fft_size];
    let mut energies: Vec<f64> = vec![0.0; frame_size + 1];
    let mut centered: Vec<f64> = vec![0.0; frame_size];

    let mut track: Vec<HnrRow> = Vec::new();
    let mut signal_frames = 0usize;
    let mut capped_frames = 0usize;
    let mut pitch_index = 0usize;

    let global_first = 2.0f64.max((fs / options.fmax).ceil());
    let global_last_base = ((frame_size / 2) as f64 - 1.0).min((fs / options.fmin).floor());

    let mut start: usize = 0;
    while start
        .checked_add(frame_size)
        .is_some_and(|end| end <= signal.len())
    {
        // `re.fill(0)` first: only the first `frame_size` entries are overwritten below, and
        // the transform must see the zero-padded tail.
        re.fill(0.0);
        im.fill(0.0);

        let mut mean = 0.0f64;
        for i in 0..frame_size {
            mean += signal[start + i] as f64;
        }
        mean /= frame_size_f;

        // Baseline order: write `re[i]` and `centered[i]` from the same expression, then
        // extend the prefix energies with that same value.
        energies[0] = 0.0;
        for i in 0..frame_size {
            let value = signal[start + i] as f64 - mean;
            re[i] = value;
            centered[i] = value;
            energies[i + 1] = energies[i] + value * value;
        }

        // Baseline: (start + frameSize / 2) / sampleRate.
        let time = (start as f64 + frame_size_f / 2.0) / fs;

        if energies[frame_size] / frame_size_f < 1e-10 {
            if let Some(observe) = observer.as_deref_mut() {
                observe(FrameDiagnostics {
                    mean,
                    centered: &centered,
                    energies: &energies,
                    fft_size,
                    stage1_re: None,
                    stage1_im: None,
                    autocorrelation_re: None,
                });
            }
            track.push(HnrRow {
                time,
                db: None,
                reason: Some("low-energy"),
                peak_correlation: None,
                lag_samples: None,
                comparison_samples: None,
                correlation_method: None,
                refinement_converged: None,
            });
            match start.checked_add(hop) {
                Some(next) => start = next,
                None => break,
            }
            continue;
        }
        signal_frames += 1;

        fft(&mut re, &mut im);

        let stage1 = observer.as_ref().map(|_| (re.clone(), im.clone()));

        // Power spectrum, made real: re[i] = re^2 + im^2, im[i] = 0.
        for i in 0..fft_size {
            re[i] = re[i] * re[i] + im[i] * im[i];
            im[i] = 0.0;
        }

        // The power spectrum is a real even sequence, so the forward transform's real part
        // divided by N is the autocorrelation. Same stage rotations, forward direction.
        fft(&mut re, &mut im);

        if let Some(observe) = observer.as_deref_mut() {
            observe(FrameDiagnostics {
                mean,
                centered: &centered,
                energies: &energies,
                fft_size,
                stage1_re: stage1.as_ref().map(|p| p.0.as_slice()),
                stage1_im: stage1.as_ref().map(|p| p.1.as_slice()),
                autocorrelation_re: Some(&re),
            });
        }

        // Baseline's exact `Math.min(Math.floor(frameSize / 2) - 1, Math.floor(sampleRate / fmin))`.
        // `frame_size / 2` is integer division here, i.e. the same value `Math.floor` produces
        // for the non-negative integer `frameSize`.
        let global_last = ((frame_size / 2) as f64 - 1.0).min((fs / options.fmin).floor());
        debug_assert_eq!(global_last, global_last_base);

        // Nearest-evidence scan. The baseline advances only while the *next* row is strictly
        // closer; a strict `<` means a tie leaves `pitch_index` on the earlier row.
        while pitch_index + 1 < pitch.len()
            && (pitch[pitch_index + 1].time - time).abs() < (pitch[pitch_index].time - time).abs()
        {
            pitch_index += 1;
        }
        let evidence = pitch.get(pitch_index).copied();

        let has_pitch_evidence = evidence.is_some_and(|p| {
            p.f0 > 0.0
                && p.aperiodicity <= PITCH_APERIODICITY_LIMIT
                && (p.time - time).abs() <= hop as f64 / fs
        });

        if options.require_pitch && !has_pitch_evidence {
            track.push(HnrRow {
                time,
                db: None,
                reason: Some("unvoiced-or-uncertain"),
                peak_correlation: None,
                lag_samples: None,
                comparison_samples: None,
                correlation_method: None,
                refinement_converged: None,
            });
            match start.checked_add(hop) {
                Some(next) => start = next,
                None => break,
            }
            continue;
        }

        // `expectedLag` is a JavaScript *number*; where the baseline passes it through
        // `Math.max`/`Math.min` against the integer range bounds a NaN would select the bound
        // and leave `first > last`. That is unreachable behind `hasPitchEvidence`, which
        // already requires `f0 > 0` and a finite `time`, but `first`/`last` are nevertheless
        // computed as `f64` and the loop below guards `first <= last` so the port can never
        // trap where the baseline would silently emit an empty range.
        let expected_lag = if has_pitch_evidence {
            Some(fs / evidence.map_or(0.0, |p| p.f0))
        } else {
            None
        }
        .filter(|lag| *lag != 0.0); // Baseline's expectedLag ? ... treats underflowed zero as false.
        let first = match expected_lag {
            // Math.max(globalFirst, Math.floor(expectedLag * (1 - maxPitchDeviation)))
            Some(lag) => global_first.max((lag * (1.0 - options.max_pitch_deviation)).floor()),
            None => global_first,
        };
        let last = match expected_lag {
            // Math.min(globalLast, Math.ceil(expectedLag * (1 + maxPitchDeviation)))
            Some(lag) => global_last.min((lag * (1.0 + options.max_pitch_deviation)).ceil()),
            None => global_last,
        };

        let state = FrameCorrelation {
            autocorrelation: &re,
            energies: &energies,
            frame_size,
            fft_size: fft_size_f,
        };

        let mut best = 0.0f64;
        let mut peak: Option<Refinement> = None;

        // `first` can exceed `last` or `last` can be negative only for configurations no caller
        // reaches: `global_first == 2`, `global_last >= 0` for every accepted `fmin`/`fmax`,
        // and `lower <= upper` always holds because `fs / fmax <= fs / fmin`. Guarding the
        // conversion keeps the port panic-free for arbitrary (still finite) bounds instead of
        // relying on that argument.
        if first <= last && first >= 0.0 {
            let first_int = first as usize;
            let last_int = last as usize;
            for lag in first_int..=last_int {
                let value = state.value(lag);
                // `correlation(lag - 1)` and `correlation(lag + 1)` are requested for every
                // lag, including the first, so `lag` must be at least 1 for the prefix-energy
                // index to stay in range. `globalFirst >= 2` guarantees it.
                let left = state.value(lag - 1);
                let right = state.value(lag + 1);
                if value >= left && value >= right {
                    let curvature = left - 2.0 * value + right;
                    let shift = if curvature < -1e-12 {
                        (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    };
                    let lower = (fs / options.fmax).max(lag as f64 - 1.0);
                    let upper = (fs / options.fmin).min(lag as f64 + 1.0);
                    // The bracket is exactly what the peak loop derived; no widening, no
                    // clamping to the integer range and no change of initial lag.
                    let refined = refine_correlation_peak(
                        &centered,
                        lag as f64 + shift,
                        lower,
                        upper,
                        &window(),
                        sin,
                        budget,
                    )?;
                    if refined.converged && refined.correlation > best {
                        best = refined.correlation;
                        peak = Some(refined);
                    }
                }
            }
        }

        if !best.is_finite() || best < options.min_peak_correlation {
            // `best > 0` is false both when `best` is exactly `0.0` and when it is `NaN`, so a
            // frame whose best comparison is a genuine zero baseline is reported as
            // `no-periodic-peak` with `peakCorrelation: 0`, matching the baseline.
            let reason = if best > 0.0 {
                "low-periodicity"
            } else {
                "no-periodic-peak"
            };
            track.push(HnrRow {
                time,
                db: None,
                reason: Some(reason),
                peak_correlation: Some(if best.is_finite() { best } else { 0.0 }),
                lag_samples: None,
                comparison_samples: None,
                correlation_method: None,
                refinement_converged: None,
            });
            match start.checked_add(hop) {
                Some(next) => start = next,
                None => break,
            }
            continue;
        }

        let capped = best.min(1.0);
        let db = calculate_hnr(capped);
        if best >= 1.0 - 1e-6 {
            capped_frames += 1;
        }
        // Only a converged refinement can set `best`, so `peak` is `Some` here and its
        // measured fields mirror the baseline's expansion of `peak`.
        let peak = peak.ok_or("refinement result is missing")?;
        track.push(HnrRow {
            time,
            db,
            reason: None,
            peak_correlation: Some(capped),
            lag_samples: peak.lag_samples,
            comparison_samples: peak.comparison_samples,
            correlation_method: Some(CORRELATION_METHOD),
            refinement_converged: Some(true),
        });

        match start.checked_add(hop) {
            Some(next) => start = next,
            None => break,
        }
    }

    let summary = summarize_harmonicity(&track, hop as f64 / fs, 0.1);

    Ok(HnrResult {
        track,
        signal_frames,
        capped_frames,
        correlation_method: CORRELATION_METHOD,
        interpolation_half_samples: HALF,
        summary,
    })
}
