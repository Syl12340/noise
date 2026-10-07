use super::{
    FullMath,
    formants::{FormantSession, PitchInfo, TrackOptions},
    js_round, resample,
    spectral::SpectrogramSession,
    tables,
    value::{Value, array, num, obj, text},
};
use crate::{
    acoustics::quality::{self, PcmQualityInspector, PcmQualityReport},
    speech::{
        emphasis::emphasize_float,
        harmonicity::{HarmonicityOptions, HnrRow, PitchEvidence, summarize_harmonicity},
        hnr_session::HnrSession,
        pitch_session::{PitchOptions, PitchSession},
        resample_session::ResampleSession,
        segments::{Span, plan_segments},
        voice_metrics::{IntensityOptions, intensity, pitch_period_variability},
        yin::PitchPoint,
    },
};
#[derive(Clone, Copy)]
pub struct Parameters {
    pub order: usize,
    pub ceiling: u32,
    pub window_ms: u32,
    pub connected: bool,
}
impl Default for Parameters {
    fn default() -> Self {
        Self {
            order: 12,
            ceiling: 5000,
            window_ms: 25,
            connected: false,
        }
    }
}
pub struct FullProgress {
    pub stage: &'static str,
    pub segment: usize,
    pub completed: usize,
    pub total: usize,
}
struct Piece {
    signal: Vec<f32>,
    analysis: Option<Vec<f32>>,
    quality: PcmQualityReport,
    pitch: Vec<Value>,
    info: Vec<PitchInfo>,
    hnr: Option<HnrSession>,
    formants: Option<FormantSession>,
    spectral: Option<SpectrogramSession>,
    rs: Option<ResampleSession>,
    yin: Option<PitchSession>,
}
pub struct FullSession {
    pcm: Vec<i16>,
    rate: u32,
    parameters: Parameters,
    spans: Vec<Span>,
    segment: usize,
    stage: u8,
    piece: Option<Piece>,
    signal: Vec<f32>,
    pitch: Vec<Value>,
    formants: Vec<Value>,
    intensity: Vec<Value>,
    hnr: Vec<Value>,
    spectra: Vec<Vec<f32>>,
    times: Vec<f64>,
    qualities: Vec<Value>,
    intervals: Vec<Value>,
    signal_frames: usize,
    capped_frames: usize,
    clipped: bool,
    plateau: bool,
    cached: Option<Value>,
    failed: bool,
}
fn support(start: f64, end: f64) -> Value {
    obj(vec![("start", num(start)), ("end", num(end))])
}
fn candidate0() -> Value {
    obj(vec![("freq", num(0.0)), ("bandwidth", num(0.0))])
}
fn clear(row: &mut Value) {
    if row.get("f0").is_some() {
        row.set("f0", num(0.0));
    }
    if row.get("db").is_some() {
        row.set("db", Value::Null);
    }
    if row.get("F1").is_some() {
        for k in ["F1", "F2", "F3"] {
            row.set(k, candidate0());
        }
        row.set("exploratory", obj(vec![]));
    }
}
fn clipped(row: &Value, q: &PcmQualityReport) -> bool {
    let s = row.get("support").unwrap();
    let start = s.get("start").unwrap().num().unwrap();
    let end = s.get("end").unwrap().num().unwrap();
    q.evidence
        .clipping_evidence
        .intervals
        .iter()
        .any(|i| start < i.end && end > i.start)
}
fn quality_value(q: &PcmQualityReport) -> Value {
    let e = &q.evidence.clipping_evidence;
    obj(vec![
        ("clippedSamples", num(q.clipped_samples as f64)),
        (
            "nearFullScaleSamples",
            num(q.near_full_scale_samples as f64),
        ),
        ("nearFullScale", Value::Bool(q.near_full_scale)),
        ("peakAbs", num(q.peak_abs as f64)),
        ("digitalSilence", Value::Bool(q.digital_silence)),
        ("noAcSignal", Value::Bool(q.no_ac_signal)),
        ("plateauSuspected", Value::Bool(q.plateau_suspected)),
        ("clipped", Value::Bool(q.clipped)),
        (
            "clippingEvidence",
            obj(vec![
                ("windowSeconds", num(e.window_seconds)),
                ("railLimit", num(e.rail_limit as f64)),
                ("maxRails", num(e.max_rails as f64)),
                (
                    "maxConsecutiveRailSamples",
                    num(e.max_consecutive_rail_samples as f64),
                ),
                (
                    "intervals",
                    array(
                        e.intervals
                            .iter()
                            .map(|i| support(i.start, i.end))
                            .collect(),
                    ),
                ),
            ]),
        ),
    ])
}
fn pitch_value(p: PitchPoint) -> Value {
    let f = p.frame;
    let mut r = obj(vec![
        ("time", num(p.time)),
        ("f0", num(f.f0)),
        ("aperiodicity", num(f.aperiodicity)),
    ]);
    if let Some(v) = f.raw_f0 {
        r.set("rawF0", num(v));
    }
    if let Some(v) = f.reason {
        r.set("reason", text(v));
    }
    if let Some((min, max)) = f.range {
        r.set("range", obj(vec![("min", num(min)), ("max", num(max))]));
    }
    if let Some(v) = f.range_boundary_adjusted {
        r.set("rangeBoundaryAdjusted", Value::Bool(v));
    }
    if let Some(v) = f.numeric_tolerance_hz {
        r.set("numericToleranceHz", num(v));
    }
    r
}
fn hnr_value(r: &HnrRow) -> Value {
    let mut v = obj(vec![
        ("time", num(r.time)),
        ("db", r.db.map(num).unwrap_or(Value::Null)),
    ]);
    if let Some(s) = r.reason {
        v.set("reason", text(s));
    }
    for (k, x) in [
        ("peakCorrelation", r.peak_correlation),
        ("lagSamples", r.lag_samples),
        ("comparisonSamples", r.comparison_samples.map(|v| v as f64)),
    ] {
        if let Some(x) = x {
            v.set(k, num(x));
        }
    }
    if let Some(s) = r.correlation_method {
        v.set("correlationMethod", text(s));
    }
    if let Some(b) = r.refinement_converged {
        v.set("refinementConverged", Value::Bool(b));
    }
    v
}
pub fn hnr_summary(rows: &[Value]) -> Value {
    let r: Vec<HnrRow> = rows
        .iter()
        .map(|v| HnrRow {
            time: v.get("time").unwrap().num().unwrap(),
            db: v.get("db").and_then(Value::num),
            reason: v.get("reason").and_then(Value::string).map(|s| match s {
                "low-energy" => "low-energy",
                "unvoiced-or-uncertain" => "unvoiced-or-uncertain",
                "capture-gap-boundary" => "capture-gap-boundary",
                _ => "other",
            }),
            peak_correlation: None,
            lag_samples: None,
            comparison_samples: None,
            correlation_method: None,
            refinement_converged: None,
        })
        .collect();
    let s = summarize_harmonicity(&r, 0.01, 0.1);
    obj(vec![
        ("activeFrames", num(s.active_frames as f64)),
        ("validFrames", num(s.valid_frames as f64)),
        ("coverage", num(s.coverage)),
        ("validDurationSeconds", num(s.valid_duration_seconds)),
        ("minDurationSeconds", num(s.min_duration_seconds)),
        (
            "partialMeanHNR",
            s.partial_mean_hnr.map(num).unwrap_or(Value::Null),
        ),
        ("avgHNR", s.avg_hnr.map(num).unwrap_or(Value::Null)),
    ])
}
fn shifted(mut row: Value, span: Span, rate: u32, index: usize, multi: bool) -> Value {
    let shift = span.start_sample as f64 / rate as f64;
    let end = span.end_sample as f64 / rate as f64;
    if multi {
        let time = row.get("time").unwrap().num().unwrap();
        row.set("time", num(time + shift));
        row.set("segmentIndex", num(index as f64));
        for k in ["support", "decisionSupport"] {
            if let Some(v) = row.get_mut(k) {
                let start = v.get("start").unwrap().num().unwrap();
                let e = v.get("end").unwrap().num().unwrap();
                v.set("start", num(start + shift));
                v.set("end", num(e + shift));
            }
        }
        if let Some(v) = row.get("support") {
            if v.get("start").unwrap().num().unwrap() < shift
                || v.get("end").unwrap().num().unwrap() > end
            {
                clear(&mut row);
                row.set("reason", text("capture-gap-boundary"));
            }
        }
    }
    row
}
impl FullSession {
    pub fn signal(&self) -> &[f32] {
        &self.signal
    }
    pub fn pitch(&self) -> &[Value] {
        &self.pitch
    }
    pub fn formants(&self) -> &[Value] {
        &self.formants
    }
    pub fn intensity(&self) -> &[Value] {
        &self.intensity
    }
    pub fn hnr(&self) -> &[Value] {
        &self.hnr
    }
    pub fn spectra(&self) -> &[Vec<f32>] {
        &self.spectra
    }
    pub fn times(&self) -> &[f64] {
        &self.times
    }
    pub fn new(
        pcm: Vec<i16>,
        rate: u32,
        parameters: Parameters,
        cuts: &[f64],
    ) -> Result<Self, &'static str> {
        if pcm.is_empty()
            || pcm.len() > 262144
            || pcm.len() as f64 > 5.25 * rate as f64
            || ![12000, 16000, 22050, 24000, 32000, 44100, 48000].contains(&rate)
            || ![8, 10, 12, 14].contains(&parameters.order)
            || ![4000, 4500, 5000, 5500, 6000, 7000, 8000].contains(&parameters.ceiling)
            || ![25, 40].contains(&parameters.window_ms)
            || parameters.ceiling + 1000 > rate / 2
        {
            return Err("invalid full analysis capture/parameters");
        }
        let spans = plan_segments(pcm.len(), rate, cuts)?;
        let signal = vec![0.0; pcm.len()];
        Ok(Self {
            pcm,
            rate,
            parameters,
            spans,
            segment: 0,
            stage: 0,
            piece: None,
            signal,
            pitch: vec![],
            formants: vec![],
            intensity: vec![],
            hnr: vec![],
            spectra: vec![],
            times: vec![],
            qualities: vec![],
            intervals: vec![],
            signal_frames: 0,
            capped_frames: 0,
            clipped: false,
            plateau: false,
            cached: None,
            failed: false,
        })
    }
    pub fn done(&self) -> bool {
        !self.failed && self.segment == self.spans.len()
    }
    fn progress(&self, stage: &'static str, completed: usize, total: usize) -> FullProgress {
        FullProgress {
            stage,
            segment: self.segment,
            completed,
            total,
        }
    }
    pub fn step(&mut self, math: &impl FullMath) -> Result<FullProgress, &'static str> {
        if self.failed {
            return Err("failed full session");
        }
        let result = self.step_inner(math);
        if result.is_err() {
            self.failed = true;
            self.piece = None;
        }
        result
    }
    fn step_inner(&mut self, math: &impl FullMath) -> Result<FullProgress, &'static str> {
        if self.done() {
            return Ok(self.progress("complete", self.segment, self.spans.len()));
        }
        let span = self.spans[self.segment];
        let duration = (span.end_sample - span.start_sample) as f64 / self.rate as f64;
        let target = 2 * (self.parameters.ceiling + 1000);
        match self.stage {
            0 => {
                let pcm = &self.pcm[span.start_sample..span.end_sample];
                let q = quality::inspect_pcm(pcm, &mut PcmQualityInspector::new(self.rate));
                let signal = quality::centered_signal(pcm);
                let rs = resample::session(signal.clone(), self.rate, 12000, 5500.0)?;
                self.piece = Some(Piece {
                    signal,
                    analysis: None,
                    quality: q,
                    pitch: vec![],
                    info: vec![],
                    hnr: None,
                    formants: None,
                    spectral: None,
                    rs: Some(rs),
                    yin: None,
                });
                self.stage = 1;
                Ok(self.progress("centered", 1, 1))
            }
            1 => {
                let p = self.piece.as_mut().unwrap();
                let r = p.rs.as_mut().unwrap().step_batch(256)?;
                if r.done {
                    let a = p.rs.as_mut().unwrap().finish()?.to_vec();
                    p.rs = None;
                    p.analysis = Some(a.clone());
                    p.yin = Some(PitchSession::new(a, PitchOptions::default())?);
                    self.stage = 2;
                }
                Ok(self.progress("pitch-resample", r.completed, r.total))
            }
            2 => {
                let p = self.piece.as_mut().unwrap();
                let y = p.yin.as_mut().unwrap();
                if let Some(receipt) = y.step_frame() {
                    let time = receipt.row.time;
                    let mut row = pitch_value(receipt.row);
                    let s = time - 1024.0 / 12000.0 / 2.0 - 128.0 / self.rate as f64;
                    let e = time + 1024.0 / 12000.0 / 2.0 + 128.0 / self.rate as f64;
                    row.set("support", support(s, e));
                    if s < 0.0 || e > duration {
                        row.set("f0", num(0.0));
                        row.set("reason", text("incomplete-filter-support"));
                    }
                    if clipped(&row, &p.quality) {
                        row.set("f0", num(0.0));
                        row.set("reason", text("clipped-input"));
                    }
                    p.info.push(PitchInfo {
                        time,
                        f0: row.get("f0").unwrap().num().unwrap(),
                        aperiodicity: row.get("aperiodicity").unwrap().num().unwrap(),
                        support: Some((s, e)),
                    });
                    p.pitch.push(row);
                }
                let n = y.completed_frames();
                let total = y.total_frames();
                if y.done() {
                    let a = p.analysis.take().unwrap();
                    let evidence = p
                        .info
                        .iter()
                        .map(|p| PitchEvidence {
                            time: p.time,
                            f0: p.f0,
                            aperiodicity: p.aperiodicity,
                        })
                        .collect();
                    p.hnr = Some(HnrSession::new(
                        a,
                        12000.0,
                        HarmonicityOptions {
                            require_pitch: true,
                            ..Default::default()
                        },
                        evidence,
                    )?);
                    p.yin = None;
                    self.stage = 3;
                }
                Ok(self.progress("pitch", n, total))
            }
            3 => {
                let p = self.piece.as_mut().unwrap();
                let h = p.hnr.as_mut().unwrap();
                h.next(&|v| math.sin(v))?;
                let n = h.completed_frames();
                let total = h.total_frames();
                if h.done() {
                    let result = h.finish()?;
                    self.signal_frames += result.signal_frames;
                    self.capped_frames += result.capped_frames;
                    for r in &result.track {
                        let mut row = hnr_value(r);
                        row.set(
                            "support",
                            support(
                                r.time - 1024.0 / 12000.0 / 2.0 - 128.0 / self.rate as f64,
                                r.time + 1024.0 / 12000.0 / 2.0 + 128.0 / self.rate as f64,
                            ),
                        );
                        if clipped(&row, &p.quality) {
                            row.set("db", Value::Null);
                            row.set("reason", text("clipped-input"));
                        }
                        self.hnr.push(shifted(
                            row,
                            span,
                            self.rate,
                            self.segment,
                            self.spans.len() > 1,
                        ));
                    }
                    p.hnr = None;
                    p.rs = Some(resample::session(
                        p.signal.clone(),
                        self.rate,
                        target,
                        self.parameters.ceiling as f64 + 500.0,
                    )?);
                    self.stage = 4;
                }
                Ok(self.progress("hnr", n, total))
            }
            4 => {
                let p = self.piece.as_mut().unwrap();
                let r = p.rs.as_mut().unwrap().step_batch(256)?;
                if r.done {
                    let a = p.rs.as_mut().unwrap().finish()?.to_vec();
                    p.rs = None;
                    let (_, coef) = tables::emphasis(target).unwrap();
                    let frame = js_round(target as f64 * self.parameters.window_ms as f64 / 1000.0)
                        as usize;
                    let hop = js_round(target as f64 * 0.01) as usize;
                    let order = (js_round(self.parameters.order as f64 * target as f64 / 12000.0)
                        as usize)
                        .max(4);
                    p.formants = Some(FormantSession::new(
                        emphasize_float(&a, coef),
                        p.info.clone(),
                        TrackOptions {
                            fs: target as f64,
                            frame,
                            hop,
                            order,
                            min: 90.0,
                            max: self.parameters.ceiling as f64,
                            bandwidth: 500.0,
                            compare_orders: true,
                            fundamental_ratio: 1.5,
                            margin: 128.0 / self.rate as f64 + 1.0 / target as f64,
                        },
                    )?);
                    self.stage = 5;
                }
                Ok(self.progress("formant-resample", r.completed, r.total))
            }
            5 => {
                let p = self.piece.as_mut().unwrap();
                let f = p.formants.as_mut().unwrap();
                if let Some(mut row) = f.step(math)? {
                    if clipped(&row, &p.quality) {
                        clear(&mut row);
                        row.set("reason", text("clipped-input"));
                    }
                    self.formants.push(shifted(
                        row,
                        span,
                        self.rate,
                        self.segment,
                        self.spans.len() > 1,
                    ));
                }
                let n = f.completed();
                let total = f.total();
                if f.done() {
                    p.formants = None;
                    p.spectral = Some(SpectrogramSession::new(
                        emphasize_float(&p.signal, 0.97),
                        self.rate,
                    )?);
                    self.stage = 6;
                }
                Ok(self.progress("formants", n, total))
            }
            6 => {
                let p = self.piece.as_mut().unwrap();
                let s = p.spectral.as_mut().unwrap();
                if let Some((time, column)) = s.step(math) {
                    self.times.push(if self.spans.len() > 1 {
                        time + span.start_sample as f64 / self.rate as f64
                    } else {
                        time
                    });
                    self.spectra.push(column);
                }
                let n = s.completed();
                let total = s.total();
                if s.done() {
                    self.stage = 7;
                }
                Ok(self.progress("spectrogram", n, total))
            }
            _ => {
                let p = self.piece.take().unwrap();
                let r = intensity(
                    &p.signal,
                    IntensityOptions {
                        fs: self.rate as f64,
                        frame_size: None,
                        hop: None,
                    },
                )?;
                for v in r.track {
                    let mut row = obj(vec![
                        ("time", num(v.time)),
                        ("db", num(v.db)),
                        (
                            "support",
                            support(
                                v.time - r.frame_size as f64 / self.rate as f64 / 2.0,
                                v.time + r.frame_size as f64 / self.rate as f64 / 2.0,
                            ),
                        ),
                    ]);
                    if clipped(&row, &p.quality) {
                        row.set("db", Value::Null);
                        row.set("reason", text("clipped-input"));
                    }
                    self.intensity.push(shifted(
                        row,
                        span,
                        self.rate,
                        self.segment,
                        self.spans.len() > 1,
                    ));
                }
                self.signal[span.start_sample..span.end_sample].copy_from_slice(&p.signal);
                self.clipped |= p.quality.clipped;
                self.plateau |= p.quality.plateau_suspected;
                let shift = if self.spans.len() > 1 {
                    span.start_sample as f64 / self.rate as f64
                } else {
                    0.0
                };
                for i in &p.quality.evidence.clipping_evidence.intervals {
                    self.intervals.push(support(i.start + shift, i.end + shift));
                }
                self.qualities.push(quality_value(&p.quality));
                for row in p.pitch {
                    self.pitch.push(shifted(
                        row,
                        span,
                        self.rate,
                        self.segment,
                        self.spans.len() > 1,
                    ));
                }
                self.segment += 1;
                self.stage = 0;
                Ok(self.progress("intensity", 1, 1))
            }
        }
    }
    fn coverage(&self) -> Value {
        fn count(n: usize, size: usize, hop: usize) -> usize {
            if n < size { 0 } else { (n - size) / hop + 1 }
        }
        let fr = 2 * (self.parameters.ceiling + 1000);
        let formant_size = js_round(fr as f64 * self.parameters.window_ms as f64 / 1000.0) as usize;
        let formant_hop = js_round(fr as f64 * 0.01) as usize;
        let pt = count(
            (self.pcm.len() as f64 * 12000.0 / self.rate as f64).floor() as usize,
            1024,
            120,
        );
        let ft = count(
            (self.pcm.len() as f64 * fr as f64 / self.rate as f64).floor() as usize,
            formant_size,
            formant_hop,
        );
        let pcs: usize = self
            .spans
            .iter()
            .map(|s| {
                count(
                    ((s.end_sample - s.start_sample) as f64 * 12000.0 / self.rate as f64).floor()
                        as usize,
                    1024,
                    120,
                )
            })
            .sum();
        let fcs: usize = self
            .spans
            .iter()
            .map(|s| {
                count(
                    ((s.end_sample - s.start_sample) as f64 * fr as f64 / self.rate as f64).floor()
                        as usize,
                    formant_size,
                    formant_hop,
                )
            })
            .sum();
        let invalid = |rows: &[Value], reasons: &[&str]| {
            rows.iter()
                .filter(|r| {
                    r.get("reason")
                        .and_then(Value::string)
                        .is_some_and(|v| reasons.contains(&v))
                })
                .count()
        };
        obj(vec![
            ("denominator", text("ideal-continuous-received-pcm")),
            ("pitchTotal", num(pt as f64)),
            ("pitchComputed", num(self.pitch.len() as f64)),
            ("pitchExcludedBoundary", num(pt.saturating_sub(pcs) as f64)),
            ("pitchFailedSegment", num(0.0)),
            (
                "pitchInvalidInput",
                num(invalid(
                    &self.pitch,
                    &[
                        "clipped-input",
                        "capture-gap-boundary",
                        "incomplete-filter-support",
                    ],
                ) as f64),
            ),
            (
                "pitchAccepted",
                num(self
                    .pitch
                    .iter()
                    .filter(|r| r.get("f0").unwrap().num().unwrap() > 0.0)
                    .count() as f64),
            ),
            ("formantTotal", num(ft as f64)),
            ("formantComputed", num(self.formants.len() as f64)),
            (
                "formantExcludedBoundary",
                num(ft.saturating_sub(fcs) as f64),
            ),
            ("formantFailedSegment", num(0.0)),
            (
                "formantInvalidInput",
                num(invalid(&self.formants, &["clipped-input", "capture-gap-boundary"]) as f64),
            ),
            (
                "formantsAccepted",
                array(
                    ["F1", "F2", "F3"]
                        .iter()
                        .map(|k| {
                            num(self
                                .formants
                                .iter()
                                .filter(|r| {
                                    r.get(k).unwrap().get("freq").unwrap().num().unwrap() > 0.0
                                })
                                .count() as f64)
                        })
                        .collect(),
                ),
            ),
            (
                "formantsExploratory",
                array(
                    ["F1", "F2", "F3"]
                        .iter()
                        .map(|k| {
                            num(self
                                .formants
                                .iter()
                                .filter(|r| {
                                    r.get("exploratory").is_some_and(|v| v.get(k).is_some())
                                })
                                .count() as f64)
                        })
                        .collect(),
                ),
            ),
        ])
    }
    pub fn finish(&mut self) -> Result<&Value, &'static str> {
        if !self.done() {
            return Err("full analysis incomplete");
        }
        if self.cached.is_none() {
            let p = self.parameters;
            let fr = 2 * (p.ceiling + 1000);
            let (freq, _) = tables::emphasis(fr).unwrap();
            let order = js_round(p.order as f64 * fr as f64 / 12000.0).max(4.0);
            let frame = js_round(fr as f64 * p.window_ms as f64 / 1000.0);
            let multi = self.spans.len() > 1;
            let mut parameters = obj(vec![
                ("lpcOrder", num(p.order as f64)),
                ("maxFormant", num(p.ceiling as f64)),
                ("windowMs", num(p.window_ms as f64)),
                (
                    "task",
                    text(if p.connected {
                        "connected"
                    } else {
                        "sustained"
                    }),
                ),
                ("sampleRate", num(self.rate as f64)),
                ("analysisRate", num(12000.0)),
                ("formantAnalysisRate", num(fr as f64)),
                ("formantGuardBandHz", num(1000.0)),
                ("preEmphasisFrequencyHz", num(freq)),
                ("effectiveFormantOrder", num(order)),
                ("formantInputWindowSeconds", num(frame / fr as f64)),
                ("formantTrackingContext", text("since-last-tracker-reset")),
                ("hnrLowpassHz", num(5500.0)),
                ("hnrAnalysisRate", num(12000.0)),
                ("hnrFrameSeconds", num(1024.0 / 12000.0)),
                (
                    "hnrCorrelationMethod",
                    text("normalized-fractional-delay-sinc-129"),
                ),
                ("hnrInterpolationHalfSamples", num(64.0)),
                ("nominalRecordingSeconds", num(5.0)),
                ("captureEndToleranceSeconds", num(0.25)),
                ("pitchFrameSize", num(1024.0)),
                ("hopSize", num(120.0)),
                ("fmin", num(40.0)),
                ("fmax", num(1200.0)),
                ("minFundamentalRatio", num(1.5)),
                ("compareOrders", Value::Bool(true)),
                (
                    "discontinuityBoundariesSeconds",
                    array(
                        self.spans
                            .iter()
                            .skip(1)
                            .map(|s| num(s.start_sample as f64 / self.rate as f64))
                            .collect(),
                    ),
                ),
            ]);
            if multi {
                parameters.set("discontinuityPolicy", text("segment-before-dsp"));
                parameters.set("timeAxis", text("received-samples"));
            }
            let mut hnr = hnr_summary(&self.hnr);
            hnr.set("signalFrames", num(self.signal_frames as f64));
            hnr.set("cappedFrames", num(self.capped_frames as f64));
            if !multi {
                hnr.set(
                    "correlationMethod",
                    text("normalized-fractional-delay-sinc-129"),
                );
                hnr.set("interpolationHalfSamples", num(64.0));
            }
            let avg = hnr.get("avgHNR").unwrap().clone();
            let f0: Vec<f64> = self
                .pitch
                .iter()
                .map(|p| p.get("f0").unwrap().num().unwrap())
                .collect();
            let variability = pitch_period_variability(&f0, multi, self.clipped)?
                .value
                .map(num)
                .unwrap_or(Value::Null);
            let quality = if multi {
                obj(vec![
                    ("clipped", Value::Bool(self.clipped)),
                    ("plateauSuspected", Value::Bool(self.plateau)),
                    ("failedSegments", num(0.0)),
                ])
            } else {
                self.qualities[0].clone()
            };
            let mut result = obj(vec![
                ("profile", text("pcm-speech-v2")),
                ("RESULT_SCHEMA_VERSION", num(2.0)),
                ("ALGORITHM_VERSION", text("acoustics-2026-10-05.1")),
                ("parameters", parameters),
                ("sampleRate", num(self.rate as f64)),
                ("duration", num(self.pcm.len() as f64 / self.rate as f64)),
                ("harmonicity", hnr),
                ("avgHNR", avg),
                ("jitter", variability),
                ("inputQuality", quality),
                ("invalidIntervals", array(self.intervals.clone())),
                ("coverage", self.coverage()),
                (
                    "formantStatus",
                    obj(vec![
                        ("classification", text("experimental-candidates")),
                        ("quantitativeUseValidated", Value::Bool(false)),
                        (
                            "reason",
                            text(
                                "Cross-model agreement does not establish accuracy; see the frozen synthetic validation report.",
                            ),
                        ),
                    ]),
                ),
                (
                    "spectrogram",
                    obj(vec![
                        ("width", num(self.spectra.len() as f64)),
                        ("height", num(512.0)),
                        (
                            "times",
                            array(self.times.iter().copied().map(num).collect()),
                        ),
                    ]),
                ),
            ]);
            if multi {
                result.set(
                    "analysisSegments",
                    array(
                        self.spans
                            .iter()
                            .map(|s| {
                                obj(vec![
                                    ("start", num(s.start_sample as f64 / self.rate as f64)),
                                    ("end", num(s.end_sample as f64 / self.rate as f64)),
                                    ("startSample", num(s.start_sample as f64)),
                                    ("endSample", num(s.end_sample as f64)),
                                    ("status", text("analyzed")),
                                ])
                            })
                            .collect(),
                    ),
                );
            }
            self.cached = Some(result);
        }
        Ok(self.cached.as_ref().unwrap())
    }
    pub fn complete_value(&mut self) -> Result<Value, &'static str> {
        let mut v = self.finish()?.clone();
        v.set(
            "signal",
            array(self.signal.iter().map(|v| num(*v as f64)).collect()),
        );
        v.set("pitchTrack", array(self.pitch.clone()));
        v.set("formantTracks", array(self.formants.clone()));
        v.set("intensityTrack", array(self.intensity.clone()));
        v.get_mut("harmonicity")
            .unwrap()
            .set("track", array(self.hnr.clone()));
        v.get_mut("spectrogram").unwrap().set(
            "data",
            array(
                self.spectra
                    .iter()
                    .map(|c| array(c.iter().map(|v| num(*v as f64)).collect()))
                    .collect(),
            ),
        );
        Ok(v)
    }
}
