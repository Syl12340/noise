//! PCM audio quality inspection and clipping/silence detection.
//!
//! Mirrors `utils/audio-quality.js` (inspectPcm / PcmQualityInspector).
//! Sliding 10 ms evidence window survives callback boundaries.

/// A recorded interval of clipping in seconds [start, end].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClippedInterval {
    pub start: f64,
    pub end: f64,
}

/// Clipping evidence collected across the inspection session.
#[derive(Debug, Clone)]
pub struct ClippingEvidence {
    pub window_seconds: f64,
    pub rail_limit: u32,
    pub max_rails: u32,
    pub max_consecutive_rail_samples: u32,
    pub intervals: Vec<ClippedInterval>,
}

/// Evidence result returned from `PcmQualityInspector::process`.
#[derive(Debug, Clone)]
pub struct QualityEvidence {
    pub clipped: bool,
    pub plateau_suspected: bool,
    pub clipping_evidence: ClippingEvidence,
}

/// Sliding-window PCM quality inspector preserving state across chunks.
#[derive(Debug, Clone)]
pub struct PcmQualityInspector {
    pub sample_rate: u32,
    pub window_samples: usize,
    pub rail_limit: u32,
    pub rail_window: Vec<u8>,
    pub position: usize,
    pub rails: u32,
    pub samples: u64,
    pub max_rails: u32,
    pub rail_run: u32,
    pub max_rail_run: u32,
    pub clipped_intervals: Vec<ClippedInterval>,
    pub previous: Option<i16>,
    pub run: u32,
    pub run_start: Option<i16>,
    pub plateau_suspected: bool,
    pub clipped: bool,
}

impl PcmQualityInspector {
    /// Creates a new inspector for the specified sample rate (default 44100).
    pub fn new(sample_rate: u32) -> Self {
        let window_samples = (sample_rate as f64 * 0.01).round().max(1.0) as usize; // 441
        let rail_limit = ((window_samples as f64 * 0.001).ceil() as u32).max(2); // 2
        Self {
            sample_rate,
            window_samples,
            rail_limit,
            rail_window: vec![0; window_samples],
            position: 0,
            rails: 0,
            samples: 0,
            max_rails: 0,
            rail_run: 0,
            max_rail_run: 0,
            clipped_intervals: Vec::new(),
            previous: None,
            run: 0,
            run_start: None,
            plateau_suspected: false,
            clipped: false,
        }
    }

    /// Feeds PCM samples into the inspector, updating sliding window and rail metrics.
    pub fn process(&mut self, pcm: &[i16]) -> QualityEvidence {
        for &sample in pcm {
            let rail: u8 = if sample == i16::MAX || sample == i16::MIN {
                1
            } else {
                0
            };

            let old_rail = self.rail_window[self.position] as u32;
            self.rails = (self.rails + rail as u32) - old_rail;
            self.rail_window[self.position] = rail;
            self.position = (self.position + 1) % self.window_samples;
            self.samples += 1;

            self.rail_run = if rail == 1 { self.rail_run + 1 } else { 0 };
            self.max_rails = self.max_rails.max(self.rails);
            self.max_rail_run = self.max_rail_run.max(self.rail_run);

            if self.rails >= self.rail_limit {
                self.clipped = true;
                let start = (self.samples.saturating_sub(self.window_samples as u64) as f64)
                    / (self.sample_rate as f64);
                let end = (self.samples as f64) / (self.sample_rate as f64);

                if let Some(last) = self.clipped_intervals.last_mut() {
                    if start <= last.end {
                        last.end = end;
                    } else {
                        self.clipped_intervals.push(ClippedInterval { start, end });
                    }
                } else {
                    self.clipped_intervals.push(ClippedInterval { start, end });
                }
            }

            if Some(sample) == self.previous {
                self.run += 1;
            } else {
                // Require actual approach and departure, excluding constant DC
                if self.run >= 8 && self.previous.is_some_and(|p| (p as i32).abs() > 1024) {
                    if let (Some(prev), Some(r_start)) = (self.previous, self.run_start) {
                        let prev_i = prev as i64;
                        let r_start_i = r_start as i64;
                        let cur_i = sample as i64;
                        if (prev_i - r_start_i) * (prev_i - cur_i) > 0 {
                            self.plateau_suspected = true;
                        }
                    }
                }
                self.run_start = self.previous;
                self.run = 1;
            }
            self.previous = Some(sample);
        }

        QualityEvidence {
            clipped: self.clipped,
            plateau_suspected: self.plateau_suspected,
            clipping_evidence: ClippingEvidence {
                window_seconds: (self.window_samples as f64) / (self.sample_rate as f64),
                rail_limit: self.rail_limit,
                max_rails: self.max_rails,
                max_consecutive_rail_samples: self.max_rail_run,
                intervals: self.clipped_intervals.clone(),
            },
        }
    }
}

/// Inspection report for a single input chunk.
#[derive(Debug, Clone)]
pub struct PcmQualityReport {
    pub clipped_samples: usize,
    pub near_full_scale_samples: usize,
    pub near_full_scale: bool,
    pub peak_abs: u32,
    pub digital_silence: bool,
    pub no_ac_signal: bool,
    pub plateau_suspected: bool,
    pub clipped: bool,
    pub evidence: QualityEvidence,
}

/// Inspects a chunk of PCM samples using the provided quality inspector.
pub fn inspect_pcm(pcm: &[i16], inspector: &mut PcmQualityInspector) -> PcmQualityReport {
    let mut clipped_samples = 0;
    let mut near_full_scale_samples = 0;
    let mut peak_abs: u32 = 0;
    let mut min: i16 = 32767;
    let mut max: i16 = -32768;

    for &sample in pcm {
        if sample == i16::MAX || sample == i16::MIN {
            clipped_samples += 1;
        }
        let abs = (sample as i32).unsigned_abs();
        if abs >= 32112 {
            near_full_scale_samples += 1;
        }
        if abs > peak_abs {
            peak_abs = abs;
        }
        if sample < min {
            min = sample;
        }
        if sample > max {
            max = sample;
        }
    }

    let evidence = inspector.process(pcm);
    let near_full_scale = near_full_scale_samples > 0;
    let no_ac_signal = pcm.len() > 1 && ((max as i32) - (min as i32) <= 2);
    let digital_silence = !pcm.is_empty() && (peak_abs <= 1 || no_ac_signal);

    PcmQualityReport {
        clipped_samples,
        near_full_scale_samples,
        near_full_scale,
        peak_abs,
        digital_silence,
        no_ac_signal,
        plateau_suspected: evidence.plateau_suspected,
        clipped: evidence.clipped,
        evidence,
    }
}

/// Centers the signal across a single block by removing the block mean.
/// Used for non-continuous or block-level offline analysis.
pub fn centered_signal(pcm: &[i16]) -> Vec<f32> {
    if pcm.is_empty() {
        return Vec::new();
    }
    let mut sum = 0.0f64;
    for &sample in pcm {
        sum += sample as f64;
    }
    let mean = sum / (pcm.len() as f64);
    let mut signal = Vec::with_capacity(pcm.len());
    for &sample in pcm {
        signal.push(((sample as f64 - mean) / 32768.0) as f32);
    }
    signal
}
