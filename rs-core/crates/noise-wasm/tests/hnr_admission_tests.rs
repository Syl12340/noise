#![cfg(feature = "harmonicity")]
use noise_core::speech::harmonicity::{HarmonicityOptions, PitchEvidence};
use noise_wasm::speech_api::{BAD_ARGUMENT, OK, SpeechApi};

#[test]
fn rejected_admission_preserves_results_handles_and_other_sessions() {
    let mut a = SpeechApi::new();
    let normal = HarmonicityOptions::default();
    let quiet = vec![0.0; 1024];
    assert_eq!(a.hnr_begin(&quiet, 12000.0, normal, &[]), OK);
    a.ack();
    let duplicate = [PitchEvidence {
        time: 0.0,
        f0: 200.0,
        aperiodicity: 0.1,
    }; 2];
    let mut cases = vec![
        (
            quiet.clone(),
            HarmonicityOptions {
                hop: 12000,
                ..normal
            },
            vec![],
        ),
        (
            quiet.clone(),
            HarmonicityOptions {
                fmin: 200.0,
                fmax: 200.0,
                ..normal
            },
            vec![],
        ),
        (quiet.clone(), normal, duplicate.to_vec()),
    ];
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut signal = quiet.clone();
        signal[1023] = bad;
        cases.push((
            signal,
            HarmonicityOptions {
                require_pitch: true,
                ..normal
            },
            vec![],
        ));
    }
    for (signal, opts, pitch) in cases {
        assert_eq!(a.hnr_begin(&signal, 12000.0, opts, &pitch), BAD_ARGUMENT);
        assert_eq!(a.kind(), 0);
        assert_eq!(
            a.harmonicity_with_sin(&signal, 12000.0, &opts, &pitch, &|_| panic!(
                "invalid input reached DSP"
            )),
            BAD_ARGUMENT
        );
        assert_eq!(a.kind(), 0);
    }
    assert_eq!(a.hnr_next(1, &f64::sin), OK);
    a.ack();
    assert_eq!(a.hnr_finish(1), OK);
    a.ack();
    assert_eq!(a.hnr_begin(&quiet, 12000.0, normal, &[]), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"handle\":2")
    );
}

#[test]
fn zero_threshold_without_peak_is_a_row_not_a_failed_session() {
    let mut a = SpeechApi::new();
    // Accepted frequency band lies below the frame's searchable integer delays.
    // This forces an empty search without depending on floating-point peak details.
    let opts = HarmonicityOptions {
        fmin: 1.0,
        fmax: 2.0,
        min_peak_correlation: 0.0,
        ..Default::default()
    };
    let signal: Vec<f32> = (0..1024)
        .map(|i| if i % 2 == 0 { 0.2 } else { -0.2 })
        .collect();
    assert_eq!(a.hnr_begin(&signal, 12000.0, opts, &[]), OK);
    a.ack();
    assert_eq!(a.hnr_next(1, &|_| panic!("empty search")), OK);
    assert!(
        std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("no-periodic-peak")
    );
    a.ack();
    assert_eq!(a.hnr_finish(1), OK);
    let result = std::str::from_utf8(a.json_result()).unwrap();
    assert!(result.contains("\"avgHNR\":null"));
    assert!(result.contains("\"validFrames\":0"));
}
