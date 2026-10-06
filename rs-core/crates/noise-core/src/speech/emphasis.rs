//! Pre-emphasis filters for speech analysis.
//!
//! Ports two *distinct* baseline first-sample formulas verbatim:
//! - [`pre_emphasis`] mirrors `preEmphasis` in `utils/phonetic/pre-emphasis.js`.
//! - [`emphasize_float`] mirrors `emphasizeFloat` in `utils/phonetic/resample.js`.
//!
//! Both baselines allocate a `Float32Array` and store every result through it, so the Rust
//! port returns `Vec<f32>` and casts each ordered `f64` expression result with `as f32`.
//! That cast is the same round-to-nearest-even narrowing a JavaScript `Float32Array` store
//! performs; nothing else is rounded.
//!
//! Do not merge these two functions. Their first samples are defined by different formulas
//! and produce different bits for the same logical input.

/// Applies PCM pre-emphasis with the baseline `preEmphasis` formula.
///
/// Mirrors:
/// ```text
/// out[0] = pcm[0] / 32768.0;
/// out[i] = (pcm[i] / 32768.0) - coeff * (pcm[i - 1] / 32768.0);
/// ```
///
/// Note that the first sample does **not** involve `coeff` and is *not*
/// `x[0] * (1 - coeff)`; that is the [`emphasize_float`] rule. Each division is performed
/// independently in `f64` exactly as written in the baseline (no hoisted reciprocal, no
/// factored common denominator).
///
/// An empty input returns an empty vector. The baseline would read `pcm[0]` unconditionally,
/// but this port never indexes out of bounds; for `n == 0` the baseline's observable output
/// is an empty `Float32Array`, which is what is returned here.
///
/// `coeff` is used exactly as supplied, including nonfinite values, matching JavaScript
/// arithmetic propagation.
pub fn pre_emphasis(pcm: &[i16], coeff: f64) -> Vec<f32> {
    let n = pcm.len();
    let mut out = vec![0.0f32; n];
    if n == 0 {
        return out;
    }
    // Baseline: out[0] = pcm[0] / 32768.0
    out[0] = ((pcm[0] as f64) / 32768.0) as f32;
    for i in 1..n {
        // Baseline order: divide both operands, multiply, then subtract.
        out[i] = (((pcm[i] as f64) / 32768.0) - coeff * ((pcm[i - 1] as f64) / 32768.0)) as f32;
    }
    out
}

/// Applies float-signal emphasis with the baseline `emphasizeFloat` formula.
///
/// Mirrors:
/// ```text
/// out[0] = signal[0] * (1 - coefficient);
/// out[i] = signal[i] - coefficient * signal[i - 1];
/// ```
///
/// The first sample uses the `(1 - coefficient)` high-pass form, which is *not* the
/// [`pre_emphasis`] rule. `signal` is the already-normalized float signal; inputs are read as
/// their stored `f32` bit patterns and widened exactly to `f64`, reproducing the array reads
/// JavaScript performs after its `Float32Array` allocation.
///
/// An empty input returns an empty vector, matching the baseline's `if (signal.length)` guard.
/// `coefficient` is used exactly as supplied, including nonfinite values.
pub fn emphasize_float(signal: &[f32], coefficient: f64) -> Vec<f32> {
    let mut out = vec![0.0f32; signal.len()];
    if signal.is_empty() {
        return out;
    }
    // Baseline: out[0] = signal[0] * (1 - coefficient)
    out[0] = ((signal[0] as f64) * (1.0 - coefficient)) as f32;
    for i in 1..signal.len() {
        out[i] = ((signal[i] as f64) - coefficient * (signal[i - 1] as f64)) as f32;
    }
    out
}
