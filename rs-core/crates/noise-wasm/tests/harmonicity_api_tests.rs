#![cfg(feature = "harmonicity")]
use noise_core::speech::harmonicity::{HarmonicityOptions, PitchEvidence};
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
#[test]
fn hnr_pending_result_is_not_replaced() {
    let mut a = SpeechApi::new();
    a.pcm_emphasis(&[], 0.97);
    assert_eq!(
        a.harmonicity_with_sin(&[], 12000.0, &HarmonicityOptions::default(), &[], &f64::sin),
        WOULD_BLOCK
    );
    assert_eq!(a.kind(), 2);
}
#[test]
fn hnr_bounds_reject_before_processing() {
    let mut a = SpeechApi::new();
    let opts = HarmonicityOptions::default();
    assert_eq!(
        a.harmonicity_with_sin(&vec![0.0; 8193], 12000.0, &opts, &[], &f64::sin),
        CAPACITY
    );
    assert_eq!(a.kind(), 0);
    let bad = HarmonicityOptions { hop: 0, ..opts };
    assert_eq!(
        a.harmonicity_with_sin(&[], 12000.0, &bad, &[], &f64::sin),
        BAD_ARGUMENT
    );
    assert_eq!(a.kind(), 0);
}
#[test]
fn silence_and_unvoiced_evidence_remain_distinct() {
    let mut a = SpeechApi::new();
    let opts = HarmonicityOptions {
        require_pitch: true,
        ..Default::default()
    };
    assert_eq!(
        a.harmonicity_with_sin(&vec![0.0; 1024], 12000.0, &opts, &[], &f64::sin),
        OK
    );
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("low-energy")
    );
    a.ack();
    let pitch = [
        PitchEvidence {
            time: 0.1,
            f0: 200.0,
            aperiodicity: 0.1,
        },
        PitchEvidence {
            time: 0.0,
            f0: 200.0,
            aperiodicity: 0.1,
        },
    ];
    assert_eq!(
        a.harmonicity_with_sin(&[], 12000.0, &opts, &pitch, &f64::sin),
        BAD_ARGUMENT
    );
}
