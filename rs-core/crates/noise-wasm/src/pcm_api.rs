//! Serialization only; offline DSP reuses acoustics::quality.
use noise_core::acoustics::quality::PcmQualityReport;
pub fn quality_json(r: &PcmQualityReport) -> String {
    let e = &r.evidence.clipping_evidence;
    let intervals: Vec<String> = e
        .intervals
        .iter()
        .map(|i| format!("{{\"start\":{},\"end\":{}}}", i.start, i.end))
        .collect();
    format!(
        "{{\"clippedSamples\":{},\"nearFullScaleSamples\":{},\"nearFullScale\":{},\"peakAbs\":{},\"digitalSilence\":{},\"noAcSignal\":{},\"plateauSuspected\":{},\"clipped\":{},\"clippingEvidence\":{{\"windowSeconds\":{},\"railLimit\":{},\"maxRails\":{},\"maxConsecutiveRailSamples\":{},\"intervals\":[{}]}}}}",
        r.clipped_samples,
        r.near_full_scale_samples,
        r.near_full_scale,
        r.peak_abs,
        r.digital_silence,
        r.no_ac_signal,
        r.plateau_suspected,
        r.clipped,
        e.window_seconds,
        e.rail_limit,
        e.max_rails,
        e.max_consecutive_rail_samples,
        intervals.join(",")
    )
}
