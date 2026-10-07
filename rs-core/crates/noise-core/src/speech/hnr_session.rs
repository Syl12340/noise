//! Owned continuous-segment HNR; every step commits one baseline frame.
use super::{
    fractional::WorkBudget,
    harmonicity::{self, HarmonicityOptions, HnrResult, HnrRow, HnrTimeline, PitchEvidence},
};
pub const MAX_PITCH_ROWS: usize = 4096;
pub const MAX_FRAMES: usize = 4096;
pub const FRAME_PAIR_BUDGET: u64 = 150_000_000;
pub struct HnrSession {
    signal: Vec<f32>,
    input_len: usize,
    pitch: Vec<PitchEvidence>,
    fs: f64,
    opts: HarmonicityOptions,
    pitch_index: usize,
    total_frames: usize,
    completed: usize,
    rows: Vec<HnrRow>,
    signal_frames: usize,
    capped_frames: usize,
    failed: Option<&'static str>,
    cached: Option<HnrResult>,
}
pub struct FrameReceipt {
    pub index: usize,
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    pub row: HnrRow,
}
impl HnrSession {
    pub fn new(
        signal: Vec<f32>,
        fs: f64,
        opts: HarmonicityOptions,
        pitch: Vec<PitchEvidence>,
    ) -> Result<Self, &'static str> {
        harmonicity::validate(&signal, fs, &opts, &pitch)?;
        let frames = if signal.len() < opts.frame_size {
            0
        } else {
            (signal.len() - opts.frame_size) / opts.hop + 1
        };
        if frames > MAX_FRAMES || pitch.len() > MAX_PITCH_ROWS {
            return Err("session capacity exceeded");
        }
        Ok(Self {
            input_len: signal.len(),
            signal,
            pitch,
            fs,
            opts,
            pitch_index: 0,
            total_frames: frames,
            completed: 0,
            rows: Vec::with_capacity(frames),
            signal_frames: 0,
            capped_frames: 0,
            failed: None,
            cached: None,
        })
    }
    pub fn total_frames(&self) -> usize {
        self.total_frames
    }
    pub fn input_len(&self) -> usize {
        self.input_len
    }
    pub fn sample_rate(&self) -> f64 {
        self.fs
    }
    pub fn options(&self) -> HarmonicityOptions {
        self.opts
    }
    pub fn finished_result(&self) -> Option<&HnrResult> {
        self.cached.as_ref()
    }
    pub fn completed_frames(&self) -> usize {
        self.completed
    }
    pub fn done(&self) -> bool {
        self.failed.is_none() && self.completed == self.total_frames
    }
    pub fn next(
        &mut self,
        sin: &impl Fn(f64) -> f64,
    ) -> Result<Option<FrameReceipt>, &'static str> {
        self.next_with_budget(sin, FRAME_PAIR_BUDGET)
    }
    fn next_with_budget(
        &mut self,
        sin: &impl Fn(f64) -> f64,
        limit: u64,
    ) -> Result<Option<FrameReceipt>, &'static str> {
        if let Some(reason) = self.failed {
            return Err(reason);
        }
        if self.done() {
            return Ok(None);
        }
        let start = self
            .completed
            .checked_mul(self.opts.hop)
            .ok_or("invalid HNR frame cursor")?;
        let frame = &self.signal[start..start + self.opts.frame_size];
        let mut timeline = HnrTimeline {
            sample_offset: start,
            pitch_index: self.pitch_index,
        };
        let mut budget = WorkBudget::new(limit);
        let result = harmonicity::estimate_harmonicity_at(
            frame,
            self.fs,
            &self.opts,
            &self.pitch,
            sin,
            &mut budget,
            None,
            &mut timeline,
        );
        let mut result = match result {
            Ok(r) => r,
            Err(reason) => {
                self.failed = Some(reason);
                self.signal = Vec::new();
                self.pitch = Vec::new();
                return Err(reason);
            }
        };
        if result.track.len() != 1 {
            self.failed = Some("invalid HNR frame result");
            return Err("invalid HNR frame result");
        }
        let row = result.track.pop().unwrap();
        let index = self.completed;
        self.pitch_index = timeline.pitch_index;
        self.signal_frames += result.signal_frames;
        self.capped_frames += result.capped_frames;
        self.rows.push(row);
        self.completed += 1;
        Ok(Some(FrameReceipt {
            index,
            completed: self.completed,
            total: self.total_frames,
            done: self.done(),
            row,
        }))
    }
    pub fn finish(&mut self) -> Result<&HnrResult, &'static str> {
        if let Some(reason) = self.failed {
            return Err(reason);
        }
        if !self.done() {
            return Err("session incomplete");
        }
        if self.cached.is_none() {
            let summary =
                harmonicity::summarize_harmonicity(&self.rows, self.opts.hop as f64 / self.fs, 0.1);
            self.cached = Some(HnrResult {
                track: std::mem::take(&mut self.rows),
                signal_frames: self.signal_frames,
                capped_frames: self.capped_frames,
                correlation_method: harmonicity::CORRELATION_METHOD,
                interpolation_half_samples: 64,
                summary,
            });
            self.signal = Vec::new();
            self.pitch = Vec::new();
        }
        Ok(self.cached.as_ref().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_frame_never_commits_or_replays_and_cannot_finish() {
        let mut signal = vec![0.0; 2048];
        for (i, x) in signal[1024..].iter_mut().enumerate() {
            *x = if i % 2 == 0 { 0.2 } else { -0.2 };
        }
        let opts = HarmonicityOptions {
            hop: 1024,
            ..Default::default()
        };
        let mut s = HnrSession::new(signal, 12000.0, opts, vec![]).unwrap();
        assert_eq!(
            s.next_with_budget(&f64::sin, 0)
                .unwrap()
                .unwrap()
                .row
                .reason,
            Some("low-energy")
        );
        assert_eq!(s.completed_frames(), 1);
        assert!(matches!(
            s.next_with_budget(&f64::sin, 0),
            Err("work budget exceeded")
        ));
        assert_eq!(s.completed_frames(), 1);
        assert!(!s.done());
        assert!(matches!(
            s.next(&|_| panic!("must not replay")),
            Err("work budget exceeded")
        ));
        assert!(matches!(s.finish(), Err("work budget exceeded")));
    }
    #[test]
    fn incomplete_finish_and_empty_recording_have_distinct_results() {
        let mut s = HnrSession::new(vec![0.0; 2504], 12000.0, Default::default(), vec![]).unwrap();
        assert!(matches!(s.finish(), Err("session incomplete")));
        let mut empty = HnrSession::new(vec![], 12000.0, Default::default(), vec![]).unwrap();
        assert!(empty.done());
        assert!(empty.next(&|_| panic!("empty")).unwrap().is_none());
        assert_eq!(empty.finish().unwrap().summary.avg_hnr, None);
    }
}
