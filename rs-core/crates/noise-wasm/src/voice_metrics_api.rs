use noise_core::speech::voice_metrics::{IntensityResult, VariabilityResult};
pub fn intensity_json(r: &IntensityResult) -> String {
    let rows: Vec<String> = r
        .track
        .iter()
        .map(|p| format!("{{\"time\":{},\"db\":{}}}", p.time, p.db))
        .collect();
    format!(
        "{{\"track\":[{}],\"fs\":{},\"frameSize\":{},\"hop\":{},\"unit\":\"dBFS\",\"method\":\"rectangular-rms\",\"referenceRms\":1,\"rmsFloor\":0.000000000001,\"calibrationApplied\":false}}",
        rows.join(","),
        r.fs,
        r.frame_size,
        r.hop
    )
}
pub fn variability_json(r: &VariabilityResult) -> String {
    let value = r
        .value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".into());
    let reason = r
        .reason
        .map(|v| format!("\"{v}\""))
        .unwrap_or_else(|| "null".into());
    format!(
        "{{\"value\":{value},\"pairCount\":{},\"reason\":{reason},\"unit\":\"ratio\",\"definition\":\"adjacent-voiced-frame-period-variability\",\"cycleJitter\":false}}",
        r.pair_count
    )
}
