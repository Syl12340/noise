//! Fractional-delay normalized correlation.
//!
//! Faithful ordered-`f64` port of `utils/phonetic/fractional-correlation.js`
//! (`refineCorrelationPeak`), plus the call-level work budget required by
//! `phase4/PORT_CONTRACT.md`.
//!
//! # What is preserved exactly
//!
//! * The interpolation kernel is a **normalized 129-sample Blackman-windowed sinc**, not a
//!   parabolic height interpolation. The frozen window is supplied by the caller
//!   (`hnr_tables::window()`); this module never builds it, because a `cos`-based rebuild
//!   would need the same one-ULP `Math.cos` as the baseline.
//! * Every ordered arithmetic step of the baseline is reproduced: the accumulation order of
//!   the left energy, the dot product and the right energy, the `sum` reduction over the
//!   kernel, the kernel normalization (in place, then re-read), the `sqrt` denominator and the
//!   `[-1, 1]` clamp.
//! * The integer-shift fast path (`fraction < 1e-12 || 1 - fraction < 1e-12`) is kept
//!   separate from the convolution path even though the two agree mathematically: they do
//!   **not** agree bit-for-bit, and the baseline chooses between them on exact `lag` bits.
//! * Brent's bounded search is reproduced including the parabola step, the golden-section
//!   fallback, the `2 * tolerance - (b - a) / 2` convergence test, the 32-iteration cap, the
//!   `Math.abs(e) > tolerance` gate on the *previous* step, and the endpoint sweep that runs
//!   *after* the loop and can replace the result.
//! * `Math.max`/`Math.min`/`Math.abs` argument evaluation order is preserved where the
//!   baseline can pass `NaN`.
//!
//! # Bound: the sinc primitive is explicit
//!
//! The baseline computes the kernel with `Math.sin`. There is deliberately **no built-in
//! `sin` call anywhere in this file**: the sine is an `&impl Fn(f64) -> f64` callback so the
//! host can supply the frozen JavaScript `Math.sin` oracle bit-for-bit (see the contract's
//! "Native core takes an explicit sin callback"). Passing a different libm is a caller
//! decision, and the caller owns the resulting one-ULP divergence.
//!
//! # Bound: the work budget
//!
//! All allocations happen before any loop runs (`Vec::with_capacity`), there is no unwinding,
//! so a budget failure cannot strand a partially built result. Each *evaluation* charges
//! `count` for an integer shift or `count * 129` for a sinc convolution, and the charge
//! happens **before** the evaluation's loops execute. Once a charge is refused the evaluation
//! returns without touching any accumulator, so no partial result is ever published.

/// Comparison-window half width in samples.
///
/// Mirrors `const HALF = 64` in `fractional-correlation.js` and is also the
/// `interpolationHalfSamples` value reported by the baseline. The kernel therefore always has
/// `2 * HALF + 1 = 129` taps.
pub const HALF: usize = 64;

/// Exact tap count of the fractional kernel (`2 * HALF + 1`).
pub const KERNEL_LEN: usize = 2 * HALF + 1;

/// Error returned when a call-level pair budget would be exceeded.
///
/// The contract requires an explicit capacity failure with no partial result; the crate's
/// ported speech boundary uses static `&'static str` reasons, so this is the message.
pub const WORK_BUDGET_EXCEEDED: &str = "work budget exceeded";

/// Call-level pair (interpolation tap) budget shared across all candidates and frames.
///
/// Mirrors a plain `{remaining, consumed}` counter. `charge` is the only mutator, so a caller
/// cannot observe a partially applied charge: either the whole amount is deducted or the
/// budget is left untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkBudget {
    /// Pairs still available. Never decremented below zero.
    pub remaining: u64,
    /// Pairs already charged.
    pub consumed: u64,
}

impl WorkBudget {
    /// Creates a budget with `limit` pairs available.
    pub const fn new(limit: u64) -> Self {
        Self {
            remaining: limit,
            consumed: 0,
        }
    }

    /// Charges `pairs` interpolation taps against the budget.
    ///
    /// # Errors
    ///
    /// Returns [`WORK_BUDGET_EXCEEDED`] when `pairs` does not fit in `remaining`. The budget is
    /// left exactly as it was, so a refused charge never consumes capacity.
    pub fn charge(&mut self, pairs: u64) -> Result<(), &'static str> {
        if pairs > self.remaining {
            return Err(WORK_BUDGET_EXCEEDED);
        }
        self.remaining -= pairs;
        self.consumed += pairs;
        Ok(())
    }
}

/// Result of [`refine_correlation_peak`].
///
/// Field presence mirrors the baseline's object construction. The baseline returns
/// `{correlation, converged}` on every early exit and only adds the measured fields on the
/// successful return, so `lag_samples`, `comparison_samples`, `interpolation_half_samples`
/// and `evaluations` are all absent (`None`) together whenever the search bailed out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Refinement {
    /// Best normalized correlation found; `NaN` on the early-exit paths.
    pub correlation: f64,
    /// Whether the interval test (not the iteration cap) ended the search.
    pub converged: bool,
    /// Best lag in samples; present only on the completed return.
    pub lag_samples: Option<f64>,
    /// `frame.len() - 2 * HALF - ceil(upper)` for this refinement's comparison window.
    pub comparison_samples: Option<usize>,
    /// Always `HALF` (64) when present; interpolated samples on each side of the peak.
    pub interpolation_half_samples: Option<usize>,
    /// Total number of `fractionalCorrelation` evaluations, including the two endpoints.
    pub evaluations: Option<usize>,
}

/// The baseline's `comparison(frame, upperLag)` state object, plus the normalized kernel.
///
/// `count` is computed with `f64::ceil` on the caller's `upper` before it is narrowed, exactly
/// like `Math.ceil`, and `frame.len() - 2 * HALF - ceil(upper)` is evaluated as an `f64`
/// subtraction before the truncating conversion, exactly like the JavaScript `count`.
struct Comparison<'a> {
    frame: &'a [f64],
    count: usize,
    left_energy: f64,
    kernel: [f64; KERNEL_LEN],
    window: [f64; KERNEL_LEN],
}

impl<'a> Comparison<'a> {
    /// Mirrors `comparison(frame, upperLag)` including the left-energy accumulation order.
    fn new(frame: &'a [f64], upper_lag: f64, window: &[f64; KERNEL_LEN]) -> Self {
        // No mutation of the source slice is possible: `frame` is the same slice the caller
        // passed and it is never wrapped in a `Cell`/`RefCell`.
        debug_assert_eq!(window.len(), KERNEL_LEN);
        let count = (frame.len() as f64 - 2.0 * HALF as f64 - upper_lag.ceil()) as usize;
        let mut left_energy = 0.0f64;
        for i in HALF..HALF + count {
            let sample = frame[i];
            left_energy += sample * sample;
        }
        Self {
            frame,
            count,
            left_energy,
            kernel: [0.0; KERNEL_LEN],
            window: *window,
        }
    }

    /// Mirrors `fractionalCorrelation(state, lag)` and charges the budget first.
    ///
    /// Charge rule (contract): `count` pairs for the integer-shift branch, `count * 129` pairs
    /// for the sinc-convolution branch, always **before** the corresponding loops run. The
    /// batch is charged once per evaluation rather than once per inner iteration so that the
    /// per-iteration decrement cannot alter the accumulation order.
    fn correlation(
        &mut self,
        lag: f64,
        sin: &impl Fn(f64) -> f64,
        budget: &mut WorkBudget,
    ) -> Result<f64, &'static str> {
        if self.count < 2 || self.left_energy <= 1e-20 {
            // Mirrors the baseline's NaN guard, which runs before any lag arithmetic. No work
            // is performed for this evaluation, so nothing is charged.
            return Ok(f64::NAN);
        }

        // JavaScript: integer = Math.floor(lag), fraction = lag - integer.
        let integer = lag.floor();
        let fraction = lag - integer;

        let mut dot = 0.0f64;
        let mut right_energy = 0.0f64;

        if fraction < 1e-12 || 1.0 - fraction < 1e-12 {
            // Integer-shift branch: `count` pairs, charged before the loop.
            let pairs = self.count as u64;
            budget.charge(pairs)?;
            // Math.round: ties go to +Infinity, unlike Rust's round-half-away-from-zero.
            // The conversion saturates on overflow instead of wrapping, so a pathological lag
            // still fails a bounds check rather than aliasing a valid index. For every lag
            // reaching this branch the shift is the small non-negative integer the baseline
            // uses.
            let shift = js_round(lag) as usize;
            for i in HALF..HALF + self.count {
                let left = self.frame[i];
                let right = self.frame[i + shift];
                dot += left * right;
                right_energy += right * right;
            }
        } else {
            // Sinc-convolution branch: `count` windows of 129 taps.
            let taps = KERNEL_LEN as u64;
            let pairs = (self.count as u64).saturating_mul(taps);
            budget.charge(pairs)?;

            let mut sum = 0.0f64;
            for j in -(HALF as i32)..=HALF as i32 {
                let t = j as f64 - fraction;
                let pi_t = core::f64::consts::PI * t;
                let value = sin(pi_t) / pi_t * self.window[(j + HALF as i32) as usize];
                self.kernel[(j + HALF as i32) as usize] = value;
                sum += value;
            }
            for tap in self.kernel.iter_mut() {
                *tap /= sum;
            }

            for i in HALF..HALF + self.count {
                let mut right = 0.0f64;
                let first = i + integer as usize - HALF;
                for j in 0..KERNEL_LEN {
                    right += self.frame[first + j] * self.kernel[j];
                }
                let left = self.frame[i];
                dot += left * right;
                right_energy += right * right;
            }
        }

        let denominator = (self.left_energy * right_energy).sqrt();
        Ok(if denominator > 1e-20 {
            {
                let ratio = dot / denominator;
                if ratio.is_nan() {
                    f64::NAN
                } else {
                    ratio.clamp(-1.0, 1.0)
                }
            }
        } else {
            f64::NAN
        })
    }
}

/// `Math.round` for `f64`: nearest integer, with exact halves rounding toward `+Infinity`.
///
/// Rust's `f64::round` rounds halves away from zero, which differs at `-n - 0.5`. The three
/// branches below agree with JavaScript bit-for-bit on `[-0.5, 0)` (`-0.0`), on exact
/// half-integers either side of zero, on the values adjacent to `±0.5` (where `value + 0.5`
/// rounds *up* to `1.0`), on subnormal magnitudes, and on `±Infinity`. The signed zero is
/// irrelevant downstream because the only caller converts the result to `usize`, but it is
/// preserved here so the helper remains a faithful `Math.round` for future callers.
fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// Maximizes the actual normalized correlation of `frame` over the closed lag bracket.
///
/// Direct port of the `refineCorrelationPeak(frame, initialLag, lower, upper)` generator. The
/// generator's `yield` points carried no values, and the one consumer
/// (`harmonicity.js`) drained the generator to completion, so the returned object is the same
/// whether the body is stepped or run eagerly: this port runs it eagerly.
///
/// # Arguments
///
/// * `frame` — the centered frame (`centered` in the baseline), already de-meaned.
/// * `initial` — starting lag, clamped into `[lower, upper]` before the first evaluation.
/// * `lower`, `upper` — lag bracket in samples; `upper` must be strictly greater than `lower`.
/// * `window` — the frozen 129-sample Blackman window from `hnr_tables::window()`.
/// * `sin` — the scalar sine primitive; the host supplies the baseline's `Math.sin`.
/// * `budget` — call-level pair budget, charged per evaluation before its loops run.
///
/// # Returns
///
/// * `Ok(Refinement { correlation: NaN, converged: false, .. })` when `!(upper > lower)`, when
///   the first evaluation is non-finite, or when any later evaluation is non-finite. On these
///   paths every measured field stays `None`, matching the baseline's two-key return.
/// * `Ok(Refinement { .. })` with every measured field present when the search runs to
///   completion, including the endpoint sweep that may replace `x` and `fx` after the loop.
///
/// # Errors
///
/// [`WORK_BUDGET_EXCEEDED`] if a single evaluation cannot be charged. The error leaves no
/// partial result: the caller receives no `Refinement` at all.
pub fn refine_correlation_peak(
    frame: &[f64],
    initial: f64,
    lower: f64,
    upper: f64,
    window: &[f64; KERNEL_LEN],
    sin: &impl Fn(f64) -> f64,
    budget: &mut WorkBudget,
) -> Result<Refinement, &'static str> {
    // `if (!(upper > lower)) return {correlation: NaN, converged: false}`. Negated so a NaN
    // bound also bails out, exactly like the baseline's comparison.
    if upper.partial_cmp(&lower) != Some(core::cmp::Ordering::Greater) {
        return early_exit();
    }

    if !initial.is_finite()
        || !lower.is_finite()
        || !upper.is_finite()
        || lower < 0.0
        || upper > frame.len() as f64
        || frame.len() > 4096
        || !frame.iter().all(|v| v.is_finite())
    {
        return Err("invalid refinement input");
    }
    let mut state = Comparison::new(frame, upper, window);

    let mut a = lower;
    let mut b = upper;
    // Math.max(a, Math.min(b, initialLag)): `f64::min`/`f64::max` ignore NaN and keep the
    // non-NaN operand; all three arguments here were validated finite.
    let mut x = a.max(b.min(initial));
    let mut w = x;
    let mut v = x;
    let mut fx = state.correlation(x, sin, budget)?;
    let mut fw = fx;
    let mut fv = fx;
    let mut d = 0.0f64;
    let mut e = 0.0f64;
    let mut evaluations: usize = 1;
    let mut converged = false;

    if !fx.is_finite() {
        return early_exit();
    }

    // Samples. The actual normalized correlation is evaluated at every step.
    const TOLERANCE: f64 = 1e-5;
    // JavaScript: (3 - Math.sqrt(5)) / 2, evaluated in that order.
    let golden = (3.0 - 5.0f64.sqrt()) / 2.0;

    for _ in 0..32 {
        let middle = (a + b) / 2.0;
        if (x - middle).abs() <= 2.0 * TOLERANCE - (b - a) / 2.0 {
            converged = true;
            break;
        }
        let mut parabola = false;
        if e.abs() > TOLERANCE {
            let r = (x - w) * (fx - fv);
            let q0 = (x - v) * (fx - fw);
            let mut p = (x - v) * q0 - (x - w) * r;
            let mut q = 2.0 * (q0 - r);
            if q > 0.0 {
                p = -p;
            }
            q = q.abs();
            let previous = e;
            e = d;
            // `d` is not pre-assigned here: the only way out of this block without setting it
            // is the parabola branch, and that branch always sets it.
            if q > 0.0 && p.abs() < (q * previous / 2.0).abs() && p > q * (a - x) && p < q * (b - x)
            {
                d = p / q;
                parabola = true;
                let proposed = x + d;
                if proposed - a < 2.0 * TOLERANCE || b - proposed < 2.0 * TOLERANCE {
                    // Math.max(a, Math.min(b, x)) spelled out: Rust's `clamp` panics on NaN.
                    d = if middle >= x { 1.0 } else { -1.0 } * TOLERANCE;
                }
            }
        }
        if !parabola {
            e = if x < middle { b - x } else { a - x };
            d = golden * e;
        }
        let step = if d.abs() >= TOLERANCE {
            d
        } else if d >= 0.0 {
            TOLERANCE
        } else {
            -TOLERANCE
        };
        let u = x + step;

        let fu = state.correlation(u, sin, budget)?;
        evaluations += 1;
        if !fu.is_finite() {
            return early_exit();
        }
        if fu >= fx {
            if u >= x {
                a = x;
            } else {
                b = x;
            }
            v = w;
            fv = fw;
            w = x;
            fw = fx;
            x = u;
            fx = fu;
        } else {
            if u < x {
                a = u;
            } else {
                b = u;
            }
            if fu >= fw || w == x {
                v = w;
                fv = fw;
                w = u;
                fw = fu;
            } else if fu >= fv || v == x || v == w {
                v = u;
                fv = fu;
            }
        }
    }

    // Include physical range endpoints; an endpoint maximum need not be interior.
    for lag in [lower, upper] {
        let value = state.correlation(lag, sin, budget)?;
        evaluations += 1;
        if value > fx {
            x = lag;
            fx = value;
        }
    }

    Ok(Refinement {
        correlation: fx,
        converged,
        lag_samples: Some(x),
        comparison_samples: Some(state.count),
        interpolation_half_samples: Some(HALF),
        evaluations: Some(evaluations),
    })
}

/// The baseline's `{ correlation: NaN, converged: false }` return, with every measured field
/// absent.
const fn early_exit() -> Result<Refinement, &'static str> {
    Ok(Refinement {
        correlation: f64::NAN,
        converged: false,
        lag_samples: None,
        comparison_samples: None,
        interpolation_half_samples: None,
        evaluations: None,
    })
}
