// utils/phonetic/voice-metrics.js
// 音质特征计算：HNR / 帧间周期变化率 / Intensity

/**
 * 由归一化自相关峰估计 HNR；参数不能使用 YIN CMNDF。
 * @param {number} correlation - 原始信号上的归一化自相关峰 (0~1)
 * @returns {?number} HNR (dB)，输入无效时返回 null
 */
function calculateHNR(correlation) {
  if (!Number.isFinite(correlation) || correlation <= 0 || correlation > 1) return null;
  const r = Math.min(correlation, 1 - 1e-6);
  return 10 * Math.log10(r / (1 - r));
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
 * 对去直流、未经预加重的浮点信号按帧切分（不加窗），计算 RMS → dBFS。
 * 0 dBFS = 数字满幅，负值 = 相对衰减。不加校准偏移。
 * @param {Float32Array} signal - 去直流、未经预加重的浮点信号
 * @param {number} sampleRate - 采样率
 * @param {number} frameSize - 帧长
 * @param {number} hopSize - 帧移
 * @returns {Array<{time: number, db: number}>} 声强轨迹 (dBFS, 负值)
 */
function calculateIntensity(signal, sampleRate, frameSize, hopSize) {
  const track = [];
  let start = 0;

  while (start + frameSize <= signal.length) {
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = signal[start + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const dbfs = 20 * Math.log10(Math.max(rms, 1e-12));
    track.push({ time: (start + frameSize / 2) / sampleRate, db: dbfs });
    start += hopSize;
  }

  return track;
}

module.exports = {
  calculateHNR,
  calculatePitchPeriodVariability,
  calculateJitter,
  calculateIntensity,
};
