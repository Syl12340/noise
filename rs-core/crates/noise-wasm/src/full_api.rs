#[cfg(target_arch = "wasm32")]
use noise_core::speech::full::{FullMath, roots::RootMath, tables};
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn math_hypot(a: f64, b: f64) -> f64;
    fn math_atan2(a: f64, b: f64) -> f64;
    fn math_log(a: f64) -> f64;
    fn math_log10(a: f64) -> f64;
    fn hnr_sin(a: f64) -> f64;
}
#[cfg(target_arch = "wasm32")]
pub struct RuntimeMath;
#[cfg(target_arch = "wasm32")]
impl RootMath for RuntimeMath {
    fn seed(&self, d: usize, i: usize) -> (f64, f64) {
        tables::root_seed(d, i)
    }
    fn hypot(&self, a: f64, b: f64) -> f64 {
        unsafe { math_hypot(a, b) }
    }
}
#[cfg(target_arch = "wasm32")]
impl FullMath for RuntimeMath {
    fn atan2(&self, y: f64, x: f64) -> f64 {
        unsafe { math_atan2(y, x) }
    }
    fn ln(&self, x: f64) -> f64 {
        unsafe { math_log(x) }
    }
    fn log10(&self, x: f64) -> f64 {
        unsafe { math_log10(x) }
    }
    fn sin(&self, x: f64) -> f64 {
        unsafe { hnr_sin(x) }
    }
}
