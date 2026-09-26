// 窗化 sinc 抗混叠重采样。保持第 0 个采样时刻，不引入额外时间位移。
function* iterateResample(signal, inputRate, outputRate, cutoffHz) {
  const out = new Float32Array(Math.floor(signal.length * outputRate / inputRate));
  if (!signal.length) return out;
  const half = 128;
  const cutoff = Math.min(cutoffHz, outputRate * 0.49) / inputRate;
  const kernels = new Map();
  for (let i = 0; i < out.length; i++) {
    const position = i * inputRate / outputRate;
    const base = Math.floor(position);
    const phase = Math.round((position - base) * 1e6) / 1e6;
    let kernel = kernels.get(phase);
    if (!kernel) {
      kernel = new Float64Array(2 * half + 1);
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        const t = j - phase;
        const sinc = Math.abs(t) < 1e-12 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
        const window = 0.42 + 0.5 * Math.cos(Math.PI * j / half) + 0.08 * Math.cos(2 * Math.PI * j / half);
        kernel[j + half] = sinc * window;
        sum += kernel[j + half];
      }
      for (let j = 0; j < kernel.length; j++) kernel[j] /= sum;
      kernels.set(phase, kernel);
    }
    let value = 0;
    for (let j = -half; j <= half; j++) {
      const index = Math.max(0, Math.min(signal.length - 1, base + j));
      value += signal[index] * kernel[j + half];
    }
    out[i] = value;
    if (i % 256 === 255) yield;
  }
  return out;
}

function emphasizeFloat(signal, coefficient = 0.97) {
  const out = new Float32Array(signal.length);
  if (signal.length) out[0] = signal[0] * (1 - coefficient);
  for (let i = 1; i < signal.length; i++) out[i] = signal[i] - coefficient * signal[i - 1];
  return out;
}

const { consume, consumeAsync } = require('./iteration');
function resampleLowPass(signal, inputRate, outputRate, cutoffHz) {
  return consume(iterateResample(signal, inputRate, outputRate, cutoffHz));
}
function resampleLowPassAsync(signal, inputRate, outputRate, cutoffHz, options = {}) {
  return consumeAsync(iterateResample(signal, inputRate, outputRate, cutoffHz), options);
}
module.exports = { resampleLowPass, resampleLowPassAsync, emphasizeFloat };
