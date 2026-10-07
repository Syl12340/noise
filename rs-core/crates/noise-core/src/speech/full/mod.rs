pub mod formants;
pub mod linear;
pub mod pipeline;
pub mod resample;
pub mod roots;
pub mod spectral;
pub mod tables;
pub mod value;
pub trait FullMath: roots::RootMath {
    fn atan2(&self, y: f64, x: f64) -> f64;
    fn ln(&self, x: f64) -> f64;
    fn log10(&self, x: f64) -> f64;
    fn sin(&self, x: f64) -> f64;
}
pub fn js_round(v: f64) -> f64 {
    let f = v.floor();
    if v - f < 0.5 { f } else { f + 1.0 }
}
