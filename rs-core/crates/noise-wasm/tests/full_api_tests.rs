#![cfg(feature = "full-speech")]
use noise_core::speech::full::{
    FullMath,
    pipeline::{FullSession, Parameters},
    roots::RootMath,
    tables,
};
use noise_wasm::speech_api::{BAD_ARGUMENT, OK, SpeechApi, WOULD_BLOCK};
struct TestMath;
impl RootMath for TestMath {
    fn hypot(&self, a: f64, b: f64) -> f64 {
        a.hypot(b)
    }
    fn seed(&self, d: usize, i: usize) -> (f64, f64) {
        tables::root_seed(d, i)
    }
}
impl FullMath for TestMath {
    fn atan2(&self, y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
    fn ln(&self, x: f64) -> f64 {
        x.ln()
    }
    fn log10(&self, x: f64) -> f64 {
        x.log10()
    }
    fn sin(&self, x: f64) -> f64 {
        x.sin()
    }
}
fn params() -> Parameters {
    Parameters {
        ceiling: 4000,
        ..Parameters::default()
    }
}
#[test]
fn full_registry_preserves_pending_output_and_releases_stale_handles() {
    let mut a = SpeechApi::new();
    assert_eq!(a.full_begin(&[0; 64], 12000, params(), &[]), OK);
    let saved = a.json_result().to_vec();
    assert_eq!(a.full_next(1, &TestMath), WOULD_BLOCK);
    assert_eq!(a.full_cancel(1), WOULD_BLOCK);
    assert_eq!(a.json_result(), saved);
    a.ack();
    assert_eq!(a.full_finish(1), -8);
    assert_eq!(a.full_begin(&[0; 64], 12000, params(), &[]), -6);
    assert_eq!(a.full_next(2, &TestMath), -1);
    assert_eq!(a.full_cancel(1), OK);
    assert_eq!(a.full_next(1, &TestMath), -1);
    assert_eq!(a.full_begin(&[0; 64], 12000, params(), &[]), OK);
    a.ack();
    assert_eq!(a.full_cancel(2), OK);
}
#[test]
fn full_completed_result_is_cached_and_binary_reads_are_bounded() {
    let mut a = SpeechApi::new();
    assert_eq!(a.full_begin(&[100, 200, 300], 12000, params(), &[]), OK);
    a.ack();
    for _ in 0..100 {
        assert_eq!(a.full_next(1, &TestMath), OK);
        let done = std::str::from_utf8(a.json_result())
            .unwrap()
            .contains("\"done\":true");
        a.ack();
        if done {
            break;
        }
    }
    assert_eq!(a.full_finish(1), OK);
    let meta = a.json_result().to_vec();
    a.ack();
    assert_eq!(a.full_finish(1), OK);
    assert_eq!(a.json_result(), meta);
    a.ack();
    assert_eq!(a.full_read(1, 0, 0), OK);
    assert_eq!(a.float_result().len(), 3);
    assert!(a.float_result().iter().any(|v| *v != 0.0));
    a.ack();
    assert_eq!(a.full_read(1, 5, 0), BAD_ARGUMENT);
    assert_eq!(a.kind(), 0);
    assert_eq!(a.full_read(1, 999, 0), BAD_ARGUMENT);
    assert_eq!(a.full_cancel(1), OK);
}
#[test]
fn full_admission_checks_physical_rate_and_input_domain() {
    let mut a = SpeechApi::new();
    for (rate, p) in [
        (0, params()),
        (
            16000,
            Parameters {
                ceiling: 8000,
                ..Parameters::default()
            },
        ),
        (
            48000,
            Parameters {
                ceiling: u32::MAX,
                ..params()
            },
        ),
    ] {
        assert_eq!(a.full_begin(&[0; 64], rate, p, &[]), BAD_ARGUMENT);
    }
    assert_eq!(a.full_begin(&[], 12000, params(), &[]), BAD_ARGUMENT);
    assert_eq!(
        a.full_begin(&[0; 64], 12000, params(), &[0.0; 4097]),
        BAD_ARGUMENT
    );
    assert_eq!(a.full_burg(&[f64::NAN], 12), BAD_ARGUMENT);
    assert_eq!(a.full_roots(&[0.0, 1.0], &TestMath), BAD_ARGUMENT);
}
#[test]
fn every_formant_profile_handles_short_captures_without_partial_failure() {
    for rate in [12000, 16000, 22050, 24000, 32000, 44100, 48000] {
        for ceiling in [4000, 4500, 5000, 5500, 6000, 7000, 8000] {
            if ceiling + 1000 > rate / 2 {
                continue;
            }
            let mut s = FullSession::new(
                vec![0; 64],
                rate,
                Parameters {
                    ceiling,
                    order: 14,
                    window_ms: 40,
                    connected: false,
                },
                &[],
            )
            .unwrap();
            for _ in 0..100 {
                if s.done() {
                    break;
                }
                s.step(&TestMath).unwrap();
            }
            assert!(s.done());
            assert!(s.finish().unwrap().get("profile").is_some());
        }
    }
}
