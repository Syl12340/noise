//! # noise-core: Phase 0A Experimental Probe Engine
//!
//! Phase 0A Hello-DSP verification probe.
//! This crate implements the core memory buffer logic and probe ABI v1 for Phase 0A.
//!
//! IMPORTANT:
//! - This is an experimental verification probe, NOT production acoustic DSP.
//! - Default feature set retains the no_std, zero-allocation 0A probe.
//! - The separate `acoustics` feature provides the isolated legacy noise port.

#![cfg_attr(not(feature = "acoustics"), no_std)]

#[cfg(feature = "acoustics")]
pub mod acoustics;

#[cfg(feature = "speech")]
pub mod speech;

#[cfg(test)]
extern crate std;

/// Fixed capacity of probe input/output buffers (in f32 elements).
pub const PROBE_CAPACITY: usize = 4096;

/// Phase 0A Probe ABI Version.
pub const PROBE_ABI_VERSION: u32 = 1;

/// Error code: Operation succeeded.
pub const PROBE_ERR_OK: i32 = 0;
/// Error code: Requested length exceeds probe capacity.
pub const PROBE_ERR_LEN_OVERFLOW: i32 = -1;
/// Error code: Gain multiplier is not a finite f32 (NaN or ±Inf).
pub const PROBE_ERR_NON_FINITE_GAIN: i32 = -2;
/// Error code: Input buffer contains non-finite f32 values (NaN or ±Inf).
pub const PROBE_ERR_NON_FINITE_INPUT: i32 = -3;
/// Error code: Computed product overflows to a non-finite f32 (NaN or ±Inf).
pub const PROBE_ERR_NON_FINITE_PRODUCT: i32 = -4;

/// Dedicated probe buffers holding fixed-size input and output arrays.
///
/// Guaranteed to be 4-byte aligned for direct TypedArray mapping in WebAssembly.
#[repr(C, align(4))]
pub struct ProbeBuffers {
    input: [f32; PROBE_CAPACITY],
    output: [f32; PROBE_CAPACITY],
}

impl Default for ProbeBuffers {
    fn default() -> Self {
        Self::new()
    }
}

impl ProbeBuffers {
    /// Creates a new `ProbeBuffers` instance initialized with all zeros.
    pub const fn new() -> Self {
        Self {
            input: [0.0; PROBE_CAPACITY],
            output: [0.0; PROBE_CAPACITY],
        }
    }

    /// Resets all elements in both input and output buffers to 0.0.
    pub fn reset(&mut self) {
        self.input.fill(0.0);
        self.output.fill(0.0);
    }

    /// Returns a shared reference to the input buffer array.
    pub fn input(&self) -> &[f32; PROBE_CAPACITY] {
        &self.input
    }

    /// Returns a mutable reference to the input buffer array.
    pub fn input_mut(&mut self) -> &mut [f32; PROBE_CAPACITY] {
        &mut self.input
    }

    /// Returns a shared reference to the output buffer array.
    pub fn output(&self) -> &[f32; PROBE_CAPACITY] {
        &self.output
    }

    /// Returns a mutable reference to the output buffer array.
    pub fn output_mut(&mut self) -> &mut [f32; PROBE_CAPACITY] {
        &mut self.output
    }

    /// Returns the raw pointer to the input buffer (native pointer width, no truncation).
    pub fn input_ptr(&self) -> *const f32 {
        self.input.as_ptr()
    }

    /// Returns the raw pointer to the output buffer (native pointer width, no truncation).
    pub fn output_ptr(&self) -> *const f32 {
        self.output.as_ptr()
    }

    /// Returns the native byte address of the input buffer as `usize`.
    pub fn input_addr(&self) -> usize {
        self.input.as_ptr() as usize
    }

    /// Returns the native byte address of the output buffer as `usize`.
    pub fn output_addr(&self) -> usize {
        self.output.as_ptr() as usize
    }

    /// Returns the maximum capacity in elements (4096).
    pub const fn capacity(&self) -> usize {
        PROBE_CAPACITY
    }

    /// Returns the ABI version (1).
    pub const fn abi_version(&self) -> u32 {
        PROBE_ABI_VERSION
    }

    /// Processes `len` elements from `input` by multiplying each by `gain`,
    /// writing the results into `output`.
    ///
    /// Validation rules per Phase 0A ABI v1:
    /// - Checks `len <= PROBE_CAPACITY` as u32 first before any slice or cast (-1 if violated)
    /// - Checks `gain.is_finite()` (-2 if violated)
    /// - If `len == 0`, returns 0 immediately without modifying output
    /// - Checks all `input[0..len]` are finite (-3 if any is NaN/±Inf)
    /// - Checks all `(input[i] * gain)` are finite (-4 if any is NaN/±Inf)
    /// - Output is ONLY modified after all validations pass (all-or-nothing commit).
    /// - Samples after `len` in the output buffer remain completely untouched.
    pub fn process(&mut self, len: u32, gain: f32) -> i32 {
        // Step 1: Explicit boundary check before conversion or slicing
        if len > PROBE_CAPACITY as u32 {
            return PROBE_ERR_LEN_OVERFLOW;
        }

        // Safe conversion to usize since len <= 4096 fits on any platform (16/32/64-bit)
        let n = len as usize;

        // Step 2: Validate gain finiteness
        if !gain.is_finite() {
            return PROBE_ERR_NON_FINITE_GAIN;
        }

        // Step 3: Handle len = 0 (valid, zero-length operation, output untouched)
        if n == 0 {
            return PROBE_ERR_OK;
        }

        // Step 4: Full validation pass: inspect all input values
        for &sample in &self.input[..n] {
            if !sample.is_finite() {
                return PROBE_ERR_NON_FINITE_INPUT;
            }
        }

        // Step 5: Full validation pass: inspect all products
        for &sample in &self.input[..n] {
            let product = sample * gain;
            if !product.is_finite() {
                return PROBE_ERR_NON_FINITE_PRODUCT;
            }
        }

        // Step 6: All checks passed: commit results to output[..n]
        for i in 0..n {
            self.output[i] = self.input[i] * gain;
        }

        PROBE_ERR_OK
    }
}
