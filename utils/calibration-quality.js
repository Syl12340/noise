const { fftInPlace } = require('./fft');

// 校准音的频带占比和分段电平稳定性。绝对 80 dB 仍由外部参考声源提供。
function inspectCalibrationTone(signal, sampleRate) {
  const size = 4096;
  const re = new Float64Array(size), im = new Float64Array(size);
  let blocks = 0, validBlocks = 0, minDb = Infinity, maxDb = -Infinity;
  const starts = [];
  for (let start = 0; start + size <= signal.length; start += size) starts.push(start);
  // 最后一段不足一窗时，用末端对齐的重叠窗检查，避免漏检尾部噪声。
  if (signal.length >= size && starts[starts.length - 1] !== signal.length - size) starts.push(signal.length - size);
  for (const start of starts) {
    let mean = 0;
    for (let i = 0; i < size; i++) mean += signal[start + i];
    mean /= size;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const sample = signal[start + i] - mean;
      energy += sample * sample;
      re[i] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
      im[i] = 0;
    }
    const db = 10 * Math.log10(Math.max(energy / size, 1e-24));
    minDb = Math.min(minDb, db); maxDb = Math.max(maxDb, db);
    fftInPlace(re, im, size);
    let bandEnergy = 0, totalEnergy = 0;
    for (let k = 1; k <= size / 2; k++) {
      const power = (re[k] * re[k] + im[k] * im[k]) * (k === size / 2 ? 1 : 2);
      totalEnergy += power;
      const frequency = k * sampleRate / size;
      if (frequency >= 950 && frequency <= 1050) bandEnergy += power;
    }
    blocks++;
    if (db >= -70 && totalEnergy > 0 && bandEnergy / totalEnergy >= 0.9) validBlocks++;
  }
  return { valid: blocks > 0 && validBlocks === blocks && maxDb - minDb <= 1.5,
    blocks, validBlocks, levelRange: maxDb - minDb };
}

module.exports = { inspectCalibrationTone };
