#![cfg(feature = "speech")]
use noise_core::speech::*;
#[test]
fn track_rejects_nonadvancing_hop_and_rate() {
    assert!(pitch_track(&[0.0; 16], 12000.0, 8, 0, 0.1, 40.0, 1200.0).is_err());
    assert!(pitch_track(&[0.0; 16], 0.0, 8, 1, 0.1, 40.0, 1200.0).is_err());
    assert!(pitch_track(&[0.0; 16], f64::INFINITY, 8, 1, 0.1, 40.0, 1200.0).is_err());
}
#[test]
fn short_input_has_no_partial_frames() {
    assert!(
        pitch_track(&[0.0; 15], 12000.0, 16, 1, 0.1, 40.0, 1200.0)
            .unwrap()
            .is_empty()
    );
    for n in 0..8 {
        assert_eq!(
            yin_pitch_frame(&vec![1.0; n], 12000.0, 0.1, 40.0, 1200.0).f0,
            0.0
        );
    }
}
#[test]
fn odd_frame_centers_remain_half_sample_times() {
    let track = pitch_track(&[0.0; 10], 12000.0, 9, 1, 0.1, 40.0, 1200.0).unwrap();
    assert_eq!(track.len(), 2);
    assert_eq!(track[0].time.to_bits(), (4.5f64 / 12000.0).to_bits());
    assert_eq!(track[1].time.to_bits(), (5.5f64 / 12000.0).to_bits());
}
