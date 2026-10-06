//! Opt-in legacy noise ABI. No application or recording integration.
use noise_core::acoustics::{AcousticEvent, MAX_CHUNK_SAMPLES, NoiseEngine, ProcessError};

mod wire {
    include!("acoustics_wire.rs");
}
pub const ABI_VERSION: u32 = 1;
pub const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SESSIONS: usize = 4;
pub const OK: i32 = 0;
pub const BAD_HANDLE: i32 = -1;
pub const BAD_ARGUMENT: i32 = -2;
pub const WOULD_BLOCK: i32 = -3;
pub const BAD_SEQUENCE: i32 = -4;
pub const EVENT_CAPACITY: i32 = -5;
pub const REGISTRY_FULL: i32 = -6;

/// Owned native-testable state; shared staging input belongs to the WASM instance.
pub struct Registry {
    sessions: Vec<(u32, NoiseEngine)>,
    next_handle: u64,
    result: Vec<u8>,
    pending: bool,
    pub last_status: i32,
    #[cfg(target_arch = "wasm32")]
    input: Vec<i16>,
}
impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}
impl Registry {
    pub fn new() -> Self {
        Self {
            sessions: Vec::new(),
            next_handle: 1,
            result: Vec::new(),
            pending: false,
            last_status: OK,
            #[cfg(target_arch = "wasm32")]
            input: vec![0; MAX_CHUNK_SAMPLES],
        }
    }
    pub fn result(&self) -> &[u8] {
        &self.result
    }
    pub fn has_result(&self) -> bool {
        self.pending
    }
    pub fn ack(&mut self) -> i32 {
        self.pending = false;
        self.result.clear();
        self.status(OK)
    }
    fn status(&mut self, code: i32) -> i32 {
        self.last_status = code;
        code
    }
    fn index(&mut self, handle: u32) -> Result<usize, i32> {
        if self.pending {
            return Err(self.status(WOULD_BLOCK));
        }
        self.sessions
            .iter()
            .position(|(h, _)| *h == handle)
            .ok_or_else(|| self.status(BAD_HANDLE))
    }
    fn publish(&mut self, result: String) -> i32 {
        // A size failure after a committed operation is a fatal instance failure,
        // never a recoverable code that invites duplicate processing.
        assert!(
            result.len() <= MAX_RESULT_BYTES,
            "noise result exceeds ABI capacity"
        );
        self.result = result.into_bytes();
        self.pending = true;
        self.status(OK)
    }
    pub fn create(&mut self, offset: f64, capacity: u32) -> u32 {
        if self.pending {
            self.status(WOULD_BLOCK);
            return 0;
        }
        if !offset.is_finite() || !(1..=128).contains(&capacity) {
            self.status(BAD_ARGUMENT);
            return 0;
        }
        if self.sessions.len() >= MAX_SESSIONS || self.next_handle > u32::MAX as u64 {
            self.status(REGISTRY_FULL);
            return 0;
        }
        let handle = self.next_handle as u32;
        self.next_handle += 1;
        self.sessions.push((
            handle,
            NoiseEngine::with_capacity(offset, capacity as usize),
        ));
        self.status(OK);
        handle
    }
    pub fn destroy(&mut self, handle: u32) -> i32 {
        let index = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        self.sessions.swap_remove(index);
        self.status(OK)
    }
    pub fn process(&mut self, handle: u32, seq: u32, pcm: &[i16], needed: u32) -> i32 {
        let index = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        if pcm.len() > MAX_CHUNK_SAMPLES || needed > 1 {
            return self.status(BAD_ARGUMENT);
        }
        let engine = &mut self.sessions[index].1;
        match engine.process_chunk(seq, pcm, needed == 1) {
            Ok(receipt) => {
                let output = format!(
                    "{{\"receipt\":{},\"snapshot\":{}}}",
                    wire::json_receipt(&receipt),
                    wire::json_snapshot(&engine.snapshot())
                );
                self.publish(output)
            }
            Err(error) => self.status(match error {
                ProcessError::WouldBlock => WOULD_BLOCK,
                ProcessError::EventCapacityExceeded { .. } => EVENT_CAPACITY,
                ProcessError::CapacityExceeded { .. } => BAD_ARGUMENT,
                ProcessError::InvalidSequence { .. } | ProcessError::SequenceOverflow { .. } => {
                    BAD_SEQUENCE
                }
            }),
        }
    }
    pub fn snapshot(&mut self, handle: u32) -> i32 {
        let i = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        self.publish(wire::json_snapshot(&self.sessions[i].1.snapshot()))
    }
    pub fn query(&mut self, handle: u32) -> i32 {
        let i = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        let result = self.sessions[i]
            .1
            .query_spectrum()
            .map(|s| wire::json_spectrum(&s))
            .unwrap_or_else(|| "null".into());
        self.publish(result)
    }
    pub fn next_event(&mut self, handle: u32) -> i32 {
        let i = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        let result = match self.sessions[i].1.peek_event() {
            Some(AcousticEvent::SecondWindow(w)) => wire::json_second_window(w),
            Some(AcousticEvent::Spectrum(s)) => wire::json_spectrum(s),
            None => "null".into(),
        };
        assert!(result.len() <= MAX_RESULT_BYTES);
        self.sessions[i].1.pop_event();
        self.publish(result)
    }
    pub fn finish(&mut self, handle: u32, invalid: u32) -> i32 {
        let i = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        if invalid > 1 {
            return self.status(BAD_ARGUMENT);
        }
        let s = self.sessions[i].1.finish(invalid == 1);
        self.publish(wire::json_final(
            s.total_samples,
            s.a_energy,
            s.leq_a,
            &s.disposition,
            s.termination_reason.as_deref(),
            s.tail.as_ref(),
        ))
    }
    pub fn invalidate(&mut self, handle: u32, reason: u32) -> i32 {
        let i = match self.index(handle) {
            Ok(i) => i,
            Err(e) => return e,
        };
        let text = match reason {
            0 => "invalid_format",
            1 => "system_interruption",
            2 => "stop_timeout",
            3 => "stream_discontinuity",
            _ => return self.status(BAD_ARGUMENT),
        };
        self.sessions[i].1.hard_invalid(text);
        self.publish(wire::json_snapshot(&self.sessions[i].1.snapshot()))
    }
}

// Never compiled on a native multi-thread host. Atomics are rejected in lib.rs.
#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;
    use core::cell::{Cell, UnsafeCell};
    struct Slot {
        registry: UnsafeCell<Option<Registry>>,
        busy: Cell<bool>,
    }
    // SAFETY: single-thread WASM, no shared memory, guarded non-reentrant calls.
    unsafe impl Sync for Slot {}
    static SLOT: Slot = Slot {
        registry: UnsafeCell::new(None),
        busy: Cell::new(false),
    };
    fn access<R>(f: impl FnOnce(&mut Registry) -> R) -> R {
        if SLOT.busy.replace(true) {
            core::arch::wasm32::unreachable();
        }
        // SAFETY: exclusive access until busy is cleared; no callbacks/imports.
        let registry = unsafe { &mut *SLOT.registry.get() }.get_or_insert_with(Registry::new);
        let result = f(registry);
        SLOT.busy.set(false);
        result
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_abi_version() -> u32 {
        ABI_VERSION
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_input_capacity() -> u32 {
        MAX_CHUNK_SAMPLES as u32
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_input_ptr() -> u32 {
        access(|r| r.input.as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_result_ptr() -> u32 {
        access(|r| {
            if r.pending {
                r.result.as_ptr() as u32
            } else {
                0
            }
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_result_len() -> u32 {
        access(|r| r.result.len() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_has_result() -> u32 {
        access(|r| r.pending as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_last_status() -> i32 {
        access(|r| r.last_status)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_ack() -> i32 {
        access(Registry::ack)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_create(offset: f64, capacity: u32) -> u32 {
        access(|r| r.create(offset, capacity))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_destroy(h: u32) -> i32 {
        access(|r| r.destroy(h))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_process(h: u32, seq: u32, len: u32, needed: u32) -> i32 {
        access(|r| {
            if len > MAX_CHUNK_SAMPLES as u32 {
                return r.status(BAD_ARGUMENT);
            }
            let pcm = r.input[..len as usize].to_vec();
            r.process(h, seq, &pcm, needed)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_snapshot(h: u32) -> i32 {
        access(|r| r.snapshot(h))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_query(h: u32) -> i32 {
        access(|r| r.query(h))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_next_event(h: u32) -> i32 {
        access(|r| r.next_event(h))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_finish(h: u32, invalid: u32) -> i32 {
        access(|r| r.finish(h, invalid))
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_invalidate(h: u32, reason: u32) -> i32 {
        access(|r| r.invalidate(h, reason))
    }
}
