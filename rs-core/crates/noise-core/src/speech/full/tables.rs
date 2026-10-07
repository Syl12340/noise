use super::roots::RootMath;
include!("../../../../../coefficients/full-speech-v1/profiles.rs");
pub fn root_seed(degree: usize, index: usize) -> (f64, f64) {
    let b = include_bytes!("../../../../../coefficients/full-speech-v1/root-seeds.bin");
    let p = (degree * (degree - 1) / 2 - 1 + index) * 16;
    (
        f64::from_le_bytes(b[p..p + 8].try_into().unwrap()),
        f64::from_le_bytes(b[p + 8..p + 16].try_into().unwrap()),
    )
}
pub fn read_values(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
}
pub fn emphasis(rate: u32) -> Option<(f64, f64)> {
    let rates = [10000, 11000, 12000, 13000, 14000, 16000, 18000];
    let i = rates.iter().position(|r| *r == rate)?;
    let b = include_bytes!("../../../../../coefficients/full-speech-v1/emphasis.bin");
    Some((
        f64::from_le_bytes(b[..8].try_into().unwrap()),
        f64::from_le_bytes(b[(i + 1) * 8..(i + 2) * 8].try_into().unwrap()),
    ))
}
pub fn hamming(n: usize) -> Option<Vec<f64>> {
    let b: &[u8] = match n {
        250 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-250.bin"),
        275 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-275.bin"),
        300 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-300.bin"),
        325 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-325.bin"),
        350 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-350.bin"),
        400 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-400.bin"),
        440 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-440.bin"),
        450 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-450.bin"),
        480 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-480.bin"),
        520 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-520.bin"),
        560 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-560.bin"),
        640 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-640.bin"),
        720 => include_bytes!("../../../../../coefficients/full-speech-v1/hamming-720.bin"),
        _ => return None,
    };
    Some(read_values(b))
}
pub fn hann(rate: u32) -> Option<Vec<f64>> {
    let b: &[u8] = match rate {
        12000 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-12000.bin"),
        16000 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-16000.bin"),
        22050 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-22050.bin"),
        24000 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-24000.bin"),
        32000 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-32000.bin"),
        44100 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-44100.bin"),
        48000 => include_bytes!("../../../../../coefficients/full-speech-v1/hann-48000.bin"),
        _ => return None,
    };
    Some(read_values(b))
}
pub struct NativeMath;
impl RootMath for NativeMath {
    fn seed(&self, d: usize, i: usize) -> (f64, f64) {
        root_seed(d, i)
    }
    fn hypot(&self, a: f64, b: f64) -> f64 {
        a.hypot(b)
    }
}
impl super::FullMath for NativeMath {
    fn atan2(&self, y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
    fn ln(&self, x: f64) -> f64 {
        x.ln()
    }
    fn log10(&self, x: f64) -> f64 {
        x.log10()
    }
    fn sin(&self, x: f64) -> f64 {
        x.sin()
    }
}
