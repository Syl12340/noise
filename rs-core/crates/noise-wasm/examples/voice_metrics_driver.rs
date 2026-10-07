use noise_core::speech::voice_metrics::IntensityOptions;
use noise_wasm::speech_api::{OK, SpeechApi};
use std::io::{self, Read, Write};
fn main() {
    let mut b = Vec::new();
    io::stdin().read_to_end(&mut b).unwrap();
    let mut a = SpeechApi::new();
    match b[0] {
        1 => {
            let fs = f64::from_le_bytes(b[1..9].try_into().unwrap());
            let frame = u32::from_le_bytes(b[9..13].try_into().unwrap()) as usize;
            let hop = u32::from_le_bytes(b[13..17].try_into().unwrap()) as usize;
            let n = u32::from_le_bytes(b[17..21].try_into().unwrap()) as usize;
            assert!(n <= 262144);
            assert_eq!(b.len(), 21 + n * 4);
            let signal: Vec<f32> = b[21..]
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(
                a.intensity_track(
                    &signal,
                    IntensityOptions {
                        fs,
                        frame_size: if frame == 0 { None } else { Some(frame) },
                        hop: if hop == 0 { None } else { Some(hop) }
                    }
                ),
                OK
            );
        }
        2 => {
            let n = u32::from_le_bytes(b[1..5].try_into().unwrap()) as usize;
            assert!(n <= 4096);
            assert_eq!(b.len(), 7 + n * 8);
            let f0: Vec<f64> = b[7..]
                .chunks_exact(8)
                .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(a.period_variability(&f0, b[5] != 0, b[6] != 0), OK);
        }
        _ => panic!("unknown operation"),
    }
    io::stdout().write_all(a.json_result()).unwrap();
}
