#![cfg(feature = "speech")]
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, UNSUPPORTED, WOULD_BLOCK};
#[test]
fn pending_and_bad_batch_preserve_resample_cursor() {
    let mut a = SpeechApi::new();
    assert_eq!(a.resample_begin(&[0.2; 512], 16000, 12000, 5500.0), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.resample_next(1, 128), WOULD_BLOCK);
    assert_eq!(a.resample_progress(1), WOULD_BLOCK);
    assert_eq!(a.resample_finish(1), WOULD_BLOCK);
    assert_eq!(a.resample_cancel(1), WOULD_BLOCK);
    assert_eq!(saved, a.json_result());
    a.ack();
    assert_eq!(a.resample_finish(1), -8);
    assert_eq!(a.resample_next(1, 0), BAD_ARGUMENT);
    assert_eq!(a.resample_next(1, 4097), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.resample_next(1, 128), OK);
    assert_eq!(a.float_result().len(), 128);
    a.ack();
    assert_eq!(a.resample_progress(1), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"completed\":128")
    );
    a.ack();
    assert_eq!(a.resample_cancel(1), OK);
    assert_eq!(a.resample_begin(&[], 12000, 12000, 5500.0), OK);
    a.ack();
    assert_eq!(a.resample_next(1, 1), -1);
    assert_eq!(a.resample_finish(2), OK);
    assert!(a.float_result().is_empty());
}
#[test]
fn distinct_rate_sessions_and_idempotent_finish_remain_independent() {
    let mut a = SpeechApi::new();
    assert_eq!(a.resample_begin(&[0.0; 5], 12000, 12000, 5500.0), OK);
    a.ack();
    assert_eq!(a.resample_begin(&[0.0; 5], 48000, 12000, 5500.0), OK);
    a.ack();
    assert_eq!(a.resample_begin(&[], 12000, 12000, 5500.0), -6);
    assert_eq!(a.resample_next(1, 2), OK);
    a.ack();
    assert_eq!(a.resample_next(2, 1), OK);
    a.ack();
    assert_eq!(a.resample_finish(2), OK);
    assert_eq!(a.float_result().len(), 1);
    a.ack();
    assert_eq!(a.resample_cancel(2), OK);
    assert_eq!(a.resample_next(1, 3), OK);
    a.ack();
    assert_eq!(a.resample_finish(1), OK);
    let values = a.float_result().to_vec();
    assert_eq!(values.len(), 5);
    a.ack();
    assert_eq!(a.resample_finish(1), OK);
    assert_eq!(values, a.float_result());
    a.ack();
    assert_eq!(a.resample_next(1, 1), OK);
    assert!(a.float_result().is_empty());
}
#[test]
fn invalid_profiles_and_capacity_do_not_create_handles() {
    let mut a = SpeechApi::new();
    assert_eq!(a.resample_begin(&[], 0, 12000, 5500.0), UNSUPPORTED);
    assert_eq!(
        a.resample_begin(&[f32::NAN], 12000, 12000, 5500.0),
        BAD_ARGUMENT
    );
    assert_eq!(
        a.resample_begin(&vec![0.0; 262145], 12000, 12000, 5500.0),
        CAPACITY
    );
    assert_eq!(a.kind(), 0);
    assert_eq!(a.resample_begin(&[0.5], 48000, 12000, 5500.0), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"handle\":1")
    );
    a.ack();
    assert_eq!(a.resample_next(1, 1), OK);
    assert!(a.float_result().is_empty());
    a.ack();
    assert_eq!(a.resample_finish(1), OK);
    assert!(a.float_result().is_empty());
}
