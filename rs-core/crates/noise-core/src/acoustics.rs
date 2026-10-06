//! Phase 1: Legacy Noise Acoustic Processing Pipeline.
//!
//! Direct port of baseline 3a0d676 noise monitoring pipeline:
//! - audio-quality: inspect_pcm, PcmQualityInspector, centered_signal, DCBlocker
//! - audio-math: calculate_rms, calculate_db, calculate_leq_from_energy, calculate_cne_from_leq, AWeightingFilter, integrate_filter_tail
//! - fft: 32768 Cooley-Tukey FFT in-place with Hann windowing
//! - canvas-spectrum: 29 1/3-octave band analysis
//! - NoiseEngine: synchronous session coordinator matching contract v1.

// Keep baseline indexed loops visibly ordered during the compatibility port.
#![allow(clippy::needless_range_loop)]

pub mod a_weighting;
pub mod coefficients;
pub mod dc_blocker;
pub mod engine;
pub mod fft;
pub mod math;
pub mod quality;
pub mod spectrum;

pub use a_weighting::{AWeightingFilter, FilterTailResult, integrate_filter_tail};
pub use coefficients::{AWeightingCoeffs, AcousticCoefficients, BandBinRange, FftRotation};
pub use dc_blocker::DCBlocker;
pub use engine::{
    AcousticEvent, DEFAULT_EVENT_CAPACITY, EngineState, FinalSummary, MAX_CHUNK_SAMPLES,
    NoiseEngine, ProcessError, ProcessReceipt, SILENCE_TERMINATION_LIMIT, SecondWindowRecord,
    SpectrumRecord, TerminationReason,
};
pub use fft::{
    FFT_BIN_COUNT, FFT_HOP_SIZE, FFT_SAMPLE_RATE, FFT_SIZE, apply_hann_window, compute_spectrum,
    fft_in_place,
};
pub use math::{
    REFERENCE_EXPOSURE_SECONDS, calculate_cne_from_leq, calculate_db, calculate_leq_from_energy,
    calculate_rms, calculate_time_term,
};
pub use quality::{
    ClippedInterval, ClippingEvidence, PcmQualityInspector, PcmQualityReport, QualityEvidence,
    centered_signal, inspect_pcm,
};
pub use spectrum::{THIRD_OCTAVE_CENTERS, compute_third_octave_bands};
