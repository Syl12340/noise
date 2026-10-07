use noise_core::speech::full::{
    self, FullMath,
    formants::{FormantSession, PitchInfo, TrackOptions},
    pipeline::{FullSession, Parameters},
    roots::RootMath,
    spectral::SpectrogramSession,
    value::{Value, array, num, obj},
};
use std::{
    collections::BTreeMap,
    io::{self, Read},
};
struct Reader {
    b: Vec<u8>,
    at: usize,
}
impl Reader {
    fn byte(&mut self) -> u8 {
        let v = self.b[self.at];
        self.at += 1;
        v
    }
    fn u(&mut self) -> usize {
        let v = u32::from_le_bytes(self.b[self.at..self.at + 4].try_into().unwrap());
        self.at += 4;
        v as usize
    }
    fn f(&mut self) -> f64 {
        let v = f64::from_le_bytes(self.b[self.at..self.at + 8].try_into().unwrap());
        self.at += 8;
        v
    }
    fn signal(&mut self) -> Vec<f32> {
        let n = self.u();
        assert!(n <= 262144);
        let v = self.b[self.at..self.at + n * 4]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        self.at += n * 4;
        v
    }
    fn doubles(&mut self) -> Vec<f64> {
        let n = self.u();
        assert!(n <= 4096);
        (0..n).map(|_| self.f()).collect()
    }
    fn pcm(&mut self) -> Vec<i16> {
        let n = self.u();
        assert!(n <= 262144);
        let v = self.b[self.at..self.at + n * 2]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes(b.try_into().unwrap()))
            .collect();
        self.at += n * 2;
        v
    }
}
fn bits(v: f64) -> u64 {
    if v.is_nan() {
        f64::NAN.to_bits()
    } else {
        v.to_bits()
    }
}
struct Oracle {
    values: BTreeMap<(u8, u64, u64), f64>,
}
impl Oracle {
    fn read(r: &mut Reader) -> Self {
        let n = r.u();
        assert!(n <= 2_000_000);
        let mut values = BTreeMap::new();
        for _ in 0..n {
            let code = r.byte();
            let a = r.f();
            let b = r.f();
            let output = r.f();
            values.insert((code, bits(a), bits(b)), output);
        }
        Self { values }
    }
    fn get(&self, code: u8, a: f64, b: f64) -> f64 {
        *self
            .values
            .get(&(code, bits(a), bits(b)))
            .unwrap_or_else(|| panic!("Unknown oracle input {code}: {a:?} {b:?}"))
    }
}
impl RootMath for Oracle {
    fn seed(&self, d: usize, i: usize) -> (f64, f64) {
        full::tables::root_seed(d, i)
    }
    fn hypot(&self, a: f64, b: f64) -> f64 {
        self.get(1, a, b)
    }
}
impl FullMath for Oracle {
    fn atan2(&self, a: f64, b: f64) -> f64 {
        self.get(2, a, b)
    }
    fn ln(&self, a: f64) -> f64 {
        self.get(3, a, 0.0)
    }
    fn log10(&self, a: f64) -> f64 {
        self.get(4, a, 0.0)
    }
    fn sin(&self, a: f64) -> f64 {
        self.get(5, a, 0.0)
    }
}
fn main() {
    let mut b = Vec::new();
    io::stdin().read_to_end(&mut b).unwrap();
    let mut r = Reader { b, at: 0 };
    let op = r.byte();
    let result = match op {
        1 => {
            let order = r.u();
            let frame = r.doubles();
            let _math = Oracle::read(&mut r);
            full::linear::burg_lpc(&frame, order).map(|v| {
                obj(vec![
                    ("a", array(v.a.into_iter().map(num).collect())),
                    ("error", num(v.error)),
                ])
            })
        }
        2 => {
            let coeff = r.doubles();
            let math = Oracle::read(&mut r);
            full::roots::find_roots(&coeff, &math).map(|v| {
                array(
                    v.into_iter()
                        .map(|r| obj(vec![("re", num(r.re)), ("im", num(r.im))]))
                        .collect(),
                )
            })
        }
        3 => {
            let fs = r.u() as f64;
            let order = r.u();
            let signal = r.signal();
            let n = r.u();
            let pitch = (0..n)
                .map(|_| PitchInfo {
                    time: r.f(),
                    f0: r.f(),
                    aperiodicity: r.f(),
                    support: None,
                })
                .collect();
            let math = Oracle::read(&mut r);
            let mut s = FormantSession::new(
                signal,
                pitch,
                TrackOptions {
                    fs,
                    frame: full::js_round(fs * 0.025) as usize,
                    hop: full::js_round(fs * 0.01) as usize,
                    order,
                    min: 90.0,
                    max: 5000.0,
                    bandwidth: 500.0,
                    compare_orders: true,
                    fundamental_ratio: 1.5,
                    margin: 0.0,
                },
            )
            .unwrap();
            while !s.done() {
                s.step(&math).unwrap();
            }
            Ok(array(s.rows().to_vec()))
        }
        4 => {
            let fs = r.u() as u32;
            let signal = r.signal();
            let math = Oracle::read(&mut r);
            let mut s = SpectrogramSession::new(signal, fs).unwrap();
            while !s.done() {
                s.step(&math);
            }
            Ok(obj(vec![
                (
                    "data",
                    array(
                        s.columns()
                            .iter()
                            .map(|c| array(c.iter().map(|&v| num(v as f64)).collect()))
                            .collect(),
                    ),
                ),
                ("times", array(s.times().iter().copied().map(num).collect())),
                ("width", num(s.total() as f64)),
                ("height", num(512.0)),
            ]))
        }
        5 => {
            let rate = r.u() as u32;
            let order = r.u();
            let ceiling = r.u() as u32;
            let window_ms = r.u() as u32;
            let connected = r.byte() != 0;
            let cuts = r.doubles();
            let pcm = r.pcm();
            let math = Oracle::read(&mut r);
            let mut s = FullSession::new(
                pcm,
                rate,
                Parameters {
                    order,
                    ceiling,
                    window_ms,
                    connected,
                },
                &cuts,
            )
            .unwrap();
            while !s.done() {
                s.step(&math).unwrap();
            }
            s.complete_value()
        }
        _ => panic!("invalid operation"),
    };
    assert_eq!(r.at, r.b.len());
    println!(
        "{}",
        result
            .unwrap_or_else(|_| obj(vec![("error", Value::Bool(true))]))
            .json()
    );
}
