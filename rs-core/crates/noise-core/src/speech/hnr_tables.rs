pub fn window() -> [f64; 129] {
    let bytes = include_bytes!("../../../../coefficients/hnr-v1/fractional-window.f64le");
    core::array::from_fn(|i| f64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap()))
}
