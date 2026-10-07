#![cfg(feature = "harmonicity")]
use noise_core::speech::{
    harmonicity::{HarmonicityOptions, PitchEvidence},
    time_support::Interval,
};
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
#[test]
fn assembly_pending_gate_and_rejections_do_not_consume_a_piece() {
    let mut a = SpeechApi::new();
    assert_eq!(a.assembly_begin(2048, 12000, 1024, 120), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.assembly_append(1, 0, 0, 1024, &[]), WOULD_BLOCK);
    assert_eq!(a.assembly_finish(1), WOULD_BLOCK);
    assert_eq!(a.assembly_cancel(1), WOULD_BLOCK);
    assert_eq!(a.plan_segments(2048, 12000, &[]), WOULD_BLOCK);
    assert_eq!(a.prepare_pitch(&[], 2048, 12000, 1024, &[]), WOULD_BLOCK);
    assert_eq!(saved, a.json_result());
    a.ack();
    assert_eq!(a.assembly_finish(1), -8);
    assert_eq!(a.assembly_append(1, 0, 1, 1024, &[]), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(
        a.assembly_append(
            1,
            0,
            0,
            1024,
            &[Interval {
                start: 0.0,
                end: 0.01
            }]
        ),
        BAD_ARGUMENT
    );
    assert_eq!(a.assembly_append(1, 0, 0, 1024, &[]), OK);
    a.ack();
    assert_eq!(a.assembly_finish(1), -8);
    assert_eq!(a.assembly_append(1, 0, 1024, 2048, &[]), OK);
    a.ack();
    assert_eq!(a.assembly_finish(1), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.assembly_cancel(1), OK);
    assert_eq!(a.assembly_begin(1024, 12000, 1024, 120), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"handle\":2")
    );
    a.ack();
    assert_eq!(a.assembly_cancel(1), -1);
    assert_eq!(a.assembly_cancel(2), OK);
}
#[test]
fn copied_completed_result_survives_cancellation_and_finish_is_idempotent() {
    let mut a = SpeechApi::new();
    let opts = HarmonicityOptions {
        require_pitch: true,
        ..Default::default()
    };
    assert_eq!(a.assembly_begin(3072, 12000, 1024, 120), OK);
    a.ack();
    for i in 0..3 {
        let h = i + 1;
        assert_eq!(a.hnr_begin(&vec![0.0; 1024], 12000.0, opts, &[]), OK);
        a.ack();
        assert_eq!(
            a.assembly_append(1, h, i as usize * 1024, (i as usize + 1) * 1024, &[]),
            -8
        );
        assert_eq!(a.hnr_next(h, &f64::sin), OK);
        a.ack();
        assert_eq!(a.hnr_finish(h), OK);
        a.ack();
        assert_eq!(
            a.assembly_append(1, h, i as usize * 1024, (i as usize + 1) * 1024, &[]),
            OK
        );
        a.ack();
        assert_eq!(a.hnr_cancel(h), OK);
    }
    assert_eq!(a.assembly_finish(1), OK);
    let result = a.json_result().to_vec();
    a.ack();
    assert_eq!(a.assembly_finish(1), OK);
    assert_eq!(a.json_result(), result);
    a.ack();
    assert_eq!(a.assembly_cancel(1), OK);
}
#[test]
fn plans_and_qualification_reject_capacity_and_preserve_quality_precedence() {
    let mut a = SpeechApi::new();
    let boundaries: Vec<f64> = (1..129).map(|i| i as f64 / 12000.0).collect();
    assert_eq!(a.plan_segments(2048, 12000, &boundaries), CAPACITY);
    assert_eq!(a.kind(), 0);
    let pitch = [PitchEvidence {
        time: 0.0,
        f0: 200.0,
        aperiodicity: 0.1,
    }];
    assert_eq!(
        a.prepare_pitch(
            &pitch,
            1024,
            12000,
            1024,
            &[Interval {
                start: 0.0,
                end: 0.01
            }]
        ),
        OK
    );
    let result = std::str::from_utf8(a.json_result()).unwrap();
    assert!(result.contains("clipped-input"));
    assert!(!result.contains("incomplete-filter-support"));
    a.ack();
    assert_eq!(
        a.prepare_pitch(&vec![pitch[0]; 4097], 1024, 12000, 1024, &[]),
        CAPACITY
    );
    assert_eq!(a.kind(), 0);
}
