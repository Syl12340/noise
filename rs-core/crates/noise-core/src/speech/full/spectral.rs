use super::{FullMath, js_round, tables};
pub struct SpectrogramSession {
    signal: Vec<f32>,
    fs: u32,
    window: Vec<f64>,
    hop: usize,
    total: usize,
    cursor: usize,
    columns: Vec<Vec<f32>>,
    times: Vec<f64>,
}
impl SpectrogramSession {
    pub fn new(signal: Vec<f32>, fs: u32) -> Result<Self, &'static str> {
        if signal.len() > 262144 || !signal.iter().all(|v| v.is_finite()) {
            return Err("invalid spectrogram input");
        }
        let window = tables::hann(fs).ok_or("unsupported spectrogram rate")?;
        let hop = js_round(fs as f64 * 0.002) as usize;
        let total = if signal.len() < window.len() {
            0
        } else {
            (signal.len() - window.len()) / hop + 1
        };
        if total * 512 > 1_500_000 {
            return Err("spectrogram capacity");
        }
        Ok(Self {
            signal,
            fs,
            window,
            hop,
            total,
            cursor: 0,
            columns: Vec::with_capacity(total),
            times: Vec::with_capacity(total),
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
    pub fn columns(&self) -> &[Vec<f32>] {
        &self.columns
    }
    pub fn times(&self) -> &[f64] {
        &self.times
    }
    pub fn step(&mut self, math: &impl FullMath) -> Option<(f64, Vec<f32>)> {
        if self.done() {
            return None;
        }
        let start = self.cursor * self.hop;
        let time = (start as f64 + self.window.len() as f64 / 2.0) / self.fs as f64;
        let mut re = vec![0.0; 1024];
        let mut im = vec![0.0; 1024];
        for (i, w) in self.window.iter().enumerate() {
            re[i] = self.signal[start + i] as f64 * w;
        }
        crate::speech::generic_fft::fft(&mut re, &mut im);
        let scale = 2.0 / (self.window.len() as f64 * 0.5);
        let mut column = Vec::with_capacity(512);
        for k in 0..512 {
            let power = re[k] * re[k] + im[k] * im[k];
            let rms = power.sqrt() * scale / std::f64::consts::SQRT_2;
            let db = 20.0 * math.log10(rms.max(1e-12));
            let db = (-80.0f64).max(0.0f64.min(db));
            column.push(((db - (-80.0)) / (0.0 - (-80.0))) as f32);
        }
        self.cursor += 1;
        self.times.push(time);
        self.columns.push(column.clone());
        Some((time, column))
    }
}
