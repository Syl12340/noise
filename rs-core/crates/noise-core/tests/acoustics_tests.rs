//! Integration and unit tests for the Phase 1 Acoustics module.
//!
//! Validates compliance with `phase1/PORT_CONTRACT.md` and numerical rules.

#![cfg(feature = "acoustics")]

use noise_core::acoustics::*;

fn ac_signal(len: usize, amplitude: i16) -> Vec<i16> {
    (0..len)
        .map(|i| if i % 2 == 0 { amplitude } else { -amplitude })
        .collect()
}

#[test]
fn test_coefficients_loading() {
    let coeffs = AcousticCoefficients::load();
    assert_eq!(coeffs.hann_window.len(), 32768);
    assert_eq!(coeffs.fft_rotations.len(), 15);
    assert_eq!(coeffs.band_ranges.len(), 29);
    assert_eq!(coeffs.a_weighting.fir.len(), 129);
    assert!(coeffs.dc_pole > 0.99 && coeffs.dc_pole < 1.0);
    assert!(coeffs.a_weighting.gain > 0.0);
}

#[test]
fn test_math_functions_and_nan_propagation() {
    // 1. RMS
    let pcm = [0.0f32, 1.0, -1.0, 0.0];
    let rms = calculate_rms(&pcm);
    assert!((rms - 0.7071067811865475).abs() < 1e-12);
    assert!(calculate_rms(&[]).is_nan());

    // 2. dB with NaN and clamping
    assert!(calculate_db(f64::NAN, 32768.0).is_nan());
    let db_zero = calculate_db(0.0, 32768.0);
    assert!((db_zero - 20.0 * (1e-12f64 / 32768.0).log10()).abs() < 1e-12);
    let db_ref = calculate_db(32768.0, 32768.0);
    assert!((db_ref - 0.0).abs() < 1e-12);

    // 3. Leq from energy
    assert_eq!(calculate_leq_from_energy(-1.0, 44100, 0.0), 0.0);
    assert_eq!(calculate_leq_from_energy(f64::NAN, 44100, 0.0), 0.0);
    assert_eq!(calculate_leq_from_energy(100.0, 0, 0.0), 0.0);
    let leq = calculate_leq_from_energy(44100.0, 44100, 100.0);
    assert!((leq - 100.0).abs() < 1e-12);

    // 4. CNE from Leq
    assert_eq!(calculate_cne_from_leq(80.0, -10.0), 70.0);
}

#[test]
fn test_quality_inspector_rails_and_sliding_window() {
    let mut inspector = PcmQualityInspector::new(44100);
    assert_eq!(inspector.window_samples, 441);
    assert_eq!(inspector.rail_limit, 2);

    // Feed clean samples
    let clean = vec![0i16; 400];
    let ev = inspector.process(&clean);
    assert!(!ev.clipped);

    // Feed 2 rail samples
    let rails = vec![32767i16, -32768i16];
    let ev2 = inspector.process(&rails);
    assert!(ev2.clipped);
    assert!(inspector.clipped);
    assert!(inspector.rails >= 2);
    assert!(!inspector.clipped_intervals.is_empty());
}

#[test]
fn test_quality_plateau_detection() {
    let mut inspector = PcmQualityInspector::new(44100);

    // Ramp up
    inspector.process(&[100, 500, 1500]);
    // Flat top > 1024 for >= 8 samples
    let flat = vec![2000i16; 10];
    inspector.process(&flat);
    // Ramp down
    let ev = inspector.process(&[1500, 500, 100]);
    assert!(ev.plateau_suspected);
}

#[test]
fn test_digital_silence_detection() {
    let mut inspector = PcmQualityInspector::new(44100);

    // Zero amplitude
    let silent = vec![0i16; 100];
    let q = inspect_pcm(&silent, &mut inspector);
    assert!(q.digital_silence);

    // Small AC amplitude <= 1
    let low = vec![1i16, -1, 0, 1];
    let q2 = inspect_pcm(&low, &mut inspector);
    assert!(q2.digital_silence);

    // Constant DC signal (max - min <= 2)
    let dc = vec![1000i16, 1001, 1000, 1002];
    let q3 = inspect_pcm(&dc, &mut inspector);
    assert!(q3.digital_silence);
    assert!(q3.no_ac_signal);

    // AC signal with amplitude > 2
    let ac = vec![1000i16, 1005, 1000, 995];
    let q4 = inspect_pcm(&ac, &mut inspector);
    assert!(!q4.digital_silence);
    assert!(!q4.no_ac_signal);
}

#[test]
fn test_dc_blocker_continuous_state() {
    let coeffs = AcousticCoefficients::load();
    let mut blocker = DCBlocker::new(coeffs.dc_pole);

    // Feed constant DC signal
    let dc_block1 = vec![16384i16; 1000];
    let out1 = blocker.process(&dc_block1);
    assert_eq!(out1.len(), 1000);
    // First sample of initialized blocker subtracts previousInput=x, so y is small
    assert_eq!(out1[0], 0.0);

    // Constant input starting at sample zero is seeded and remains exactly zero.
    assert!(out1.iter().all(|&v| v == 0.0));
    blocker.reset();
    assert_eq!(blocker.process(&[0])[0], 0.0);
    let step = blocker.process(&dc_block1);
    let last_val1 = step[999].abs();
    let dc_block2 = vec![16384i16; 1000];
    let out2 = blocker.process(&dc_block2);
    let last_val2 = out2[999].abs();
    assert!(last_val2 < last_val1);
}

#[test]
fn test_a_weighting_and_tail_flush() {
    let coeffs = AcousticCoefficients::load();
    let mut filter = AWeightingFilter::new(&coeffs.a_weighting);

    // Process 1000 samples of 1 kHz tone at 44.1 kHz
    let mut signal = Vec::with_capacity(1000);
    for i in 0..1000 {
        let angle = 2.0 * std::f64::consts::PI * 1000.0 * (i as f64) / 44100.0;
        signal.push((angle.sin() * 16384.0) as i16);
    }

    let mut blocker = DCBlocker::new(coeffs.dc_pole);
    let z = blocker.process(&signal);
    let a = filter.process(&z, false);
    assert_eq!(a.len(), 1000);

    let energy: f64 = a.iter().map(|&s| (s as f64) * (s as f64)).sum();
    assert!(energy > 0.0);

    // Flush tail
    let tail = integrate_filter_tail(&mut filter, energy, 44100);
    assert!(tail.energy >= 0.0);
    assert!(tail.padding_samples > 0);
    assert!(tail.padding_samples <= 88200);
}

#[test]
fn test_fft_and_spectrum_bands() {
    let coeffs = AcousticCoefficients::load();
    let mut pcm = vec![0.0f64; 32768];

    // Generate 1 kHz sine wave
    for (i, sample) in pcm.iter_mut().enumerate() {
        let angle = 2.0 * std::f64::consts::PI * 1000.0 * (i as f64) / 44100.0;
        *sample = angle.sin() * 16384.0;
    }

    let (linear_bins, spectrum_db) =
        compute_spectrum(&pcm, 100.0, &coeffs.hann_window, &coeffs.fft_rotations);
    assert_eq!(linear_bins.len(), 16384);
    assert_eq!(spectrum_db.len(), 16384);

    // Peak near 1 kHz (bin ~ 1000 / (44100 / 32768) ≈ 743)
    let freq_res: f64 = 44100.0 / 32768.0;
    let expected_bin = (1000.0 / freq_res).round() as usize;

    let mut max_bin = 0;
    let mut max_power = 0.0f64;
    for (k, &p) in linear_bins.iter().enumerate() {
        if p > max_power {
            max_power = p;
            max_bin = k;
        }
    }
    assert!((max_bin as isize - expected_bin as isize).abs() <= 2);

    // 29 bands calculation
    let bands = compute_third_octave_bands(&spectrum_db, &coeffs.band_ranges);
    assert_eq!(bands.len(), 29);

    // 1 kHz is band index 16
    assert!(bands[16] > 80.0);
}

#[test]
fn test_engine_sequence_and_empty_chunk() {
    let mut engine = NoiseEngine::new(100.0);
    assert_eq!(engine.expected_seq(), 1);

    // 1. Empty input: returns IgnoredEmpty, seq does not advance
    let empty_res = engine.process_chunk(1, &[], false).unwrap();
    assert_eq!(empty_res, ProcessReceipt::IgnoredEmpty);
    assert_eq!(engine.expected_seq(), 1);

    // 2. Wrong seq: returns InvalidSequence error, state untouched
    let err = engine.process_chunk(2, &[100, 200], false).unwrap_err();
    assert_eq!(
        err,
        ProcessError::InvalidSequence {
            expected: 1,
            actual: 2
        }
    );
    assert_eq!(engine.expected_seq(), 1);

    // 3. Correct seq: commits, seq advances
    let ok = engine.process_chunk(1, &[100, 200], false).unwrap();
    match ok {
        ProcessReceipt::Committed { seq, samples, .. } => {
            assert_eq!(seq, 1);
            assert_eq!(samples, 2);
        }
        _ => panic!("Expected committed"),
    }
    assert_eq!(engine.expected_seq(), 2);
}

#[test]
fn test_engine_clipping_rejection_q_only() {
    let mut engine = NoiseEngine::new(100.0);

    // Chunk causing clipping: 2 consecutive rail samples
    let clipped_chunk = vec![32767i16; 10];
    let receipt = engine.process_chunk(1, &clipped_chunk, false).unwrap();
    match receipt {
        ProcessReceipt::TerminatedQOnly {
            seq,
            reason,
            clipped,
            ..
        } => {
            assert_eq!(seq, 1);
            assert_eq!(reason, "clipped");
            assert!(clipped);
        }
        _ => panic!("Expected TerminatedQOnly on clipping"),
    }
    assert!(engine.is_terminated());
    assert_eq!(engine.expected_seq(), 2);

    // Subsequent chunk rejected with IgnoredAfterTermination
    let after = engine.process_chunk(2, &[50, 60], false).unwrap();
    assert_eq!(after, ProcessReceipt::IgnoredAfterTermination);
    assert_eq!(engine.expected_seq(), 2);

    // Terminated engine cannot tail on normal finish
    let final_summary = engine.finish(false);
    assert_eq!(final_summary.termination_reason.as_deref(), Some("clipped"));
    assert!(final_summary.tail.is_none());
}

#[test]
fn test_engine_digital_silence_termination() {
    let mut engine = NoiseEngine::new(100.0);

    // Small chunks of silence accumulating towards 2205 samples
    // 2 chunks of 1000 = 2000 samples (< 2205): should commit normally
    let chunk1000 = vec![0i16; 1000];
    let r1 = engine.process_chunk(1, &chunk1000, false).unwrap();
    assert!(matches!(r1, ProcessReceipt::Committed { .. }));

    let r2 = engine.process_chunk(2, &chunk1000, false).unwrap();
    assert!(matches!(r2, ProcessReceipt::Committed { .. }));

    // Next chunk of 300 samples reaches 2300 >= 2205: should terminate Q-only!
    let chunk300 = vec![0i16; 300];
    let r3 = engine.process_chunk(3, &chunk300, false).unwrap();
    match r3 {
        ProcessReceipt::TerminatedQOnly {
            seq,
            reason,
            digital_silence,
            ..
        } => {
            assert_eq!(seq, 3);
            assert_eq!(reason, "digital_silence");
            assert!(digital_silence);
        }
        _ => panic!("Expected TerminatedQOnly on cumulative silence"),
    }
    assert!(engine.is_terminated());
}

#[test]
fn test_engine_second_window_and_query_spectrum() {
    let mut engine = NoiseEngine::new(100.0);

    // Feed 44100 samples in 2 chunks (22050 each)
    let mut chunk = vec![0i16; 22050];
    for (i, sample) in chunk.iter_mut().enumerate() {
        *sample = ((i % 1000) as i16) * 10;
    }

    // Before 32768 samples, query_spectrum is None
    assert!(engine.query_spectrum().is_none());

    let _ = engine.process_chunk(1, &chunk, false).unwrap();
    let events1 = engine.drain_events();
    assert!(events1.is_empty()); // No full second yet

    let _ = engine.process_chunk(2, &chunk, false).unwrap();
    let events2 = engine.drain_events();
    assert_eq!(events2.len(), 1); // 1 second window event

    match &events2[0] {
        AcousticEvent::SecondWindow(w) => {
            assert_eq!(w.second, 1);
            assert_eq!(w.exclusive_end, 44100);
            assert_eq!(w.source_seq, 2);
            assert!(w.interval_z_energy > 0.0);
            assert!(w.cumulative_a_energy > 0.0);
        }
        _ => panic!("Expected SecondWindow event"),
    }

    // Now buffered samples = 44100 >= 32768, query_spectrum returns Some
    let query_spec = engine.query_spectrum();
    assert!(query_spec.is_some());
    let spec = query_spec.unwrap();
    assert_eq!(spec.source, "query");
    assert_eq!(spec.linear_bins.len(), 16384);
    assert_eq!(spec.bands_db.len(), 29);

    // Finish session normally
    let summary = engine.finish(false);
    assert_eq!(summary.total_samples, 44100);
    assert!(summary.tail.is_some());
    assert_eq!(summary.disposition, "normal");
}

#[test]
fn test_chunk_boundary_invariance() {
    // Processing the same signal as 1 giant chunk vs 10 smaller chunks
    // must result in bitwise exact accumulated A energy.
    let mut signal = vec![0i16; 44100];
    for (i, sample) in signal.iter_mut().enumerate() {
        *sample = ((i as f64 * 0.1).sin() * 8000.0) as i16;
    }

    // Case A: 1 chunk of 44100
    let mut engine_a = NoiseEngine::new(100.0);
    engine_a.process_chunk(1, &signal, false).unwrap();
    let summary_a = engine_a.finish(false);

    // Case B: 10 chunks of 4410
    let mut engine_b = NoiseEngine::new(100.0);
    for i in 0..10 {
        let slice = &signal[i * 4410..(i + 1) * 4410];
        engine_b
            .process_chunk((i + 1) as u32, slice, false)
            .unwrap();
    }
    let summary_b = engine_b.finish(false);

    assert_eq!(summary_a.total_samples, summary_b.total_samples);
    assert_eq!(summary_a.total_samples, 44100);
    assert_eq!(
        summary_a.a_energy.to_bits(),
        summary_b.a_energy.to_bits(),
        "Accumulated energy must be bitwise identical across chunk splits"
    );
}

#[test]
fn test_capacity_exceeded_error() {
    let mut engine = NoiseEngine::new(100.0);
    let giant_chunk = vec![0i16; MAX_CHUNK_SAMPLES + 1];
    let err = engine.process_chunk(1, &giant_chunk, false).unwrap_err();
    assert_eq!(
        err,
        ProcessError::CapacityExceeded {
            len: MAX_CHUNK_SAMPLES + 1,
            max: MAX_CHUNK_SAMPLES
        }
    );
    assert_eq!(engine.expected_seq(), 1);
}

#[test]
fn test_i16_min_abs_and_sliding_window() {
    let mut inspector = PcmQualityInspector::new(44100);

    // 1. Single sample of i16::MIN (-32768) must not panic, peak_abs must be 32768
    let min_sample = [-32768i16];
    let q = inspect_pcm(&min_sample, &mut inspector);
    assert_eq!(q.peak_abs, 32768);
    assert!(q.near_full_scale);
    assert_eq!(q.clipped_samples, 1);
    assert_eq!(q.near_full_scale_samples, 1);

    // 2. Single sample of i16::MAX (32767)
    let max_sample = [32767i16];
    let q2 = inspect_pcm(&max_sample, &mut inspector);
    assert_eq!(q2.peak_abs, 32767);
    assert!(q2.near_full_scale);
    assert_eq!(q2.clipped_samples, 1);

    // 3. Sliding window of negative full scale
    let mut inspector2 = PcmQualityInspector::new(44100);
    let neg_rails = vec![-32768i16; 10];
    let ev = inspector2.process(&neg_rails);
    assert!(ev.clipped);
    assert!(inspector2.rails >= 2);
    assert_eq!(inspector2.samples, 10);
    assert!(!inspector2.clipped_intervals.is_empty());
}

#[test]
fn test_plateau_i32_overflow_protection() {
    let mut inspector = PcmQualityInspector::new(44100);

    // Large swing: from -30000 to +32000, hold for 10 samples, then swing back to -30000.
    // (prev - r_start) * (prev - cur) = (32000 - (-30000)) * (32000 - (-30000)) = 62000 * 62000 = 3,844,000,000 > i32::MAX.
    inspector.process(&[-30000i16]);
    inspector.process(&[32000i16; 10]);
    let ev = inspector.process(&[-30000i16]);
    assert!(
        ev.plateau_suspected,
        "Plateau with > i32::MAX product must be detected without overflow"
    );
}

#[test]
fn test_integrate_filter_tail_nan_propagation() {
    let coeffs = AcousticCoefficients::load();
    let mut filter = AWeightingFilter::new(&coeffs.a_weighting);

    // Passing NaN as reference_energy must propagate NaN threshold,
    // quiet comparison must never succeed, running all the way to max_samples (88200).
    let tail = integrate_filter_tail(&mut filter, f64::NAN, 44100);
    assert_eq!(tail.padding_samples, 88200);
    assert!(!tail.converged);
}

#[test]
fn test_clipping_priority_over_silence_count() {
    let mut engine = NoiseEngine::new(100.0);
    engine.process_chunk(1, &[0; 1000], false).unwrap();

    // A chunk of 10 samples that causes clipping (2 rails):
    // Even though peak_abs might be tested, clipping must terminate before incrementing silence counters.
    let clipped_chunk = vec![32767i16; 10];
    let res = engine.process_chunk(2, &clipped_chunk, false).unwrap();
    match res {
        ProcessReceipt::TerminatedQOnly {
            reason,
            clipped,
            digital_silence,
            ..
        } => {
            assert_eq!(reason, "clipped");
            assert!(clipped);
            assert!(digital_silence); // Raw constant block is also silent; clipping takes priority.
        }
        _ => panic!("Expected TerminatedQOnly on clipping"),
    }

    let snap = engine.snapshot();
    assert_eq!(
        snap.silent_sample_count, 1000,
        "Silence counters must NOT be changed when clipped"
    );
    assert_eq!(snap.consecutive_silent_sample_count, 1000);
}

#[test]
fn test_finish_idempotency_and_caching() {
    let mut engine = NoiseEngine::new(100.0);
    let chunk = ac_signal(44100, 5000);
    engine.process_chunk(1, &chunk, false).unwrap();

    // First finish: normal
    let sum1 = engine.finish(false);
    assert_eq!(sum1.disposition, "normal");
    assert!(sum1.tail.is_some());

    // Second finish: repeat normal finish must return identical cached summary
    let sum2 = engine.finish(false);
    assert_eq!(sum1, sum2);

    // Third finish: calling finish(true) on normally finished engine must NOT mutate to invalid
    let sum3 = engine.finish(true);
    assert_eq!(sum1, sum3);

    // Fresh engine finished with invalid first
    let mut engine_invalid = NoiseEngine::new(100.0);
    engine_invalid.process_chunk(1, &chunk, false).unwrap();
    let inv1 = engine_invalid.finish(true);
    assert_eq!(inv1.disposition, "invalid");
    assert!(inv1.tail.is_none());

    // Repeat finish(false) must NOT recover or tail
    let inv2 = engine_invalid.finish(false);
    assert_eq!(inv1, inv2);
}

#[test]
fn test_terminated_guard_priority() {
    let mut engine = NoiseEngine::new(100.0);
    // Terminate engine via hard_invalid
    engine.hard_invalid("test_termination");
    assert!(engine.is_terminated());

    // 1. Empty input after termination returns IgnoredAfterTermination
    let r_empty = engine.process_chunk(1, &[], false).unwrap();
    assert_eq!(r_empty, ProcessReceipt::IgnoredAfterTermination);

    // 2. Oversized input after termination returns IgnoredAfterTermination
    let giant = vec![0i16; MAX_CHUNK_SAMPLES + 10];
    let r_giant = engine.process_chunk(1, &giant, false).unwrap();
    assert_eq!(r_giant, ProcessReceipt::IgnoredAfterTermination);

    // 3. Wrong seq after termination returns IgnoredAfterTermination
    let r_wrong_seq = engine.process_chunk(99, &[100, 200], false).unwrap();
    assert_eq!(r_wrong_seq, ProcessReceipt::IgnoredAfterTermination);
}

#[test]
fn test_capacity_one_second_accepted_and_retry_drain() {
    // Engine with event_capacity = 1
    let mut engine = NoiseEngine::with_capacity(100.0, 1);

    // 1 second (44100 samples) chunk produces exactly 1 SecondWindow event.
    // When event queue is empty (0/1), this chunk must be accepted!
    let chunk = ac_signal(44100, 2000);
    let r1 = engine.process_chunk(1, &chunk, false).unwrap();
    assert!(matches!(r1, ProcessReceipt::Committed { .. }));
    assert_eq!(engine.event_count(), 1);

    // Queue is now full (1/1). Submitting another 1 second chunk must return WouldBlock
    let r2 = engine.process_chunk(2, &chunk, false);
    assert_eq!(r2, Err(ProcessError::WouldBlock));
    assert_eq!(
        engine.expected_seq(),
        2,
        "State must not be committed on WouldBlock"
    );

    // Drain events -> queue is now empty (0/1)
    let drained = engine.drain_events();
    assert_eq!(drained.len(), 1);
    assert_eq!(engine.event_count(), 0);

    // Retry chunk with seq = 2: now succeeds!
    let r3 = engine.process_chunk(2, &chunk, false).unwrap();
    assert!(matches!(r3, ProcessReceipt::Committed { .. }));
    assert_eq!(engine.expected_seq(), 3);
}

#[test]
fn test_engine_snapshot_and_no_flush() {
    let mut engine = NoiseEngine::new(100.0);
    let chunk = ac_signal(22050, 1000);
    engine.process_chunk(1, &chunk, false).unwrap();

    // Snapshot can be taken without finishing or flushing tail
    let snap = engine.snapshot();
    assert_eq!(snap.total_a_samples, 22050);
    assert!(snap.total_a_energy > 0.0);
    assert_eq!(snap.seq, 2);
    assert_eq!(snap.state, "active");
    assert_eq!(snap.inspector.samples, 22050);
    assert_eq!(snap.inspector.rail_window.len(), 441);
    assert!(snap.dc_blocker.initialized);

    // Session can continue processing normally after snapshot
    let r2 = engine.process_chunk(2, &chunk, false).unwrap();
    assert!(matches!(r2, ProcessReceipt::Committed { .. }));
    let snap2 = engine.snapshot();
    assert_eq!(snap2.total_a_samples, 44100);
}

#[test]
fn test_scheduled_spectrum_source() {
    let mut engine = NoiseEngine::new(100.0);
    let chunk = ac_signal(32768, 1000);
    // Need spectrum = true, reaches 32768 samples -> emits scheduled spectrum
    engine.process_chunk(1, &chunk, true).unwrap();
    let events = engine.drain_events();
    let mut found_scheduled = false;
    for ev in events {
        if let AcousticEvent::Spectrum(s) = ev {
            assert_eq!(s.source, "scheduled");
            assert_eq!(s.linear_bins.len(), 16384);
            assert_eq!(s.bands_db.len(), 29);
            found_scheduled = true;
        }
    }
    assert!(
        found_scheduled,
        "Periodic spectrum must have source == 'scheduled'"
    );
}

#[test]
fn test_block_larger_than_event_capacity_is_not_retryable_backpressure() {
    let mut engine = NoiseEngine::with_capacity(100.0, 1);
    let before = engine.snapshot();
    let result = engine.process_chunk(1, &ac_signal(88200, 1000), false);
    assert_eq!(
        result,
        Err(ProcessError::EventCapacityExceeded {
            needed: 2,
            capacity: 1
        })
    );
    assert_eq!(before, engine.snapshot());
    assert!(engine.drain_events().is_empty());
}
