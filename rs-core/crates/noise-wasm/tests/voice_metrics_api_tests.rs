#![cfg(feature = "speech")]
use noise_core::speech::voice_metrics::IntensityOptions;
use noise_wasm::speech_api::{BAD_ARGUMENT, CAPACITY, OK, SpeechApi, WOULD_BLOCK};
fn opts() -> IntensityOptions {
    IntensityOptions {
        fs: 12000.0,
        frame_size: None,
        hop: None,
    }
}
#[test]
fn metric_admission_preserves_pending_output_and_rejects_nonfinite_math() {
    let mut a = SpeechApi::new();
    assert_eq!(a.period_variability(&[100.0, 200.0], false, false), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.intensity_track(&[], opts()), WOULD_BLOCK);
    assert_eq!(a.period_variability(&[], true, true), WOULD_BLOCK);
    assert_eq!(saved, a.json_result());
    a.ack();
    assert_eq!(
        a.period_variability(&[f64::NAN], false, false),
        BAD_ARGUMENT
    );
    assert_eq!(a.period_variability(&[5e-324], false, false), BAD_ARGUMENT);
    assert_eq!(
        a.period_variability(&[1e-308, 1e-308], false, false),
        BAD_ARGUMENT
    );
    assert_eq!(a.intensity_track(&[f32::INFINITY], opts()), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(
        a.intensity_track(
            &[0.0],
            IntensityOptions {
                fs: 1e308,
                frame_size: Some(1),
                hop: None
            }
        ),
        BAD_ARGUMENT
    );
    assert_eq!(a.kind(), 0);
    assert_eq!(
        a.intensity_track(
            &[0.0],
            IntensityOptions {
                fs: 5e-324,
                frame_size: Some(1),
                hop: Some(1)
            }
        ),
        BAD_ARGUMENT
    );
    assert_eq!(a.kind(), 0);
}
#[test]
fn variability_is_unavailable_for_gaps_clipping_or_no_adjacent_voiced_pair() {
    let mut a = SpeechApi::new();
    for (f0, gaps, clipped, reason) in [
        (
            &[100.0, 0.0, 200.0][..],
            false,
            false,
            "no-adjacent-voiced-pairs",
        ),
        (&[100.0, 200.0][..], true, false, "capture-discontinuity"),
        (&[100.0, 200.0][..], false, true, "clipped-input"),
    ] {
        assert_eq!(a.period_variability(f0, gaps, clipped), OK);
        let s = std::str::from_utf8(a.json_result()).unwrap();
        assert!(s.contains("\"value\":null"));
        assert!(s.contains(reason));
        a.ack();
    }
    assert_eq!(
        a.period_variability(&vec![200.0; 4097], false, false),
        CAPACITY
    );
    assert_eq!(a.kind(), 0);
}
#[test]
fn silence_floor_empty_and_default_window_have_explicit_digital_units() {
    let mut a = SpeechApi::new();
    assert_eq!(a.intensity_track(&[0.0; 300], opts()), OK);
    let s = std::str::from_utf8(a.json_result()).unwrap();
    assert!(s.contains("\"db\":-240"));
    assert!(s.contains("\"unit\":\"dBFS\""));
    assert!(s.contains("\"calibrationApplied\":false"));
    a.ack();
    assert_eq!(a.intensity_track(&[], opts()), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"track\":[]")
    );
    a.ack();
    assert_eq!(
        a.intensity_track(
            &[],
            IntensityOptions {
                fs: 22050.0,
                frame_size: None,
                hop: None
            }
        ),
        OK
    );
    let s = std::str::from_utf8(a.json_result()).unwrap();
    assert!(s.contains("\"frameSize\":551"));
    assert!(s.contains("\"hop\":221"));
}
