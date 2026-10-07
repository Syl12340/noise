//! Baseline descriptive metrics with explicit digital/voice-frame definitions.
pub const MAX_INPUT: usize = 262144;
pub const MAX_ROWS: usize = 4096;
pub const MAX_FRAME: usize = 4096;
#[derive(Clone, Copy)]
pub struct IntensityOptions {
    pub fs: f64,
    pub frame_size: Option<usize>,
    pub hop: Option<usize>,
}
pub struct IntensityRow {
    pub time: f64,
    pub db: f64,
}
pub struct IntensityResult {
    pub track: Vec<IntensityRow>,
    pub fs: f64,
    pub frame_size: usize,
    pub hop: usize,
}
fn round_positive(v: f64) -> Result<usize, &'static str> {
    let f = v.floor();
    let rounded = if v - f < 0.5 { f } else { f + 1.0 };
    if !rounded.is_finite() || rounded > u32::MAX as f64 {
        return Err("intensity defaults exceed addressable range");
    }
    Ok(rounded as usize)
}
pub fn intensity(signal: &[f32], opts: IntensityOptions) -> Result<IntensityResult, &'static str> {
    if signal.len() > MAX_INPUT {
        return Err("metrics capacity exceeded");
    }
    if !opts.fs.is_finite() || opts.fs <= 0.0 || !signal.iter().all(|v| v.is_finite()) {
        return Err("invalid intensity input");
    }
    let frame = match opts.frame_size {
        Some(v) => v,
        None => round_positive(opts.fs * 0.025)?,
    };
    let hop = match opts.hop {
        Some(v) => v,
        None => round_positive(opts.fs * 0.01)?,
    };
    if hop as u128 > u32::MAX as u128 {
        return Err("intensity hop exceeds addressable range");
    }
    if frame > MAX_FRAME {
        return Err("metrics capacity exceeded");
    }
    if frame == 0 || hop == 0 {
        return Err("invalid intensity frame/hop");
    }
    let count = if signal.len() < frame {
        0
    } else {
        (signal.len() - frame) / hop + 1
    };
    if count > MAX_ROWS {
        return Err("metrics capacity exceeded");
    }
    if count > 0 && !((((count - 1) * hop) as f64 + frame as f64 / 2.0) / opts.fs).is_finite() {
        return Err("invalid intensity time");
    }
    let mut track = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * hop;
        let mut sum = 0.0f64;
        for &v in &signal[start..start + frame] {
            let sample = v as f64;
            sum += sample * sample;
        }
        let rms = (sum / frame as f64).sqrt();
        let db = 20.0 * rms.max(1e-12).log10();
        track.push(IntensityRow {
            time: (start as f64 + frame as f64 / 2.0) / opts.fs,
            db,
        });
    }
    Ok(IntensityResult {
        track,
        fs: opts.fs,
        frame_size: frame,
        hop,
    })
}
pub struct VariabilityResult {
    pub value: Option<f64>,
    pub pair_count: usize,
    pub reason: Option<&'static str>,
}
pub fn pitch_period_variability(
    f0: &[f64],
    gaps: bool,
    clipped: bool,
) -> Result<VariabilityResult, &'static str> {
    if f0.len() > MAX_ROWS {
        return Err("metrics capacity exceeded");
    }
    if !f0.iter().all(|v| v.is_finite()) {
        return Err("nonfinite F0 input");
    }
    if gaps || clipped {
        return Ok(VariabilityResult {
            value: None,
            pair_count: 0,
            reason: Some(if gaps {
                "capture-discontinuity"
            } else {
                "clipped-input"
            }),
        });
    }
    let mut previous: Option<f64> = None;
    let mut sum_diff: f64 = 0.0;
    let mut sum_pair_mean: f64 = 0.0;
    let mut pairs = 0;
    for &f in f0 {
        if f > 0.0 {
            let period = 1.0 / f;
            if !period.is_finite() {
                return Err("nonfinite pitch period");
            }
            if let Some(p) = previous {
                let d: f64 = period - p;
                sum_diff += d.abs();
                sum_pair_mean += (period + p) / 2.0;
                pairs += 1;
                if !sum_diff.is_finite() || !sum_pair_mean.is_finite() {
                    return Err("nonfinite variability reduction");
                }
            }
            previous = Some(period);
        } else {
            previous = None;
        }
    }
    let value = if pairs == 0 || sum_pair_mean <= 0.0 {
        None
    } else {
        Some(sum_diff / sum_pair_mean)
    };
    Ok(VariabilityResult {
        value,
        pair_count: pairs,
        reason: if value.is_none() {
            Some("no-adjacent-voiced-pairs")
        } else {
            None
        },
    })
}
