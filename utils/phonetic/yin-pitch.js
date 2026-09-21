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
  const tauMin = Math.floor(sampleRate / fmax);
  const tauMax = Math.min(halfLen - 1, Math.floor(sampleRate / fmin));

  if (tauMax <= tauMin) return { f0: 0, aperiodicity: 1 };

  let frameEnergy = 0;
  for (let i = 0; i < frame.length; i++) {
    frameEnergy += frame[i] * frame[i];
  }
  if (frameEnergy / frame.length < 1e-10) {
    return { f0: 0, aperiodicity: 1 };
  }

  // 1. 差分函数 d(tau) = sum( (x[j] - x[j+tau])^2 )
  const diff = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < halfLen; j++) {
      const d = frame[j] - frame[j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // 2. 累积均值归一化差分函数 (CMNDF)
  const cmndf = new Float64Array(tauMax + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = runningSum > 1e-30 ? diff[tau] * tau / runningSum : 1;
  }

  // 3. 绝对阈值检测：找第一个低于 threshold 的谷值
  let bestTau = -1;
  let aperiodicity = 1;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (cmndf[tau] < threshold) {
      // 找到谷底
      while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) {
        tau++;
      }
      aperiodicity = cmndf[tau];
      // 4. 抛物线插值提高精度
      const s0 = cmndf[tau - 1];
      const s1 = cmndf[tau];
      const s2 = tau + 1 <= tauMax ? cmndf[tau + 1] : s1;
      const denom = s0 - 2 * s1 + s2;
      const rawShift = Math.abs(denom) > 1e-12 ? 0.5 * (s0 - s2) / denom : 0;
      const shift = Math.max(-1, Math.min(1, rawShift));
      bestTau = tau + shift;
      break;
    }
  }

  // 5. 亚阈值回退：全局最小值
  if (bestTau < 0) {
    let minVal = Infinity;
    let minTau = tauMin;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        minTau = tau;
      }
    }
    if (minVal > 0.5) return { f0: 0, aperiodicity: 1 };

    aperiodicity = minVal;
    // 抛物线插值
    const tau = minTau;
    const s0 = tau > 0 ? cmndf[tau - 1] : cmndf[tau];
    const s1 = cmndf[tau];
    const s2 = tau < tauMax ? cmndf[tau + 1] : cmndf[tau];
    const denom = s0 - 2 * s1 + s2;
    const rawShift = Math.abs(denom) > 1e-12 ? 0.5 * (s0 - s2) / denom : 0;
    const shift = Math.max(-1, Math.min(1, rawShift));
    bestTau = tau + shift;
  }

  if (bestTau <= 0) return { f0: 0, aperiodicity: 1 };
  return { f0: sampleRate / bestTau, aperiodicity: Math.min(aperiodicity, 1) };
}

/**
 * 对整个信号逐帧提取基频轨迹。
 * @param {Float32Array} signal - 预加重后的浮点信号（未加窗，内部自行切分）
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {number} [options.frameSize] - 帧长
 * @param {number} [options.hopSize] - 帧移
 * @param {number} [options.threshold] - YIN 阈值
 * @param {number} [options.fmin] - 最低基频
 * @param {number} [options.fmax] - 最高基频
 * @returns {Array<{time: number, f0: number, aperiodicity: number}>} 时间-基频-非周期性三元组数组
 */
function yinPitchTrack(signal, sampleRate, options = {}) {
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
    const { f0, aperiodicity } = yinPitchFrame(frame, sampleRate, threshold, fmin, fmax);
    track.push({ time, f0, aperiodicity });
  }

  return track;
}

module.exports = { yinPitchFrame, yinPitchTrack };
