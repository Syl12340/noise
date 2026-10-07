//! Windowed-sinc anti-aliasing resampler (phase 3 first batch).
//!
//! Numerically faithful port of the convolution loop in
//! `utils/phonetic/resample.js` (`iterateResample` / `resampleLowPass`). Only that one
//! operation is ported here; `emphasizeFloat` lives in [`crate::speech::emphasis`].
//!
//! # Division of responsibility
//!
//! This module owns the *arithmetic* and the *validation policy*. It does **not** own the
//! normalized filter coefficients. The frozen, captured 257-tap kernels are supplied by the
//! sibling `resample_tables` module (owned by the parent task) through
//! [`crate::speech::resample_tables::load_bank`], keyed by the microphase the baseline
//! quantizes to. Nothing here regenerates `sin`, `cos` or a normalization sum at runtime;
//! the baseline's transcendental kernel construction is never re-derived, only replayed.
//!
//! # Baseline arithmetic, preserved exactly
//!
//! ```text
//! const half = 128;
//! const cutoff = Math.min(cutoffHz, outputRate * 0.49) / inputRate;
//! out.length = Math.floor(signal.length * outputRate / inputRate);
//! position  = i * inputRate / outputRate;      // i, inputRate, outputRate are Numbers
//! base      = Math.floor(position);
//! phase     = Math.round((position - base) * 1e6) / 1e6;
//! value     = sum over j = -128..=128 of signal[edgeHeld(base + j)] * kernel[j + 128];
//! ```
//!
//! Consequences that are deliberately reproduced:
//!
//! - **Output length** is `floor(n * out / in)`, with `n * out` computed first exactly as the
//!   baseline's left-to-right `signal.length * outputRate / inputRate` does.
//! - **Position** is `i * input / output` in `f64`, matching JavaScript `Number` ordering
//!   (`(i * inputRate) / outputRate`, not `i * (inputRate / outputRate)`).
//! - **`Math.round` tie behavior**: ties go toward `+Infinity`. As in [`crate::speech::yin`],
//!   the port uses `floor` plus an explicit frac test rather than `x + 0.5`, because adding
//!   `0.5` first can round a just-below-half `f64` up to the wrong integer.
//! - **Summation order** is ascending `j = -128..=128`, exactly the baseline's `for` loop.
//!   No reassociation, no pairwise/tree summation, no SIMD lanes, and no fused multiply-add.
//! - **Edge hold**: `index = max(0, min(len - 1, base + j))`, including the baseline's
//!   `min`-before-`max` nesting and its `len - 1` upper bound.
//! - **Storage**: the accumulator is `f64` and only the final store is narrowed with `as f32`,
//!   which is the same round-to-nearest-even narrowing a `Float32Array` store performs.
//!
//! All of those properties matter for the intended relation, which is *bit equality* against
//! the frozen JavaScript reference on finite fixtures — not a tolerance.
//!
//! # Kernel lookup
//!
//! The baseline caches one kernel per quantized `phase` in a `Map`. Two `phase` keys are
//! forms occur: phase0 for integral positions, and multiple recurring positive phases for
//! non-integer rate ratios. Captured keys are integer microphases rather than fractions.
//!
//! A kernel that is not present in the bank is an **explicit** `Err`, never an approximation,
//! never a neighboring-phase substitution and never a locally computed fallback. Each output
//! sample's kernel is borrowed from the bank rather than cloned, so the per-sample cost stays
//! at 257 ordered multiplication/addition pairs plus one lookup in the small frozen bank.
//!
//! # Validation policy (documented bounded API difference)
//!
//! The baseline is a permissive generator: it will happily produce `NaN` for a nonfinite
//! sample, silently truncate an out-of-range rate, and grow an unbounded output for an
//! unbounded input. This port instead rejects up front, so that invalid input can never be
//! mistaken for a numerically verified comparison case:
//!
//! | Condition | Result |
//! |---|---|
//! | profile not in the supported set below | `Err("unsupported resample profile")` |
//! | `signal.len() > 262144` | `Err("signal length exceeds 262144 samples")` |
//! | any sample `NaN` / `±Inf` | `Err("signal contains non-finite samples")` |
//! | `signal.is_empty()` | `Ok(vec![])` |
//! | supported profile, no kernel for a required phase | `Err("missing resample kernel for quantized phase")` |
//!
//! Validation happens before any allocation or arithmetic, so an invalid request has no
//! partial effect. The supported set is exactly the profile frozen by
//! `phase3/PORT_CONTRACT.md`: `12000/16000/22050/24000/32000/44100/48000 -> 12000` with
//! `cutoff = 5500 Hz`. A supported input rate with a different output rate or cutoff is
//! *unsupported*, not approximated.
//!
//! # Scope
//!
//! Experimental opt-in compatibility port. This is not production integration, and matching
//! the baseline bit-for-bit is **not** new scientific validation of the resampler's
//! anti-aliasing behaviour — upstream limitations are reproduced, not repaired.

use crate::speech::resample_tables::{KernelBank, load_bank};

/// Baseline `const half = 128`, i.e. 128 taps on each side of the sample position.
pub const HALF_TAPS: usize = 128;

/// Baseline kernel length `2 * half + 1`; also the stride of a frozen kernel row.
pub const KERNEL_TAPS: usize = 2 * HALF_TAPS + 1;

/// Baseline phase quantization factor (`Math.round(... * 1e6) / 1e6`).
pub const PHASE_QUANTIZATION: f64 = 1e6;

/// Maximum accepted input length, from `phase3/PORT_CONTRACT.md` ("Maximum input 262144").
pub const MAX_INPUT_SAMPLES: usize = 262144;

/// Output rate of the single profile supported by this batch.
pub const SUPPORTED_OUTPUT_RATE: u32 = 12000;

/// Cutoff in Hz of the single profile supported by this batch.
pub const SUPPORTED_CUTOFF_HZ: f64 = 5500.0;

/// Input rates supported by this batch, in ascending order.
pub const SUPPORTED_INPUT_RATES: [u32; 7] = [12000, 16000, 22050, 24000, 32000, 44100, 48000];

/// Error text returned when the requested `(input, output, cutoff)` profile is not the one
/// frozen for this batch. Other profiles are rejected outright; there is no approximate path.
pub const ERR_UNSUPPORTED_PROFILE: &str = "unsupported resample profile";

/// Error text returned for an input longer than [`MAX_INPUT_SAMPLES`].
pub const ERR_INPUT_TOO_LONG: &str = "signal length exceeds 262144 samples";

/// Error text returned when any input sample is `NaN` or `±Inf`.
pub const ERR_NON_FINITE_INPUT: &str = "signal contains non-finite samples";

/// Error text returned when the frozen kernel bank has no entry for a required phase.
///
/// Reaching this means the frozen table does not cover the phases this profile produces;
/// the port refuses rather than substituting a neighboring phase or an approximate kernel.
pub const ERR_MISSING_PHASE: &str = "missing resample kernel for quantized phase";

/// Resamples `signal` with the baseline windowed-sinc low-pass kernel bank.
///
/// See the module documentation for the exact ordering, rounding and validation contract.
///
/// # Arguments
///
/// - `signal`: input samples, read as their stored `f32` bit patterns and widened exactly to
///   `f64` (the same lossless widening a JavaScript `Float32Array` read performs).
/// - `input_rate` / `output_rate`: profile rates. Only the profiles in
///   [`SUPPORTED_INPUT_RATES`] paired with [`SUPPORTED_OUTPUT_RATE`] are accepted.
/// - `cutoff_hz`: profile cutoff. Must be exactly [`SUPPORTED_CUTOFF_HZ`] for the accepted
///   profile; the number is part of the profile identity, not an adjustable parameter.
///
/// # Returns
///
/// [`Ok`] with `floor(n * output_rate / input_rate)` samples, or an [`Err`] carrying one of
/// the static error strings listed in the module documentation.
pub fn resample_low_pass(
    signal: &[f32],
    input_rate: u32,
    output_rate: u32,
    cutoff_hz: f64,
) -> Result<Vec<f32>, &'static str> {
    let out_len = validate(signal, input_rate, output_rate, cutoff_hz)?;
    if signal.is_empty() {
        return Ok(Vec::new());
    }
    let bank = load_bank(input_rate, output_rate, cutoff_hz).ok_or(ERR_MISSING_PHASE)?;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        out.push(sample_at(signal, input_rate, output_rate, i, &bank)?);
    }
    Ok(out)
}

pub(crate) fn validate(
    signal: &[f32],
    input_rate: u32,
    output_rate: u32,
    cutoff_hz: f64,
) -> Result<usize, &'static str> {
    if output_rate != SUPPORTED_OUTPUT_RATE
        || cutoff_hz != SUPPORTED_CUTOFF_HZ
        || !SUPPORTED_INPUT_RATES.contains(&input_rate)
    {
        return Err(ERR_UNSUPPORTED_PROFILE);
    }

    let n = signal.len();
    if n > MAX_INPUT_SAMPLES {
        return Err(ERR_INPUT_TOO_LONG);
    }

    for &sample in signal {
        if !sample.is_finite() {
            return Err(ERR_NON_FINITE_INPUT);
        }
    }

    Ok(((n as f64) * (output_rate as f64) / (input_rate as f64)).floor() as usize)
}

/// Shared ordered arithmetic for one global output index; source is never a batch slice.
pub(crate) fn sample_at(
    signal: &[f32],
    input_rate: u32,
    output_rate: u32,
    i: usize,
    bank: &KernelBank,
) -> Result<f32, &'static str> {
    let input_rate_f = input_rate as f64;
    let output_rate_f = output_rate as f64;
    let last_index = signal.len() - 1;

    // Baseline: const position = i * inputRate / outputRate.
    let position = (i as f64) * input_rate_f / output_rate_f;
    // Baseline: const base = Math.floor(position).
    let base = position.floor();
    // Baseline: const phase = Math.round((position - base) * 1e6) / 1e6.
    // Math.round ties go toward +Infinity; see `js_round` for why `+ 0.5` is not used.
    let phase_key = js_round((position - base) * PHASE_QUANTIZATION) as u32;

    // Borrow, never clone: `kernels` is indexed in place for the whole 257-tap loop.
    let (_, kernel) = bank
        .kernels
        .iter()
        .find(|(key, _)| *key == phase_key)
        .ok_or(ERR_MISSING_PHASE)?;
    debug_assert_eq!(kernel.len(), KERNEL_TAPS, "frozen kernel must be 257 taps");

    // Baseline: let value = 0; for (let j = -half; j <= half; j++) { ... }
    let mut value = 0.0f64;
    for j in -128i64..=128i64 {
        // Baseline: Math.max(0, Math.min(signal.length - 1, base + j)).
        let raw = base + (j as f64);
        let clamped = if raw < 0.0 {
            0.0
        } else if raw > last_index as f64 {
            last_index as f64
        } else {
            raw
        };
        // `clamped` is an integer-valued f64 in [0, n - 1] by construction; the cast is
        // exact and cannot leave the slice bounds.
        let index = clamped as usize;
        let tap = kernel[(j + 128) as usize];
        // Baseline: value += signal[index] * kernel[j + half]; ascending j, one rounding
        // per multiply-add pair, no FMA contraction permitted on this expression.
        value += (signal[index] as f64) * tap;
    }

    // Baseline's Float32Array store, before any callback can observe this sample.
    Ok(value as f32)
}

/// `Math.round(x)` for finite `x`: nearest integer, with exact `.5` ties toward `+Infinity`.
///
/// Implemented as `floor` plus a frac test rather than `(x + 0.5).floor()`. The two agree for
/// most inputs, but adding `0.5` first can round a value just below `k + 0.5` up to exactly
/// `k + 0.5` (and then `floor` yields `k + 1`), which would select the wrong frozen kernel.
/// The baseline calls `Math.round` directly, so the explicit test is the faithful form.
///
/// Non-finite input cannot reach this function: it is only called on
/// `(position - base) * 1e6`, which is a finite product of finite bounded values.
#[inline]
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor < 0.5 { floor } else { floor + 1.0 }
}
