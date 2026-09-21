// utils/phonetic/voice-metrics.js
// 音质特征计算：HNR / 帧间周期变化率 / Intensity

/**
 * 由非周期性指标计算谐噪比 (Harmonic-to-Noise Ratio)。
 * 公式: HNR = 10 * log10((1 - ap) / ap)，ap 为 CMNDF 最小值。
 * @param {number} aperiodicity - YIN CMNDF 最小值 (0~1)，越低越周期性
 * @returns {?number} HNR (dB)，输入无效时返回 null
 */
function calculateHNR(aperiodicity) {
  if (!Number.isFinite(aperiodicity) || aperiodicity <= 0 || aperiodicity >= 1) return null;
  return 10 * Math.log10((1 - aperiodicity) / aperiodicity);
}

/**
 * 计算相邻有声分析帧之间的周期变化率。
 * 这是基于帧级 F0 的描述性指标，不等同于逐声门周期 Jitter。
 * @param {Array<{time: number, f0: number}>} pitchTrack - 基频轨迹
 * @returns {?number} 帧间周期变化率，无有效数据返回 null
 */
function calculatePitchPeriodVariability(pitchTrack) {
  let previousPeriod = null;
  let sumDiff = 0;
  let sumPairMeanPeriod = 0;
  let pairCount = 0;

  for (const pt of pitchTrack) {
    if (pt.f0 > 0) {
      const period = 1 / pt.f0;
      if (previousPeriod !== null) {
        sumDiff += Math.abs(period - previousPeriod);
        sumPairMeanPeriod += (period + previousPeriod) / 2;
        pairCount++;
      }
      previousPeriod = period;
    } else {
      // 不跨越停顿拼接两个独立有声段。
      previousPeriod = null;
    }
  }
  if (pairCount === 0 || sumPairMeanPeriod <= 0) return null;
  return sumDiff / sumPairMeanPeriod;
}

// 保留旧导出名，避免其他调用方中断；该值是帧间周期变化率，不是逐声门周期 Jitter。
const calculateJitter = calculatePitchPeriodVariability;

/**
 * 逐帧计算短时声强轨迹 (dBFS)。
 * 对预加重后的浮点信号按帧切分（不加窗），计算 RMS → dBFS。
 * 0 dBFS = 数字满幅，负值 = 相对衰减。不加校准偏移。
 * @param {Float32Array} signal - 预加重后的浮点信号
 * @param {number} sampleRate - 采样率
 * @param {number} frameSize - 帧长
 * @param {number} hopSize - 帧移
 * @returns {Array<{time: number, db: number}>} 声强轨迹 (dBFS, 负值)
 */
function calculateIntensity(signal, sampleRate, frameSize, hopSize) {
  const track = [];
  let start = 0;
  let idx = 0;

  while (start + frameSize <= signal.length) {
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = signal[start + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const dbfs = 20 * Math.log10(Math.max(rms, 1e-12));
    track.push({ time: (idx * hopSize) / sampleRate, db: dbfs });
    start += hopSize;
    idx++;
  }

  return track;
}

module.exports = {
  calculateHNR,
  calculatePitchPeriodVariability,
  calculateJitter,
  calculateIntensity,
};
