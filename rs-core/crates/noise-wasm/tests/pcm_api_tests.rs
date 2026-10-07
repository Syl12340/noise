#![cfg(feature = "speech")]
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
#[test]
fn offline_pcm_calls_share_pending_gate_and_reject_before_publishing() {
    let mut a = SpeechApi::new();
    assert_eq!(a.inspect_pcm_offline(&[32767, -32768], 12000), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.inspect_pcm_offline(&[], 0), WOULD_BLOCK);
    assert_eq!(a.center_pcm(&[]), WOULD_BLOCK);
    assert_eq!(saved, a.json_result());
    a.ack();
    assert_eq!(a.inspect_pcm_offline(&[], 0), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    let too_long = vec![0; 262145];
    assert_eq!(a.inspect_pcm_offline(&too_long, 12000), CAPACITY);
    assert_eq!(a.center_pcm(&too_long), CAPACITY);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.center_pcm(&[]), OK);
    assert_eq!(a.kind(), 2);
    assert!(a.float_result().is_empty());
}
#[test]
fn offline_inspection_has_no_cross_segment_rail_state() {
    let mut a = SpeechApi::new();
    assert_eq!(a.inspect_pcm_offline(&[32767, -32768], 12000), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"clipped\":true")
    );
    a.ack();
    assert_eq!(a.inspect_pcm_offline(&[2000; 32], 12000), OK);
    let text = std::str::from_utf8(a.json_result()).unwrap();
    assert!(text.contains("\"clipped\":false"));
    assert!(text.contains("\"intervals\":[]"));
    a.ack();
    assert_eq!(a.center_pcm(&[2000; 32]), OK);
    assert!(a.float_result().iter().all(|v| v.to_bits() == 0));
}
