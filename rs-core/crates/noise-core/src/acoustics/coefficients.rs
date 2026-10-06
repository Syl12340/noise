//! Acoustic coefficients loader for Phase 1.
//!
//! Loads and decodes pre-exported little-endian coefficient tables directly from
//! `coefficients/noise-44100-v1/`, ensuring exact bitwise parity with the JavaScript baseline
//! and avoiding runtime trigonometric/exponential drift.

/// A-weighting filter coefficients decoded from `a_weighting.f64le`.
#[derive(Debug, Clone)]
pub struct AWeightingCoeffs {
    pub b1: [f64; 3],
    pub a1: [f64; 3],
    pub b2: [f64; 3],
    pub a2: [f64; 3],
    pub gain: f64,
    pub fir: [f64; 129],
}

/// 1/3-octave band bin range (start_bin, end_bin).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BandBinRange {
    pub start_bin: u32,
    pub end_bin: u32,
}

/// FFT stage rotation factor (cos(angle), sin(angle)).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FftRotation {
    pub cos: f64,
    pub sin: f64,
}

/// All loaded coefficient tables for 44.1 kHz acoustic processing.
#[derive(Debug, Clone)]
pub struct AcousticCoefficients {
    pub a_weighting: AWeightingCoeffs,
    pub dc_pole: f64,
    pub hann_window: Vec<f64>,
    pub fft_rotations: [FftRotation; 15],
    pub band_ranges: [BandBinRange; 29],
}

const RAW_A_WEIGHTING: &[u8] =
    include_bytes!("../../../../coefficients/noise-44100-v1/a_weighting.f64le");
const RAW_DC_POLE: &[u8] = include_bytes!("../../../../coefficients/noise-44100-v1/dc_pole.f64le");
const RAW_HANN: &[u8] = include_bytes!("../../../../coefficients/noise-44100-v1/hann.f64le");
const RAW_FFT_ROTATIONS: &[u8] =
    include_bytes!("../../../../coefficients/noise-44100-v1/fft_rotations.f64le");
const RAW_BAND_RANGES: &[u8] =
    include_bytes!("../../../../coefficients/noise-44100-v1/band_ranges.u32le");

fn read_f64_le(bytes: &[u8], offset: usize) -> f64 {
    let slice: [u8; 8] = bytes[offset..offset + 8]
        .try_into()
        .expect("slice with incorrect length for f64");
    f64::from_le_bytes(slice)
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let slice: [u8; 4] = bytes[offset..offset + 4]
        .try_into()
        .expect("slice with incorrect length for u32");
    u32::from_le_bytes(slice)
}

impl AcousticCoefficients {
    /// Decodes all coefficient tables from the embedded binary byte buffers.
    pub fn load() -> Self {
        assert_eq!(
            RAW_A_WEIGHTING.len(),
            1136,
            "a_weighting.f64le must be 1136 bytes"
        );
        assert_eq!(RAW_DC_POLE.len(), 8, "dc_pole.f64le must be 8 bytes");
        assert_eq!(RAW_HANN.len(), 262144, "hann.f64le must be 262144 bytes");
        assert_eq!(
            RAW_FFT_ROTATIONS.len(),
            240,
            "fft_rotations.f64le must be 240 bytes"
        );
        assert_eq!(
            RAW_BAND_RANGES.len(),
            232,
            "band_ranges.u32le must be 232 bytes"
        );

        // 1. A-weighting: b1[3], a1[3], b2[3], a2[3], gain, fir[129]
        let mut offset = 0;
        let mut b1 = [0.0; 3];
        for v in &mut b1 {
            *v = read_f64_le(RAW_A_WEIGHTING, offset);
            offset += 8;
        }
        let mut a1 = [0.0; 3];
        for v in &mut a1 {
            *v = read_f64_le(RAW_A_WEIGHTING, offset);
            offset += 8;
        }
        let mut b2 = [0.0; 3];
        for v in &mut b2 {
            *v = read_f64_le(RAW_A_WEIGHTING, offset);
            offset += 8;
        }
        let mut a2 = [0.0; 3];
        for v in &mut a2 {
            *v = read_f64_le(RAW_A_WEIGHTING, offset);
            offset += 8;
        }
        let gain = read_f64_le(RAW_A_WEIGHTING, offset);
        offset += 8;

        let mut fir = [0.0; 129];
        for v in &mut fir {
            *v = read_f64_le(RAW_A_WEIGHTING, offset);
            offset += 8;
        }
        assert_eq!(offset, 1136);

        let a_weighting = AWeightingCoeffs {
            b1,
            a1,
            b2,
            a2,
            gain,
            fir,
        };

        // 2. DC pole (1 f64)
        let dc_pole = read_f64_le(RAW_DC_POLE, 0);

        // 3. Hann window (32768 f64)
        let mut hann_window = Vec::with_capacity(32768);
        for i in 0..32768 {
            hann_window.push(read_f64_le(RAW_HANN, i * 8));
        }

        // 4. FFT rotations (15 stages of cos, sin)
        let mut fft_rotations = [FftRotation { cos: 0.0, sin: 0.0 }; 15];
        for i in 0..15 {
            let cos = read_f64_le(RAW_FFT_ROTATIONS, i * 16);
            let sin = read_f64_le(RAW_FFT_ROTATIONS, i * 16 + 8);
            fft_rotations[i] = FftRotation { cos, sin };
        }

        // 5. 1/3-octave band ranges (29 ranges of start_bin, end_bin)
        let mut band_ranges = [BandBinRange {
            start_bin: 0,
            end_bin: 0,
        }; 29];
        for i in 0..29 {
            let start_bin = read_u32_le(RAW_BAND_RANGES, i * 8);
            let end_bin = read_u32_le(RAW_BAND_RANGES, i * 8 + 4);
            band_ranges[i] = BandBinRange { start_bin, end_bin };
        }

        Self {
            a_weighting,
            dc_pole,
            hann_window,
            fft_rotations,
            band_ranges,
        }
    }
}
