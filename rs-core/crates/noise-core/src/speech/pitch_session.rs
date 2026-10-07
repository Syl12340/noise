//! One complete YIN frame per call, using the existing ordered arithmetic.
use super::yin::{PitchPoint, yin_pitch_frame};
pub const MAX_INPUT: usize = 262144;
pub const MAX_FRAME: usize = 4096;
pub const MAX_ROWS: usize = 4096;
pub const PAIR_BUDGET: u64 = 150_000_000;
#[derive(Clone, Copy, Debug)]
pub struct PitchOptions {
    pub fs: f64,
    pub frame_size: usize,
    pub hop: usize,
    pub threshold: f64,
    pub fmin: f64,
    pub fmax: f64,
}
impl Default for PitchOptions {
    fn default() -> Self {
        Self {
            fs: 12000.0,
            frame_size: 1024,
            hop: 120,
            threshold: 0.1,
            fmin: 40.0,
            fmax: 1200.0,
        }
    }
}
pub struct PitchReceipt {
    pub index: usize,
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    pub row: PitchPoint,
}
pub struct PitchSession {
    signal: Vec<f32>,
    opts: PitchOptions,
    total: usize,
    completed: usize,
    rows: Vec<PitchPoint>,
    cached: Option<Vec<PitchPoint>>,
}
impl PitchSession {
    pub fn new(signal: Vec<f32>, opts: PitchOptions) -> Result<Self, &'static str> {
        if signal.len() > MAX_INPUT || opts.frame_size > MAX_FRAME {
            return Err("pitch capacity exceeded");
        }
        if opts.fs <= 0.0
            || opts.frame_size == 0
            || opts.hop == 0
            || ![opts.fs, opts.threshold, opts.fmin, opts.fmax]
                .iter()
                .all(|v| v.is_finite())
            || !signal.iter().all(|v| v.is_finite())
        {
            return Err("invalid pitch session input");
        }
        let total = if signal.len() < opts.frame_size {
            0
        } else {
            (signal.len() - opts.frame_size) / opts.hop + 1
        };
        let half = (opts.frame_size / 2) as u64;
        if total > MAX_ROWS || total as u64 * half * half.saturating_sub(1) > PAIR_BUDGET {
            return Err("pitch capacity exceeded");
        }
        Ok(Self {
            signal,
            opts,
            total,
            completed: 0,
            rows: Vec::with_capacity(total),
            cached: None,
        })
    }
    pub fn total_frames(&self) -> usize {
        self.total
    }
    pub fn completed_frames(&self) -> usize {
        self.completed
    }
    pub fn done(&self) -> bool {
        self.completed == self.total
    }
    pub fn step_frame(&mut self) -> Option<PitchReceipt> {
        if self.done() {
            return None;
        }
        // Admission proves this bounded complete frame lies inside the immutable input.
        let start = self.completed * self.opts.hop;
        let frame: Vec<f64> = self.signal[start..start + self.opts.frame_size]
            .iter()
            .map(|&v| v as f64)
            .collect();
        let row = PitchPoint {
            time: (start as f64 + self.opts.frame_size as f64 / 2.0) / self.opts.fs,
            frame: yin_pitch_frame(
                &frame,
                self.opts.fs,
                self.opts.threshold,
                self.opts.fmin,
                self.opts.fmax,
            ),
        };
        let index = self.completed;
        self.rows.push(row);
        self.completed += 1;
        Some(PitchReceipt {
            index,
            completed: self.completed,
            total: self.total,
            done: self.done(),
            row,
        })
    }
    pub fn finish(&mut self) -> Result<&[PitchPoint], &'static str> {
        if !self.done() {
            return Err("pitch session incomplete");
        }
        if self.cached.is_none() {
            self.cached = Some(std::mem::take(&mut self.rows));
            self.signal = Vec::new();
        }
        Ok(self.cached.as_deref().unwrap())
    }
}
