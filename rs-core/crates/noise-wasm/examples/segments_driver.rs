use noise_core::speech::{
    harmonicity::{self, HnrResult, HnrRow, PitchEvidence},
    segments::Span,
    time_support::Interval,
};
use noise_wasm::segments_api::{self, Assembly};
use std::io::{self, Read};
struct Reader {
    bytes: Vec<u8>,
    at: usize,
}
impl Reader {
    fn byte(&mut self) -> u8 {
        let b = self.bytes[self.at];
        self.at += 1;
        b
    }
    fn u32(&mut self) -> usize {
        let x = u32::from_le_bytes(self.bytes[self.at..self.at + 4].try_into().unwrap());
        self.at += 4;
        x as usize
    }
    fn f64(&mut self) -> f64 {
        let x = f64::from_le_bytes(self.bytes[self.at..self.at + 8].try_into().unwrap());
        self.at += 8;
        x
    }
    fn optional(&mut self) -> Option<f64> {
        if self.byte() == 0 {
            None
        } else {
            Some(self.f64())
        }
    }
    fn reason(&mut self) -> Option<&'static str> {
        match self.byte() {
            0 => None,
            1 => Some("low-energy"),
            2 => Some("unvoiced-or-uncertain"),
            3 => Some("low-periodicity"),
            4 => Some("no-periodic-peak"),
            _ => panic!("bad reason"),
        }
    }
    fn intervals(&mut self) -> Vec<Interval> {
        let n = self.u32();
        assert!(n <= 4096);
        (0..n)
            .map(|_| Interval {
                start: self.f64(),
                end: self.f64(),
            })
            .collect()
    }
    fn hnr(&mut self, hop: usize) -> HnrResult {
        let signal_frames = self.u32();
        let capped_frames = self.u32();
        let n = self.u32();
        assert!(n <= 4096);
        let track: Vec<HnrRow> = (0..n)
            .map(|_| HnrRow {
                time: self.f64(),
                db: self.optional(),
                reason: self.reason(),
                peak_correlation: self.optional(),
                lag_samples: self.optional(),
                comparison_samples: self.optional().map(|v| v as usize),
                correlation_method: if self.byte() == 0 {
                    None
                } else {
                    Some(harmonicity::CORRELATION_METHOD)
                },
                refinement_converged: match self.byte() {
                    0 => None,
                    1 => Some(false),
                    2 => Some(true),
                    _ => panic!("bad convergence"),
                },
            })
            .collect();
        let summary = harmonicity::summarize_harmonicity(&track, hop as f64 / 12000.0, 0.1);
        HnrResult {
            track,
            signal_frames,
            capped_frames,
            correlation_method: harmonicity::CORRELATION_METHOD,
            interpolation_half_samples: 64,
            summary,
        }
    }
}
fn main() {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes).unwrap();
    let mut r = Reader { bytes, at: 0 };
    let op = r.byte();
    let samples = r.u32();
    let rate = r.u32() as u32;
    let output = match op {
        1 => {
            let n = r.u32();
            assert!(n <= 4096);
            let boundaries: Vec<f64> = (0..n).map(|_| r.f64()).collect();
            segments_api::plan(samples, rate, &boundaries).unwrap()
        }
        2 => {
            let frame = r.u32();
            let n = r.u32();
            assert!(n <= 4096);
            let pitch: Vec<PitchEvidence> = (0..n)
                .map(|_| PitchEvidence {
                    time: r.f64(),
                    f0: r.f64(),
                    aperiodicity: r.f64(),
                })
                .collect();
            let intervals = r.intervals();
            segments_api::pitch(&pitch, samples, rate, frame, &intervals).unwrap()
        }
        3 => {
            let frame = r.u32();
            let hop = r.u32();
            let n = r.u32();
            assert!(n <= 128);
            let mut a = Assembly::new(samples, rate, frame, hop).unwrap();
            for _ in 0..n {
                let span = Span {
                    start_sample: r.u32(),
                    end_sample: r.u32(),
                };
                let failed = r.byte() != 0;
                let intervals = r.intervals();
                let hnr = if failed { None } else { Some(r.hnr(hop)) };
                a.append(span, hnr.as_ref(), &intervals).unwrap();
            }
            a.finish().unwrap().to_owned()
        }
        _ => panic!("bad operation"),
    };
    assert_eq!(r.at, r.bytes.len());
    println!("{output}");
}
