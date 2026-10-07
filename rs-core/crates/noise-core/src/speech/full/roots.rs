#[derive(Clone, Copy, Debug)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}
pub trait RootMath {
    fn hypot(&self, a: f64, b: f64) -> f64;
    fn seed(&self, degree: usize, index: usize) -> (f64, f64);
}
fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
fn polynomial(c: &[f64], z: Complex) -> Complex {
    let mut re = c[0];
    let mut im = 0.0;
    for &v in &c[1..] {
        let r = re * z.re - im * z.im + v;
        im = re * z.im + im * z.re;
        re = r;
    }
    Complex { re, im }
}
fn residual(c: &[f64], z: Complex, math: &impl RootMath) -> f64 {
    let p = polynomial(c, z);
    let magnitude = math.hypot(p.re, p.im);
    let absz = math.hypot(z.re, z.im);
    let mut scale = c[0].abs();
    for &v in &c[1..] {
        scale = scale * absz + v.abs();
    }
    magnitude / max(1.0, scale)
}
pub fn find_roots(
    coefficients: &[f64],
    math: &impl RootMath,
) -> Result<Vec<Complex>, &'static str> {
    if coefficients.len() <= 1 {
        return Ok(vec![]);
    }
    let degree = coefficients.len() - 1;
    if degree > 32 || !coefficients.iter().all(|v| v.is_finite()) || coefficients[0].abs() < 1e-30 {
        return Err("invalid polynomial");
    }
    let c: Vec<f64> = coefficients.iter().map(|v| v / coefficients[0]).collect();
    if !c.iter().all(|v| v.is_finite()) {
        return Err("nonfinite polynomial normalization");
    }
    if degree == 1 {
        return Ok(vec![Complex { re: -c[1], im: 0.0 }]);
    }
    let mut radius = 1.0;
    for v in &c[1..] {
        radius = max(radius, 1.0 + v.abs());
    }
    let mut roots: Vec<Complex> = (0..degree)
        .map(|i| {
            let (cos, sin) = math.seed(degree, i);
            let radial = 1.0 + 0.01 * i as f64 / degree as f64;
            Complex {
                re: radius * radial * cos,
                im: radius * radial * sin,
            }
        })
        .collect();
    let mut converged = false;
    for _ in 0..2000 {
        let mut next = Vec::with_capacity(degree);
        let mut delta = 0.0;
        for i in 0..degree {
            let z = roots[i];
            let value = polynomial(&c, z);
            let mut dr = 1.0;
            let mut di = 0.0;
            for (j, other) in roots.iter().enumerate() {
                if j == i {
                    continue;
                }
                let r = z.re - other.re;
                let im = z.im - other.im;
                let nr = dr * r - di * im;
                di = dr * im + di * r;
                dr = nr;
            }
            let mut abs = dr * dr + di * di;
            if abs < 1e-30 {
                dr += 1e-12 * (i + 1) as f64;
                di += 1e-12 * (degree - i) as f64;
                abs = dr * dr + di * di;
            }
            let r = (value.re * dr + value.im * di) / abs;
            let im = (value.im * dr - value.re * di) / abs;
            next.push(Complex {
                re: z.re - r,
                im: z.im - im,
            });
            delta = max(delta, math.hypot(r, im));
        }
        roots = next;
        let mut max_res = 0.0;
        let mut magnitude = 0.0;
        for &z in &roots {
            max_res = max(max_res, residual(&c, z, math));
            magnitude = max(magnitude, math.hypot(z.re, z.im));
        }
        if delta <= 1e-12 * (1.0 + magnitude) && max_res <= 1e-10 {
            converged = true;
            break;
        }
    }
    let mut final_res = 0.0;
    for &z in &roots {
        final_res = max(final_res, residual(&c, z, math));
    }
    if !final_res.is_finite()
        || roots.iter().any(|z| !z.re.is_finite() || !z.im.is_finite())
        || (!converged && final_res > 1e-7)
    {
        return Err("polynomial did not converge");
    }
    for z in &mut roots {
        if z.re.abs() < 1e-12 {
            z.re = 0.0;
        }
        if z.im.abs() < 1e-10 {
            z.im = 0.0;
        }
    }
    roots.sort_by(|a, b| {
        a.re.partial_cmp(&b.re)
            .unwrap()
            .then_with(|| a.im.partial_cmp(&b.im).unwrap())
    });
    Ok(roots)
}
