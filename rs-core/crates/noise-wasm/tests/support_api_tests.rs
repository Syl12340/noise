#![cfg(feature = "speech")]
use noise_core::speech::time_support::Interval;
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
#[test]
fn support_validation_is_atomic_and_pending_results_are_preserved() {
    let mut api = SpeechApi::new();
    assert_eq!(api.support_evidence(&[0.1], 0.1, 0.0, 1.0, &[]), OK);
    let saved = api.json_result().to_vec();
    assert_eq!(
        api.support_evidence(&[f64::NAN], 0.1, 0.0, 1.0, &[]),
        WOULD_BLOCK
    );
    assert_eq!(saved, api.json_result());
    api.ack();
    for times in [vec![f64::NAN], vec![0.1, 0.1], vec![-0.1], vec![2.0]] {
        assert_eq!(
            api.support_evidence(&times, 0.1, 0.0, 1.0, &[]),
            BAD_ARGUMENT
        );
        assert_eq!(api.kind(), 0);
    }
    assert_eq!(
        api.support_evidence(
            &[0.1],
            0.1,
            0.0,
            1.0,
            &[Interval {
                start: 0.3,
                end: 0.2
            }]
        ),
        BAD_ARGUMENT
    );
    assert_eq!(
        api.support_evidence(&[1e308], 1e308, 1e308, 1e308, &[]),
        BAD_ARGUMENT
    );
    assert_eq!(
        api.support_evidence(&vec![0.0; 4097], 0.1, 0.0, 1.0, &[]),
        CAPACITY
    );
    assert_eq!(api.kind(), 0);
    assert_eq!(api.support_evidence(&[], 0.1, 0.0, 0.0, &[]), OK);
    assert_eq!(api.json_result(), b"[]");
}
