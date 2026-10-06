//! Opt-in speech ABI and owned HNR sessions. One owner and one pending result per instance.
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
    #[cfg(target_arch = "wasm32")]
    support_intervals: Vec<f64>,
    #[cfg(all(target_arch = "wasm32", feature = "harmonicity"))]
    pitch_evidence: Vec<f64>,
    #[cfg(feature = "harmonicity")]
    hnr_sessions: Vec<(u32, noise_core::speech::hnr_session::HnrSession)>,
    #[cfg(feature = "harmonicity")]
    next_hnr_handle: u64,
    #[cfg(all(target_arch = "wasm32", feature = "harmonicity"))]
    session_pitch: Vec<f64>,
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
            #[cfg(target_arch = "wasm32")]
            support_intervals: vec![0.0; 2 * FRAME_CAPACITY],
            #[cfg(all(target_arch = "wasm32", feature = "harmonicity"))]
            pitch_evidence: vec![0.0; 3 * crate::harmonicity_api::MAX_PITCH_ROWS],
            #[cfg(feature = "harmonicity")]
            hnr_sessions: Vec::new(),
            #[cfg(feature = "harmonicity")]
            next_hnr_handle: 1,
            #[cfg(all(target_arch = "wasm32", feature = "harmonicity"))]
            session_pitch: vec![0.0; 3 * noise_core::speech::hnr_session::MAX_PITCH_ROWS],
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
    pub fn support_evidence(
        &mut self,
        times: &[f64],
        window: f64,
        margin: f64,
        duration: f64,
        intervals: &[noise_core::speech::time_support::Interval],
    ) -> i32 {
        use noise_core::speech::time_support::assess_support;
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        let rows = match assess_support(times, window, margin, duration, intervals) {
            Ok(r) => r,
            Err("support capacity exceeded") => return CAPACITY,
            Err(_) => return BAD_ARGUMENT,
        };
        let mut text = String::from("[");
        for (i, r) in rows.iter().enumerate() {
            if i > 0 {
                text.push(',');
            }
            text.push_str(&format!(
                "{{\"time\":{},\"support\":{{\"start\":{},\"end\":{}}},\"incompleteFilterSupport\":{},\"clipped\":{}}}",
                number(r.time), number(r.support.start), number(r.support.end), r.incomplete_filter_support, r.clipped
            ));
        }
        text.push(']');
        self.json(text)
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
    #[cfg(feature = "harmonicity")]
    pub fn harmonicity_with_sin(
        &mut self,
        signal: &[f32],
        fs: f64,
        opts: &noise_core::speech::harmonicity::HarmonicityOptions,
        pitch: &[noise_core::speech::harmonicity::PitchEvidence],
        sin: &impl Fn(f64) -> f64,
    ) -> i32 {
        use noise_core::speech::{fractional::WorkBudget, harmonicity::estimate_harmonicity};
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if signal.len() > crate::harmonicity_api::MAX_HNR_SAMPLES
            || pitch.len() > crate::harmonicity_api::MAX_PITCH_ROWS
        {
            return CAPACITY;
        }
        if opts.frame_size == 0 || opts.hop == 0 {
            return BAD_ARGUMENT;
        }
        let frames = if signal.len() < opts.frame_size {
            0
        } else {
            (signal.len() - opts.frame_size) / opts.hop + 1
        };
        if frames > 128 {
            return CAPACITY;
        }
        let mut budget = WorkBudget::new(PAIR_BUDGET);
        match estimate_harmonicity(signal, fs, opts, pitch, sin, &mut budget) {
            Ok(result) => self.json(crate::harmonicity_api::result(&result)),
            Err("work budget exceeded") => CAPACITY,
            Err(_) => BAD_ARGUMENT,
        }
    }
    #[cfg(feature = "harmonicity")]
    pub fn hnr_begin(
        &mut self,
        signal: &[f32],
        fs: f64,
        opts: noise_core::speech::harmonicity::HarmonicityOptions,
        pitch: &[noise_core::speech::harmonicity::PitchEvidence],
    ) -> i32 {
        use noise_core::speech::hnr_session::{HnrSession, MAX_PITCH_ROWS};
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        if self.hnr_sessions.len() >= 2 || self.next_hnr_handle > u32::MAX as u64 {
            return -6;
        }
        if signal.len() > INPUT_CAPACITY || pitch.len() > MAX_PITCH_ROWS {
            return CAPACITY;
        }
        let session = match HnrSession::new(signal.to_vec(), fs, opts, pitch.to_vec()) {
            Ok(s) => s,
            Err("session capacity exceeded") => return CAPACITY,
            Err(_) => return BAD_ARGUMENT,
        };
        let total = session.total_frames();
        let h = self.next_hnr_handle as u32;
        self.next_hnr_handle += 1;
        self.hnr_sessions.push((h, session));
        self.json(format!(
            "{{\"handle\":{h},\"total\":{total},\"completed\":0,\"done\":{}}}",
            total == 0
        ))
    }
    #[cfg(feature = "harmonicity")]
    pub fn hnr_next(&mut self, h: u32, sin: &impl Fn(f64) -> f64) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        let Some((_, s)) = self.hnr_sessions.iter_mut().find(|(id, _)| *id == h) else {
            return -1;
        };
        let text = match s.next(sin) {
            Ok(Some(r)) => format!(
                "{{\"state\":\"frame\",\"index\":{},\"completed\":{},\"total\":{},\"done\":{},\"row\":{}}}",
                r.index,
                r.completed,
                r.total,
                r.done,
                crate::harmonicity_api::row(&r.row)
            ),
            Ok(None) => format!(
                "{{\"state\":\"complete\",\"completed\":{},\"total\":{},\"done\":true}}",
                s.completed_frames(),
                s.total_frames()
            ),
            Err("work budget exceeded") => return CAPACITY,
            Err(_) => return BAD_ARGUMENT,
        };
        self.json(text)
    }
    #[cfg(feature = "harmonicity")]
    pub fn hnr_finish(&mut self, h: u32) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        let Some((_, s)) = self.hnr_sessions.iter_mut().find(|(id, _)| *id == h) else {
            return -1;
        };
        let text = match s.finish() {
            Ok(r) => crate::harmonicity_api::result(r),
            Err("session incomplete") => return -8,
            Err("work budget exceeded") => return CAPACITY,
            Err(_) => return BAD_ARGUMENT,
        };
        self.json(text)
    }
    #[cfg(feature = "harmonicity")]
    pub fn hnr_cancel(&mut self, h: u32) -> i32 {
        if self.kind != 0 {
            return WOULD_BLOCK;
        }
        let Some(i) = self.hnr_sessions.iter().position(|(id, _)| *id == h) else {
            return -1;
        };
        self.hnr_sessions.swap_remove(i);
        OK
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
    pub extern "C" fn speech_support_abi_version() -> u32 {
        1
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_support_interval_capacity() -> u32 {
        FRAME_CAPACITY as u32
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_support_intervals_ptr() -> u32 {
        access(|a| a.support_intervals.as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_support_evidence(
        len: u32,
        window: f64,
        margin: f64,
        duration: f64,
        count: u32,
    ) -> i32 {
        access(|a| {
            if a.kind != 0 {
                return WOULD_BLOCK;
            }
            if len > FRAME_CAPACITY as u32 || count > FRAME_CAPACITY as u32 {
                return CAPACITY;
            }
            let times = a.frame[..len as usize].to_vec();
            let intervals = a.support_intervals[..count as usize * 2]
                .chunks_exact(2)
                .map(|p| noise_core::speech::time_support::Interval {
                    start: p[0],
                    end: p[1],
                })
                .collect::<Vec<_>>();
            a.support_evidence(&times, window, margin, duration, &intervals)
        })
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
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_input_capacity() -> u32 {
        crate::harmonicity_api::MAX_HNR_SAMPLES as u32
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_pitch_capacity() -> u32 {
        crate::harmonicity_api::MAX_PITCH_ROWS as u32
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_pitch_ptr() -> u32 {
        access(|a| a.pitch_evidence.as_ptr() as u32)
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_harmonicity(
        len: u32,
        fs: f64,
        size: u32,
        hop: u32,
        min: f64,
        max: f64,
        require: u32,
        min_corr: f64,
        deviation: f64,
        pitch_len: u32,
    ) -> i32 {
        access(|a| {
            if len > crate::harmonicity_api::MAX_HNR_SAMPLES as u32
                || pitch_len > crate::harmonicity_api::MAX_PITCH_ROWS as u32
            {
                return CAPACITY;
            }
            if require > 1 {
                return BAD_ARGUMENT;
            }
            let signal = a.signal[..len as usize].to_vec();
            let pitch = a.pitch_evidence[..pitch_len as usize * 3]
                .chunks_exact(3)
                .map(|p| noise_core::speech::harmonicity::PitchEvidence {
                    time: p[0],
                    f0: p[1],
                    aperiodicity: p[2],
                })
                .collect::<Vec<_>>();
            let opts = noise_core::speech::harmonicity::HarmonicityOptions {
                frame_size: size as usize,
                hop: hop as usize,
                fmin: min,
                fmax: max,
                require_pitch: require == 1,
                min_peak_correlation: min_corr,
                max_pitch_deviation: deviation,
            };
            a.harmonicity_with_sin(
                &signal,
                fs,
                &opts,
                &pitch,
                &crate::harmonicity_api::runtime_sin,
            )
        })
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_session_abi_version() -> u32 {
        1
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_session_pitch_capacity() -> u32 {
        noise_core::speech::hnr_session::MAX_PITCH_ROWS as u32
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_session_pitch_ptr() -> u32 {
        access(|a| a.session_pitch.as_ptr() as u32)
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_begin(
        len: u32,
        fs: f64,
        size: u32,
        hop: u32,
        min: f64,
        max: f64,
        require: u32,
        min_corr: f64,
        deviation: f64,
        pitch_len: u32,
    ) -> i32 {
        access(|a| {
            if len > INPUT_CAPACITY as u32
                || pitch_len > noise_core::speech::hnr_session::MAX_PITCH_ROWS as u32
            {
                return CAPACITY;
            }
            if require > 1 {
                return BAD_ARGUMENT;
            }
            let signal = a.signal[..len as usize].to_vec();
            let pitch = a.session_pitch[..pitch_len as usize * 3]
                .chunks_exact(3)
                .map(|p| noise_core::speech::harmonicity::PitchEvidence {
                    time: p[0],
                    f0: p[1],
                    aperiodicity: p[2],
                })
                .collect::<Vec<_>>();
            let opts = noise_core::speech::harmonicity::HarmonicityOptions {
                frame_size: size as usize,
                hop: hop as usize,
                fmin: min,
                fmax: max,
                require_pitch: require == 1,
                min_peak_correlation: min_corr,
                max_pitch_deviation: deviation,
            };
            a.hnr_begin(&signal, fs, opts, &pitch)
        })
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_next(h: u32) -> i32 {
        access(|a| a.hnr_next(h, &crate::harmonicity_api::runtime_sin))
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_finish(h: u32) -> i32 {
        access(|a| a.hnr_finish(h))
    }
    #[cfg(feature = "harmonicity")]
    #[unsafe(no_mangle)]
    pub extern "C" fn speech_hnr_cancel(h: u32) -> i32 {
        access(|a| a.hnr_cancel(h))
    }
}
