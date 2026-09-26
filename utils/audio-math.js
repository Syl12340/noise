// utils/audio-math.js
const { CANVAS_CONFIG } = require('./constants');
const { fftInPlace } = require('./fft');

/**
 * 计算连续音频离散采样信号的均方根值（RMS）。
 * 通过对短时时域积分能量的统计，将其作为后续转换为物理声压级的基础依据。
 * @param {Int16Array} pcmData - 底层音频设备采集的未被计权的脉冲编码调制(PCM)时域序列数据 
 * @returns {number} 映射短时声学能量积分的 RMS 振幅
 */
function calculateRMS(pcmData) {
  let sumSquares = 0;
  for (let i = 0; i < pcmData.length; i++) {
    const sample = pcmData[i];
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / pcmData.length);
}

/**
 * 将线性 RMS 振幅转换为对数域分贝（dB）值。
 * 结合预设的电声学校准参考因子，将计算结果对齐至物理真实声压级（SPL），
 * 用于后续拟合近似自由声场（free field）条件下的响度。
 * @param {number} rms - 线性度量的均方根声压包络
 * @param {number} reference - 声学参考系数值 (对于 16-bit PCM 基准常值为 32768.0)
 * @returns {number} 对数量化的物理声压级 (dB)
 */
function calculateDb(rms, reference) {
  const ref = typeof reference === 'number' && reference > 0 ? reference : 32768.0;
  return 20 * Math.log10(Math.max(rms, 1e-12) / ref);
}

/**
 * 由累计的归一化平方幅值和样本数计算 Leq。
 * 该形式按样本加权，适用于录音帧长度不一致的连续音频流。
 * @param {number} totalSquaredAmplitude 归一化样本平方和
 * @param {number} totalSampleCount 有效样本总数
 * @param {number} [offset=0] dBFS 到 dB SPL 的校准偏移
 * @returns {number} 等效连续声级；无有效样本时返回 0
 */
function calculateLeqFromEnergy(totalSquaredAmplitude, totalSampleCount, offset = 0) {
  if (!Number.isFinite(totalSquaredAmplitude) || totalSquaredAmplitude < 0 || totalSampleCount <= 0) {
    return 0;
  }

  const meanSquare = totalSquaredAmplitude / totalSampleCount;
  return 10 * Math.log10(Math.max(meanSquare, 1e-24)) + offset;
}

/**
 * 由已经完成时间积分的 Leq 计算预计暴露 CNE。
 * @param {number} leq A 计权等效连续声级
 * @param {number} timeTerm 预计暴露时长项 10*log10(T/T0)
 * @returns {number} CNE
 */
function calculateCNEFromLeq(leq, timeTerm) {
  // 当前没有样本级峰度模型；仅报告由 LAeq 与预计暴露时间换算的等效暴露级。
  return leq + timeTerm;
}

/**
 * A 计权近似：低频双二阶节 + 按模拟目标曲线设计的 FIR 高频段。
 * 不再把 12.2 kHz 模拟极点直接双线性变换，避免奈奎斯特处人为归零。
 * 有限长 FIR 是数值近似；设备与全频带精度仍需实测校验。
 */
class AWeightingFilter {
  constructor(sampleRate = CANVAS_CONFIG.FFT.SAMPLE_RATE) {
    const toDigitalPole = (frequency) => {
      const analogPole = -2 * Math.PI * frequency;
      return (2 * sampleRate + analogPole) / (2 * sampleRate - analogPole);
    };

    // IEC A 计权模拟原型的四组转折频率，经双线性变换得到数字极点。
    const pole20 = toDigitalPole(20.598997);
    const pole107 = toDigitalPole(107.65265);
    const pole738 = toDigitalPole(737.86223);

    // 两个 20.6Hz 极点与两个 z=1 零点。
    this.b1 = [1.0, -2.0, 1.0];
    this.a1 = [1.0, -2 * pole20, pole20 * pole20];
    this.z1 = [0, 0]; // 延迟线状态寄存器

    // 107.7Hz、737.9Hz 极点与两个 z=1 零点。
    this.b2 = [1.0, -2.0, 1.0];
    this.a2 = [1.0, -(pole107 + pole738), pole107 * pole738];
    this.z2 = [0, 0];

    const lowMagnitude = (frequency) => {
      const s = 4 * Math.pow(Math.sin(Math.PI * frequency / sampleRate), 2);
      const denominator = pole => (1 - pole) * (1 - pole) + pole * s;
      return s * s / (denominator(pole20) * Math.sqrt(denominator(pole107) * denominator(pole738)));
    };
    const prototype = (frequency) => {
      const f2 = frequency * frequency;
      const high2 = 12194.217 * 12194.217;
      return high2 * f2 * f2 / ((f2 + 20.598997 * 20.598997)
        * Math.sqrt((f2 + 107.65265 * 107.65265) * (f2 + 737.86223 * 737.86223)) * (f2 + high2));
    };
    const reference = prototype(1000);
    const designSize = 2048;
    const re = new Float64Array(designSize), im = new Float64Array(designSize);
    for (let k = 0; k <= designSize / 2; k++) {
      const f = Math.max(0.1, k * sampleRate / designSize);
      const response = prototype(f) / reference / lowMagnitude(f);
      re[k] = response;
      if (k > 0 && k < designSize / 2) re[designSize - k] = response;
    }
    // 实偶幅频响应的逆变换；时移得到可实时执行的线性相位 FIR。
    fftInPlace(re, im, designSize);
    const half = 64;
    this.fir = new Float64Array(2 * half + 1);
    let firAtOneKhz = 0;
    for (let i = 0; i < this.fir.length; i++) {
      const lag = i - half;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * lag / half) + 0.08 * Math.cos(2 * Math.PI * lag / half);
      this.fir[i] = re[(lag + designSize) % designSize] / designSize * window;
      firAtOneKhz += this.fir[i] * Math.cos(2 * Math.PI * 1000 * lag / sampleRate);
    }
    this.gain = 1 / (lowMagnitude(1000) * Math.abs(firAtOneKhz));
    this.history = new Float64Array(this.fir.length);
    this.historyIndex = 0;
  }

  /**
    * 处理单帧 PCM 数据，返回 A 计权后的音频。
    * @param {Int16Array|Float32Array} inputBuffer 原始 PCM 数据。
    * @param {boolean} [normalize=true] 是否将 16 位整数归一化为 [-1, 1]。
    *   - true：输入视为 Int16 PCM，内部先除以 32768。
    *   - false：输入已是浮点归一化数据，直接进入滤波器。
    * @returns {Float32Array} A 计权后的音频数据（浮点数）。
    * Side effect: 更新双二阶节与 FIR 历史；同一实例连续使用，不能每帧重建。
   */
  process(inputBuffer, normalize = true) {
    const len = inputBuffer.length;
    const output = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      // 1. 归一化输入
      let x = normalize ? inputBuffer[i] / 32768.0 : inputBuffer[i];
      x *= this.gain;

      // 2. 级联 Biquad 1 (直接 II 型转置)
      let y1 = this.b1[0] * x + this.z1[0];
      this.z1[0] = this.b1[1] * x - this.a1[1] * y1 + this.z1[1];
      this.z1[1] = this.b1[2] * x - this.a1[2] * y1;

      // 3. 级联 Biquad 2
      let y2 = this.b2[0] * y1 + this.z2[0];
      this.z2[0] = this.b2[1] * y1 - this.a2[1] * y2 + this.z2[1];
      this.z2[1] = this.b2[2] * y1 - this.a2[2] * y2;

      this.history[this.historyIndex] = y2;
      let value = 0, index = this.historyIndex;
      for (let tap = 0; tap < this.fir.length; tap++) {
        value += this.fir[tap] * this.history[index];
        if (--index < 0) index = this.history.length - 1;
      }
      this.historyIndex = (this.historyIndex + 1) % this.history.length;
      output[i] = value;
    }

    return output;
  }
}

module.exports = {
  calculateRMS,
  calculateDb,
  calculateLeqFromEnergy,
  calculateCNEFromLeq,
  AWeightingFilter,
};
