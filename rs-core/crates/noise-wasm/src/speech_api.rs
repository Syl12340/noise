//! Stateless, opt-in speech ABI. One owner and one pending result per instance.
use noise_core::speech::{
    PitchFrame, emphasize_float, pitch_track, pre_emphasis, resample_low_pass, yin_pitch_frame,
};
pub const INPUT_CAPACITY: usize = 262144;
pub const FRAME_CAPACITY: usize = 4096;
pub const PAIR_BUDGET: u64 = 150_000_000;
pub const OK: i32 = 0;
pub const BAD_ARGUMENT: i32 = -2;
pub const WOULD_BLOCK: i32 = -3;
pub const CAPACITY: i32 = -5;
pub const UNSUPPORTED: i32 = -7;

fn number(v: f64) -> String {
    if v.is_nan() {
        "\"NaN\"".into()
    } else if v == f64::INFINITY {
        "\"+Infinity\"".into()
    } else if v == f64::NEG_INFINITY {
        "\"-Infinity\"".into()
    } else {
        v.to_string()
    }
}
fn pitch_json(p: &PitchFrame) -> String {
    let mut text = format!(
        "{{\"f0\":{},\"aperiodicity\":{}",
        number(p.f0),
        number(p.aperiodicity)
    );
    if let Some(v) = p.raw_f0 {
        text.push_str(&format!(",\"rawF0\":{}", number(v)));
    }
    if let Some(v) = p.reason {
        text.push_str(&format!(",\"reason\":\"{v}\""));
    }
    if let Some((min, max)) = p.range {
        text.push_str(&format!(
            ",\"range\":{{\"min\":{},\"max\":{}}}",
            number(min),
            number(max)
        ));
    }
    if let Some(v) = p.range_boundary_adjusted {
        text.push_str(&format!(",\"rangeBoundaryAdjusted\":{v}"));
    }
    if let Some(v) = p.numeric_tolerance_hz {
        text.push_str(&format!(",\"numericToleranceHz\":{}", number(v)));
    }
    text.push('}');
    text
}
pub struct SpeechApi {
    json: Vec<u8>,
    floats: Vec<f32>,
    kind: u32,
    #[cfg(target_arch = "wasm32")]
    pcm: Vec<i16>,
    #[cfg(target_arch = "wasm32")]
    signal: Vec<f32>,
    #[cfg(target_arch = "wasm32")]
    frame: Vec<f64>,
}
impl Default for SpeechApi {
    fn default() -> Self {
        Self::new()
    }
}
impl SpeechApi {
    pub fn new() -> Self {
        Self {
            json: Vec::new(),
            floats: Vec::new(),
            kind: 0,
            #[cfg(target_arch = "wasm32")]
            pcm: vec![0; INPUT_CAPACITY],
            #[cfg(target_arch = "wasm32")]
            signal: vec![0.0; INPUT_CAPACITY],
            #[cfg(target_arch = "wasm32")]
            frame: vec![0.0; FRAME_CAPACITY],
        }
    }
    pub fn kind(&self) -> u32 {
        self.kind
    }
    pub fn json_result(&self) -> &[u8] {
        &self.json
    }
    pub fn float_result(&self) -> &[f32] {
        &self.floats
    }
    pub fn ack(&mut self) -> i32 {
        self.kind = 0;
        self.json.clear();
        self.floats.clear();
        OK
    }
    fn json(&mut self, text: String) -> i32 {
        assert!(text.len() <= 2 * 1024 * 1024);
        self.json = text.into_bytes();
        self.kind = 1;
        OK
    }
    fn floats(&mut self, output: Vec<f32>) -> i32 {
        assert!(output.len() <= INPUT_CAPACITY);
        self.floats = output;
        self.kind = 2;
        OK
    }
    pub fn pitch_frame(
        &mut self,
        frame: &[f64],
        fs: f64,
        threshold: f64,
        min: f64,
        max: f64,
    ) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if frame.len() > FRAME_CAPACITY {
            return CAPACITY;
        }
        if ![fs, threshold, min, max].iter().all(|v| v.is_finite())
            || !frame.iter().all(|v| v.is_finite())
        {
            return BAD_ARGUMENT;
        }
        self.json(pitch_json(&yin_pitch_frame(frame, fs, threshold, min, max)))
    }
    #[allow(clippy::too_many_arguments)] // Explicit baseline options at the verification boundary.
    pub fn track(
        &mut self,
        signal: &[f32],
        fs: f64,
        size: usize,
        hop: usize,
        threshold: f64,
        min: f64,
        max: f64,
    ) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if signal.len() > INPUT_CAPACITY || size > FRAME_CAPACITY {
            return CAPACITY;
        }
        if size == 0
            || hop == 0
            || fs <= 0.0
            || ![fs, threshold, min, max].iter().all(|v| v.is_finite())
            || !signal.iter().all(|v| v.is_finite())
        {
            return BAD_ARGUMENT;
        }
        let frames = if signal.len() < size {
            0
        } else {
            (signal.len() - size) / hop + 1
        };
        let half = (size / 2) as u64;
        if frames > 4096 || frames as u64 * half * half.saturating_sub(1) > PAIR_BUDGET {
            return CAPACITY;
        }
        let points = match pitch_track(signal, fs, size, hop, threshold, min, max) {
            Ok(p) => p,
            Err(_) => return BAD_ARGUMENT,
        };
        let mut text = String::from("[");
        for (i, p) in points.iter().enumerate() {
            if i > 0 {
                text.push(',');
            }
            let fields = pitch_json(&p.frame);
            text.push_str(&format!("{{\"time\":{},{}", number(p.time), &fields[1..]));
        }
        text.push(']');
        self.json(text)
    }
    pub fn pcm_emphasis(&mut self, pcm: &[i16], coef: f64) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if pcm.len() > INPUT_CAPACITY {
            return CAPACITY;
        }
        if !coef.is_finite() {
            return BAD_ARGUMENT;
        }
        self.floats(pre_emphasis(pcm, coef))
    }
    pub fn float_emphasis(&mut self, signal: &[f32], coef: f64) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if signal.len() > INPUT_CAPACITY {
            return CAPACITY;
        }
        if !coef.is_finite() || !signal.iter().all(|v| v.is_finite()) {
            return BAD_ARGUMENT;
        }
        self.floats(emphasize_float(signal, coef))
    }
    pub fn resample(&mut self, signal: &[f32], input: u32, output: u32, cutoff: f64) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if signal.len() > INPUT_CAPACITY {
            return CAPACITY;
        }
        if !signal.iter().all(|v| v.is_finite()) {
            return BAD_ARGUMENT;
        }
        if ![12000, 16000, 22050, 24000, 32000, 44100, 48000].contains(&input)
            || output != 12000
            || cutoff != 5500.0
        {
            return UNSUPPORTED;
        }
        match resample_low_pass(signal, input, output, cutoff) {
            Ok(v) => self.floats(v),
            Err(_) => UNSUPPORTED,
        }
    }
}
#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;
    use core::cell::{Cell, UnsafeCell};
    struct Slot {
        api: UnsafeCell<Option<SpeechApi>>,
        busy: Cell<bool>,
    }
    // SAFETY: gated single-thread WASM, no atomics/shared memory; reject reentry.
    unsafe impl Sync for Slot {}
    static SLOT: Slot = Slot {
        api: UnsafeCell::new(None),
        busy: Cell::new(false),
    };
    fn access<R>(f: impl FnOnce(&mut SpeechApi) -> R) -> R {
        if SLOT.busy.replace(true) {
            core::arch::wasm32::unreachable();
        }
        let api = unsafe { &mut *SLOT.api.get() }.get_or_insert_with(SpeechApi::new);
        let out = f(api);
        SLOT.busy.set(false);
        out
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_abi_version() -> u32 {
        1
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_input_capacity() -> u32 {
        INPUT_CAPACITY as u32
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_frame_capacity() -> u32 {
        FRAME_CAPACITY as u32
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_pcm_ptr() -> u32 {
        access(|a| a.pcm.as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_signal_ptr() -> u32 {
        access(|a| a.signal.as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_frame_ptr() -> u32 {
        access(|a| a.frame.as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_result_kind() -> u32 {
        access(|a| a.kind)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_result_ptr() -> u32 {
        access(|a| match a.kind {
            1 => a.json.as_ptr() as u32,
            2 => a.floats.as_ptr() as u32,
            _ => 0,
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_result_len() -> u32 {
        access(|a| match a.kind {
            1 => a.json.len() as u32,
            2 => (a.floats.len() * 4) as u32,
            _ => 0,
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_ack() -> i32 {
        access(SpeechApi::ack)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_pitch_frame(
        len: u32,
        fs: f64,
        threshold: f64,
        min: f64,
        max: f64,
    ) -> i32 {
        access(|a| {
            if len > FRAME_CAPACITY as u32 {
                return CAPACITY;
            }
            let input = a.frame[..len as usize].to_vec();
            a.pitch_frame(&input, fs, threshold, min, max)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_track(
        len: u32,
        fs: f64,
        size: u32,
        hop: u32,
        threshold: f64,
        min: f64,
        max: f64,
    ) -> i32 {
        access(|a| {
            if len > INPUT_CAPACITY as u32 {
                return CAPACITY;
            }
            let input = a.signal[..len as usize].to_vec();
            a.track(&input, fs, size as usize, hop as usize, threshold, min, max)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_pcm_emphasis(len: u32, coef: f64) -> i32 {
        access(|a| {
            if len > INPUT_CAPACITY as u32 {
                return CAPACITY;
            }
            let input = a.pcm[..len as usize].to_vec();
            a.pcm_emphasis(&input, coef)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_float_emphasis(len: u32, coef: f64) -> i32 {
        access(|a| {
            if len > INPUT_CAPACITY as u32 {
                return CAPACITY;
            }
            let input = a.signal[..len as usize].to_vec();
            a.float_emphasis(&input, coef)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_resample(len: u32, input: u32, output: u32, cutoff: f64) -> i32 {
        access(|a| {
            if len > INPUT_CAPACITY as u32 {
                return CAPACITY;
            }
            let signal = a.signal[..len as usize].to_vec();
            a.resample(&signal, input, output, cutoff)
        })
    }
}
