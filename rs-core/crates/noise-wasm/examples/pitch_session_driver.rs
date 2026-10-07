use noise_core::speech::pitch_session::{PitchOptions, PitchSession};
use noise_wasm::speech_api::pitch_track_json;
use std::io::{self, Read};
struct Reader {
    bytes: Vec<u8>,
    at: usize,
}
impl Reader {
    fn u32(&mut self) -> usize {
        let n = u32::from_le_bytes(self.bytes[self.at..self.at + 4].try_into().unwrap());
        self.at += 4;
        n as usize
    }
    fn f64(&mut self) -> f64 {
        let n = f64::from_le_bytes(self.bytes[self.at..self.at + 8].try_into().unwrap());
        self.at += 8;
        n
    }
}
fn main() {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes).unwrap();
    let mut r = Reader { bytes, at: 0 };
    let fs = r.f64();
    let frame_size = r.u32();
    let hop = r.u32();
    let threshold = r.f64();
    let fmin = r.f64();
    let fmax = r.f64();
    let n = r.u32();
    assert!(n <= 262144);
    assert_eq!(r.bytes.len() - r.at, n * 4);
    let signal = r.bytes[r.at..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let mut s = PitchSession::new(
        signal,
        PitchOptions {
            fs,
            frame_size,
            hop,
            threshold,
            fmin,
            fmax,
        },
    )
    .unwrap();
    while !s.done() {
        s.step_frame();
    }
    let text = pitch_track_json(s.finish().unwrap());
    assert_eq!(pitch_track_json(s.finish().unwrap()), text);
    println!("{text}");
}
