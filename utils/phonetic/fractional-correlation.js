// Evaluate the actual normalized dot product at fractional delays. Interpolating
// three correlation heights is insufficient for sharp, multi-harmonic peaks.
const HALF = 64;
const window = Float64Array.from({ length: 2 * HALF + 1 }, (_, i) => {
  const lag = i - HALF;
  return .42 + .5 * Math.cos(Math.PI * lag / HALF) + .08 * Math.cos(2 * Math.PI * lag / HALF);
});

function comparison(frame, upperLag) {
  // The same left/right sample pairs and normalization support are used for
  // every lag within this peak's bracket. No endpoint extension is introduced.
  const count = frame.length - 2 * HALF - Math.ceil(upperLag);
  let leftEnergy = 0;
  for (let i = HALF; i < HALF + count; i++) leftEnergy += frame[i] * frame[i];
  return { count, leftEnergy, frame, kernel: new Float64Array(window.length) };
}

function fractionalCorrelation(state, lag) {
  const { frame, count, leftEnergy, kernel } = state;
  if (count < 2 || leftEnergy <= 1e-20) return NaN;
  const integer = Math.floor(lag), fraction = lag - integer;
  let dot = 0, rightEnergy = 0;
  if (fraction < 1e-12 || 1 - fraction < 1e-12) {
    const shift = Math.round(lag);
    for (let i = HALF; i < HALF + count; i++) {
      const right = frame[i + shift];
      dot += frame[i] * right; rightEnergy += right * right;
    }
  } else {
    let sum = 0;
    for (let j = -HALF; j <= HALF; j++) {
      const t = j - fraction;
      const value = Math.sin(Math.PI * t) / (Math.PI * t) * window[j + HALF];
      kernel[j + HALF] = value; sum += value;
    }
    for (let j = 0; j < kernel.length; j++) kernel[j] /= sum;
    for (let i = HALF; i < HALF + count; i++) {
      let right = 0;
      const first = i + integer - HALF;
      for (let j = 0; j < kernel.length; j++) right += frame[first + j] * kernel[j];
      dot += frame[i] * right; rightEnergy += right * right;
    }
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 1e-20 ? Math.max(-1, Math.min(1, dot / denominator)) : NaN;
}

function* refineCorrelationPeak(frame, initialLag, lower, upper) {
  if (!(upper > lower)) return { correlation: NaN, converged: false };
  const state = comparison(frame, upper);
  let a = lower, b = upper;
  let x = Math.max(a, Math.min(b, initialLag)), w = x, v = x;
  let fx = fractionalCorrelation(state, x), fw = fx, fv = fx;
  let d = 0, e = 0, evaluations = 1, converged = false;
  yield;
  if (!Number.isFinite(fx)) return { correlation: NaN, converged: false };
  const tolerance = 1e-5; // samples; actual normalized correlation is evaluated.
  const golden = (3 - Math.sqrt(5)) / 2;
  for (let iteration = 0; iteration < 32; iteration++) {
    const middle = (a + b) / 2;
    if (Math.abs(x - middle) <= 2 * tolerance - (b - a) / 2) { converged = true; break; }
    let parabola = false;
    if (Math.abs(e) > tolerance) {
      const r = (x - w) * (fx - fv), q0 = (x - v) * (fx - fw);
      let p = (x - v) * q0 - (x - w) * r, q = 2 * (q0 - r);
      if (q > 0) p = -p;
      q = Math.abs(q);
      const previous = e; e = d;
      if (q > 0 && Math.abs(p) < Math.abs(q * previous / 2)
        && p > q * (a - x) && p < q * (b - x)) {
        d = p / q; parabola = true;
        const proposed = x + d;
        if (proposed - a < 2 * tolerance || b - proposed < 2 * tolerance)
          d = (middle >= x ? 1 : -1) * tolerance;
      }
    }
    if (!parabola) { e = x < middle ? b - x : a - x; d = golden * e; }
    const u = x + (Math.abs(d) >= tolerance ? d : (d >= 0 ? 1 : -1) * tolerance);
    const fu = fractionalCorrelation(state, u); evaluations++;
    yield;
    if (!Number.isFinite(fu)) return { correlation: NaN, converged: false };
    if (fu >= fx) {
      if (u >= x) a = x; else b = x;
      v = w; fv = fw; w = x; fw = fx; x = u; fx = fu;
    } else {
      if (u < x) a = u; else b = u;
      if (fu >= fw || w === x) { v = w; fv = fw; w = u; fw = fu; }
      else if (fu >= fv || v === x || v === w) { v = u; fv = fu; }
    }
  }
  // Include physical range endpoints; an endpoint maximum need not be interior.
  for (const lag of [lower, upper]) {
    const value = fractionalCorrelation(state, lag); evaluations++;
    if (value > fx) { x = lag; fx = value; }
    yield;
  }
  return { correlation: fx, lagSamples: x, comparisonSamples: state.count,
    interpolationHalfSamples: HALF, evaluations, converged };
}

module.exports = { refineCorrelationPeak };
