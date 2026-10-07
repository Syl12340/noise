#![cfg(feature = "speech")]
use noise_core::speech::pitch_session::PitchOptions;
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
#[test]
fn pending_and_invalid_admission_preserve_pitch_handle_and_cursor() {
    let mut a = SpeechApi::new();
    let opts = PitchOptions::default();
    assert_eq!(a.pitch_begin(&vec![0.0; 2048], opts), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.pitch_next(1), WOULD_BLOCK);
    assert_eq!(a.pitch_finish(1), WOULD_BLOCK);
    assert_eq!(a.pitch_cancel(1), WOULD_BLOCK);
    assert_eq!(a.pitch_begin(&[], opts), WOULD_BLOCK);
    assert_eq!(saved, a.json_result());
    a.ack();
    assert_eq!(a.pitch_finish(1), -8);
    assert_eq!(a.pitch_begin(&[f32::NAN], opts), BAD_ARGUMENT);
    assert_eq!(
        a.pitch_begin(&[], PitchOptions { fs: 0.0, ..opts }),
        BAD_ARGUMENT
    );
    assert_eq!(a.kind(), 0);
    assert_eq!(a.pitch_next(1), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"index\":0")
    );
    a.ack();
    assert_eq!(a.pitch_cancel(1), OK);
    assert_eq!(a.pitch_begin(&[], opts), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"handle\":2")
    );
    a.ack();
    assert_eq!(a.pitch_cancel(1), -1);
    assert_eq!(a.pitch_cancel(2), OK);
}
#[test]
fn whole_session_budget_is_not_reset_for_every_frame() {
    let mut a = SpeechApi::new();
    let opts = PitchOptions {
        frame_size: 4096,
        ..Default::default()
    };
    assert_eq!(a.pitch_begin(&vec![0.0; 65000], opts), CAPACITY);
    assert_eq!(a.kind(), 0);
    assert_eq!(
        a.pitch_begin(
            &vec![0.0; 6000],
            PitchOptions {
                frame_size: 1,
                hop: 1,
                ..Default::default()
            }
        ),
        CAPACITY
    );
    assert_eq!(
        a.pitch_begin(&vec![0.0; 69784], PitchOptions::default()),
        CAPACITY
    );
    assert_eq!(
        a.pitch_begin(&vec![0.0; 69783], PitchOptions::default()),
        OK
    );
    a.ack();
    assert_eq!(a.pitch_cancel(1), OK);
    assert_eq!(
        a.pitch_begin(&vec![0.0; 63000], PitchOptions::default()),
        OK
    );
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"total\":517")
    );
}
#[test]
fn short_odd_frames_and_finish_are_complete_and_idempotent() {
    let mut a = SpeechApi::new();
    let odd = PitchOptions {
        frame_size: 9,
        hop: 7,
        ..Default::default()
    };
    assert_eq!(a.pitch_begin(&[0.0; 16], odd), OK);
    a.ack();
    assert_eq!(a.pitch_next(1), OK);
    let first = std::str::from_utf8(a.json_result()).unwrap();
    assert!(first.contains("\"time\":0.000375"));
    a.ack();
    assert_eq!(a.pitch_next(1), OK);
    a.ack();
    assert_eq!(a.pitch_finish(1), OK);
    let result = a.json_result().to_vec();
    a.ack();
    assert_eq!(a.pitch_finish(1), OK);
    assert_eq!(a.json_result(), result);
    a.ack();
    assert_eq!(a.pitch_cancel(1), OK);
    assert_eq!(a.pitch_begin(&[0.0; 8], odd), OK);
    a.ack();
    assert_eq!(a.pitch_next(2), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"state\":\"complete\"")
    );
    a.ack();
    assert_eq!(a.pitch_finish(2), OK);
    assert_eq!(a.json_result(), b"[]");
}
