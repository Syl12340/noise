// Extracted from native reference driver. No DSP resides in serialization.
use noise_core::acoustics::engine::EngineSnapshot;
use noise_core::acoustics::{ProcessReceipt, SecondWindowRecord, SpectrumRecord, FilterTailResult};

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


pub(super) fn json_receipt(receipt: &ProcessReceipt) -> String {
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
            line
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
            line
        }
        ProcessReceipt::IgnoredEmpty => {
            r#"{"type":"receipt","status":"ignored_empty"}"#.to_string()
        }
        ProcessReceipt::IgnoredAfterTermination => {
            r#"{"type":"receipt","status":"ignored_after_termination"}"#.to_string()
        }
    }
}


pub(super) fn json_snapshot(s: &EngineSnapshot) -> String {
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
    line
}


pub(super) fn json_second_window(w: &SecondWindowRecord) -> String {
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
    line
}


pub(super) fn json_spectrum(s: &SpectrumRecord) -> String {
    let line = format!(
        r#"{{"type":"spectrum","source":"{}","at_sample":{},"linear_bins":{},"spectrum_db":{},"bands_db":{}}}"#,
        s.source,
        s.at_sample,
        json_f64_slice(&s.linear_bins),
        json_f64_slice(&s.spectrum_db),
        json_f64_slice(&s.bands_db),
    );
    line
}


pub(super) fn json_final(
    total_samples: u64,
    a_energy: f64,
    leq_a: f64,
    disposition: &str,
    reason: Option<&str>,
    tail: Option<&FilterTailResult>,
) -> String {
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
    line
}
