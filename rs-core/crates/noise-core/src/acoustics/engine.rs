//! NoiseEngine synchronous processing engine and session state machine.
//!
//! Owns session state, DC blocker, A-weighting filter, quality inspector,
//! energy accumulators, ring buffer, and bounded event queue.
//!
//! Follows the contract specified in `phase1/PORT_CONTRACT.md`.

use std::collections::VecDeque;

use super::a_weighting::{AWeightingFilter, FilterTailResult, integrate_filter_tail};
use super::coefficients::AcousticCoefficients;
use super::dc_blocker::DCBlocker;
use super::fft::{FFT_HOP_SIZE, FFT_SIZE, compute_spectrum};
use super::math::{calculate_db, calculate_leq_from_energy, calculate_rms};
use super::quality::{ClippedInterval, PcmQualityInspector, inspect_pcm};
use super::spectrum::compute_third_octave_bands;

pub const DEFAULT_EVENT_CAPACITY: usize = 128;
pub const MAX_CHUNK_SAMPLES: usize = 262144;
pub const SILENCE_TERMINATION_LIMIT: u64 = 2205; // 50 ms at 44.1 kHz

/// Termination reason for a session.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminationReason {
    Clipped,
    DigitalSilence,
    HardInvalid(String),
    NormalFinished,
    InvalidFinished,
}

impl TerminationReason {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Clipped => "clipped",
            Self::DigitalSilence => "digital_silence",
            Self::HardInvalid(s) => s.as_str(),
            Self::NormalFinished => "normal_finished",
            Self::InvalidFinished => "invalid_finished",
        }
    }
}

/// Lifecycle state of the `NoiseEngine`.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineState {
    Active,
    Terminated(TerminationReason),
}

/// Receipt emitted after attempting to process a chunk.
#[derive(Debug, Clone, PartialEq)]
pub enum ProcessReceipt {
    Committed {
        seq: u32,
        samples: usize,
        clipped: bool,
        digital_silence: bool,
        chunk_rms: f64,
        chunk_dbfs: f64,
        chunk_dbspl: f64,
    },
    TerminatedQOnly {
        seq: u32,
        reason: String,
        samples: usize,
        clipped: bool,
        digital_silence: bool,
    },
    IgnoredEmpty,
    IgnoredAfterTermination,
}

/// Error returned when chunk cannot be accepted.
#[derive(Debug, Clone, PartialEq)]
pub enum ProcessError {
    InvalidSequence { expected: u32, actual: u32 },
    CapacityExceeded { len: usize, max: usize },
    WouldBlock,
    EventCapacityExceeded { needed: usize, capacity: usize },
    SequenceOverflow { seq: u32 },
}

/// Snapshot of the PCM quality inspector state.
#[derive(Debug, Clone, PartialEq)]
pub struct InspectorSnapshot {
    pub samples: u64,
    pub rails: u32,
    pub position: usize,
    pub rail_window: Vec<u8>,
    pub max_rails: u32,
    pub max_consecutive_rails: u32,
    pub clipped_intervals: Vec<ClippedInterval>,
    pub plateau_suspected: bool,
    pub clipped: bool,
    pub previous: Option<i16>,
    pub run: u32,
    pub run_start: Option<i16>,
}

/// Snapshot of the DC blocker filter state.
#[derive(Debug, Clone, PartialEq)]
pub struct DcBlockerSnapshot {
    pub previous_input: f64,
    pub previous_output: f64,
    pub initialized: bool,
}

/// Snapshot of the A-weighting filter delay line and history.
#[derive(Debug, Clone, PartialEq)]
pub struct AWeightingSnapshot {
    pub z1: [f64; 2],
    pub z2: [f64; 2],
    pub history_index: usize,
}

/// Comprehensive read-only snapshot of all engine, quality, and DSP metrics.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineSnapshot {
    pub seq: u32,
    pub state: String,
    pub total_a_samples: u64,
    pub total_a_energy: f64,
    pub silent_sample_count: u64,
    pub near_full_scale_observed: bool,
    pub consecutive_silent_sample_count: u64,
    pub interval_sample_counter: usize,
    pub interval_z_energy: f64,
    pub interval_z_samples: u64,
    pub second_index: u32,
    pub ring_write_index: usize,
    pub ring_buffered_samples: usize,
    pub fft_sample_count: usize,
    pub inspector: InspectorSnapshot,
    pub dc_blocker: DcBlockerSnapshot,
    pub a_weighting: AWeightingSnapshot,
}

/// A 1-second integration window record.
#[derive(Debug, Clone, PartialEq)]
pub struct SecondWindowRecord {
    pub second: u32,
    pub exclusive_end: u64,
    pub interval_z_energy: f64,
    pub interval_z_samples: u64,
    pub cumulative_a_energy: f64,
    pub cumulative_a_samples: u64,
    pub source_seq: u32,
    pub chunk_rms: f64,
    pub chunk_dbfs: f64,
    pub chunk_dbspl: f64,
    pub interval_dbspl_z: f64,
}

/// Spectrum analysis record (periodic or query).
#[derive(Debug, Clone, PartialEq)]
pub struct SpectrumRecord {
    pub at_sample: u64,
    pub source: String,
    pub linear_bins: Vec<f64>,
    pub spectrum_db: Vec<f64>,
    pub bands_db: Vec<f64>,
}

/// Events produced into the bounded event queue.
#[derive(Debug, Clone, PartialEq)]
pub enum AcousticEvent {
    SecondWindow(SecondWindowRecord),
    Spectrum(SpectrumRecord),
}

/// Final summary upon session completion.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalSummary {
    pub total_samples: u64,
    pub a_energy: f64,
    pub leq_a: f64,
    pub disposition: String,
    pub termination_reason: Option<String>,
    pub tail: Option<FilterTailResult>,
}

/// Core acoustic noise monitoring engine.
pub struct NoiseEngine {
    coeffs: AcousticCoefficients,
    offset: f64,
    expected_seq: u32,
    state: EngineState,

    // DSP components
    dc_blocker: DCBlocker,
    a_weighting: AWeightingFilter,
    quality_inspector: PcmQualityInspector,

    // Accumulators
    total_a_energy: f64,
    total_a_samples: u64,
    interval_z_energy: f64,
    interval_z_samples: u64,
    interval_sample_counter: usize,
    second_index: u32,

    // Ring buffer and FFT
    pcm_ring_buffer: Vec<f64>,
    pcm_write_index: usize,
    pcm_buffered_samples: usize,
    fft_sample_count: usize,

    // Silence detection
    silent_sample_count: u64,
    near_full_scale_observed: bool,
    consecutive_silent_sample_count: u64,

    // Tail and completion
    tail_result: Option<FilterTailResult>,
    cached_final_summary: Option<FinalSummary>,

    // Event queue
    events: VecDeque<AcousticEvent>,
    event_capacity: usize,
}

impl NoiseEngine {
    /// Creates a new `NoiseEngine` instance with the given dB SPL calibration offset.
    pub fn new(offset: f64) -> Self {
        Self::with_capacity(offset, DEFAULT_EVENT_CAPACITY)
    }

    /// Creates a new `NoiseEngine` with a custom event queue capacity.
    pub fn with_capacity(offset: f64, event_capacity: usize) -> Self {
        let coeffs = AcousticCoefficients::load();
        let dc_blocker = DCBlocker::new(coeffs.dc_pole);
        let a_weighting = AWeightingFilter::new(&coeffs.a_weighting);
        let quality_inspector = PcmQualityInspector::new(44100);
        let event_capacity = event_capacity.max(1);

        Self {
            coeffs,
            offset,
            expected_seq: 1,
            state: EngineState::Active,
            dc_blocker,
            a_weighting,
            quality_inspector,
            total_a_energy: 0.0,
            total_a_samples: 0,
            interval_z_energy: 0.0,
            interval_z_samples: 0,
            interval_sample_counter: 0,
            second_index: 0,
            pcm_ring_buffer: vec![0.0; FFT_SIZE],
            pcm_write_index: 0,
            pcm_buffered_samples: 0,
            fft_sample_count: 0,
            silent_sample_count: 0,
            near_full_scale_observed: false,
            consecutive_silent_sample_count: 0,
            tail_result: None,
            cached_final_summary: None,
            events: VecDeque::with_capacity(event_capacity),
            event_capacity,
        }
    }

    /// Returns whether the engine has been terminated.
    pub fn is_terminated(&self) -> bool {
        matches!(self.state, EngineState::Terminated(_))
    }

    /// Returns the current state.
    pub fn state(&self) -> &EngineState {
        &self.state
    }

    /// Returns the expected sequence number for the next chunk.
    pub fn expected_seq(&self) -> u32 {
        self.expected_seq
    }

    /// Returns the number of events currently queued.
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    /// Drains all queued acoustic events.
    pub fn drain_events(&mut self) -> Vec<AcousticEvent> {
        self.events.drain(..).collect()
    }

    /// Inspect one queued event without advancing or changing ownership.
    pub fn peek_event(&self) -> Option<&AcousticEvent> {
        self.events.front()
    }

    /// Transfer one event after the host has prepared its bounded response.
    pub fn pop_event(&mut self) -> Option<AcousticEvent> {
        self.events.pop_front()
    }

    /// Explicit hard invalidation (e.g. on stream corruption, timeout, interruption).
    pub fn hard_invalid(&mut self, reason: &str) {
        if !self.is_terminated() {
            let r = TerminationReason::HardInvalid(reason.to_string());
            self.state = EngineState::Terminated(r.clone());
            let summary = self.make_final_summary(true, Some(r));
            self.cached_final_summary = Some(summary);
        }
    }

    /// Returns a full, read-only snapshot of all current session, DSP, quality,
    /// and window states without modifying clock or flushing filter tail.
    pub fn snapshot(&self) -> EngineSnapshot {
        EngineSnapshot {
            seq: self.expected_seq,
            state: match &self.state {
                EngineState::Active => "active".to_string(),
                EngineState::Terminated(r) => format!("terminated({})", r.as_str()),
            },
            total_a_samples: self.total_a_samples,
            total_a_energy: self.total_a_energy,
            silent_sample_count: self.silent_sample_count,
            near_full_scale_observed: self.near_full_scale_observed,
            consecutive_silent_sample_count: self.consecutive_silent_sample_count,
            interval_sample_counter: self.interval_sample_counter,
            interval_z_energy: self.interval_z_energy,
            interval_z_samples: self.interval_z_samples,
            second_index: self.second_index,
            ring_write_index: self.pcm_write_index,
            ring_buffered_samples: self.pcm_buffered_samples,
            fft_sample_count: self.fft_sample_count,
            inspector: InspectorSnapshot {
                samples: self.quality_inspector.samples,
                rails: self.quality_inspector.rails,
                position: self.quality_inspector.position,
                rail_window: self.quality_inspector.rail_window.clone(),
                max_rails: self.quality_inspector.max_rails,
                max_consecutive_rails: self.quality_inspector.max_rail_run,
                clipped_intervals: self.quality_inspector.clipped_intervals.clone(),
                plateau_suspected: self.quality_inspector.plateau_suspected,
                clipped: self.quality_inspector.clipped,
                previous: self.quality_inspector.previous,
                run: self.quality_inspector.run,
                run_start: self.quality_inspector.run_start,
            },
            dc_blocker: DcBlockerSnapshot {
                previous_input: self.dc_blocker.previous_input,
                previous_output: self.dc_blocker.previous_output,
                initialized: self.dc_blocker.initialized,
            },
            a_weighting: AWeightingSnapshot {
                z1: self.a_weighting.z1,
                z2: self.a_weighting.z2,
                history_index: self.a_weighting.history_index,
            },
        }
    }

    /// Pure query for current 1/3-octave spectrum.
    /// Returns `None` if fewer than 32768 samples have been received.
    /// Does not alter clock, hop count, sample count, or ring buffer.
    pub fn query_spectrum(&self) -> Option<SpectrumRecord> {
        if self.pcm_buffered_samples < FFT_SIZE {
            None
        } else {
            Some(self.compute_spectrum_internal(self.total_a_samples, "query"))
        }
    }

    fn compute_spectrum_internal(&self, at_sample: u64, source: &str) -> SpectrumRecord {
        let mut fft_input = vec![0.0f64; FFT_SIZE];
        let start_read = self.pcm_write_index;
        for i in 0..FFT_SIZE {
            fft_input[i] = self.pcm_ring_buffer[(start_read + i) % FFT_SIZE];
        }

        let (linear_bins, spectrum_db) = compute_spectrum(
            &fft_input,
            self.offset,
            &self.coeffs.hann_window,
            &self.coeffs.fft_rotations,
        );
        let bands_db = compute_third_octave_bands(&spectrum_db, &self.coeffs.band_ranges);

        SpectrumRecord {
            at_sample,
            source: source.to_string(),
            linear_bins,
            spectrum_db,
            bands_db,
        }
    }

    /// Processes an input chunk of PCM samples.
    pub fn process_chunk(
        &mut self,
        seq: u32,
        pcm: &[i16],
        spectrum_needed: bool,
    ) -> Result<ProcessReceipt, ProcessError> {
        // 1. Terminated guard MUST come first! All subsequent inputs after termination
        // are IgnoredAfterTermination without checking capacity, emptiness, or seq.
        if self.is_terminated() {
            return Ok(ProcessReceipt::IgnoredAfterTermination);
        }

        // 2. Empty input: does not consume seq or alter state
        if pcm.is_empty() {
            return Ok(ProcessReceipt::IgnoredEmpty);
        }

        // 3. Boundary check: max chunk size
        if pcm.len() > MAX_CHUNK_SAMPLES {
            return Err(ProcessError::CapacityExceeded {
                len: pcm.len(),
                max: MAX_CHUNK_SAMPLES,
            });
        }

        // 4. Sequence number validation: seq must strictly match expected_seq
        if seq != self.expected_seq {
            return Err(ProcessError::InvalidSequence {
                expected: self.expected_seq,
                actual: seq,
            });
        }

        let next_seq = self
            .expected_seq
            .checked_add(1)
            .ok_or(ProcessError::SequenceOverflow {
                seq: self.expected_seq,
            })?;

        // 5. Exact event queue capacity pre-check based on current interval & ring/hop phase
        let needed_windows = (self.interval_sample_counter + pcm.len()) / 44100;
        let needed_spectrums = if spectrum_needed {
            if self.pcm_buffered_samples < FFT_SIZE {
                let to_fill = FFT_SIZE - self.pcm_buffered_samples;
                if pcm.len() < to_fill {
                    0
                } else {
                    1 + (pcm.len() - to_fill) / FFT_HOP_SIZE
                }
            } else {
                (self.fft_sample_count + pcm.len()) / FFT_HOP_SIZE
            }
        } else {
            0
        };
        let potential_events = needed_windows + needed_spectrums;
        if potential_events > self.event_capacity {
            return Err(ProcessError::EventCapacityExceeded {
                needed: potential_events,
                capacity: self.event_capacity,
            });
        }
        if self.events.len() + potential_events > self.event_capacity {
            return Err(ProcessError::WouldBlock);
        }

        // 6. Inspect PCM quality (updates sliding inspector)
        let quality = inspect_pcm(pcm, &mut self.quality_inspector);
        self.near_full_scale_observed |= quality.near_full_scale;

        // 7. Check Q-only rejections (DSP zero progress)
        // Main clipping takes priority: check clipped BEFORE incrementing silence counters!
        if quality.clipped {
            self.expected_seq = next_seq;
            self.state = EngineState::Terminated(TerminationReason::Clipped);
            return Ok(ProcessReceipt::TerminatedQOnly {
                seq,
                reason: "clipped".to_string(),
                samples: pcm.len(),
                clipped: true,
                digital_silence: quality.digital_silence,
            });
        }

        // Only increment silence counters if NOT clipped
        if quality.digital_silence {
            self.silent_sample_count += pcm.len() as u64;
            self.consecutive_silent_sample_count += pcm.len() as u64;
        } else {
            self.consecutive_silent_sample_count = 0;
        }

        if self.consecutive_silent_sample_count >= SILENCE_TERMINATION_LIMIT {
            self.expected_seq = next_seq;
            self.state = EngineState::Terminated(TerminationReason::DigitalSilence);
            return Ok(ProcessReceipt::TerminatedQOnly {
                seq,
                reason: "digital_silence".to_string(),
                samples: pcm.len(),
                clipped: false,
                digital_silence: true,
            });
        }

        // 8. Normal chunk commit (Q + D both progress)
        self.expected_seq = next_seq;

        let buffer_z = self.dc_blocker.process(pcm);
        let chunk_rms = calculate_rms(&buffer_z);
        let chunk_dbfs = calculate_db(chunk_rms, 1.0);
        let chunk_dbspl = chunk_dbfs + self.offset;

        let buffer_a = self.a_weighting.process(&buffer_z, false);

        for i in 0..pcm.len() {
            let norm_z = buffer_z[i];
            let weight_a = buffer_a[i];

            let energy_a = (weight_a as f64) * (weight_a as f64);
            self.total_a_energy += energy_a;
            self.total_a_samples += 1;

            self.interval_z_energy += (norm_z as f64) * (norm_z as f64);
            self.interval_z_samples += 1;

            // Ring buffer writes f32 * 32768 cast to f64
            self.pcm_ring_buffer[self.pcm_write_index] = (norm_z as f64) * 32768.0;
            self.pcm_write_index = (self.pcm_write_index + 1) % FFT_SIZE;

            if self.pcm_buffered_samples < FFT_SIZE {
                self.pcm_buffered_samples += 1;
                if self.pcm_buffered_samples == FFT_SIZE {
                    if spectrum_needed {
                        let spec =
                            self.compute_spectrum_internal(self.total_a_samples, "scheduled");
                        self.events.push_back(AcousticEvent::Spectrum(spec));
                    }
                    self.fft_sample_count = 0;
                }
            } else {
                self.fft_sample_count += 1;
                if self.fft_sample_count >= FFT_HOP_SIZE {
                    self.fft_sample_count -= FFT_HOP_SIZE;
                    if spectrum_needed {
                        let spec =
                            self.compute_spectrum_internal(self.total_a_samples, "scheduled");
                        self.events.push_back(AcousticEvent::Spectrum(spec));
                    }
                }
            }

            self.interval_sample_counter += 1;
            if self.interval_sample_counter >= 44100 {
                self.interval_sample_counter -= 44100;
                self.second_index += 1;

                let interval_dbspl_z = calculate_leq_from_energy(
                    self.interval_z_energy,
                    self.interval_z_samples,
                    self.offset,
                );

                let window = SecondWindowRecord {
                    second: self.second_index,
                    exclusive_end: self.total_a_samples,
                    interval_z_energy: self.interval_z_energy,
                    interval_z_samples: self.interval_z_samples,
                    cumulative_a_energy: self.total_a_energy,
                    cumulative_a_samples: self.total_a_samples,
                    source_seq: seq,
                    chunk_rms,
                    chunk_dbfs,
                    chunk_dbspl,
                    interval_dbspl_z,
                };
                self.interval_z_energy = 0.0;
                self.interval_z_samples = 0;
                self.events.push_back(AcousticEvent::SecondWindow(window));
            }
        }

        Ok(ProcessReceipt::Committed {
            seq,
            samples: pcm.len(),
            clipped: quality.clipped,
            digital_silence: quality.digital_silence,
            chunk_rms,
            chunk_dbfs,
            chunk_dbspl,
        })
    }

    /// Idempotent finish of the session.
    ///
    /// - Normal finish with samples and not hard-invalid flushes A-weighting tail.
    /// - Signal-terminated sessions (clipped, silence, hard-invalid) cannot tail or resume.
    pub fn finish(&mut self, disposition_invalid: bool) -> FinalSummary {
        if let Some(ref cached) = self.cached_final_summary {
            return cached.clone();
        }

        match self.state {
            EngineState::Terminated(ref reason) => {
                // If already terminated (e.g. Clipped, Silence, HardInvalid, or already Finished),
                // cannot tail or revive. Return existing summary idempotently.
                let summary = self.make_final_summary(true, Some(reason.clone()));
                self.cached_final_summary = Some(summary.clone());
                return summary;
            }
            EngineState::Active => {}
        }

        if disposition_invalid {
            self.state = EngineState::Terminated(TerminationReason::InvalidFinished);
            let summary = self.make_final_summary(true, Some(TerminationReason::InvalidFinished));
            self.cached_final_summary = Some(summary.clone());
            return summary;
        }

        // Normal finish
        if self.total_a_samples > 0 {
            let tail_res = integrate_filter_tail(&mut self.a_weighting, self.total_a_energy, 44100);
            self.total_a_energy += tail_res.energy;
            self.tail_result = Some(tail_res);
        }
        self.state = EngineState::Terminated(TerminationReason::NormalFinished);
        let summary = self.make_final_summary(false, Some(TerminationReason::NormalFinished));
        self.cached_final_summary = Some(summary.clone());
        summary
    }

    fn make_final_summary(
        &self,
        is_invalid: bool,
        reason: Option<TerminationReason>,
    ) -> FinalSummary {
        let leq_a =
            calculate_leq_from_energy(self.total_a_energy, self.total_a_samples, self.offset);

        FinalSummary {
            total_samples: self.total_a_samples,
            a_energy: self.total_a_energy,
            leq_a,
            disposition: if is_invalid {
                "invalid".to_string()
            } else {
                "normal".to_string()
            },
            termination_reason: reason.map(|r| r.as_str().to_string()),
            tail: self.tail_result,
        }
    }
}
