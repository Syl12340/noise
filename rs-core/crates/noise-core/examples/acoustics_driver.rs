//! Native CLI Driver for acoustic port verification.
//!
//! Reads custom binary protocol NAC1 files and prints structured NDJSON lines
//! to stdout for validation by test harness and JS comparisons.
//!
//! Protocol NAC1:
//! - Magic: "NAC1" (4 bytes)
//! - Calibration offset: f64LE (8 bytes)
//! - Opcode stream:
//!   - 1 (P): process_chunk (seq u32LE, len u32LE, needSpectrum u8, samples [i16LE; len])
//!   - 2 (Q): query_spectrum
//!   - 3 (F): finish (disposition u8: 0=normal, 1=invalid)
//!   - 4 (I): hard_invalid (reason_len u32LE, reason_bytes [u8; reason_len])
//!   - 5 (D): drain events
//!   - 6 (S): unit_spectrum (32768 f64LE samples) -> outputs raw linear powers, bins, bands
//!   - 7 (M): scalar math operations with f64 args and float/NaN classification

use std::fs::File;
use std::io::{self, Read, Write};
use std::process;

use noise_core::acoustics::engine::EngineSnapshot;
use noise_core::acoustics::fft::compute_spectrum_full;
use noise_core::acoustics::{
    AcousticCoefficients, AcousticEvent, FilterTailResult, MAX_CHUNK_SAMPLES, NoiseEngine,
    ProcessError, ProcessReceipt, SecondWindowRecord, SpectrumRecord, calculate_cne_from_leq,
    calculate_db, calculate_leq_from_energy, calculate_time_term, compute_third_octave_bands,
};

fn json_f64(v: f64) -> String {
    if v.is_nan() {
        "\"NaN\"".to_string()
    } else if v.is_infinite() {
        if v.is_sign_positive() {
            "\"+Infinity\"".to_string()
        } else {
            "\"-Infinity\"".to_string()
        }
    } else {
        format!("{}", v)
    }
}

fn json_f64_slice(slice: &[f64]) -> String {
    let mut s = String::with_capacity(slice.len() * 16 + 2);
    s.push('[');
    for (i, &v) in slice.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&json_f64(v));
    }
    s.push(']');
    s
}

fn emit_ndjson(json_str: &str) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{}", json_str);
}

fn json_text(text: &str) -> String {
    let mut result = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            ch if ch <= '\u{001f}' => result.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => result.push(ch),
        }
    }
    result.push('"');
    result
}

fn classify_f64(v: f64) -> &'static str {
    if v.is_nan() {
        "nan"
    } else if v.is_infinite() {
        if v.is_sign_positive() {
            "+infinity"
        } else {
            "-infinity"
        }
    } else if v == 0.0 {
        "zero"
    } else if v.is_subnormal() {
        "subnormal"
    } else {
        "normal"
    }
}

fn emit_receipt(receipt: &ProcessReceipt) {
    match receipt {
        ProcessReceipt::Committed {
            seq,
            samples,
            clipped,
            digital_silence,
            chunk_rms,
            chunk_dbfs,
            chunk_dbspl,
        } => {
            let line = format!(
                r#"{{"type":"receipt","status":"committed","seq":{},"samples":{},"clipped":{},"digital_silence":{},"chunk_rms":{},"chunk_dbfs":{},"chunk_dbspl":{}}}"#,
                seq,
                samples,
                clipped,
                digital_silence,
                json_f64(*chunk_rms),
                json_f64(*chunk_dbfs),
                json_f64(*chunk_dbspl),
            );
            emit_ndjson(&line);
        }
        ProcessReceipt::TerminatedQOnly {
            seq,
            reason,
            samples,
            clipped,
            digital_silence,
        } => {
            let line = format!(
                r#"{{"type":"receipt","status":"terminated_q_only","seq":{},"reason":"{}","samples":{},"clipped":{},"digital_silence":{}}}"#,
                seq, reason, samples, clipped, digital_silence
            );
            emit_ndjson(&line);
        }
        ProcessReceipt::IgnoredEmpty => {
            emit_ndjson(r#"{"type":"receipt","status":"ignored_empty"}"#);
        }
        ProcessReceipt::IgnoredAfterTermination => {
            emit_ndjson(r#"{"type":"receipt","status":"ignored_after_termination"}"#);
        }
    }
}

fn emit_snapshot(s: &EngineSnapshot) {
    let mut intervals_str = String::from("[");
    for (i, it) in s.inspector.clipped_intervals.iter().enumerate() {
        if i > 0 {
            intervals_str.push(',');
        }
        intervals_str.push_str(&format!(
            r#"{{"start":{},"end":{}}}"#,
            json_f64(it.start),
            json_f64(it.end)
        ));
    }
    intervals_str.push(']');

    let mut rail_win_str = String::from("[");
    for (i, &b) in s.inspector.rail_window.iter().enumerate() {
        if i > 0 {
            rail_win_str.push(',');
        }
        rail_win_str.push_str(&b.to_string());
    }
    rail_win_str.push(']');

    let prev_str = match s.inspector.previous {
        Some(p) => p.to_string(),
        None => "null".to_string(),
    };
    let run_start_str = match s.inspector.run_start {
        Some(p) => p.to_string(),
        None => "null".to_string(),
    };

    let line = format!(
        r#"{{"type":"snapshot","seq":{},"state":"{}","near_full_scale_observed":{},"total_a_samples":{},"total_a_energy":{},"silent_samples":{},"consecutive_silent_samples":{},"interval_sample_counter":{},"interval_z_energy":{},"interval_z_samples":{},"second_index":{},"ring_write_index":{},"ring_buffered_samples":{},"fft_sample_count":{},"inspector":{{"samples":{},"rails":{},"position":{},"max_rails":{},"max_consecutive_rails":{},"plateau_suspected":{},"clipped":{},"previous":{},"run":{},"run_start":{},"rail_window":{},"intervals":{}}},"dc":{{"previous_input":{},"previous_output":{},"initialized":{}}},"a_weighting":{{"z1":[{},{}],"z2":[{},{}],"history_index":{}}}}}"#,
        s.seq,
        json_text(&s.state).trim_matches('"'),
        s.near_full_scale_observed,
        s.total_a_samples,
        json_f64(s.total_a_energy),
        s.silent_sample_count,
        s.consecutive_silent_sample_count,
        s.interval_sample_counter,
        json_f64(s.interval_z_energy),
        s.interval_z_samples,
        s.second_index,
        s.ring_write_index,
        s.ring_buffered_samples,
        s.fft_sample_count,
        s.inspector.samples,
        s.inspector.rails,
        s.inspector.position,
        s.inspector.max_rails,
        s.inspector.max_consecutive_rails,
        s.inspector.plateau_suspected,
        s.inspector.clipped,
        prev_str,
        s.inspector.run,
        run_start_str,
        rail_win_str,
        intervals_str,
        json_f64(s.dc_blocker.previous_input),
        json_f64(s.dc_blocker.previous_output),
        s.dc_blocker.initialized,
        json_f64(s.a_weighting.z1[0]),
        json_f64(s.a_weighting.z1[1]),
        json_f64(s.a_weighting.z2[0]),
        json_f64(s.a_weighting.z2[1]),
        s.a_weighting.history_index,
    );
    emit_ndjson(&line);
}

fn emit_second_window(w: &SecondWindowRecord) {
    let line = format!(
        r#"{{"type":"window","second":{},"exclusive_end":{},"interval_z_energy":{},"interval_z_samples":{},"cumulative_a_energy":{},"cumulative_a_samples":{},"source_seq":{},"chunk_rms":{},"chunk_dbfs":{},"chunk_dbspl":{},"interval_dbspl_z":{}}}"#,
        w.second,
        w.exclusive_end,
        json_f64(w.interval_z_energy),
        w.interval_z_samples,
        json_f64(w.cumulative_a_energy),
        w.cumulative_a_samples,
        w.source_seq,
        json_f64(w.chunk_rms),
        json_f64(w.chunk_dbfs),
        json_f64(w.chunk_dbspl),
        json_f64(w.interval_dbspl_z),
    );
    emit_ndjson(&line);
}

fn emit_spectrum(s: &SpectrumRecord) {
    let line = format!(
        r#"{{"type":"spectrum","source":"{}","at_sample":{},"linear_bins":{},"spectrum_db":{},"bands_db":{}}}"#,
        s.source,
        s.at_sample,
        json_f64_slice(&s.linear_bins),
        json_f64_slice(&s.spectrum_db),
        json_f64_slice(&s.bands_db),
    );
    emit_ndjson(&line);
}

fn emit_final(
    total_samples: u64,
    a_energy: f64,
    leq_a: f64,
    disposition: &str,
    reason: Option<&str>,
    tail: Option<&FilterTailResult>,
) {
    let tail_str = match tail {
        Some(t) => format!(
            r#"{{"energy":{},"padding_samples":{},"converged":{}}}"#,
            json_f64(t.energy),
            t.padding_samples,
            t.converged
        ),
        None => "null".to_string(),
    };
    let reason_str = match reason {
        Some(r) => json_text(r),
        None => "null".to_string(),
    };
    let line = format!(
        r#"{{"type":"final","total_samples":{},"a_energy":{},"leq_a":{},"disposition":"{}","termination_reason":{},"tail":{}}}"#,
        total_samples,
        json_f64(a_energy),
        json_f64(leq_a),
        disposition,
        reason_str,
        tail_str
    );
    emit_ndjson(&line);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        emit_ndjson(r#"{"type":"error","code":"invalid_args","message":"Expected file path"}"#);
        process::exit(1);
    }

    let file_path = &args[1];
    let mut file = match File::open(file_path) {
        Ok(f) => f,
        Err(e) => {
            let line = format!(
                r#"{{"type":"error","code":"io_error","message":"Cannot open file: {}"}}"#,
                e
            );
            emit_ndjson(&line);
            process::exit(1);
        }
    };

    let mut data = Vec::new();
    if let Err(e) = file.read_to_end(&mut data) {
        let line = format!(
            r#"{{"type":"error","code":"io_error","message":"Cannot read file: {}"}}"#,
            e
        );
        emit_ndjson(&line);
        process::exit(1);
    }

    if data.len() < 12 {
        emit_ndjson(
            r#"{"type":"error","code":"header_too_short","message":"File smaller than 12 bytes"}"#,
        );
        process::exit(1);
    }

    // 1. Magic check: b"NAC1"
    if &data[0..4] != b"NAC1" {
        emit_ndjson(r#"{"type":"error","code":"invalid_magic","message":"Magic is not NAC1"}"#);
        process::exit(1);
    }

    // 2. Calibration offset
    let offset_bytes: [u8; 8] = data[4..12].try_into().unwrap();
    let offset = f64::from_le_bytes(offset_bytes);

    let mut engine = NoiseEngine::new(offset);
    let mut cursor = 12usize;

    while cursor < data.len() {
        let opcode = data[cursor];
        cursor += 1;

        match opcode {
            1 => {
                // Opcode P: process_chunk
                // Format: seq (4B), len (4B), need_spectrum (1B), samples (len * 2B)
                if cursor + 9 > data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_chunk_header"}"#);
                    process::exit(1);
                }
                let seq = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());
                let len =
                    u32::from_le_bytes(data[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
                let need_spectrum = data[cursor + 8] != 0;
                cursor += 9;

                if len > MAX_CHUNK_SAMPLES {
                    let line = format!(
                        r#"{{"type":"error","code":"chunk_capacity_exceeded","len":{},"max":{}}}"#,
                        len, MAX_CHUNK_SAMPLES
                    );
                    emit_ndjson(&line);
                    process::exit(1);
                }

                if cursor + len * 2 > data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_pcm_data"}"#);
                    process::exit(1);
                }

                let mut pcm = Vec::with_capacity(len);
                for i in 0..len {
                    let sample_bytes: [u8; 2] =
                        data[cursor + i * 2..cursor + i * 2 + 2].try_into().unwrap();
                    pcm.push(i16::from_le_bytes(sample_bytes));
                }
                cursor += len * 2;

                match engine.process_chunk(seq, &pcm, need_spectrum) {
                    Ok(receipt) => {
                        emit_receipt(&receipt);
                        emit_snapshot(&engine.snapshot());
                    }
                    Err(ProcessError::WouldBlock) => {
                        emit_ndjson(r#"{"type":"receipt","status":"would_block"}"#);
                        emit_snapshot(&engine.snapshot());
                    }
                    Err(ProcessError::EventCapacityExceeded { needed, capacity }) => {
                        emit_ndjson(&format!(
                            r#"{{"type":"error","code":"event_capacity_exceeded","needed":{},"capacity":{}}}"#,
                            needed, capacity
                        ));
                        process::exit(1);
                    }
                    Err(ProcessError::InvalidSequence { expected, actual }) => {
                        let line = format!(
                            r#"{{"type":"error","code":"invalid_sequence","expected":{},"actual":{}}}"#,
                            expected, actual
                        );
                        emit_ndjson(&line);
                        process::exit(1);
                    }
                    Err(ProcessError::CapacityExceeded { len, max }) => {
                        let line = format!(
                            r#"{{"type":"error","code":"capacity_exceeded","len":{},"max":{}}}"#,
                            len, max
                        );
                        emit_ndjson(&line);
                        process::exit(1);
                    }
                    Err(ProcessError::SequenceOverflow { seq }) => {
                        let line = format!(
                            r#"{{"type":"error","code":"sequence_overflow","seq":{}}}"#,
                            seq
                        );
                        emit_ndjson(&line);
                        process::exit(1);
                    }
                }
            }
            2 => {
                // Opcode Q: query_spectrum
                match engine.query_spectrum() {
                    Some(spec) => {
                        emit_spectrum(&spec);
                    }
                    None => {
                        emit_ndjson(r#"{"type":"spectrum_query_none"}"#);
                    }
                }
            }
            3 => {
                // Opcode F: finish
                // Format: disposition (1B) -> 0=normal, 1=invalid
                if cursor >= data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_finish"}"#);
                    process::exit(1);
                }
                let disposition_byte = data[cursor];
                cursor += 1;
                let disposition_invalid = disposition_byte != 0;

                let summary = engine.finish(disposition_invalid);
                emit_final(
                    summary.total_samples,
                    summary.a_energy,
                    summary.leq_a,
                    &summary.disposition,
                    summary.termination_reason.as_deref(),
                    summary.tail.as_ref(),
                );
            }
            4 => {
                // Opcode I: hard_invalid
                // Format: reason_len (4B), reason_bytes
                if cursor + 4 > data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_invalid_header"}"#);
                    process::exit(1);
                }
                let r_len =
                    u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap()) as usize;
                cursor += 4;

                if cursor + r_len > data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_invalid_reason"}"#);
                    process::exit(1);
                }
                let reason = String::from_utf8_lossy(&data[cursor..cursor + r_len]).to_string();
                cursor += r_len;

                engine.hard_invalid(&reason);
                let line = format!(
                    r#"{{"type":"hard_invalid","reason":{}}}"#,
                    json_text(&reason)
                );
                emit_ndjson(&line);
            }
            5 => {
                // Opcode D: drain events
                let events = engine.drain_events();
                for event in events {
                    match event {
                        AcousticEvent::SecondWindow(w) => emit_second_window(&w),
                        AcousticEvent::Spectrum(s) => emit_spectrum(&s),
                    }
                }
            }
            6 => {
                // Opcode 6: unit_spectrum (32768 f64LE PCM samples)
                let sample_count = 32768usize;
                if cursor + sample_count * 8 > data.len() {
                    emit_ndjson(
                        r#"{"type":"error","code":"unexpected_eof_in_fft_data","message":"Expected 32768 f64LE samples"}"#,
                    );
                    process::exit(1);
                }

                let mut pcm = Vec::with_capacity(sample_count);
                for i in 0..sample_count {
                    let bytes: [u8; 8] =
                        data[cursor + i * 8..cursor + i * 8 + 8].try_into().unwrap();
                    pcm.push(f64::from_le_bytes(bytes));
                }
                cursor += sample_count * 8;

                let coeffs = AcousticCoefficients::load();
                let spec_res =
                    compute_spectrum_full(&pcm, offset, &coeffs.hann_window, &coeffs.fft_rotations);
                let bands_db =
                    compute_third_octave_bands(&spec_res.spectrum_db, &coeffs.band_ranges);

                let line = format!(
                    r#"{{"type":"unit_spectrum","raw_powers":{},"powers":{},"linear_bins":{},"bins":{},"spectrum_db":{},"bands_db":{},"bands":{}}}"#,
                    json_f64_slice(&spec_res.raw_powers),
                    json_f64_slice(&spec_res.raw_powers),
                    json_f64_slice(&spec_res.linear_bins),
                    json_f64_slice(&spec_res.linear_bins),
                    json_f64_slice(&spec_res.spectrum_db),
                    json_f64_slice(&bands_db),
                    json_f64_slice(&bands_db),
                );
                emit_ndjson(&line);
            }
            7 => {
                // Opcode 7: scalar operation
                // Sub-op can be a 1-byte ID (1..=8) or a 4-byte string length + UTF-8 name
                if cursor >= data.len() {
                    emit_ndjson(r#"{"type":"error","code":"unexpected_eof_in_scalar_header"}"#);
                    process::exit(1);
                }

                let sub_op_id = data[cursor];
                cursor += 1;
                let op_name = match sub_op_id {
                    1 => "sqrt",
                    2 => "log10",
                    3 => "pow10",
                    4 => "db",
                    5 => "leq",
                    6 => "time_term",
                    7 => "classify",
                    8 => "cne",
                    9 => "rms",
                    _ => "unknown",
                };

                let result = match sub_op_id {
                    1 => {
                        // sqrt(x)
                        if cursor + 8 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let x = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        x.sqrt()
                    }
                    2 => {
                        // log10(x)
                        if cursor + 8 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let x = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        x.log10()
                    }
                    3 => {
                        // pow10(x)
                        if cursor + 8 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let x = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        10.0f64.powf(x)
                    }
                    4 => {
                        // calculate_db(rms, reference)
                        if cursor + 16 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let rms = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        let reference =
                            f64::from_le_bytes(data[cursor + 8..cursor + 16].try_into().unwrap());
                        cursor += 16;
                        calculate_db(rms, reference)
                    }
                    5 => {
                        // calculate_leq(energy, samples, offset)
                        if cursor + 24 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let energy =
                            f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        let samples_f =
                            f64::from_le_bytes(data[cursor + 8..cursor + 16].try_into().unwrap());
                        let off =
                            f64::from_le_bytes(data[cursor + 16..cursor + 24].try_into().unwrap());
                        cursor += 24;
                        let samples = if samples_f.is_nan() || samples_f <= 0.0 {
                            0u64
                        } else {
                            samples_f as u64
                        };
                        calculate_leq_from_energy(energy, samples, off)
                    }
                    6 => {
                        // calculate_time_term(seconds)
                        if cursor + 8 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let sec = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        calculate_time_term(sec)
                    }
                    7 => {
                        // classify(x)
                        if cursor + 8 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let x = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        x
                    }
                    8 => {
                        // calculate_cne(leq, time_term)
                        if cursor + 16 > data.len() {
                            emit_ndjson(
                                r#"{"type":"error","code":"unexpected_eof_in_scalar_args"}"#,
                            );
                            process::exit(1);
                        }
                        let leq = f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap());
                        let tt =
                            f64::from_le_bytes(data[cursor + 8..cursor + 16].try_into().unwrap());
                        cursor += 16;
                        calculate_cne_from_leq(leq, tt)
                    }
                    9 => {
                        if cursor + 4 > data.len() {
                            emit_ndjson(r#"{"type":"error","code":"rms_header_eof"}"#);
                            process::exit(1);
                        }
                        let count = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap())
                            as usize;
                        cursor += 4;
                        if count > MAX_CHUNK_SAMPLES || cursor + count * 8 > data.len() {
                            emit_ndjson(r#"{"type":"error","code":"invalid_rms_length"}"#);
                            process::exit(1);
                        }
                        let mut values = Vec::with_capacity(count);
                        for _ in 0..count {
                            values.push(f64::from_le_bytes(
                                data[cursor..cursor + 8].try_into().unwrap(),
                            ) as f32);
                            cursor += 8;
                        }
                        noise_core::acoustics::calculate_rms(&values)
                    }
                    _ => {
                        let line = format!(
                            r#"{{"type":"error","code":"unknown_scalar_op","op":"{}"}}"#,
                            op_name
                        );
                        emit_ndjson(&line);
                        process::exit(1);
                    }
                };

                let class_name = classify_f64(result);
                let line = format!(
                    r#"{{"type":"scalar","op":"{}","result":{},"class":"{}","category":"{}"}}"#,
                    op_name,
                    json_f64(result),
                    class_name,
                    class_name
                );
                emit_ndjson(&line);
            }
            unknown => {
                let line = format!(
                    r#"{{"type":"error","code":"unknown_opcode","opcode":{}}}"#,
                    unknown
                );
                emit_ndjson(&line);
                process::exit(1);
            }
        }
    }
}
