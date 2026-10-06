use noise_core::speech::time_support::Interval;
use noise_wasm::speech_api::SpeechApi;
use std::io::{self, Read};
fn main() {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes).unwrap();
    let mut words = bytes
        .chunks_exact(8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()));
    let n = words.next().unwrap() as usize;
    let count = words.next().unwrap() as usize;
    let window = words.next().unwrap();
    let margin = words.next().unwrap();
    let duration = words.next().unwrap();
    assert!(n <= 4096 && count <= 4096);
    let times: Vec<f64> = words.by_ref().take(n).collect();
    let intervals: Vec<Interval> = (0..count)
        .map(|_| Interval {
            start: words.next().unwrap(),
            end: words.next().unwrap(),
        })
        .collect();
    assert_eq!(times.len(), n);
    assert!(words.next().is_none());
    let mut api = SpeechApi::new();
    assert_eq!(
        api.support_evidence(&times, window, margin, duration, &intervals),
        0
    );
    println!("{}", std::str::from_utf8(api.json_result()).unwrap());
}
