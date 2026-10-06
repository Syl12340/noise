//! Bounded radix2 FFT with the same frozen stage rotations and ordered butterflies.
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    assert!(n.is_power_of_two() && (512..=8192).contains(&n));
    assert_eq!(im.len(), n);
    let rotations = include_bytes!("../../../../coefficients/noise-44100-v1/fft_rotations.f64le");
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut stage = 0;
    let mut len = 2;
    while len <= n {
        let half = len >> 1;
        let w_re = f64::from_le_bytes(rotations[stage * 16..stage * 16 + 8].try_into().unwrap());
        let w_im = f64::from_le_bytes(
            rotations[stage * 16 + 8..stage * 16 + 16]
                .try_into()
                .unwrap(),
        );
        let mut i = 0;
        while i < n {
            let mut cur_re = 1.0;
            let mut cur_im = 0.0;
            for k in 0..half {
                let tr = cur_re * re[i + k + half] - cur_im * im[i + k + half];
                let ti = cur_re * im[i + k + half] + cur_im * re[i + k + half];
                re[i + k + half] = re[i + k] - tr;
                im[i + k + half] = im[i + k] - ti;
                re[i + k] += tr;
                im[i + k] += ti;
                let new_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = new_re;
            }
            i += len;
        }
        stage += 1;
        len <<= 1;
    }
}
