//! Received-sample spans and quality/assembly for independently computed segments.
use super::{
    harmonicity::{self, HnrResult, HnrRow, HnrSummary, PitchEvidence},
    time_support::{self, Interval},
};
pub const MAX_SEGMENTS: usize = 128;
pub const MAX_ROWS: usize = 4096;
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub start_sample: usize,
    pub end_sample: usize,
}
pub struct QualifiedPitch {
    pub evidence: PitchEvidence,
    pub support: Interval,
    pub reason: Option<&'static str>,
}
pub struct CompletedSegment<'a> {
    pub span: Span,
    pub hnr: Option<&'a HnrResult>,
    pub intervals: &'a [Interval],
}
pub struct AssembledRow {
    pub row: HnrRow,
    pub support: Interval,
    pub segment_index: usize,
}
pub struct AssembledHnr {
    pub track: Vec<AssembledRow>,
    pub signal_frames: usize,
    pub capped_frames: usize,
    pub summary: HnrSummary,
}

pub fn validate_source(samples: usize, rate: u32) -> Result<(), &'static str> {
    if samples == 0
        || samples > harmonicity::MAX_INPUT_SAMPLES
        || !super::resample::SUPPORTED_INPUT_RATES.contains(&rate)
    {
        return Err("invalid source capture domain");
    }
    Ok(())
}
pub fn plan_segments(
    samples: usize,
    rate: u32,
    boundaries: &[f64],
) -> Result<Vec<Span>, &'static str> {
    validate_source(samples, rate)?;
    if boundaries.len() > MAX_ROWS {
        return Err("segment capacity exceeded");
    }
    let duration = samples as f64 / rate as f64;
    let mut cuts = Vec::new();
    for &time in boundaries {
        if time.is_finite() && time > 0.0 && time < duration {
            let value = time * rate as f64;
            let floor = value.floor();
            let rounded = if value - floor < 0.5 {
                floor
            } else {
                floor + 1.0
            };
            let sample = rounded as usize;
            if sample > 0 && sample < samples {
                cuts.push(sample);
            }
        }
    }
    cuts.sort_unstable();
    cuts.dedup();
    if cuts.len() >= MAX_SEGMENTS {
        return Err("segment capacity exceeded");
    }
    let mut spans = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0;
    for end in cuts.into_iter().chain(std::iter::once(samples)) {
        spans.push(Span {
            start_sample: start,
            end_sample: end,
        });
        start = end;
    }
    Ok(spans)
}
pub fn qualify_pitch(
    pitch: &[PitchEvidence],
    samples: usize,
    rate: u32,
    frame: usize,
    intervals: &[Interval],
) -> Result<Vec<QualifiedPitch>, &'static str> {
    if pitch.len() > MAX_ROWS || intervals.len() > MAX_ROWS {
        return Err("support capacity exceeded");
    }
    validate_source(samples, rate)?;
    let opts = harmonicity::HarmonicityOptions {
        frame_size: frame,
        ..Default::default()
    };
    harmonicity::validate(&[], 12000.0, &opts, pitch)?;
    let times: Vec<f64> = pitch.iter().map(|p| p.time).collect();
    let support = time_support::assess_support(
        &times,
        frame as f64 / 12000.0,
        128.0 / rate as f64,
        samples as f64 / rate as f64,
        intervals,
    )?;
    Ok(pitch
        .iter()
        .zip(support)
        .map(|(&original, s)| {
            let mut evidence = original;
            let mut reason = None;
            if s.incomplete_filter_support {
                evidence.f0 = 0.0;
                reason = Some("incomplete-filter-support");
            }
            if s.clipped {
                evidence.f0 = 0.0;
                reason = Some("clipped-input");
            }
            QualifiedPitch {
                evidence,
                support: s.support,
                reason,
            }
        })
        .collect())
}

pub fn assemble_segments(
    samples: usize,
    rate: u32,
    frame: usize,
    hop: usize,
    segments: &[CompletedSegment<'_>],
) -> Result<AssembledHnr, &'static str> {
    validate_source(samples, rate)?;
    harmonicity::validate(
        &[],
        12000.0,
        &harmonicity::HarmonicityOptions {
            frame_size: frame,
            hop,
            ..Default::default()
        },
        &[],
    )?;
    if segments.is_empty() || segments.len() > MAX_SEGMENTS {
        return Err("segment capacity exceeded");
    }
    let mut cursor = 0;
    let mut row_count = 0;
    let mut interval_count = 0;
    let mut completed_count = 0;
    // Validate the complete partition and each exact local grid before constructing output.
    for s in segments {
        if s.span.start_sample != cursor
            || s.span.end_sample <= cursor
            || s.span.end_sample > samples
        {
            return Err("invalid segment partition");
        }
        cursor = s.span.end_sample;
        interval_count += s.intervals.len();
        if interval_count > MAX_ROWS {
            return Err("segment capacity exceeded");
        }
        if let Some(hnr) = s.hnr {
            if hnr.signal_frames > hnr.track.len() || hnr.capped_frames > hnr.signal_frames {
                return Err("invalid HNR segment counters");
            }
            completed_count += 1;
            row_count += hnr.track.len();
            if row_count > MAX_ROWS {
                return Err("segment capacity exceeded");
            }
            let n = ((s.span.end_sample - s.span.start_sample) as f64 * 12000.0 / rate as f64)
                .floor() as usize;
            let expected = if n < frame { 0 } else { (n - frame) / hop + 1 };
            if hnr.track.len() != expected {
                return Err("HNR segment grid mismatch");
            }
            for (i, r) in hnr.track.iter().enumerate() {
                if r.time != (i as f64 * hop as f64 + frame as f64 / 2.0) / 12000.0
                    || r.db.is_some_and(|v| !v.is_finite())
                {
                    return Err("HNR segment grid mismatch");
                }
            }
            let times: Vec<f64> = hnr.track.iter().map(|r| r.time).collect();
            time_support::assess_support(
                &times,
                frame as f64 / 12000.0,
                128.0 / rate as f64,
                (s.span.end_sample - s.span.start_sample) as f64 / rate as f64,
                s.intervals,
            )?;
        } else if !s.intervals.is_empty() {
            return Err("failed segment cannot contain clipping evidence");
        }
    }
    if cursor != samples {
        return Err("invalid segment partition");
    }
    if completed_count == 0 {
        return Err("all segments failed");
    }
    let mut track = Vec::with_capacity(row_count);
    let mut signal_frames = 0;
    let mut capped_frames = 0;
    for (segment_index, s) in segments.iter().enumerate() {
        let Some(hnr) = s.hnr else { continue };
        signal_frames += hnr.signal_frames;
        capped_frames += hnr.capped_frames;
        let shift = s.span.start_sample as f64 / rate as f64;
        let end = s.span.end_sample as f64 / rate as f64;
        for &original in &hnr.track {
            let mut row = original;
            let mut support = Interval {
                start: row.time - frame as f64 / 12000.0 / 2.0 - 128.0 / rate as f64,
                end: row.time + frame as f64 / 12000.0 / 2.0 + 128.0 / rate as f64,
            };
            if s.intervals
                .iter()
                .any(|i| support.start < i.end && support.end > i.start)
            {
                row.db = None;
                row.reason = Some("clipped-input");
            }
            row.time += shift;
            support.start += shift;
            support.end += shift;
            if segments.len() > 1 && (support.start < shift || support.end > end) {
                row.db = None;
                row.reason = Some("capture-gap-boundary");
            }
            track.push(AssembledRow {
                row,
                support,
                segment_index,
            });
        }
    }
    let rows: Vec<HnrRow> = track.iter().map(|r| r.row).collect();
    let summary = harmonicity::summarize_harmonicity(&rows, hop as f64 / 12000.0, 0.1);
    Ok(AssembledHnr {
        track,
        signal_frames,
        capped_frames,
        summary,
    })
}
