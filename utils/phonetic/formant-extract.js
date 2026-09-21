// utils/phonetic/formant-extract.js
// 从 LPC 系数提取共振峰 F1, F2, F3

const { burgLPC } = require('./burg-lpc');
const { findRoots } = require('./poly-roots');

/**
 * 从 LPC 系数中提取共振峰。
 * 流程：LPC 多项式求根 → 筛选单位圆内上半平面的根 → 转换为频率和带宽 → 排序取 F1/F2/F3
 * @param {Float64Array} a - LPC 系数 [a0=1, a1, ..., ap]
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {number} [options.minFreq=90] - 共振峰最低频率 (Hz)
 * @param {number} [options.maxFreq=5000] - 共振峰最高频率 (Hz)
 * @param {number} [options.maxBandwidth=500] - 最大带宽 (Hz)
 * @returns {{ F1: object, F2: object, F3: object }} 共振峰对象
 */
function extractFormantsFromLPC(a, sampleRate, options = {}) {
  const {
    minFreq = 90,
    maxFreq = 5000,
    maxBandwidth = 500,
  } = options;

  // LPC 多项式系数：A(z) = a0 + a1*z^-1 + ... + ap*z^-p
  // findRoots 期望 [a0, a1, ..., ap]
  const roots = findRoots(a);

  const formants = [];
  for (const root of roots) {
    const mag = Math.sqrt(root.re * root.re + root.im * root.im);

    // 只取单位圆内的根（稳定的极点）
    if (mag >= 1.0 || mag < 1e-10) continue;

    // 只取上半平面（避免共轭对重复计数）
    if (root.im < 0) continue;

    // 转换为频率 Hz
    const freq = Math.atan2(root.im, root.re) * sampleRate / (2 * Math.PI);

    // 转换为带宽 Hz
    const bandwidth = -Math.log(mag) * sampleRate / Math.PI;

    // 筛选合理范围
    if (freq >= minFreq && freq <= maxFreq && bandwidth <= maxBandwidth) {
      formants.push({ freq: Math.round(freq * 10) / 10, bandwidth: Math.round(bandwidth * 10) / 10 });
    }
  }

  // 按频率升序排序
  formants.sort((a, b) => a.freq - b.freq);

  return {
    F1: formants[0] || { freq: 0, bandwidth: 0 },
    F2: formants[1] || { freq: 0, bandwidth: 0 },
    F3: formants[2] || { freq: 0, bandwidth: 0 },
    _all: formants,
  };
}

/**
 * 对单帧信号执行完整的共振峰提取。
 * @param {Float64Array} frame - 加窗后的单帧信号
 * @param {number} lpcOrder - LPC 阶数
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 筛选配置
 * @returns {{ F1: object, F2: object, F3: object }}
 */
function extractFormants(frame, lpcOrder, sampleRate, options = {}) {
  const { a } = burgLPC(frame, lpcOrder);
  return extractFormantsFromLPC(a, sampleRate, options);
}

/**
 * 对整个信号逐帧提取共振峰轨迹。
 * @param {Float32Array} signal - 预加重后的浮点信号
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @returns {Array<{time: number, F1: object, F2: object, F3: object}>}
 */
function formantTrack(signal, sampleRate, options = {}) {
  const {
    frameSize = 1102,
    hopSize = 441,
    lpcOrder = 16,
    minFreq = 90,
    maxFreq = 5000,
    maxBandwidth = 500,
  } = options;

  const { segmentFrames } = require('./frame-segment');
  const frames = segmentFrames(signal, frameSize, hopSize);
  const track = [];

  for (let i = 0; i < frames.length; i++) {
    const time = (i * hopSize) / sampleRate;
    const result = extractFormants(frames[i], lpcOrder, sampleRate, { minFreq, maxFreq, maxBandwidth });
    track.push({ time, ...result });
  }

  return track;
}

module.exports = { extractFormantsFromLPC, extractFormants, formantTrack };
