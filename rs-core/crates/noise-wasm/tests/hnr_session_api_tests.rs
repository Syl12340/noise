#![cfg(feature = "harmonicity")]
use noise_core::speech::harmonicity::HarmonicityOptions;
use noise_wasm::speech_api::{OK, SpeechApi, WOULD_BLOCK};
#[test]
fn session_pending_gate_applies_before_every_mutation() {
    let mut a = SpeechApi::new();
    let opts = HarmonicityOptions::default();
    assert_eq!(a.hnr_begin(&[0.0; 1024], 12000.0, opts, &[]), OK);
    let data = a.json_result().to_vec();
    assert_eq!(a.hnr_next(1, &f64::sin), WOULD_BLOCK);
    assert_eq!(a.hnr_finish(1), WOULD_BLOCK);
    assert_eq!(a.hnr_cancel(1), WOULD_BLOCK);
    assert_eq!(a.hnr_begin(&[], 12000.0, opts, &[]), WOULD_BLOCK);
    assert_eq!(a.json_result(), data);
    a.ack();
    assert_eq!(a.hnr_finish(1), -8);
    assert_eq!(a.hnr_cancel(1), OK);
}
#[test]
fn canceled_handle_never_refers_to_new_session() {
    let mut a = SpeechApi::new();
    let opts = HarmonicityOptions::default();
    assert_eq!(a.hnr_begin(&[], 12000.0, opts, &[]), OK);
    a.ack();
    assert_eq!(a.hnr_cancel(1), OK);
    assert_eq!(a.hnr_begin(&[], 12000.0, opts, &[]), OK);
    a.ack();
    assert_eq!(a.hnr_next(1, &f64::sin), -1);
    assert_eq!(a.hnr_finish(1), -1);
    assert_eq!(a.hnr_cancel(1), -1);
    assert_eq!(a.hnr_finish(2), OK);
}
