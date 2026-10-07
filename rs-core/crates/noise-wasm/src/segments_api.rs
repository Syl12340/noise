use crate::harmonicity_api::{number, row, summary};
use noise_core::speech::{
    harmonicity::{HnrResult, PitchEvidence},
    segments::{self, CompletedSegment, Span},
    time_support::Interval,
};
pub fn plan(samples: usize, rate: u32, boundaries: &[f64]) -> Result<String, &'static str> {
    let spans = segments::plan_segments(samples, rate, boundaries)?;
    let rows: Vec<String> = spans
        .iter()
        .map(|s| {
            format!(
                "{{\"startSample\":{},\"endSample\":{},\"start\":{},\"end\":{}}}",
                s.start_sample,
                s.end_sample,
                number(s.start_sample as f64 / rate as f64),
                number(s.end_sample as f64 / rate as f64)
            )
        })
        .collect();
    Ok(format!("[{}]", rows.join(",")))
}
pub fn pitch(
    pitch: &[PitchEvidence],
    samples: usize,
    rate: u32,
    frame: usize,
    intervals: &[Interval],
) -> Result<String, &'static str> {
    let qualified = segments::qualify_pitch(pitch, samples, rate, frame, intervals)?;
    let rows:Vec<String>=qualified.iter().map(|r|{
        let mut s=format!("{{\"time\":{},\"f0\":{},\"aperiodicity\":{},\"support\":{{\"start\":{},\"end\":{}}}",number(r.evidence.time),number(r.evidence.f0),number(r.evidence.aperiodicity),number(r.support.start),number(r.support.end));
        if let Some(reason)=r.reason {s.push_str(&format!(",\"reason\":\"{reason}\""));}s.push('}');s
    }).collect();
    Ok(format!("[{}]", rows.join(",")))
}
pub fn assembled(
    samples: usize,
    rate: u32,
    frame: usize,
    hop: usize,
    parts: &[CompletedSegment<'_>],
) -> Result<String, &'static str> {
    let result = segments::assemble_segments(samples, rate, frame, hop, parts)?;
    let rows: Vec<String> = result
        .track
        .iter()
        .map(|r| {
            let s = row(&r.row);
            format!(
                "{},\"support\":{{\"start\":{},\"end\":{}}},\"segmentIndex\":{}}}",
                &s[..s.len() - 1],
                number(r.support.start),
                number(r.support.end),
                r.segment_index
            )
        })
        .collect();
    let mut spans = Vec::new();
    let mut intervals = Vec::new();
    for s in parts {
        let start = s.span.start_sample as f64 / rate as f64;
        let end = s.span.end_sample as f64 / rate as f64;
        let prefix = format!(
            "\"start\":{},\"end\":{},\"startSample\":{},\"endSample\":{}",
            number(start),
            number(end),
            s.span.start_sample,
            s.span.end_sample
        );
        if s.hnr.is_some() {
            spans.push(format!("{{{prefix},\"status\":\"analyzed\"}}"));
            for i in s.intervals {
                intervals.push(format!(
                    "{{\"start\":{},\"end\":{}}}",
                    number(i.start + start),
                    number(i.end + start)
                ));
            }
        } else {
            spans.push(format!(
                "{{{prefix},\"status\":\"failed\",\"reason\":\"segment-analysis-failure\"}}"
            ));
        }
    }
    // Baseline appends all failed-span invalid intervals after successful clipping intervals.
    intervals.extend(
        spans
            .iter()
            .zip(parts)
            .filter(|(_, p)| p.hnr.is_none())
            .map(|(s, _)| s.clone()),
    );
    let summary = summary(&result.summary);
    Ok(format!(
        "{{\"analysisSegments\":[{}],\"invalidIntervals\":[{}],\"harmonicity\":{{\"track\":[{}],\"signalFrames\":{},\"cappedFrames\":{},{},\"avgHNR\":{},\"jitter\":null,\"timeAxis\":\"received-samples\",\"discontinuityPolicy\":\"segment-before-dsp\"}}",
        spans.join(","),
        intervals.join(","),
        rows.join(","),
        result.signal_frames,
        result.capped_frames,
        &summary[1..],
        result
            .summary
            .avg_hnr
            .map(number)
            .unwrap_or_else(|| "null".into())
    ))
}
pub struct OwnedPart {
    pub span: Span,
    pub result: Option<HnrResult>,
    pub intervals: Vec<Interval>,
}
pub struct Assembly {
    pub samples: usize,
    pub rate: u32,
    pub frame: usize,
    pub hop: usize,
    pub parts: Vec<OwnedPart>,
    pub cursor: usize,
    pub cached: Option<String>,
}
impl Assembly {
    pub fn new(samples: usize, rate: u32, frame: usize, hop: usize) -> Result<Self, &'static str> {
        segments::validate_source(samples, rate)?;
        noise_core::speech::harmonicity::validate(
            &[],
            12000.0,
            &noise_core::speech::harmonicity::HarmonicityOptions {
                frame_size: frame,
                hop,
                ..Default::default()
            },
            &[],
        )?;
        Ok(Self {
            samples,
            rate,
            frame,
            hop,
            parts: Vec::new(),
            cursor: 0,
            cached: None,
        })
    }
    pub fn append(
        &mut self,
        span: Span,
        result: Option<&HnrResult>,
        intervals: &[Interval],
    ) -> Result<(), &'static str> {
        if self.cached.is_some()
            || span.start_sample != self.cursor
            || span.end_sample <= self.cursor
            || span.end_sample > self.samples
        {
            return Err("invalid segment partition");
        }
        if self.parts.len() >= segments::MAX_SEGMENTS
            || self.parts.iter().map(|p| p.intervals.len()).sum::<usize>() + intervals.len()
                > segments::MAX_ROWS
            || self
                .parts
                .iter()
                .filter_map(|p| p.result.as_ref())
                .map(|r| r.track.len())
                .sum::<usize>()
                + result.map_or(0, |r| r.track.len())
                > segments::MAX_ROWS
        {
            return Err("segment capacity exceeded");
        }
        if let Some(hnr) = result {
            // Validate a local single-span projection before changing owned state.
            segments::assemble_segments(
                span.end_sample - span.start_sample,
                self.rate,
                self.frame,
                self.hop,
                &[CompletedSegment {
                    span: Span {
                        start_sample: 0,
                        end_sample: span.end_sample - span.start_sample,
                    },
                    hnr: Some(hnr),
                    intervals,
                }],
            )?;
        } else if !intervals.is_empty() {
            return Err("failed segment cannot contain clipping evidence");
        }
        self.parts.push(OwnedPart {
            span,
            result: result.cloned(),
            intervals: intervals.to_vec(),
        });
        self.cursor = span.end_sample;
        Ok(())
    }
    pub fn finish(&mut self) -> Result<&str, &'static str> {
        if self.cursor != self.samples {
            return Err("assembly incomplete");
        }
        if self.cached.is_none() {
            let parts: Vec<CompletedSegment<'_>> = self
                .parts
                .iter()
                .map(|p| CompletedSegment {
                    span: p.span,
                    hnr: p.result.as_ref(),
                    intervals: &p.intervals,
                })
                .collect();
            self.cached = Some(assembled(
                self.samples,
                self.rate,
                self.frame,
                self.hop,
                &parts,
            )?);
            self.parts.clear();
        }
        Ok(self.cached.as_deref().unwrap())
    }
}
