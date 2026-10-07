//! Phase 2: Speech first batch — emphasis and YIN pitch tracking.
//!
//! Faithful numerical port of the frozen JavaScript baseline:
//! - `utils/phonetic/yin-pitch.js`      -> [`yin::yin_pitch_frame`], [`yin::pitch_track`], [`yin::iterate_pitch`]
//! - `utils/phonetic/pre-emphasis.js`   -> [`emphasis::pre_emphasis`]
//! - `utils/phonetic/resample.js`       -> [`emphasis::emphasize_float`] (emphasis only)
//!
//! Scope boundaries for this batch (see `phase2/INTERFACE_AND_PITCH_CONTRACT.md`):
//! - Phase3 adds frozen kernels for seven input rates ->12kHz, cutoff5500Hz.
//!   Other resampling profiles remain unsupported.
//! - HNR / harmonicity and formant extraction are out of scope.
//! - This is an experimental, opt-in compatibility port. It is not production integration
//!   and it performs no new scientific validation. Known upstream scientific limitations are
//!   reproduced faithfully rather than repaired.
//!
//! # Numeric contract
//!
//! `utils/phonetic/*.js` runs on JavaScript `Number`, i.e. IEEE-754 binary64, and stores
//! its arrays through `Float32Array`. Accordingly:
//! - all ordered arithmetic is performed in `f64`,
//! - every Float32Array store is modelled by an `as f32` cast and subsequent reads widen
//!   back exactly (the same lossless f32 -> f64 widening JavaScript performs),
//! - no fused multiply-add, no reassociation, no extra rounding, no compiler fast-math is
//!   permitted on the ported expressions.
//!
//! For valid finite input the intended equality is **exact bits**, not a tolerance:
//! Float32 stores must match bit-for-bit and Float64 outputs must match bit-for-bit.
//!
//! # Two distinct first-sample formulas
//!
//! The baseline uses two *different* first-sample rules that must not be unified:
//! - [`emphasis::pre_emphasis`] (`pre-emphasis.js`): `out[0] = pcm[0] / 32768.0`
//!   (no coefficient involved), and every later sample uses `x[n] - coeff * x[n-1]`
//!   with `x[k] = pcm[k] / 32768.0`.
//! - [`emphasis::emphasize_float`] (`resample.js`): `out[0] = signal[0] * (1 - coefficient)`,
//!   and every later sample uses `signal[n] - coefficient * signal[n-1]`.
//!
//! # Bounded API difference (documented, intentional)
//!
//! `yinPitchTrack` in JavaScript derives `frameSize`/`hopSize` from an options object and
//! will silently loop forever on a nonpositive `hopSize` (`start += 0`). The Rust API takes
//! `frame_size`/`hop` as explicit usize values and **rejects** invalid track
//! configuration up front with a static error string instead of hanging:
//! - `frame_size == 0` or `hop == 0` -> `Err("frame_size and hop must be positive")`
//! - `!fs.is_finite() || fs <= 0.0`  -> `Err("sample rate must be finite and positive")`
//! - `frame_size`/`hop` exceed 2^53 -> `Err("frame size and hop exceed addressable range")`.
//!   An overflowing next offset ends the iteration, as no more frames can fit.
//!
//! For valid finite sample rates and positive integral frame/hop sizes, [`yin::pitch_track`] must return the identical
//! frame count, identical `time` values and identical per-frame fields. Per-frame
//! `yinPitchFrame` validation (nonpositive rate, inverted range, short frame, silence) is
//! *not* re-implemented here — it stays inside [`yin::yin_pitch_frame`] so the returned
//! frame values remain byte-identical to the baseline.

// Keep baseline indexed loops visibly ordered during the compatibility port.
#![allow(clippy::needless_range_loop)]

pub mod emphasis;
#[cfg(feature = "harmonicity")]
pub mod fractional;
#[cfg(feature = "harmonicity")]
mod generic_fft;
#[cfg(feature = "harmonicity")]
pub mod harmonicity;
#[cfg(feature = "harmonicity")]
pub mod hnr_session;
#[cfg(feature = "harmonicity")]
mod hnr_tables;
pub mod pitch_session;
pub mod resample;
pub mod resample_session;
mod resample_tables;
#[cfg(feature = "harmonicity")]
pub mod segments;
pub mod time_support;
pub mod yin;

pub use emphasis::{emphasize_float, pre_emphasis};
pub use resample::resample_low_pass;
pub use yin::{PitchFrame, PitchPoint, iterate_pitch, pitch_track, yin_pitch_frame};
