use noise_core::ProbeBuffers;
use noise_wasm::{probe_abi_version, probe_capacity};

#[test]
fn test_wasm_metadata_exports() {
    assert_eq!(probe_abi_version(), 1);
    assert_eq!(probe_capacity(), 4096);
}

#[test]
fn test_native_probe_buffers_instance_safety() {
    // Native integration tests exclusively use owned ProbeBuffers instances.
    // Static FFI buffers are strictly gated to single-threaded wasm32 to prevent
    // any multi-threaded data races or undefined behavior on native test runners.
    let mut probe = ProbeBuffers::new();
    assert_eq!(probe.abi_version(), 1);
    assert_eq!(probe.capacity(), 4096);

    let in_addr = probe.input_addr();
    let out_addr = probe.output_addr();

    assert_eq!(in_addr % 4, 0, "Input pointer must be 4-byte aligned");
    assert_eq!(out_addr % 4, 0, "Output pointer must be 4-byte aligned");
    assert_ne!(in_addr, out_addr, "Pointers must not be identical");

    probe.reset();

    // Process 0 elements
    let res = probe.process(0, 1.0);
    assert_eq!(res, 0);

    // Process overflow
    let res = probe.process(5000, 1.0);
    assert_eq!(res, -1);
}
