"""One-time reviewed corrections to incomplete DSH delivery; no baseline edits."""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parents[1]
p=root/'crates/noise-core/src/speech/fractional.rs'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='caa80f4c88077b77cea2a0d45f4c50506a3816f827bd684dea712d8ad3e3cc1f','Delivery changed; inspect before editing'
text=p.read_text(encoding='utf8')
text=text.replace('    kernel: [f64; KERNEL_LEN],','    kernel: [f64; KERNEL_LEN],\n    window: [f64; KERNEL_LEN],',1)
text=text.replace('            kernel: *window,','            kernel: [0.0; KERNEL_LEN],\n            window: *window,',1)
text=text.replace('for j in -HALF..=HALF {','for j in -(HALF as i32)..=HALF as i32 {',1)
text=text.replace('sin(pi_t) / pi_t * self.kernel[(j + HALF) as usize]','sin(pi_t) / pi_t * self.window[(j + HALF as i32) as usize]',1)
text=text.replace('self.kernel[(j + HALF) as usize] = value;','self.kernel[(j + HALF as i32) as usize] = value;',1)
text=text.replace('(dot / denominator).max(-1.0).min(1.0)','{ let ratio=dot/denominator; if ratio.is_nan() {f64::NAN} else {ratio.clamp(-1.0,1.0)} }',1)
start=text.index('fn js_round(');end=text.index('/// Maximizes',start)
text=text[:start]+'''fn js_round(value:f64)->f64 {
    if !value.is_finite() || value==0.0 {return value;}
    let floor=value.floor();let rounded=if value-floor<0.5 {floor}else{floor+1.0};
    if rounded==0.0&&value<0.0 {-0.0}else{rounded}
}

'''+text[end:]
text=text.replace('    let mut state = Comparison::new(frame, upper, window);','''    if !initial.is_finite() || !lower.is_finite() || !upper.is_finite() || lower<0.0
        || upper>frame.len() as f64 || frame.len()>4096 || !frame.iter().all(|v|v.is_finite()) {
        return Err("invalid refinement input");
    }
    let mut state = Comparison::new(frame, upper, window);''',1)
start=text.index('                    let clamped =');end=text.index('\n',text.index('                    d =',start))
text=text[:start]+'                    d = if middle >= x { 1.0 } else { -1.0 } * TOLERANCE;'+text[end:]
text=text.replace("non-NaN operand, which is what JavaScript's Math.min/Math.max do.","non-NaN operand; all three arguments here were validated finite.")
p.write_bytes(text.encode('utf8'))
