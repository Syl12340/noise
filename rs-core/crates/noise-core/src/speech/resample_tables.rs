//! Frozen coefficient loader. Generated from actual baseline cache; no runtime trig.
pub(crate) struct KernelBank {
    pub kernels: Vec<(u32, Vec<f64>)>,
}
pub(crate) fn load_bank(input_rate: u32, output_rate: u32, cutoff_hz: f64) -> Option<KernelBank> {
    if output_rate != 12000 || cutoff_hz != 5500.0 {
        return None;
    }
    let bytes: &[u8] = match input_rate {
        12000 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r12000.bin"),
        16000 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r16000.bin"),
        22050 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r22050.bin"),
        24000 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r24000.bin"),
        32000 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r32000.bin"),
        44100 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r44100.bin"),
        48000 => include_bytes!("../../../../coefficients/speech-resample-12000-v1/r48000.bin"),
        _ => return None,
    };
    let count = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let mut cursor = 24;
    let mut kernels = Vec::with_capacity(count);
    for _ in 0..count {
        let key = u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap());
        cursor += 4;
        let mut kernel = Vec::with_capacity(257);
        for _ in 0..257 {
            kernel.push(f64::from_le_bytes(
                bytes[cursor..cursor + 8].try_into().unwrap(),
            ));
            cursor += 8;
        }
        kernels.push((key, kernel));
    }
    Some(KernelBank { kernels })
}
