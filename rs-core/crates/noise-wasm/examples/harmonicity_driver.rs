//! Native verification uses only the actual-JS frozen scalar-sin oracle.
use noise_core::speech::{
    fractional::{WorkBudget, refine_correlation_peak},
    harmonicity::{
        HarmonicityOptions, HnrRow, PitchEvidence, calculate_hnr, estimate_harmonicity,
        summarize_harmonicity,
    },
};
use noise_wasm::harmonicity_api as wire;
use std::{collections::HashMap, env, fs};
struct Reader {
    data: Vec<u8>,
    pos: usize,
}
impl Reader {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let end = self.pos.checked_add(N).unwrap();
        let b = self.data[self.pos..end].try_into().unwrap();
        self.pos = end;
        b
    }
    fn byte(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    fn u32(&mut self) -> usize {
        u32::from_le_bytes(self.take()) as usize
    }
    fn f64(&mut self) -> f64 {
        f64::from_le_bytes(self.take())
    }
    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }
    fn oracle(&mut self) -> HashMap<u64, f64> {
        let n = self.u32();
        let mut m = HashMap::with_capacity(n);
        for _ in 0..n {
            let key = u64::from_le_bytes(self.take());
            let value = self.f64();
            assert!(m.insert(key, value).is_none());
        }
        m
    }
}
fn main() {
    let args: Vec<String> = env::args().collect();
    let mut r = Reader {
        data: fs::read(&args[1]).unwrap(),
        pos: 0,
    };
    assert_eq!(r.take::<4>(), *b"HNC1");
    let op = r.byte();
    let mut budget = WorkBudget::new(150_000_000);
    let output = match op {
        1 | 6 => {
            let fs = r.f64();
            let options = HarmonicityOptions {
                frame_size: r.u32(),
                hop: r.u32(),
                fmin: r.f64(),
                fmax: r.f64(),
                require_pitch: r.byte() != 0,
                min_peak_correlation: r.f64(),
                max_pitch_deviation: r.f64(),
            };
            let n = r.u32();
            let pn = r.u32();
            assert!(n <= 262144 && pn <= if op == 6 { 4096 } else { 512 });
            let signal: Vec<f32> = (0..n).map(|_| r.f32()).collect();
            let pitch: Vec<PitchEvidence> = (0..pn)
                .map(|_| PitchEvidence {
                    time: r.f64(),
                    f0: r.f64(),
                    aperiodicity: r.f64(),
                })
                .collect();
            let oracle = r.oracle();
            let sin = |x: f64| {
                *oracle
                    .get(&x.to_bits())
                    .unwrap_or_else(|| panic!("Unknown sin input {:016x}", x.to_bits()))
            };
            if op == 6 {
                let mut session =
                    noise_core::speech::hnr_session::HnrSession::new(signal, fs, options, pitch)
                        .unwrap();
                while session.next(&sin).unwrap().is_some() {}
                let first = wire::result(session.finish().unwrap());
                assert_eq!(first, wire::result(session.finish().unwrap()));
                first
            } else {
                wire::result(
                    &estimate_harmonicity(&signal, fs, &options, &pitch, &sin, &mut budget)
                        .unwrap(),
                )
            }
        }
        2 => {
            let initial = r.f64();
            let lower = r.f64();
            let upper = r.f64();
            let n = r.u32();
            assert!(n <= 4096);
            let frame: Vec<f64> = (0..n).map(|_| r.f64()).collect();
            let oracle = r.oracle();
            let sin = |x: f64| {
                *oracle
                    .get(&x.to_bits())
                    .unwrap_or_else(|| panic!("Unknown sin input {:016x}", x.to_bits()))
            };
            let bytes = include_bytes!("../../../coefficients/hnr-v1/fractional-window.f64le");
            let window = core::array::from_fn(|i| {
                f64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap())
            });
            wire::refinement(
                &refine_correlation_peak(&frame, initial, lower, upper, &window, &sin, &mut budget)
                    .unwrap(),
            )
        }
        3 => calculate_hnr(r.f64())
            .map(wire::number)
            .unwrap_or_else(|| "null".into()),
        4 => {
            let hop = r.f64();
            let min = r.f64();
            let n = r.u32();
            assert!(n <= 4096);
            let mut rows = Vec::new();
            for _ in 0..n {
                let time = r.f64();
                let present = r.byte();
                let value = r.f64();
                let reason = match r.byte() {
                    0 => None,
                    1 => Some("low-energy"),
                    2 => Some("unvoiced-or-uncertain"),
                    3 => Some("capture-gap-boundary"),
                    4 => Some("low-periodicity"),
                    5 => Some("no-periodic-peak"),
                    _ => Some("other"),
                };
                rows.push(HnrRow {
                    time,
                    db: if present == 1 { Some(value) } else { None },
                    reason,
                    peak_correlation: None,
                    lag_samples: None,
                    comparison_samples: None,
                    correlation_method: None,
                    refinement_converged: None,
                });
            }
            wire::summary(&summarize_harmonicity(&rows, hop, min))
        }
        5 => {
            use noise_core::speech::harmonicity::{
                FrameDiagnostics, estimate_harmonicity_observed,
            };
            let n = r.u32();
            assert!((256..=4096).contains(&n));
            let signal: Vec<f32> = (0..n).map(|_| r.f32()).collect();
            let floats = |v: Option<&[f64]>| {
                v.map(|v| {
                    format!(
                        "[{}]",
                        v.iter()
                            .map(|&x| wire::number(x))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                })
                .unwrap_or_else(|| "null".into())
            };
            let mut output = String::new();
            let mut observer = |d: FrameDiagnostics<'_>| {
                output = format!(
                    "{{\"mean\":{},\"centered\":{},\"energies\":{},\"fftSize\":{},\"stage1Re\":{},\"stage1Im\":{},\"autocorrelationRe\":{}}}",
                    wire::number(d.mean),
                    floats(Some(d.centered)),
                    floats(Some(d.energies)),
                    d.fft_size,
                    floats(d.stage1_re),
                    floats(d.stage1_im),
                    floats(d.autocorrelation_re)
                );
            };
            let opts = HarmonicityOptions {
                frame_size: n,
                require_pitch: true,
                ..Default::default()
            };
            estimate_harmonicity_observed(
                &signal,
                12000.0,
                &opts,
                &[],
                &|_| panic!("Unexpected sine evaluation"),
                &mut budget,
                Some(&mut observer),
            )
            .unwrap();
            output
        }
        _ => panic!("Unknown HNC1 operation"),
    };
    assert_eq!(r.pos, r.data.len());
    println!("{output}");
}
