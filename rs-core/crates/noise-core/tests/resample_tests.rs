#![cfg(feature = "speech")]
use noise_core::speech::resample::*;
#[test]
fn invalid_profiles_and_nonfinite_inputs_reject() {
    assert_eq!(
        resample_low_pass(&[], 44100, 16000, 5500.0),
        Err(ERR_UNSUPPORTED_PROFILE)
    );
    assert_eq!(
        resample_low_pass(&[], 44100, 12000, 5500.1),
        Err(ERR_UNSUPPORTED_PROFILE)
    );
    assert_eq!(
        resample_low_pass(&[f32::NAN], 44100, 12000, 5500.0),
        Err(ERR_NON_FINITE_INPUT)
    );
    assert_eq!(
        resample_low_pass(&vec![0.0; MAX_INPUT_SAMPLES + 1], 44100, 12000, 5500.0),
        Err(ERR_INPUT_TOO_LONG)
    );
}
#[test]
fn empty_valid_profile_has_no_output() {
    for input in SUPPORTED_INPUT_RATES {
        assert!(
            resample_low_pass(&[], input, 12000, 5500.0)
                .unwrap()
                .is_empty()
        );
    }
}
