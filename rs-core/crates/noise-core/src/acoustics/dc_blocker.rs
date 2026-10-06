//! Continuous DC Blocker (2 Hz highpass filter).
//!
//! Preserves filter state across chunk boundaries to avoid transient steps.
//! Matches `DCBlocker` in `utils/audio-quality.js`.

/// 2 Hz highpass DC blocker filter maintaining cross-chunk state.
#[derive(Debug, Clone)]
pub struct DCBlocker {
    pub pole: f64,
    pub previous_input: f64,
    pub previous_output: f64,
    pub initialized: bool,
}

impl DCBlocker {
    /// Creates a new DC Blocker with the specified pole (from coefficient table).
    pub fn new(pole: f64) -> Self {
        Self {
            pole,
            previous_input: 0.0,
            previous_output: 0.0,
            initialized: false,
        }
    }

    /// Resets the DC Blocker state to uninitialized.
    pub fn reset(&mut self) {
        self.previous_input = 0.0;
        self.previous_output = 0.0;
        self.initialized = false;
    }

    /// Processes a slice of Int16 PCM samples.
    ///
    /// Internal states and intermediate arithmetic are in f64.
    /// Outputs normalized f32 samples to match the Float32Array baseline.
    pub fn process(&mut self, pcm: &[i16]) -> Vec<f32> {
        let mut output = Vec::with_capacity(pcm.len());
        for &sample in pcm {
            let x = (sample as f64) / 32768.0;
            if !self.initialized {
                self.previous_input = x;
                self.initialized = true;
            }
            let y = ((1.0 + self.pole) / 2.0) * (x - self.previous_input)
                + self.pole * self.previous_output;
            output.push(y as f32);
            self.previous_input = x;
            self.previous_output = y;
        }
        output
    }
}
