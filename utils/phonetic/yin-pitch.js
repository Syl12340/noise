// utils/phonetic/yin-pitch.js
// YIN 基频提取算法 (de Cheveigné & Kawahara, 2002)

/**
 * 对单帧信号执行 YIN 基频检测。
 * @param {Float64Array} frame - 未加窗的单帧信号
 * @param {number} sampleRate - 采样率
 * @param {number} [threshold=0.1] - 绝对阈值
 * @param {number} [fmin=60] - 最低基频 (Hz)
 * @param {number} [fmax=500] - 最高基频 (Hz)
 * @returns {{ f0: number, aperiodicity: number }} 基频 (Hz) 与非周期性指标；无声帧返回 { f0: 0, aperiodicity: 1 }
 */
function yinPitchFrame(frame, sampleRate, threshold = 0.1, fmin = 60, fmax = 500) {
  const halfLen = Math.floor(frame.length / 2);
  const tauMax = halfLen - 1;

  if (tauMax <= 2 || !(sampleRate > 0 && fmin > 0 && fmax >= fmin)) {
    return { f0: 0, aperiodicity: 1 };
  }

  let frameEnergy = 0;
  for (let i = 0; i < frame.length; i++) {
    frameEnergy += frame[i] * frame[i];
  }
  if (frameEnergy / frame.length < 1e-10) {
    return { f0: 0, aperiodicity: 1 };
  }

  // 1. 差分函数 d(tau) = sum( (x[j] - x[j+tau])^2 )
  const diff = new Float64Array(tauMax + 1);
  const supported = new Uint8Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    let comparedEnergy = 0;
    // 延迟两端围绕同一帧中心，保证轨迹时间不随 F0 改变。
    const offset = Math.floor((frame.length - halfLen - tau) / 2);
    for (let j = 0; j < halfLen; j++) {
      const left = frame[offset + j];
      const right = frame[offset + j + tau];
      const d = left - right;
      sum += d * d;
      comparedEnergy += left * left + right * right;
    }
    diff[tau] = sum;
    // 瞬态可能完全落在当前比较区间之外，此时 d(tau)=0 并不表示周期。
    // 只有比较区间实际覆盖了本帧能量，才允许该延迟参与候选选择。
    supported[tau] = comparedEnergy >= frameEnergy * 1e-6 ? 1 : 0;
  }

  // 2. 累积均值归一化差分函数 (CMNDF)
  const cmndf = new Float64Array(tauMax + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = runningSum > 1e-30 ? diff[tau] * tau / runningSum : 1;
  }

  // 3. 保留范围内外的局部谷；不能在搜索边界截断一个仍在下降的谷。
  const candidates = [];
  for (let tau = 2; tau < tauMax; tau++) {
    if (!supported[tau]) continue;
    const s0 = cmndf[tau - 1];
    const s1 = cmndf[tau];
    const s2 = cmndf[tau + 1];
    if (s1 > s0 || s1 > s2 || (s1 === s0 && s1 === s2)) continue;
    // 周期证据取实际计算的 CMNDF 谷值。对不对称/突变的三点谷做
    // 抛物线插值可能得到负值，不能将其钳成 0（虚假的完美周期）。
    // 只对最终周期在原始差分谷上插值，不用插值创造置信证据。
    // 避免归一化分母的斜率将短周期系统性推向过高频率。
    const rawDenom = diff[tau - 1] - 2 * diff[tau] + diff[tau + 1];
    let periodShift = rawDenom > 1e-12
      ? Math.max(-0.5, Math.min(0.5, 0.5 * (diff[tau - 1] - diff[tau + 1]) / rawDenom)) : 0;
    // 只消除浮点运算噪声，不按用户配置的频率边界钳位。
    if (Math.abs(periodShift) < 8 * Number.EPSILON * tau) periodShift = 0;
    const period = tau + periodShift;
    candidates.push({
      period,
      f0: sampleRate / period,
      aperiodicity: Math.min(1, s1),
    });
  }

  // 优先最短的阈值内周期；较弱的范围外伪谷不阻断后续有效候选。
  // 上限附近保留候选证据；插值越界时明确拒绝，不钳位成有效边界值。
  const upperTolerance = fmax * 0.005;
  // Sub-microhertz floating/resampling error at an exact configured boundary
  // must not discard a valid frame. Keep rawF0; this is not the 0.5% search band.
  const numericTolerance = Math.max(1e-6, Math.max(fmin, fmax) * 1e-9);
  const inRange = candidates.filter(candidate => (
    candidate.f0 >= fmin - numericTolerance && candidate.f0 <= fmax + upperTolerance
  ));
  let chosen = inRange.find(candidate => candidate.aperiodicity < threshold);
  if (!chosen) {
    chosen = inRange.reduce((best, candidate) => (
      !best || candidate.aperiodicity < best.aperiodicity ? candidate : best
    ), null);
    // 阈值未命中时只允许中等强度的周期证据；更高 CMNDF 谷在瞬态
    // 与噪声中很容易由“从许多延迟里挑最小值”产生选择偏差。
    if (chosen && chosen.aperiodicity > 0.3) chosen = null;
  }
  if (!chosen) {
    const outside = candidates.find(candidate => (
      (candidate.f0 < fmin || candidate.f0 > fmax) && candidate.aperiodicity < threshold
    ));
    return outside
      ? { f0: 0, rawF0: outside.f0, aperiodicity: outside.aperiodicity, reason: 'out-of-range' }
      : { f0: 0, aperiodicity: 1 };
  }

  // 如果超上限短周期也满足绝对周期阈值，不能将其整数倍回填为低八度。
  // 离散 CMNDF 在短周期处的采样误差更大，不能要求它与长周期谷仅差
  // 0.01；存在两个均通过阈值的倍周期解释时，保守地报告范围外。
  const shorter = candidates.find(candidate => {
    if (candidate.f0 <= fmax + numericTolerance || candidate.aperiodicity >= threshold) return false;
    const ratio = chosen.period / candidate.period;
    const multiple = Math.round(ratio);
    return multiple >= 2 && Math.abs(ratio - multiple) <= 0.05;
  });
  if (shorter) return { f0: 0, rawF0: shorter.f0, aperiodicity: shorter.aperiodicity, reason: 'out-of-range' };
  if (chosen.f0 > fmax + numericTolerance) {
    return { f0: 0, rawF0: chosen.f0, aperiodicity: chosen.aperiodicity,
      reason: 'boundary-uncertain', range: { min: fmin, max: fmax } };
  }
  const f0 = Math.max(fmin, Math.min(fmax, chosen.f0));
  return { f0, rawF0: chosen.f0, aperiodicity: chosen.aperiodicity,
    ...(f0 !== chosen.f0 ? { rangeBoundaryAdjusted: true, numericToleranceHz: numericTolerance } : {}) };
}

/**
 * 对整个信号逐帧提取基频轨迹。
 * @param {Float32Array} signal - 去直流、抗混叠后的浮点信号，不进行预加重
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {number} [options.frameSize] - 帧长
 * @param {number} [options.hopSize] - 帧移
 * @param {number} [options.threshold] - YIN 阈值
 * @param {number} [options.fmin] - 最低基频
 * @param {number} [options.fmax] - 最高基频
 * @returns {Array<{time: number, f0: number, aperiodicity: number}>} 时间-基频-非周期性三元组数组
 */
function* iteratePitch(signal, sampleRate, options = {}) {
  const {
    frameSize = 2048,
    hopSize = 441,
    threshold = 0.1,
    fmin = 60,
    fmax = 500,
  } = options;

  const track = [];

  for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
    // YIN 直接使用原始帧；加窗会改变不同延迟处的幅度包络。
    const frame = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      frame[i] = signal[start + i];
    }
    const time = (start + frameSize / 2) / sampleRate;
    const result = yinPitchFrame(frame, sampleRate, threshold, fmin, fmax);
    track.push({ time, ...result });
    yield;
  }

  return track;
}

const { consume, consumeAsync } = require('./iteration');
function yinPitchTrack(signal, sampleRate, options = {}) {
  return consume(iteratePitch(signal, sampleRate, options));
}
function yinPitchTrackAsync(signal, sampleRate, options = {}) {
  return consumeAsync(iteratePitch(signal, sampleRate, options), options);
}
module.exports = { yinPitchFrame, yinPitchTrack, yinPitchTrackAsync };
