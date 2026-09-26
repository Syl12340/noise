const { fftInPlace } = require('../fft');
const { calculateHNR } = require('./voice-metrics');

// 去均值的原始信号上，用重叠能量归一化自相关估计周期/非周期能量比。
// 不依赖 YIN 的有声判定；低相关帧可产生负 dB，不能静默排除。
function* iterateHarmonicity(signal, sampleRate, options = {}) {
  const { frameSize = 1024, hopSize = 120, fmin = 40, fmax = 1200 } = options;
  let fftSize = 1;
  while (fftSize < 2 * frameSize) fftSize *= 2;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const energies = new Float64Array(frameSize + 1);
  const track = [];
  let activeFrames = 0, validFrames = 0, cappedFrames = 0, sumDb = 0;
  for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
    re.fill(0); im.fill(0);
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += signal[start + i];
    mean /= frameSize;
    energies[0] = 0;
    for (let i = 0; i < frameSize; i++) {
      re[i] = signal[start + i] - mean;
      energies[i + 1] = energies[i] + re[i] * re[i];
    }
    const time = (start + frameSize / 2) / sampleRate;
    if (energies[frameSize] / frameSize < 1e-10) {
      track.push({ time, db: null, reason: 'low-energy' });
      yield;
      continue;
    }
    activeFrames++;
    fftInPlace(re, im, fftSize);
    for (let i = 0; i < fftSize; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    // 功率谱为实偶序列，正变换实部 / N 等于自相关。
    fftInPlace(re, im, fftSize);
    const first = Math.max(2, Math.ceil(sampleRate / fmax));
    const last = Math.min(Math.floor(frameSize / 2) - 1, Math.floor(sampleRate / fmin));
    const correlation = (lag) => {
      const denominator = Math.sqrt(energies[frameSize - lag] * (energies[frameSize] - energies[lag]));
      return denominator > 1e-20 ? re[lag] / fftSize / denominator : 0;
    };
    let best = 0;
    for (let lag = first; lag <= last; lag++) {
      const value = correlation(lag);
      const left = correlation(lag - 1), right = correlation(lag + 1);
      if (value >= left && value >= right) {
        const curvature = left - 2 * value + right;
        const shift = curvature < -1e-12 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature)) : 0;
        best = Math.max(best, value - 0.25 * (left - right) * shift);
      }
    }
    if (!Number.isFinite(best) || best <= 0) {
      track.push({ time, db: null, reason: 'no-periodic-peak' });
      yield;
      continue;
    }
    const db = calculateHNR(Math.min(best, 1));
    if (best >= 1 - 1e-6) cappedFrames++;
    track.push({ time, db });
    sumDb += db;
    validFrames++;
    yield;
  }
  return {
    track, activeFrames, validFrames, cappedFrames,
    // 有有效能量但无法估计的帧存在时，不用剩余帧冒充全段结果。
    avgHNR: activeFrames > 0 && validFrames === activeFrames ? sumDb / validFrames : null,
    coverage: activeFrames ? validFrames / activeFrames : 0,
  };
}

const { consume, consumeAsync } = require('./iteration');
function estimateHarmonicity(signal, sampleRate, options = {}) {
  return consume(iterateHarmonicity(signal, sampleRate, options));
}
function estimateHarmonicityAsync(signal, sampleRate, options = {}) {
  return consumeAsync(iterateHarmonicity(signal, sampleRate, options), options);
}
module.exports = { estimateHarmonicity, estimateHarmonicityAsync };
