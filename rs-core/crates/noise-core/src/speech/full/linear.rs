pub struct LpcResult {
    pub a: Vec<f64>,
    pub error: f64,
}
pub fn burg_lpc(signal: &[f64], order: usize) -> Result<LpcResult, &'static str> {
    if signal.len() > 4096 || order > 32 || !signal.iter().all(|v| v.is_finite()) {
        return Err("invalid LPC input");
    }
    let n = signal.len();
    let mut a = vec![0.0; order + 1];
    a[0] = 1.0;
    if n <= order {
        return Ok(LpcResult { a, error: 0.0 });
    }
    let mut forward = signal[1..].to_vec();
    let mut backward = signal[..n - 1].to_vec();
    let mut error = 0.0;
    for &v in signal {
        error += v * v;
    }
    error /= n as f64;
    for m in 1..=order {
        let mut num = 0.0;
        let mut den = 0.0;
        for i in 0..forward.len() {
            num += forward[i] * backward[i];
            den += forward[i] * forward[i] + backward[i] * backward[i];
        }
        let km = if den > 1e-30 { -2.0 * num / den } else { 0.0 };
        let mut next = vec![0.0; m + 1];
        next[0] = 1.0;
        for i in 1..m {
            next[i] = a[i] + km * a[m - i];
        }
        next[m] = km;
        a[..=m].copy_from_slice(&next);
        if m < order {
            let size = forward.len() - 1;
            let mut f = vec![0.0; size];
            let mut b = vec![0.0; size];
            for i in 0..size {
                f[i] = forward[i + 1] + km * backward[i + 1];
                b[i] = backward[i] + km * forward[i];
            }
            forward = f;
            backward = b;
        }
        error *= 1.0 - km * km;
        if error < 0.0 {
            error = 0.0;
        }
    }
    if !error.is_finite() || !a.iter().all(|v| v.is_finite()) {
        return Err("nonfinite LPC result");
    }
    Ok(LpcResult { a, error })
}
