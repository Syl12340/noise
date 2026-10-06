use noise_core::{
    PROBE_ABI_VERSION, PROBE_CAPACITY, PROBE_ERR_LEN_OVERFLOW, PROBE_ERR_NON_FINITE_GAIN,
    PROBE_ERR_NON_FINITE_INPUT, PROBE_ERR_NON_FINITE_PRODUCT, PROBE_ERR_OK, ProbeBuffers,
};

#[test]
fn test_abi_version_and_capacity() {
    let probe = ProbeBuffers::new();
    assert_eq!(probe.abi_version(), PROBE_ABI_VERSION);
    assert_eq!(probe.abi_version(), 1);
    assert_eq!(probe.capacity(), PROBE_CAPACITY);
    assert_eq!(probe.capacity(), 4096);
}

#[test]
fn test_frozen_vector_exact_bitwise() {
    let mut probe = ProbeBuffers::new();
    let frozen_input: [f32; 5] = [-1.0, -0.5, 0.0, 0.25, 1.0];
    let gain: f32 = 0.5;
    let expected: [f32; 5] = [-0.5, -0.25, 0.0, 0.125, 0.5];

    probe.input_mut()[..5].copy_from_slice(&frozen_input);

    let res = probe.process(5, gain);
    assert_eq!(res, PROBE_ERR_OK);

    for (i, exp) in expected.iter().enumerate() {
        let actual = probe.output()[i];
        assert_eq!(
            actual.to_bits(),
            exp.to_bits(),
            "Mismatch at index {}: actual bits 0x{:08X} != expected bits 0x{:08X}",
            i,
            actual.to_bits(),
            exp.to_bits()
        );
    }
}

#[test]
fn test_len_zero_preserves_all_4096_outputs() {
    let mut probe = ProbeBuffers::new();
    // Fill with exact dyadic sentinel
    probe.output_mut().fill(42.5);

    let res = probe.process(0, 0.5);
    assert_eq!(res, PROBE_ERR_OK);

    // All 4096 elements must remain untouched
    for (i, &val) in probe.output().iter().enumerate() {
        assert_eq!(val, 42.5, "Output at index {} was modified on len=0", i);
    }
}

#[test]
fn test_partial_len_preserves_remaining_outputs() {
    let mut probe = ProbeBuffers::new();
    probe.output_mut().fill(99.0);
    probe.input_mut()[0] = 2.0;
    probe.input_mut()[1] = 4.0;

    let res = probe.process(2, 0.5);
    assert_eq!(res, PROBE_ERR_OK);

    assert_eq!(probe.output()[0], 1.0);
    assert_eq!(probe.output()[1], 2.0);

    // Elements from index 2 to 4095 must remain 99.0
    for i in 2..PROBE_CAPACITY {
        assert_eq!(
            probe.output()[i],
            99.0,
            "Output at index {} beyond len was modified",
            i
        );
    }
}

#[test]
fn test_capacity_boundaries() {
    let mut probe = ProbeBuffers::new();
    probe.input_mut().fill(0.25);
    probe.output_mut().fill(100.0);

    // 1. Boundary pass: 4096
    let res = probe.process(4096, 2.0);
    assert_eq!(res, PROBE_ERR_OK);
    for &val in probe.output().iter() {
        assert_eq!(val, 0.5);
    }

    // 2. Boundary overflow: 4097
    probe.output_mut().fill(77.0);
    let res_overflow = probe.process(4097, 2.0);
    assert_eq!(res_overflow, PROBE_ERR_LEN_OVERFLOW);
    for &val in probe.output().iter() {
        assert_eq!(val, 77.0, "Output was modified on len=4097 overflow");
    }

    // 3. u32::MAX boundary
    let res_max = probe.process(u32::MAX, 2.0);
    assert_eq!(res_max, PROBE_ERR_LEN_OVERFLOW);
    for &val in probe.output().iter() {
        assert_eq!(val, 77.0, "Output was modified on len=u32::MAX overflow");
    }
}

#[test]
fn test_independent_non_finite_gain_validation() {
    let mut probe = ProbeBuffers::new();

    // Test NaN gain
    probe.output_mut().fill(55.0);
    assert_eq!(probe.process(5, f32::NAN), PROBE_ERR_NON_FINITE_GAIN);
    for &val in probe.output().iter() {
        assert_eq!(val, 55.0);
    }

    // Test +Infinity gain
    probe.output_mut().fill(55.0);
    assert_eq!(probe.process(5, f32::INFINITY), PROBE_ERR_NON_FINITE_GAIN);
    for &val in probe.output().iter() {
        assert_eq!(val, 55.0);
    }

    // Test -Infinity gain
    probe.output_mut().fill(55.0);
    assert_eq!(
        probe.process(5, f32::NEG_INFINITY),
        PROBE_ERR_NON_FINITE_GAIN
    );
    for &val in probe.output().iter() {
        assert_eq!(val, 55.0);
    }

    // Len = 0 with invalid gain must also be rejected
    assert_eq!(probe.process(0, f32::NAN), PROBE_ERR_NON_FINITE_GAIN);
}

#[test]
fn test_independent_non_finite_input_validation() {
    let mut probe = ProbeBuffers::new();

    // Case 1: NaN input at index 2 (other inputs clean)
    probe.input_mut().fill(1.0);
    probe.output_mut().fill(33.0);
    probe.input_mut()[2] = f32::NAN;
    let res = probe.process(5, 1.0);
    assert_eq!(res, PROBE_ERR_NON_FINITE_INPUT);
    for &val in probe.output().iter() {
        assert_eq!(val, 33.0, "Output modified on NaN input failure");
    }

    // Case 2: +Infinity input at index 0 (clean inputs first, ensuring no previous NaN masks it)
    probe.input_mut().fill(1.0);
    probe.output_mut().fill(44.0);
    probe.input_mut()[0] = f32::INFINITY;
    let res = probe.process(5, 1.0);
    assert_eq!(res, PROBE_ERR_NON_FINITE_INPUT);
    for &val in probe.output().iter() {
        assert_eq!(val, 44.0, "Output modified on +Inf input failure");
    }

    // Case 3: -Infinity input at index 4 (clean inputs first)
    probe.input_mut().fill(1.0);
    probe.output_mut().fill(55.0);
    probe.input_mut()[4] = f32::NEG_INFINITY;
    let res = probe.process(5, 1.0);
    assert_eq!(res, PROBE_ERR_NON_FINITE_INPUT);
    for &val in probe.output().iter() {
        assert_eq!(val, 55.0, "Output modified on -Inf input failure");
    }
}

#[test]
fn test_product_overflow_positive_and_negative() {
    let mut probe = ProbeBuffers::new();

    // 1. Positive product overflow (+Inf)
    probe.input_mut().fill(1.0);
    probe.output_mut().fill(66.0);
    probe.input_mut()[3] = 1e38;
    let res = probe.process(5, 10.0);
    assert_eq!(res, PROBE_ERR_NON_FINITE_PRODUCT);
    for &val in probe.output().iter() {
        assert_eq!(val, 66.0, "Output modified on positive overflow");
    }

    // 2. Negative product overflow (-Inf)
    probe.input_mut().fill(1.0);
    probe.output_mut().fill(77.0);
    probe.input_mut()[3] = -1e38;
    let res = probe.process(5, 10.0);
    assert_eq!(res, PROBE_ERR_NON_FINITE_PRODUCT);
    for &val in probe.output().iter() {
        assert_eq!(val, 77.0, "Output modified on negative overflow");
    }
}

#[test]
fn test_reset_clears_all_4096_samples() {
    let mut probe = ProbeBuffers::new();

    probe.input_mut().fill(123.0);
    probe.output_mut().fill(456.0);

    probe.reset();

    for (i, &val) in probe.input().iter().enumerate() {
        assert_eq!(val, 0.0, "Input at index {} not zero after reset", i);
    }
    for (i, &val) in probe.output().iter().enumerate() {
        assert_eq!(val, 0.0, "Output at index {} not zero after reset", i);
    }

    // Repeated reset
    probe.reset();
    assert_eq!(probe.input()[PROBE_CAPACITY - 1], 0.0);
    assert_eq!(probe.output()[PROBE_CAPACITY - 1], 0.0);
}

#[test]
fn test_native_pointers_alignment_and_non_overlap() {
    let probe = ProbeBuffers::new();
    let in_addr = probe.input_addr();
    let out_addr = probe.output_addr();

    // 4-byte alignment
    assert_eq!(in_addr % 4, 0, "input address must be 4-byte aligned");
    assert_eq!(out_addr % 4, 0, "output address must be 4-byte aligned");

    // Non-overlapping check across full 4096-sample buffer (16384 bytes)
    let buf_bytes = PROBE_CAPACITY * core::mem::size_of::<f32>();
    let non_overlapping = (in_addr + buf_bytes <= out_addr) || (out_addr + buf_bytes <= in_addr);
    assert!(
        non_overlapping,
        "Input and output buffers overlap in native memory"
    );
}
