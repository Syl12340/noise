//! Local continuous-segment evidence; no recording or scientific acceptance policy.
pub const MAX_ROWS: usize = 4096;
#[derive(Clone, Copy, Debug)]
pub struct Interval {
    pub start: f64,
    pub end: f64,
}
#[derive(Debug)]
pub struct SupportEvidence {
    pub time: f64,
    pub support: Interval,
    pub incomplete_filter_support: bool,
    pub clipped: bool,
}

pub fn assess_support(
    times: &[f64],
    window: f64,
    margin: f64,
    duration: f64,
    intervals: &[Interval],
) -> Result<Vec<SupportEvidence>, &'static str> {
    if times.len() > MAX_ROWS || intervals.len() > MAX_ROWS {
        return Err("support capacity exceeded");
    }
    if !window.is_finite()
        || window <= 0.0
        || !margin.is_finite()
        || margin < 0.0
        || !duration.is_finite()
        || duration < 0.0
    {
        return Err("invalid support configuration");
    }
    let mut previous = f64::NEG_INFINITY;
    for &time in times {
        if !time.is_finite() || time < 0.0 || time > duration || time <= previous {
            return Err("invalid support time");
        }
        // Keep the baseline's ordered subtraction/addition, not time +/- (half+margin).
        if !(time - window / 2.0 - margin).is_finite()
            || !(time + window / 2.0 + margin).is_finite()
        {
            return Err("non-finite support endpoint");
        }
        previous = time;
    }
    if intervals.iter().any(|i| {
        !i.start.is_finite()
            || !i.end.is_finite()
            || i.start < 0.0
            || i.end <= i.start
            || i.end > duration
    }) {
        return Err("invalid clipping interval");
    }
    Ok(times
        .iter()
        .map(|&time| {
            let support = Interval {
                start: time - window / 2.0 - margin,
                end: time + window / 2.0 + margin,
            };
            SupportEvidence {
                time,
                incomplete_filter_support: support.start < 0.0 || support.end > duration,
                clipped: intervals
                    .iter()
                    .any(|i| support.start < i.end && support.end > i.start),
                support,
            }
        })
        .collect())
}
