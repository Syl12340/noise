#![cfg(feature = "harmonicity")]
use noise_core::speech::{
    fractional::{WorkBudget, refine_correlation_peak},
    harmonicity::*,
};
fn window() -> [f64; 129] {
    let b = include_bytes!("../../../coefficients/hnr-v1/fractional-window.f64le");
    core::array::from_fn(|i| f64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap()))
}
#[test]
fn budget_refusal_is_atomic_and_refinement_does_not_publish() {
    let mut budget = WorkBudget::new(10);
    budget.charge(3).unwrap();
    let before = budget;
    assert!(budget.charge(8).is_err());
    assert_eq!(budget, before);
    let signal: Vec<f64> = (0..512)
        .map(|i| if i % 2 == 0 { 0.2 } else { -0.2 })
        .collect();
    let mut empty = WorkBudget::new(0);
    assert_eq!(
        refine_correlation_peak(&signal, 10.2, 9.0, 11.0, &window(), &f64::sin, &mut empty),
        Err("work budget exceeded")
    );
    assert_eq!(empty.consumed, 0);
}
#[test]
fn no_lower_clamp_is_added_to_hnr() {
    assert!(calculate_hnr(1e-12).unwrap() < -119.0);
    assert_eq!(calculate_hnr(0.0), None);
    assert_eq!(calculate_hnr(f64::NAN), None);
    assert_eq!(calculate_hnr(1.0), calculate_hnr(1.0 - 1e-6));
}
#[test]
fn pitch_that_overflows_lag_is_rejected() {
    let mut budget = WorkBudget::new(150_000_000);
    let pitch = [PitchEvidence {
        time: 0.1,
        f0: 5e-324,
        aperiodicity: 0.1,
    }];
    assert!(
        estimate_harmonicity(
            &[],
            12000.0,
            &HarmonicityOptions::default(),
            &pitch,
            &f64::sin,
            &mut budget
        )
        .is_err()
    );
    // A finite lag can underflow to zero. Preserve the baseline truthiness fallback.
    let fs = 1e-300;
    let signal: Vec<f32> = (0..1024)
        .map(|i| if i % 2 == 0 { 0.2 } else { -0.2 })
        .collect();
    let opts = HarmonicityOptions {
        fmin: fs / 80.0,
        fmax: fs / 20.0,
        require_pitch: true,
        ..Default::default()
    };
    let evidence = [PitchEvidence {
        time: 512.0 / fs,
        f0: 1e308,
        aperiodicity: 0.1,
    }];
    assert!(
        estimate_harmonicity(&signal, fs, &opts, &evidence, &f64::sin, &mut budget)
            .unwrap()
            .summary
            .valid_frames
            > 0
    );
}
#[test]
fn zero_duration_summary_does_not_turn_low_energy_into_eligible_frames() {
    let row = HnrRow {
        time: 0.0,
        db: Some(40.0),
        reason: Some("low-energy"),
        peak_correlation: None,
        lag_samples: None,
        comparison_samples: None,
        correlation_method: None,
        refinement_converged: None,
    };
    let summary = summarize_harmonicity(&[row], 0.01, 0.0);
    assert_eq!(summary.active_frames, 0);
    assert_eq!(summary.valid_frames, 0);
    assert_eq!(summary.avg_hnr, None);
}
