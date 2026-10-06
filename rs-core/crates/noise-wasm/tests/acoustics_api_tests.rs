#![cfg(feature = "acoustics")]
use noise_wasm::acoustics_api::*;

#[test]
fn stale_handles_and_registry_limits() {
    let mut r = Registry::new();
    let first = r.create(100.0, 128);
    assert_ne!(first, 0);
    assert_eq!(r.destroy(first), OK);
    let second = r.create(100.0, 128);
    assert!(second > first);
    assert_eq!(r.process(first, 1, &[100, 200], 0), BAD_HANDLE);
    assert_eq!(r.create(f64::NAN, 128), 0);
    assert_eq!(r.last_status, BAD_ARGUMENT);
    for _ in 0..3 {
        assert_ne!(r.create(100.0, 128), 0);
    }
    assert_eq!(r.create(100.0, 128), 0);
    assert_eq!(r.last_status, REGISTRY_FULL);
}
#[test]
fn pending_result_prevents_cross_session_replay() {
    let mut r = Registry::new();
    let a = r.create(100.0, 128);
    let b = r.create(100.0, 128);
    assert_eq!(r.process(a, 1, &[100, 200], 0), OK);
    let saved = r.result().to_vec();
    assert_eq!(r.process(a, 1, &[100, 200], 0), WOULD_BLOCK);
    assert_eq!(r.process(b, 1, &[100, 200], 0), WOULD_BLOCK);
    assert_eq!(r.destroy(a), WOULD_BLOCK);
    assert_eq!(r.create(100.0, 128), 0);
    assert_eq!(r.result(), saved);
    r.ack();
    assert_eq!(r.process(a, 1, &[100, 200], 0), BAD_SEQUENCE);
    assert_eq!(r.process(b, 1, &[100, 200], 0), OK);
}
#[test]
fn invalid_arguments_and_intrinsic_capacity_do_not_consume_sequence() {
    let mut r = Registry::new();
    let a = r.create(100.0, 1);
    assert_eq!(r.process(a, 1, &[100, 200], 2), BAD_ARGUMENT);
    assert_eq!(r.process(a, 1, &vec![100; 50000], 1), EVENT_CAPACITY);
    assert_eq!(r.process(a, 1, &[100, 200], 0), OK);
}
#[test]
fn next_event_is_one_at_a_time_and_finish_idempotent() {
    let mut r = Registry::new();
    let a = r.create(100.0, 128);
    let pcm: Vec<i16> = (0..44100)
        .map(|i| if i % 2 == 0 { 100 } else { -100 })
        .collect();
    assert_eq!(r.process(a, 1, &pcm, 0), OK);
    r.ack();
    assert_eq!(r.next_event(a), OK);
    assert!(
        std::str::from_utf8(r.result())
            .unwrap()
            .contains("\"type\":\"window\"")
    );
    r.ack();
    assert_eq!(r.next_event(a), OK);
    assert_eq!(r.result(), b"null");
    r.ack();
    assert_eq!(r.finish(a, 0), OK);
    let first = r.result().to_vec();
    r.ack();
    assert_eq!(r.finish(a, 1), OK);
    assert_eq!(r.result(), first);
}
