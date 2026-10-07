use super::tables;
use crate::speech::resample_tables::{KernelBank, load_bank};
pub(crate) fn bank(input: u32, output: u32, cutoff: f64) -> Result<KernelBank, &'static str> {
    let bank = if output == 12000 && cutoff == 5500.0 {
        load_bank(input, output, cutoff).ok_or("unsupported profile")?
    } else {
        let bytes = tables::profile_bytes(input, output).ok_or("unsupported profile")?;
        if f64::from_le_bytes(bytes[12..20].try_into().unwrap()) != cutoff {
            return Err("unsupported cutoff");
        }
        let count = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
        let mut at = 24;
        let mut kernels = Vec::with_capacity(count);
        for _ in 0..count {
            let key = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            at += 4;
            let values = tables::read_values(&bytes[at..at + 257 * 8]);
            at += 257 * 8;
            kernels.push((key, values));
        }
        KernelBank { kernels }
    };
    Ok(bank)
}
pub fn session(
    signal: Vec<f32>,
    input: u32,
    output: u32,
    cutoff: f64,
) -> Result<crate::speech::resample_session::ResampleSession, &'static str> {
    crate::speech::resample_session::ResampleSession::with_bank(
        signal,
        input,
        output,
        bank(input, output, cutoff)?,
    )
}
pub fn resample(
    signal: &[f32],
    input: u32,
    output: u32,
    cutoff: f64,
) -> Result<Vec<f32>, &'static str> {
    if signal.len() > 262144 || !signal.iter().all(|v| v.is_finite()) {
        return Err("invalid full resample input");
    }
    let bank = bank(input, output, cutoff)?;
    let n = ((signal.len() as f64) * output as f64 / input as f64).floor() as usize;
    if n > 262144 {
        return Err("full resample capacity");
    }
    if signal.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(crate::speech::resample::sample_at(
            signal, input, output, i, &bank,
        )?);
    }
    Ok(out)
}
