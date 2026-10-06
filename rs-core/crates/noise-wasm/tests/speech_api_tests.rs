#![cfg(feature = "speech")]
use noise_wasm::speech_api::*;
#[test]
fn pending_binary_result_blocks_json_and_resample() {
    let mut a = SpeechApi::new();
    assert_eq!(a.pcm_emphasis(&[32767, 0], 0.97), OK);
    let saved = a.float_result().to_vec();
    assert_eq!(a.pitch_frame(&[], 12000.0, 0.1, 40.0, 1200.0), WOULD_BLOCK);
    assert_eq!(a.resample(&[], 44100, 12000, 5500.0), WOULD_BLOCK);
    assert_eq!(a.float_result(), saved);
    a.ack();
    assert_eq!(a.kind(), 0);
}
#[test]
fn frame_keeps_baseline_invalid_range_result() {
    let mut a = SpeechApi::new();
    assert_eq!(a.pitch_frame(&[], 0.0, 0.1, 40.0, 20.0), OK);
    assert_eq!(a.json_result(), b"{\"f0\":0,\"aperiodicity\":1}");
}
#[test]
fn track_budget_rejects_without_partial_result() {
    let mut a = SpeechApi::new();
    assert_eq!(
        a.track(&vec![0.0; 16384], 12000.0, 4096, 1, 0.1, 40.0, 1200.0),
        CAPACITY
    );
    assert_eq!(a.kind(), 0);
    assert!(a.json_result().is_empty());
}
#[test]
fn supported_recording_duration_fits_track_budget() {
    let mut a = SpeechApi::new();
    assert_eq!(
        a.track(&vec![0.0; 63000], 12000.0, 1024, 120, 0.1, 40.0, 1200.0),
        OK
    );
    assert_eq!(a.kind(), 1);
}
#[test]
fn unsupported_profile_and_nonfinite_signal_do_not_publish() {
    let mut a = SpeechApi::new();
    assert_eq!(a.resample(&[], 44100, 16000, 5500.0), UNSUPPORTED);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.float_emphasis(&[f32::NAN], 0.97), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.pcm_emphasis(&[], 0.97), OK);
    assert_eq!(a.kind(), 2);
    assert!(a.float_result().is_empty());
}
