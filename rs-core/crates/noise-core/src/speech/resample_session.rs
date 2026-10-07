//! Global-phase resampling from one immutable source, with atomic bounded batches.
use super::{
    resample::{self, ERR_MISSING_PHASE},
    resample_tables::{KernelBank, load_bank},
};
pub const MAX_BATCH: usize = 4096;
pub struct ResampleBatch {
    pub start: usize,
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    pub values: Vec<f32>,
}
pub struct ResampleSession {
    signal: Vec<f32>,
    bank: Option<KernelBank>,
    input: u32,
    output: u32,
    total: usize,
    completed: usize,
    last_start: usize,
    values: Vec<f32>,
    failed: Option<&'static str>,
}
impl ResampleSession {
    pub fn new(
        signal: Vec<f32>,
        input: u32,
        output: u32,
        cutoff: f64,
    ) -> Result<Self, &'static str> {
        let total = resample::validate(&signal, input, output, cutoff)?;
        let bank = if total == 0 {
            None
        } else {
            Some(load_bank(input, output, cutoff).ok_or(ERR_MISSING_PHASE)?)
        };
        Ok(Self {
            signal,
            bank,
            input,
            output,
            total,
            completed: 0,
            last_start: 0,
            values: Vec::with_capacity(total),
            failed: None,
        })
    }
    pub fn total(&self) -> usize {
        self.total
    }
    pub fn completed(&self) -> usize {
        self.completed
    }
    pub fn last_start(&self) -> usize {
        self.last_start
    }
    pub fn done(&self) -> bool {
        self.failed.is_none() && self.completed == self.total
    }
    pub fn failed(&self) -> Option<&'static str> {
        self.failed
    }
    pub fn step_batch(&mut self, limit: usize) -> Result<ResampleBatch, &'static str> {
        if let Some(reason) = self.failed {
            return Err(reason);
        }
        if limit == 0 || limit > MAX_BATCH {
            return Err("invalid resample batch size");
        }
        let start = self.completed;
        let end = (start + limit).min(self.total);
        let mut batch = Vec::with_capacity(end - start);
        for i in start..end {
            match resample::sample_at(
                &self.signal,
                self.input,
                self.output,
                i,
                self.bank.as_ref().unwrap(),
            ) {
                Ok(v) => batch.push(v),
                Err(reason) => {
                    self.failed = Some(reason);
                    self.signal = Vec::new();
                    self.bank = None;
                    return Err(reason);
                }
            }
        }
        self.values.extend_from_slice(&batch);
        self.last_start = start;
        self.completed = end;
        Ok(ResampleBatch {
            start,
            completed: end,
            total: self.total,
            done: self.done(),
            values: batch,
        })
    }
    pub fn finish(&mut self) -> Result<&[f32], &'static str> {
        if let Some(reason) = self.failed {
            return Err(reason);
        }
        if !self.done() {
            return Err("resample session incomplete");
        }
        self.signal = Vec::new();
        self.bank = None;
        Ok(&self.values)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_batch_never_commits_or_replays_and_cannot_finish() {
        let mut s = ResampleSession::new(vec![0.2; 1024], 16000, 12000, 5500.0).unwrap();
        s.step_batch(1).unwrap();
        let committed = s.values.clone();
        s.bank
            .as_mut()
            .unwrap()
            .kernels
            .retain(|(phase, _)| *phase != 666667);
        assert!(s.step_batch(2).is_err());
        assert_eq!(s.completed(), 1);
        assert_eq!(s.values, committed);
        assert!(!s.done());
        assert!(s.signal.is_empty());
        assert!(s.bank.is_none());
        assert!(s.step_batch(1).is_err());
        assert!(s.finish().is_err());
    }
}
