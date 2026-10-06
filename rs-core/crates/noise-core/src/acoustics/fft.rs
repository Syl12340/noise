//! 32768-point Cooley-Tukey FFT and Hann windowing.
//!
//! Mirrors `fftInPlace`, `applyHannWindow`, and `computeSpectrum` in `utils/fft.js`.
//! Rotation factors and Hann coefficients are loaded directly from coefficient tables.

use super::coefficients::FftRotation;

pub const FFT_SIZE: usize = 32768;
pub const FFT_BIN_COUNT: usize = 16384;
pub const FFT_SAMPLE_RATE: u32 = 44100;
pub const FFT_HOP_SIZE: usize = 8192;

/// In-place Radix-2 Cooley-Tukey FFT (Decimation-in-Time).
///
/// Uses precomputed rotation factors per stage to eliminate trigonometric drift.
pub fn fft_in_place(re: &mut [f64], im: &mut [f64], rotations: &[FftRotation; 15]) {
    let n = re.len();
    assert_eq!(n, FFT_SIZE);
    assert_eq!(im.len(), FFT_SIZE);

    // 1. Bit-Reversal Permutation
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;

        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    // 2. Butterfly Operations
    let mut stage = 0usize;
    let mut len = 2usize;
    while len <= n {
        let half_len = len >> 1;
        let rot = &rotations[stage];
        let w_re = rot.cos;
        let w_im = rot.sin;

        let mut i = 0usize;
        while i < n {
            let mut cur_re = 1.0f64;
            let mut cur_im = 0.0f64;

            for k in 0..half_len {
                let t_re = cur_re * re[i + k + half_len] - cur_im * im[i + k + half_len];
                let t_im = cur_re * im[i + k + half_len] + cur_im * re[i + k + half_len];

                re[i + k + half_len] = re[i + k] - t_re;
                im[i + k + half_len] = im[i + k] - t_im;
                re[i + k] += t_re;
                im[i + k] += t_im;

                let new_cur_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = new_cur_re;
            }
            i += len;
        }
        stage += 1;
        len <<= 1;
    }
}

/// Applies Hann window to PCM samples and normalizes to [-1, 1].
pub fn apply_hann_window(pcm: &[f64], out: &mut [f64], hann: &[f64]) {
    assert_eq!(pcm.len(), FFT_SIZE);
    assert_eq!(out.len(), FFT_SIZE);
    assert_eq!(hann.len(), FFT_SIZE);

    for i in 0..FFT_SIZE {
        out[i] = (pcm[i] / 32768.0) * hann[i];
    }
}

/// Result of computing power spectrum and dB SPL bins.
#[derive(Debug, Clone, PartialEq)]
pub struct SpectrumResult {
    /// Raw un-floored single-sided mean-square contributions.
    pub raw_powers: Vec<f64>,
    /// Floored linear bins (clamped at 1e-24 floor).
    pub linear_bins: Vec<f64>,
    /// dB SPL spectrum values per bin.
    pub spectrum_db: Vec<f64>,
}

/// Computes the single-sided power spectrum with both raw and floored powers.
pub fn compute_spectrum_full(
    pcm: &[f64],
    offset: f64,
    hann: &[f64],
    rotations: &[FftRotation; 15],
) -> SpectrumResult {
    let mut re = vec![0.0f64; FFT_SIZE];
    let mut im = vec![0.0f64; FFT_SIZE];

    apply_hann_window(pcm, &mut re, hann);
    // im is already zeroed

    fft_in_place(&mut re, &mut im, rotations);

    let mut window_energy = 0.0f64;
    for &h in hann {
        window_energy += h * h;
    }

    let n = FFT_SIZE as f64;
    let denom = n * window_energy;

    let mut raw_powers = Vec::with_capacity(FFT_BIN_COUNT);
    let mut linear_bins = Vec::with_capacity(FFT_BIN_COUNT);
    let mut spectrum_db = Vec::with_capacity(FFT_BIN_COUNT);

    for k in 0..FFT_BIN_COUNT {
        let fft_power = re[k] * re[k] + im[k] * im[k];
        let one_sided_factor = if k == 0 { 1.0f64 } else { 2.0f64 };
        let mean_square_contribution = (one_sided_factor * fft_power) / denom;
        raw_powers.push(mean_square_contribution);

        let clamped = if mean_square_contribution < 1e-24 {
            1e-24
        } else {
            mean_square_contribution
        };
        linear_bins.push(clamped);

        let db = 10.0 * clamped.log10() + offset;
        spectrum_db.push(db);
    }

    SpectrumResult {
        raw_powers,
        linear_bins,
        spectrum_db,
    }
}

/// Computes the single-sided power spectrum and dB SPL values.
///
/// Returns `(linear_bins, spectrum_db)`.
pub fn compute_spectrum(
    pcm: &[f64],
    offset: f64,
    hann: &[f64],
    rotations: &[FftRotation; 15],
) -> (Vec<f64>, Vec<f64>) {
    let res = compute_spectrum_full(pcm, offset, hann, rotations);
    (res.raw_powers, res.spectrum_db)
}
