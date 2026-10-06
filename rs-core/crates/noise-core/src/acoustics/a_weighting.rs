//! A-Weighting Filter and Filter Tail integration.
//!
//! Cascaded Biquad 1 + Biquad 2 (Direct Form II Transposed) + 129-tap linear-phase FIR.
//! Matches `AWeightingFilter` and `integrateFilterTail` in `utils/audio-math.js`.

use super::coefficients::AWeightingCoeffs;

/// A-weighting filter preserving state across chunk boundaries.
#[derive(Debug, Clone)]
pub struct AWeightingFilter {
    pub b1: [f64; 3],
    pub a1: [f64; 3],
    pub z1: [f64; 2],
    pub b2: [f64; 3],
    pub a2: [f64; 3],
    pub z2: [f64; 2],
    pub gain: f64,
    pub fir: [f64; 129],
    pub history: [f64; 129],
    pub history_index: usize,
}

impl AWeightingFilter {
    /// Constructs an A-weighting filter from pre-decoded coefficient tables.
    pub fn new(coeffs: &AWeightingCoeffs) -> Self {
        Self {
            b1: coeffs.b1,
            a1: coeffs.a1,
            z1: [0.0; 2],
            b2: coeffs.b2,
            a2: coeffs.a2,
            z2: [0.0; 2],
            gain: coeffs.gain,
            fir: coeffs.fir,
            history: [0.0; 129],
            history_index: 0,
        }
    }

    /// Resets internal filter delay lines and history to zero.
    pub fn reset(&mut self) {
        self.z1 = [0.0; 2];
        self.z2 = [0.0; 2];
        self.history = [0.0; 129];
        self.history_index = 0;
    }

    /// Processes an input buffer of float samples (optionally normalizing from Int16).
    ///
    /// Intermediate arithmetic is computed strictly in f64.
    /// Outputs f32 samples to match the Float32Array baseline.
    pub fn process(&mut self, input_buffer: &[f32], normalize: bool) -> Vec<f32> {
        let len = input_buffer.len();
        let mut output = Vec::with_capacity(len);

        for &sample in input_buffer {
            // 1. Normalize if requested, then apply gain
            let mut x = if normalize {
                (sample as f64) / 32768.0
            } else {
                sample as f64
            };
            x *= self.gain;

            // 2. Cascaded Biquad 1 (Direct Form II Transposed)
            let y1 = self.b1[0] * x + self.z1[0];
            self.z1[0] = self.b1[1] * x - self.a1[1] * y1 + self.z1[1];
            self.z1[1] = self.b1[2] * x - self.a1[2] * y1;

            // 3. Cascaded Biquad 2
            let y2 = self.b2[0] * y1 + self.z2[0];
            self.z2[0] = self.b2[1] * y1 - self.a2[1] * y2 + self.z2[1];
            self.z2[1] = self.b2[2] * y1 - self.a2[2] * y2;

            // 4. Circular FIR convolution
            self.history[self.history_index] = y2;
            let mut value = 0.0f64;
            let mut index = self.history_index as isize;
            for tap in 0..129 {
                value += self.fir[tap] * self.history[index as usize];
                index -= 1;
                if index < 0 {
                    index = 128;
                }
            }
            self.history_index = (self.history_index + 1) % 129;
            output.push(value as f32);
        }

        output
    }
}

/// Result of integrating the filter tail upon session completion.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterTailResult {
    pub energy: f64,
    pub padding_samples: u64,
    pub converged: bool,
}

/// Zero-extended filter tail integration: flushes remaining energy out of the A-weighting filter.
///
/// Stops when 8 consecutive 256-sample blocks fall below `threshold = max(ref, 1e-24) * 1e-12`,
/// or when 2 seconds (88200 samples) have been flushed.
pub fn integrate_filter_tail(
    weighting: &mut AWeightingFilter,
    reference_energy: f64,
    sample_rate: u32,
) -> FilterTailResult {
    let zeros = [0.0f32; 256];
    let mut energy = 0.0f64;
    let mut samples: u64 = 0;
    let mut quiet_blocks: u32 = 0;
    let max_samples = 2 * (sample_rate as u64); // 88200
    let threshold = if reference_energy.is_nan() {
        f64::NAN
    } else {
        reference_energy.max(1e-24) * 1e-12
    };

    while samples < max_samples && quiet_blocks < 8 {
        let block_len = ((max_samples - samples) as usize).min(256);
        let output = weighting.process(&zeros[..block_len], false);
        let mut block_energy = 0.0f64;
        for &val in &output {
            let v = val as f64;
            block_energy += v * v;
        }
        energy += block_energy;
        samples += block_len as u64;
        if !threshold.is_nan() && block_energy <= threshold {
            quiet_blocks += 1;
        } else {
            quiet_blocks = 0;
        }
    }

    FilterTailResult {
        energy,
        padding_samples: samples,
        converged: quiet_blocks >= 8,
    }
}
