use noise_wasm::speech_api::{OK, SpeechApi};
use std::io::{self, Read, Write};
fn main() {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes).unwrap();
    let op = bytes[0];
    let rate = u32::from_le_bytes(bytes[1..5].try_into().unwrap());
    let n = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    assert!(n <= 262144);
    assert_eq!(bytes.len(), 9 + n * 2);
    let pcm: Vec<i16> = bytes[9..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let mut a = SpeechApi::new();
    match op {
        1 => {
            assert_eq!(a.inspect_pcm_offline(&pcm, rate), OK);
            io::stdout().write_all(a.json_result()).unwrap();
        }
        2 => {
            assert_eq!(a.center_pcm(&pcm), OK);
            let output: Vec<u8> = a
                .float_result()
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            io::stdout().write_all(&output).unwrap();
        }
        _ => panic!("unknown operation"),
    }
}
