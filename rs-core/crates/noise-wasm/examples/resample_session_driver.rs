use noise_core::speech::resample_session::ResampleSession;
use std::io::{self, Read, Write};
fn main() {
    let mut b = Vec::new();
    io::stdin().read_to_end(&mut b).unwrap();
    assert!(b.len() >= 24);
    let input = u32::from_le_bytes(b[0..4].try_into().unwrap());
    let output = u32::from_le_bytes(b[4..8].try_into().unwrap());
    let cutoff = f64::from_le_bytes(b[8..16].try_into().unwrap());
    let batch = u32::from_le_bytes(b[16..20].try_into().unwrap()) as usize;
    let n = u32::from_le_bytes(b[20..24].try_into().unwrap()) as usize;
    assert!(n <= 262144);
    assert_eq!(b.len(), 24 + n * 4);
    let signal = b[24..]
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    let mut s = ResampleSession::new(signal, input, output, cutoff).unwrap();
    while !s.done() {
        s.step_batch(batch).unwrap();
    }
    let values = s.finish().unwrap().to_vec();
    assert_eq!(s.finish().unwrap(), values);
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    io::stdout().write_all(&bytes).unwrap();
}
