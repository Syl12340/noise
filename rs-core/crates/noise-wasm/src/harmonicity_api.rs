//! Wire serialization and the sole allowed HNR scalar math import.
use noise_core::speech::{
    fractional::Refinement,
    harmonicity::{HnrResult, HnrRow, HnrSummary},
};
pub const MAX_HNR_SAMPLES: usize = 8192;
pub const MAX_PITCH_ROWS: usize = 512;
pub fn number(v: f64) -> String {
    if v.is_nan() {
        "\"NaN\"".into()
    } else if v == f64::INFINITY {
        "\"+Infinity\"".into()
    } else if v == f64::NEG_INFINITY {
        "\"-Infinity\"".into()
    } else {
        v.to_string()
    }
}
fn optional(v: Option<f64>) -> String {
    v.map(number).unwrap_or_else(|| "null".into())
}
fn row(r: &HnrRow) -> String {
    let mut s = format!("{{\"time\":{},\"db\":{}", number(r.time), optional(r.db));
    if let Some(v) = r.reason {
        s.push_str(&format!(",\"reason\":\"{v}\""));
    }
    if let Some(v) = r.peak_correlation {
        s.push_str(&format!(",\"peakCorrelation\":{}", number(v)));
    }
    if let Some(v) = r.lag_samples {
        s.push_str(&format!(",\"lagSamples\":{}", number(v)));
    }
    if let Some(v) = r.comparison_samples {
        s.push_str(&format!(",\"comparisonSamples\":{v}"));
    }
    if let Some(v) = r.correlation_method {
        s.push_str(&format!(",\"correlationMethod\":\"{v}\""));
    }
    if let Some(v) = r.refinement_converged {
        s.push_str(&format!(",\"refinementConverged\":{v}"));
    }
    s.push('}');
    s
}
pub fn summary(s: &HnrSummary) -> String {
    format!(
        "{{\"activeFrames\":{},\"validFrames\":{},\"coverage\":{},\"validDurationSeconds\":{},\"minDurationSeconds\":{},\"partialMeanHNR\":{},\"avgHNR\":{}}}",
        s.active_frames,
        s.valid_frames,
        number(s.coverage),
        number(s.valid_duration_seconds),
        number(s.min_duration_seconds),
        optional(s.partial_mean_hnr),
        optional(s.avg_hnr)
    )
}
pub fn result(r: &HnrResult) -> String {
    let rows: Vec<String> = r.track.iter().map(row).collect();
    let summary = summary(&r.summary);
    format!(
        "{{\"track\":[{}],\"signalFrames\":{},\"cappedFrames\":{},\"correlationMethod\":\"{}\",\"interpolationHalfSamples\":{},{}",
        rows.join(","),
        r.signal_frames,
        r.capped_frames,
        r.correlation_method,
        r.interpolation_half_samples,
        &summary[1..]
    )
}
pub fn refinement(r: &Refinement) -> String {
    let mut s = format!(
        "{{\"correlation\":{},\"converged\":{}",
        number(r.correlation),
        r.converged
    );
    if let Some(v) = r.lag_samples {
        s.push_str(&format!(",\"lagSamples\":{}", number(v)));
    }
    if let Some(v) = r.comparison_samples {
        s.push_str(&format!(",\"comparisonSamples\":{v}"));
    }
    if let Some(v) = r.interpolation_half_samples {
        s.push_str(&format!(",\"interpolationHalfSamples\":{v}"));
    }
    if let Some(v) = r.evaluations {
        s.push_str(&format!(",\"evaluations\":{v}"));
    }
    s.push('}');
    s
}
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn hnr_sin(x: f64) -> f64;
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn runtime_sin(x: f64) -> f64 {
    // SAFETY: import has the fixed f64->f64 signature; host supplies trusted Math.sin.
    unsafe { hnr_sin(x) }
}
