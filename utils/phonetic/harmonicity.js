const { fftInPlace } = require('../fft');
const { calculateHNR } = require('./voice-metrics');
const { refineCorrelationPeak } = require('./fractional-correlation');

// Shared by whole-recording and selection summaries. Duration counts analysis
// hops, not overlapping windows; partial estimates stay inspectable explicitly.
function summarizeHarmonicity(track, hopSeconds = .01, options = {}) {
  const eligible = track.filter(row => !['low-energy', 'unvoiced-or-uncertain',
    'capture-gap-boundary'].includes(row.reason));
  const valid = eligible.filter(row => Number.isFinite(row.db));
  const coverage = eligible.length ? valid.length / eligible.length : 0;
  const validDurationSeconds = valid.length * hopSeconds;
  const minDurationSeconds = options.minDurationSeconds === undefined ? .1 : options.minDurationSeconds;
  const partialMeanHNR = valid.length ? valid.reduce((sum, row) => sum + row.db, 0) / valid.length : null;
  return { activeFrames: eligible.length, validFrames: valid.length, coverage, validDurationSeconds,
    minDurationSeconds, partialMeanHNR,
    avgHNR: coverage >= .5 && validDurationSeconds + 1e-9 >= minDurationSeconds ? partialMeanHNR : null };
}

// 去均值的原始信号上，用重叠能量归一化自相关估计周期/非周期能量比。
// 生产流水线使用 YIN 有声证据收窄延迟范围，并拒绝低相关帧；调用者仍可
// 省略 pitchTrack 进行独立的原始周期性估计。
function* iterateHarmonicity(signal, sampleRate, options = {}) {
  const {
    frameSize = 1024,
    hopSize = 120,
    fmin = 40,
    fmax = 1200,
    pitchTrack = [],
    requirePitch = false,
    minPeakCorrelation = 0.2,
    maxPitchDeviation = 0.15,
  } = options;
  let fftSize = 1;
  while (fftSize < 2 * frameSize) fftSize *= 2;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const energies = new Float64Array(frameSize + 1);
  const centered = new Float64Array(frameSize);
  const track = [];
  let signalFrames = 0, cappedFrames = 0;
  let pitchIndex = 0;
  for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
    re.fill(0); im.fill(0);
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += signal[start + i];
    mean /= frameSize;
    energies[0] = 0;
    for (let i = 0; i < frameSize; i++) {
      re[i] = signal[start + i] - mean;
      centered[i] = re[i];
      energies[i + 1] = energies[i] + re[i] * re[i];
    }
    const time = (start + frameSize / 2) / sampleRate;
    if (energies[frameSize] / frameSize < 1e-10) {
      track.push({ time, db: null, reason: 'low-energy' });
      yield;
      continue;
    }
    signalFrames++;
    fftInPlace(re, im, fftSize);
    for (let i = 0; i < fftSize; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    // 功率谱为实偶序列，正变换实部 / N 等于自相关。
    fftInPlace(re, im, fftSize);
    const globalFirst = Math.max(2, Math.ceil(sampleRate / fmax));
    const globalLast = Math.min(Math.floor(frameSize / 2) - 1, Math.floor(sampleRate / fmin));
    while (pitchIndex + 1 < pitchTrack.length
      && Math.abs(pitchTrack[pitchIndex + 1].time - time) < Math.abs(pitchTrack[pitchIndex].time - time)) {
      pitchIndex++;
    }
    const pitch = pitchTrack[pitchIndex];
    const hasPitchEvidence = !!pitch && pitch.f0 > 0 && pitch.aperiodicity <= 0.3
      && Math.abs(pitch.time - time) <= hopSize / sampleRate;
    if (requirePitch && !hasPitchEvidence) {
      track.push({ time, db: null, reason: 'unvoiced-or-uncertain' });
      yield;
      continue;
    }
    // Coverage is defined over voiced frames eligible for HNR, rather than all
    // non-silent frames. Unvoiced connected-speech intervals are not failures.
    const expectedLag = hasPitchEvidence ? sampleRate / pitch.f0 : null;
    const first = expectedLag
      ? Math.max(globalFirst, Math.floor(expectedLag * (1 - maxPitchDeviation)))
      : globalFirst;
    const last = expectedLag
      ? Math.min(globalLast, Math.ceil(expectedLag * (1 + maxPitchDeviation)))
      : globalLast;
    const correlation = (lag) => {
      const denominator = Math.sqrt(energies[frameSize - lag] * (energies[frameSize] - energies[lag]));
      return denominator > 1e-20 ? re[lag] / fftSize / denominator : 0;
    };
    let best = 0, peak = null;
    for (let lag = first; lag <= last; lag++) {
      const value = correlation(lag);
      const left = correlation(lag - 1), right = correlation(lag + 1);
      if (value >= left && value >= right) {
        const curvature = left - 2 * value + right;
        const shift = curvature < -1e-12 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature)) : 0;
        const lower = Math.max(sampleRate / fmax, lag - 1);
        const upper = Math.min(sampleRate / fmin, lag + 1);
        const refined = yield* refineCorrelationPeak(centered, lag + shift, lower, upper);
        if (refined.converged && refined.correlation > best) {
          best = refined.correlation; peak = refined;
        }
      }
    }
    if (!Number.isFinite(best) || best < minPeakCorrelation) {
      track.push({ time, db: null, reason: best > 0 ? 'low-periodicity' : 'no-periodic-peak',
        peakCorrelation: Number.isFinite(best) ? best : null });
      yield;
      continue;
    }
    const db = calculateHNR(Math.min(best, 1));
    if (best >= 1 - 1e-6) cappedFrames++;
    track.push({ time, db, peakCorrelation: best, lagSamples: peak.lagSamples,
      comparisonSamples: peak.comparisonSamples,
      correlationMethod: 'normalized-fractional-delay-sinc-129', refinementConverged: true });
    yield;
  }
  return { track, signalFrames, cappedFrames,
    correlationMethod: 'normalized-fractional-delay-sinc-129', interpolationHalfSamples: 64,
    ...summarizeHarmonicity(track, hopSize / sampleRate) };
}

const { consume, consumeAsync } = require('./iteration');
function estimateHarmonicity(signal, sampleRate, options = {}) {
  return consume(iterateHarmonicity(signal, sampleRate, options));
}
function estimateHarmonicityAsync(signal, sampleRate, options = {}) {
  return consumeAsync(iterateHarmonicity(signal, sampleRate, options), options);
}
module.exports = { estimateHarmonicity, estimateHarmonicityAsync, summarizeHarmonicity };
