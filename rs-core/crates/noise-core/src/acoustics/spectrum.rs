//! 1/3-octave band analysis across 29 frequency bands.
//!
//! Mirrors `computeThirdOctaveBands` and `BAND_BIN_RANGES` in `utils/canvas-spectrum.js`.
//! Band ranges are pre-decoded from coefficient tables.

use super::coefficients::BandBinRange;

/// Standard 1/3-octave nominal center frequencies (25 Hz to 16 kHz, 29 bands).
pub const THIRD_OCTAVE_CENTERS: [f64; 29] = [
    25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0,
    630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0,
    10000.0, 12500.0, 16000.0,
];

/// Computes 1/3-octave band sound pressure levels from FFT dB SPL bins.
///
/// Converts each bin from dB SPL back to linear power, sums across the band's bin range,
/// and converts back to dB SPL with 1e-20 clamping floor.
/// Bands where `start_bin > end_bin` evaluate to `-Infinity`.
pub fn compute_third_octave_bands(
    spectrum_db: &[f64],
    band_ranges: &[BandBinRange; 29],
) -> Vec<f64> {
    let mut band_levels = Vec::with_capacity(29);

    for range in band_ranges {
        let start_bin = range.start_bin as usize;
        let end_bin = range.end_bin as usize;

        if start_bin > end_bin {
            // No bins in this band; does not borrow energy from neighbors
            band_levels.push(f64::NEG_INFINITY);
            continue;
        }

        let mut sum_power = 0.0f64;
        for k in start_bin..=end_bin {
            sum_power += 10.0f64.powf(spectrum_db[k] / 10.0);
        }

        let clamped_power = if sum_power < 1e-20 { 1e-20 } else { sum_power };
        band_levels.push(10.0 * clamped_power.log10());
    }

    band_levels
}
