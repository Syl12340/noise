//! Acoustic mathematical calculations.
//!
//! Mirrors `calculateRMS`, `calculateDb`, `calculateLeqFromEnergy`, and `calculateCNEFromLeq`
//! in `utils/audio-math.js`.

/// Reference exposure time in seconds (8 hours = 28800 s).
pub const REFERENCE_EXPOSURE_SECONDS: f64 = 28800.0;

/// Calculates Root-Mean-Square (RMS) amplitude from a slice of audio samples.
pub fn calculate_rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return f64::NAN;
    }
    let mut sum_squares = 0.0f64;
    for &sample in samples {
        let s = sample as f64;
        sum_squares += s * s;
    }
    (sum_squares / (samples.len() as f64)).sqrt()
}

/// Converts linear RMS amplitude to decibels (dB).
///
/// Preserves JavaScript NaN propagation semantics.
pub fn calculate_db(rms: f64, reference: f64) -> f64 {
    if rms.is_nan() {
        return f64::NAN;
    }
    let ref_val = if reference > 0.0 { reference } else { 32768.0 };
    let clamped_rms = if rms < 1e-12 { 1e-12 } else { rms };
    20.0 * (clamped_rms / ref_val).log10()
}

/// Calculates equivalent continuous sound level (Leq) from cumulative normalized energy.
///
/// Returns 0.0 if energy is non-finite, negative, or sample count is zero (matching JS).
pub fn calculate_leq_from_energy(
    total_squared_amplitude: f64,
    total_sample_count: u64,
    offset: f64,
) -> f64 {
    if !total_squared_amplitude.is_finite()
        || total_squared_amplitude < 0.0
        || total_sample_count == 0
    {
        return 0.0;
    }

    let mean_square = total_squared_amplitude / (total_sample_count as f64);
    let clamped_mean = if mean_square < 1e-24 {
        1e-24
    } else {
        mean_square
    };
    10.0 * clamped_mean.log10() + offset
}

/// Calculates Cumulative Noise Exposure (CNE) from Leq and exposure time term.
pub fn calculate_cne_from_leq(leq: f64, time_term: f64) -> f64 {
    leq + time_term
}

/// Calculates time term `10 * log10(T / T0)` where T0 = 28800 s.
pub fn calculate_time_term(expected_exposure_seconds: f64) -> f64 {
    10.0 * (expected_exposure_seconds / REFERENCE_EXPOSURE_SECONDS).log10()
}
