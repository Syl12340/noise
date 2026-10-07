use super::{
    FullMath, js_round,
    linear::burg_lpc,
    roots::find_roots,
    tables,
    value::{Value, array, num, obj, text},
};
#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    pub freq: f64,
    pub bandwidth: f64,
}
impl Candidate {
    pub fn value(self) -> Value {
        obj(vec![
            ("freq", num(self.freq)),
            ("bandwidth", num(self.bandwidth)),
        ])
    }
}
fn usable(c: Option<Candidate>, band: f64) -> bool {
    c.is_some_and(|c| {
        c.freq.is_finite()
            && c.freq > 0.0
            && c.bandwidth.is_finite()
            && c.bandwidth > 0.0
            && c.bandwidth <= band
    })
}
pub struct FrameResult {
    pub candidates: Vec<Candidate>,
    pub all: Vec<Candidate>,
    pub prediction: Option<f64>,
}
pub fn from_lpc(
    a: &[f64],
    fs: f64,
    min: f64,
    max: f64,
    math: &impl FullMath,
) -> Result<FrameResult, &'static str> {
    if ![fs, min, max].iter().all(|v| v.is_finite())
        || fs <= 0.0
        || min < 0.0
        || max <= min
        || max > fs / 2.0
    {
        return Err("invalid formant frequency domain");
    }
    let roots = find_roots(a, math)?;
    let mut all = Vec::new();
    for z in roots {
        let mag = (z.re * z.re + z.im * z.im).sqrt();
        if !mag.is_finite() {
            return Err("invalid formant root");
        }
        if !(1e-10..1.0).contains(&mag) || z.im <= 0.0 {
            continue;
        }
        let freq = math.atan2(z.im, z.re) * fs / (2.0 * std::f64::consts::PI);
        let bandwidth = -math.ln(mag) * fs / std::f64::consts::PI;
        if !freq.is_finite() || !bandwidth.is_finite() {
            return Err("nonfinite formant frequency/bandwidth");
        }
        if freq > 0.0 {
            all.push(Candidate {
                freq: js_round(freq * 10.0) / 10.0,
                bandwidth: js_round(bandwidth * 10.0) / 10.0,
            });
        }
    }
    all.sort_by(|a, b| a.freq.partial_cmp(&b.freq).unwrap());
    let candidates = all
        .iter()
        .copied()
        .filter(|c| c.freq >= min && c.freq <= max)
        .collect();
    Ok(FrameResult {
        all,
        candidates,
        prediction: None,
    })
}
pub fn extract(
    frame: &[f64],
    order: usize,
    fs: f64,
    min: f64,
    max: f64,
    math: &impl FullMath,
) -> Result<FrameResult, &'static str> {
    let lpc = burg_lpc(frame, order)?;
    let mut residual = 0.0;
    let mut energy = 0.0;
    for i in order..frame.len() {
        let mut e = frame[i];
        for k in 1..=order {
            e += lpc.a[k] * frame[i - k];
        }
        residual += e * e;
        energy += frame[i] * frame[i];
    }
    let mut r = from_lpc(&lpc.a, fs, min, max, math)?;
    r.prediction = if energy > 1e-20 {
        Some(residual / energy)
    } else {
        None
    };
    Ok(r)
}
fn cost(a: Candidate, b: Candidate, math: &impl FullMath) -> f64 {
    let freq = math.ln(b.freq / a.freq).abs() / math.ln(1.1);
    let band = (b.bandwidth - a.bandwidth).abs() / 350.0;
    if freq <= 1.0 && band <= 1.0 {
        freq * 0.75 + band * 0.25
    } else {
        f64::INFINITY
    }
}
pub fn align(c: &[Candidate], r: &[Candidate], math: &impl FullMath) -> Vec<Option<Candidate>> {
    let n = c.len();
    let m = r.len();
    let mut costs = vec![vec![0.0; m + 1]; n + 1];
    let mut moves = vec![vec![0u8; m + 1]; n + 1];
    for i in 1..=n {
        costs[i][0] = i as f64 * 0.6;
        moves[i][0] = 1;
    }
    for j in 1..=m {
        costs[0][j] = j as f64 * 0.6;
        moves[0][j] = 2;
    }
    for i in 1..=n {
        for j in 1..=m {
            let matched = costs[i - 1][j - 1] + cost(c[i - 1], r[j - 1], math);
            let missing = costs[i - 1][j] + 0.6;
            let extra = costs[i][j - 1] + 0.6;
            if matched <= missing && matched <= extra {
                costs[i][j] = matched;
                moves[i][j] = 0;
            } else if missing <= extra {
                costs[i][j] = missing;
                moves[i][j] = 1;
            } else {
                costs[i][j] = extra;
                moves[i][j] = 2;
            }
        }
    }
    let mut matches = vec![None; n];
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        match moves[i][j] {
            0 => {
                i -= 1;
                j -= 1;
                matches[i] = Some(r[j]);
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    matches
}
struct Evidence {
    raw: usize,
    matches: Vec<Option<Candidate>>,
    stable: bool,
}
fn numbering(
    c: &[Candidate],
    alts: &[FrameResult],
    band: f64,
    math: &impl FullMath,
) -> Vec<Evidence> {
    if alts.is_empty() {
        return (0..c.len())
            .map(|raw| Evidence {
                raw,
                matches: vec![],
                stable: true,
            })
            .collect();
    }
    let aligned: Vec<Vec<Option<Candidate>>> =
        alts.iter().map(|r| align(c, &r.candidates, math)).collect();
    let mut result = Vec::new();
    let mut lower = false;
    for (raw, &candidate) in c.iter().enumerate() {
        let matches: Vec<Option<Candidate>> = aligned.iter().map(|a| a[raw]).collect();
        let stable = matches.iter().all(|r| r.is_some());
        let skip = lower && matches.iter().all(|r| r.is_none()) && !usable(Some(candidate), band);
        if !skip {
            result.push(Evidence {
                raw,
                matches,
                stable,
            });
        }
        if stable {
            lower = true;
        }
    }
    result
}
fn matched(
    numbered: &[Evidence],
    c: &[Candidate],
    anchors: Option<[f64; 3]>,
    math: &impl FullMath,
) -> [Option<usize>; 3] {
    let Some(anchors) = anchors else {
        return std::array::from_fn(|i| numbered.get(i).map(|e| e.raw));
    };
    let mut best_cost = f64::INFINITY;
    let mut best = [None; 3];
    struct Search<'a, M> {
        n: &'a [Evidence],
        c: &'a [Candidate],
        anchors: [f64; 3],
        math: &'a M,
    }
    fn visit<M: FullMath>(
        s: &Search<'_, M>,
        slot: usize,
        from: usize,
        selected: [Option<usize>; 3],
        v: f64,
        best_cost: &mut f64,
        best: &mut [Option<usize>; 3],
    ) {
        if slot == 3 {
            if v < *best_cost {
                *best_cost = v;
                *best = selected;
            }
            return;
        }
        let mut missing = selected;
        missing[slot] = None;
        visit(s, slot + 1, from, missing, v + 0.4, best_cost, best);
        for j in from..s.n.len() {
            let d = if s.anchors[slot] > 0.0 {
                s.math.ln(s.c[s.n[j].raw].freq / s.anchors[slot]).abs()
            } else if j == slot {
                0.0
            } else {
                f64::INFINITY
            };
            if d > 0.35 {
                continue;
            }
            let mut selected = selected;
            selected[slot] = Some(s.n[j].raw);
            visit(s, slot + 1, j + 1, selected, v + d, best_cost, best);
        }
    }
    visit(
        &Search {
            n: numbered,
            c,
            anchors,
            math,
        },
        0,
        0,
        [None; 3],
        0.0,
        &mut best_cost,
        &mut best,
    );
    best
}
#[derive(Clone, Copy)]
pub struct PitchInfo {
    pub time: f64,
    pub f0: f64,
    pub aperiodicity: f64,
    pub support: Option<(f64, f64)>,
}
pub struct TrackOptions {
    pub fs: f64,
    pub frame: usize,
    pub hop: usize,
    pub order: usize,
    pub min: f64,
    pub max: f64,
    pub bandwidth: f64,
    pub compare_orders: bool,
    pub fundamental_ratio: f64,
    pub margin: f64,
}
pub struct FormantSession {
    signal: Vec<f32>,
    pitch: Vec<PitchInfo>,
    opts: TrackOptions,
    window: Vec<f64>,
    cursor: usize,
    total: usize,
    pitch_index: usize,
    anchors: Option<[f64; 3]>,
    context: Option<f64>,
    pending: [Option<(f64, usize)>; 3],
    rows: Vec<Value>,
}
impl FormantSession {
    pub fn new(
        signal: Vec<f32>,
        pitch: Vec<PitchInfo>,
        opts: TrackOptions,
    ) -> Result<Self, &'static str> {
        if signal.len() > 262144
            || pitch.len() > 4096
            || !signal.iter().all(|v| v.is_finite())
            || opts.order > 30
            || opts.order < 4
            || opts.frame == 0
            || opts.hop == 0
            || !opts.fs.is_finite()
            || opts.fs <= 0.0
            || ![
                opts.min,
                opts.max,
                opts.bandwidth,
                opts.fundamental_ratio,
                opts.margin,
            ]
            .iter()
            .all(|v| v.is_finite())
            || opts.min < 0.0
            || opts.max <= opts.min
            || opts.max > opts.fs / 2.0
            || opts.bandwidth <= 0.0
            || opts.fundamental_ratio <= 0.0
            || opts.margin < 0.0
            || opts.order >= opts.frame - 1
        {
            return Err("invalid formant session");
        }
        let window = tables::hamming(opts.frame).ok_or("unsupported Hamming window")?;
        let total = if signal.len() < opts.frame {
            0
        } else {
            (signal.len() - opts.frame) / opts.hop + 1
        };
        if total > 4096 {
            return Err("formant capacity");
        }
        let mut previous = -1.0;
        for p in &pitch {
            if !p.time.is_finite()
                || p.time <= previous
                || !p.f0.is_finite()
                || !p.aperiodicity.is_finite()
                || p.time < 0.0
                || p.f0 < 0.0
                || !(0.0..=1.0).contains(&p.aperiodicity)
                || p.support
                    .is_some_and(|(s, e)| !s.is_finite() || !e.is_finite() || e < s)
            {
                return Err("invalid pitch evidence");
            }
            previous = p.time;
        }
        Ok(Self {
            signal,
            pitch,
            opts,
            window,
            cursor: 0,
            total,
            pitch_index: 0,
            anchors: None,
            context: None,
            pending: [None; 3],
            rows: Vec::with_capacity(total),
        })
    }
    pub fn done(&self) -> bool {
        self.cursor == self.total
    }
    pub fn total(&self) -> usize {
        self.total
    }
    pub fn completed(&self) -> usize {
        self.cursor
    }
    pub fn rows(&self) -> &[Value] {
        &self.rows
    }
    fn empty(time: f64, start: f64, end: f64) -> Value {
        let missing = Candidate {
            freq: 0.0,
            bandwidth: 0.0,
        }
        .value();
        obj(vec![
            ("time", num(time)),
            (
                "support",
                obj(vec![("start", num(start)), ("end", num(end))]),
            ),
            ("F1", missing.clone()),
            ("F2", missing.clone()),
            ("F3", missing),
        ])
    }
    pub fn step(&mut self, math: &impl FullMath) -> Result<Option<Value>, &'static str> {
        if self.done() {
            return Ok(None);
        }
        let i = self.cursor;
        let o = &self.opts;
        let time = (i as f64 * o.hop as f64 + o.frame as f64 / 2.0) / o.fs;
        while self.pitch_index + 1 < self.pitch.len()
            && (self.pitch[self.pitch_index + 1].time - time).abs()
                < (self.pitch[self.pitch_index].time - time).abs()
        {
            self.pitch_index += 1;
        }
        let pitch = self.pitch.get(self.pitch_index).copied();
        let ps = pitch.map(|p| {
            p.support.unwrap_or((
                p.time - 1024.0 / 12000.0 / 2.0,
                p.time + 1024.0 / 12000.0 / 2.0,
            ))
        });
        let start =
            (i as f64 * o.hop as f64 / o.fs - o.margin).min(ps.map_or(f64::INFINITY, |p| p.0));
        let end = ((i * o.hop + o.frame) as f64 / o.fs + o.margin)
            .max(ps.map_or(f64::NEG_INFINITY, |p| p.1));
        let mut row = Self::empty(time, start, end);
        if pitch.is_none_or(|p| {
            p.f0 <= 0.0 || p.aperiodicity > 0.3 || (p.time - time).abs() > o.hop as f64 / o.fs
        }) {
            row.set("reason", text("unvoiced-or-uncertain"));
            self.anchors = None;
            self.context = None;
            self.pending = [None; 3];
        } else {
            let fs = o.fs;
            let order = o.order;
            let min = o.min;
            let max = o.max;
            let band = o.bandwidth;
            let ratio = o.fundamental_ratio;
            let compare = o.compare_orders;
            let frame_len = o.frame;
            if self.context.is_none() {
                self.context = Some(start);
            }
            let frame: Vec<f64> = self.signal[i * self.opts.hop..i * self.opts.hop + frame_len]
                .iter()
                .zip(&self.window)
                .map(|(&s, &w)| s as f64 * w)
                .collect();
            let computed = (|| -> Result<Value, &'static str> {
                let result = extract(&frame, order, fs, min, max, math)?;
                let c = &result.candidates;
                let orders: Vec<usize> = if compare {
                    [order.saturating_sub(2), order + 2]
                        .into_iter()
                        .filter(|p| *p >= 4 && *p < frame_len - 1)
                        .collect()
                } else {
                    vec![]
                };
                let alts: Vec<FrameResult> = orders
                    .iter()
                    .map(|&p| extract(&frame, p, fs, min, max, math))
                    .collect::<Result<_, _>>()?;
                let evidence = numbering(c, &alts, band, math);
                let mut selected = matched(&evidence, c, self.anchors, math);
                for (slot, s) in selected.iter_mut().enumerate() {
                    if s.is_some() && *s != evidence.get(slot).map(|e| e.raw) {
                        *s = None;
                    }
                }
                if self.anchors.is_none() {
                    self.anchors = Some(std::array::from_fn(|s| {
                        evidence.get(s).map_or(0.0, |e| c[e.raw].freq)
                    }));
                }
                for slot in 0..3 {
                    if usable(selected[slot].map(|j| c[j]), band) {
                        self.pending[slot] = None;
                        continue;
                    }
                    let proposal = evidence.get(slot).map(|e| e.raw);
                    let conflicts = selected.iter().enumerate().any(|(other_slot, r)| {
                        r.is_some_and(|j| {
                            other_slot != slot
                                && (Some(j) == proposal
                                    || proposal.is_some_and(|k| {
                                        if other_slot < slot {
                                            c[j].freq >= c[k].freq
                                        } else {
                                            c[j].freq <= c[k].freq
                                        }
                                    }))
                        })
                    });
                    if !usable(proposal.map(|j| c[j]), band) || conflicts {
                        self.pending[slot] = None;
                        continue;
                    }
                    let proposal = proposal.unwrap();
                    let stable = self.pending[slot]
                        .is_some_and(|(f, _)| math.ln(c[proposal].freq / f).abs() <= 0.1);
                    let count = if stable {
                        self.pending[slot].unwrap().1 + 1
                    } else {
                        1
                    };
                    self.pending[slot] = Some((c[proposal].freq, count));
                    if count >= 3 {
                        selected[slot] = Some(proposal);
                        self.pending[slot] = None;
                    }
                }
                let mut row = Self::empty(time, start, end);
                row.set(
                    "decisionSupport",
                    obj(vec![
                        ("start", num(start.min(self.context.unwrap()))),
                        ("end", num(end)),
                    ]),
                );
                row.set("candidates", array(c.iter().map(|c| c.value()).collect()));
                let mut models = vec![obj(vec![
                    ("order", num(order as f64)),
                    ("candidates", array(c.iter().map(|c| c.value()).collect())),
                    (
                        "normalizedPredictionError",
                        result.prediction.map(num).unwrap_or(Value::Null),
                    ),
                ])];
                for (&p, r) in orders.iter().zip(&alts) {
                    models.push(obj(vec![
                        ("order", num(p as f64)),
                        (
                            "candidates",
                            array(r.candidates.iter().map(|c| c.value()).collect()),
                        ),
                        (
                            "normalizedPredictionError",
                            r.prediction.map(num).unwrap_or(Value::Null),
                        ),
                    ]));
                }
                row.set("modelCandidates", array(models));
                row.set(
                    "orders",
                    array(
                        std::iter::once(order)
                            .chain(orders.iter().copied())
                            .map(|p| num(p as f64))
                            .collect(),
                    ),
                );
                let mut quality = Vec::new();
                let mut exploratory = Vec::new();
                for (slot, &key) in ["F1", "F2", "F3"].iter().enumerate() {
                    let candidate = selected[slot].map(|j| c[j]);
                    let item = selected[slot].and_then(|j| evidence.iter().find(|e| e.raw == j));
                    let fallback = c.get(slot).copied();
                    let above = candidate.is_some_and(|c| c.freq >= ratio * pitch.unwrap().f0);
                    let across = item.is_some_and(|e| e.matches.iter().all(|r| usable(*r, band)));
                    let prior = evidence.iter().take(slot).any(|e| !e.stable);
                    let reason = if candidate.is_none() {
                        if fallback.is_some() && !alts.is_empty() {
                            "model-disagreement"
                        } else {
                            "no-candidate"
                        }
                    } else if item.is_some_and(|e| !e.stable) {
                        "model-disagreement"
                    } else if prior {
                        "ambiguous-numbering"
                    } else if !usable(candidate, band) {
                        "wide-bandwidth"
                    } else if !alts.is_empty() && !across {
                        "model-bandwidth-disagreement"
                    } else if !above {
                        "sparse-harmonics"
                    } else {
                        "accepted"
                    };
                    let skipped = item
                        .map(|e| {
                            (0..e.raw)
                                .filter(|j| !evidence.iter().any(|e| e.raw == *j))
                                .map(|j| c[j].value())
                                .collect()
                        })
                        .unwrap_or_default();
                    let spread = item.and_then(|e| {
                        let values: Vec<f64> = e
                            .matches
                            .iter()
                            .filter_map(|r| r.map(|r| (r.freq - candidate.unwrap().freq).abs()))
                            .collect();
                        if values.is_empty() {
                            None
                        } else {
                            Some(values.into_iter().fold(0.0, f64::max))
                        }
                    });
                    quality.push((
                        key,
                        obj(vec![
                            ("reason", text(reason)),
                            (
                                "candidate",
                                candidate
                                    .or(fallback)
                                    .map(|c| c.value())
                                    .unwrap_or(Value::Null),
                            ),
                            ("acceptanceScope", text("model-correspondence-only")),
                            ("quantitativeUseValidated", Value::Bool(false)),
                            (
                                "harmonicsBelowCandidate",
                                candidate
                                    .map(|c| num(c.freq / pitch.unwrap().f0))
                                    .unwrap_or(Value::Null),
                            ),
                            (
                                "identification",
                                text(if let Some(e) = item {
                                    if !alts.is_empty() {
                                        if e.stable {
                                            "cross-order-consensus"
                                        } else {
                                            "unresolved-ordinal"
                                        }
                                    } else {
                                        "single-model"
                                    }
                                } else {
                                    "single-model"
                                }),
                            ),
                            (
                                "rawOrdinal",
                                item.map(|e| num((e.raw + 1) as f64)).unwrap_or(Value::Null),
                            ),
                            ("skippedCandidates", array(skipped)),
                            ("frequencySpreadHz", spread.map(num).unwrap_or(Value::Null)),
                        ]),
                    ));
                    if reason == "accepted" {
                        self.anchors.as_mut().unwrap()[slot] = candidate.unwrap().freq;
                        row.set(key, candidate.unwrap().value());
                    } else if reason == "sparse-harmonics" {
                        let mut v = candidate.unwrap().value();
                        v.set("reason", text(reason));
                        v.set("quantitativeUseValidated", Value::Bool(false));
                        exploratory.push((key, v));
                    }
                }
                row.set("quality", obj(quality));
                row.set("exploratory", obj(exploratory));
                Ok(row)
            })();
            match computed {
                Ok(r) => row = r,
                Err(_) => {
                    self.anchors = None;
                    self.context = None;
                    self.pending = [None; 3];
                    row.set("reason", text("numerical-failure"));
                }
            }
        }
        self.cursor += 1;
        self.rows.push(row.clone());
        Ok(Some(row))
    }
}
