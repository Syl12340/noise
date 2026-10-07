//! # noise-wasm: Phase 0A WebAssembly Probe Export Layer
//!
//! Exposes Phase 0A ABI v1 C-FFI exports for WebAssembly host verification.
//!
//! IMPORTANT:
//! - Experimental probe only. Does not contain production acoustic DSP.
//! - Single-instance memory architecture: fixed 4096-sample f32 input & output.
//! - Built with `#![no_std]` on wasm targets with panic = abort.
//! - Complies with Rust 2024 edition requirements (`#[unsafe(no_mangle)]`).

#![cfg_attr(all(target_arch = "wasm32", not(feature = "acoustics")), no_std)]

#[cfg(feature = "acoustics")]
pub mod acoustics_api;
#[cfg(feature = "harmonicity")]
pub mod harmonicity_api;
#[cfg(feature = "harmonicity")]
pub mod segments_api;
#[cfg(feature = "speech")]
pub mod speech_api;

// Compile error if WebAssembly atomics or shared memory is enabled
#[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
compile_error!("noise-wasm requires single-threaded WebAssembly without atomics/shared-memory");

/// Returns the Phase 0A probe ABI version (1).
/// Pure metadata function, safe and available across all targets.
#[unsafe(no_mangle)]
pub extern "C" fn probe_abi_version() -> u32 {
    noise_core::PROBE_ABI_VERSION
}

/// Returns the fixed capacity of the probe buffers (4096).
/// Pure metadata function, safe and available across all targets.
#[unsafe(no_mangle)]
pub extern "C" fn probe_capacity() -> u32 {
    noise_core::PROBE_CAPACITY as u32
}

#[cfg(all(target_arch = "wasm32", not(feature = "acoustics")))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// -----------------------------------------------------------------------------
// WASM-only C-FFI stateful buffer exports
// Strictly gated to wasm32 without atomics: never compiled on native hosts.
// -----------------------------------------------------------------------------
#[cfg(all(target_arch = "wasm32", not(target_feature = "atomics")))]
mod wasm_state {
    use core::cell::{Cell, UnsafeCell};
    use noise_core::ProbeBuffers;

    pub struct WasmProbeSlot {
        pub buffers: UnsafeCell<ProbeBuffers>,
        pub busy: Cell<bool>,
    }

    // SAFETY:
    // 1. WebAssembly execution on wasm32v1-none is single-threaded with no shared memory
    //    and no background OS threads.
    // 2. The `Cell<bool>` flag guards against re-entrant calls from the host.
    // 3. Interior mutability via `UnsafeCell` avoids deprecated and UB-prone `static mut` references.
    // 4. This slot is strictly gated to wasm32 without atomics, eliminating any native data races.
    unsafe impl Sync for WasmProbeSlot {}

    pub static PROBE_INSTANCE: WasmProbeSlot = WasmProbeSlot {
        buffers: UnsafeCell::new(ProbeBuffers::new()),
        busy: Cell::new(false),
    };
}

#[cfg(all(target_arch = "wasm32", not(target_feature = "atomics")))]
pub use wasm_ffi_exports::*;

#[cfg(all(target_arch = "wasm32", not(target_feature = "atomics")))]
mod wasm_ffi_exports {
    use super::wasm_state::PROBE_INSTANCE;

    /// Returns the byte offset of the input buffer in WebAssembly linear memory.
    /// The address is guaranteed to be 4-byte aligned and fits within u32 in wasm32.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_input_ptr() -> u32 {
        let addr = unsafe { (*PROBE_INSTANCE.buffers.get()).input_addr() };
        u32::try_from(addr).expect("wasm32 linear memory address must fit in u32")
    }

    /// Returns the byte offset of the output buffer in WebAssembly linear memory.
    /// The address is guaranteed to be 4-byte aligned and fits within u32 in wasm32.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_output_ptr() -> u32 {
        let addr = unsafe { (*PROBE_INSTANCE.buffers.get()).output_addr() };
        u32::try_from(addr).expect("wasm32 linear memory address must fit in u32")
    }

    /// Processes `len` elements by multiplying each input element by `gain`.
    ///
    /// Returns:
    ///   0: Success
    ///  -1: Length exceeds capacity (4096)
    ///  -2: Non-finite gain multiplier
    ///  -3: Non-finite input sample
    ///  -4: Non-finite product (overflow)
    ///
    /// Traps via `wasm unreachable` if re-entrant execution is detected on the same instance.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_process(len: u32, gain: f32) -> i32 {
        if PROBE_INSTANCE.busy.get() {
            // Re-entrant call detected on the same instance: fail-fast via trap
            core::arch::wasm32::unreachable();
        }

        PROBE_INSTANCE.busy.set(true);
        let result = unsafe { (*PROBE_INSTANCE.buffers.get()).process(len, gain) };
        PROBE_INSTANCE.busy.set(false);
        result
    }

    /// Clears both input and output buffers to zero.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_reset() {
        if PROBE_INSTANCE.busy.get() {
            core::arch::wasm32::unreachable();
        }

        PROBE_INSTANCE.busy.set(true);
        unsafe { (*PROBE_INSTANCE.buffers.get()).reset() };
        PROBE_INSTANCE.busy.set(false);
    }

    /// Fault injection endpoint: deliberately triggers a WebAssembly `unreachable` trap.
    ///
    /// Per Phase 0A contract, after a trap occurs, the host MUST invalidate the instance
    /// and construct a new WebAssembly instance for subsequent operations.
    #[unsafe(no_mangle)]
    pub extern "C" fn probe_force_trap() {
        core::arch::wasm32::unreachable();
    }
}
