// utils/audio-math.js
const { CNE_FORMULA, CANVAS_CONFIG } = require('./constants');

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
 * 增量计算等效连续声级（Leq）。
 * 采用能量求和法累加瞬态时间轴上的声学能量分布，
 * 用以评估长时间声场暴露产生的稳态响应负荷。
 * @param {number} currentDB - 当前秒的 A 计权等效声压 L_A dB(A)
 * @param {number} totalSeconds - 时间序列积分的总时长（秒）
 * @param {number} totalEnergySum - 连续积分能量累计缓存
 * @returns {object} { leq: 等效连续声级, totalEnergySum: 更新后的标量累积能量 }
 */
function calculateLeqIncremental(currentDB, totalSeconds, totalEnergySum) {
  const nextEnergySum = totalEnergySum + Math.pow(10, currentDB / 10);
  const avgEnergy = nextEnergySum / totalSeconds;
  return {
    leq: 10 * Math.log10(avgEnergy),
    totalEnergySum: nextEnergySum,
  };
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
 * @param {number} kFactor 脉冲噪声惩罚因子
 * @returns {number} CNE
 */
function calculateCNEFromLeq(leq, timeTerm, kFactor) {
  return leq + timeTerm + kFactor * CNE_FORMULA.K_FACTOR_WEIGHT;
}

/**
 * 基于短时滑动窗口（Sliding Window）的波值因子 (K-Factor) 估算
 * @param {Array<number>} dbHistory - 历史秒级声压级数组
 * @param {number} currentTime - 当前时间索引（秒）
 * @param {number} [windowSize=10] - 滑动窗口大小（秒）
 * @returns {number} 波值因子（0 或 1）
 */
function estimateKFactorSliding(dbHistory, currentTime, windowSize = 10) {
  if (currentTime <= 0 || !dbHistory || dbHistory.length === 0) return 0;

  const startIdx = Math.max(1, currentTime - windowSize + 1);
  let localMax = -Infinity;
  let localMin = Infinity;

  for (let i = startIdx; i <= currentTime; i++) {
    const value = dbHistory[i];
    if (typeof value !== 'number') {
      continue;
    }
    if (value > localMax) localMax = value;
    if (value < localMin) localMin = value;
  }

  if (!Number.isFinite(localMax) || !Number.isFinite(localMin)) {
    return 0;
  }

  return (localMax - localMin) > 15 ? 1 : 0;
}

/**
 * 计算引入脉冲惩罚后的累积噪声能量 (CNE, Cumulative Noise Energy)。
 * 这是一个综合了时域等效声压级（Leq）、预定日接触持续时长以及 K-Factor 波动惩罚影响的关键职业卫生学曝光评估指标，
 * 其结果是对基础声学变量（A计权真实声压）经过一系列等效缩放与惩罚加权后的评价数值。
 * @param {number} currentDB - 当前秒的 A 计权瞬态真实声压值 (dB)
 * @param {number} totalSeconds - 本次测量有效时长基数
 * @param {number} timeTerm - 基于预估接触时域加权得到的时间平移项参数
 * @param {number} totalEnergySum - 历史统计所推导出的对质量级宏观累积能量
 * @param {number} currentKFactor - 当前短时滑动窗口估算的 K-Factor（0 或 1）
 * @returns {object} 返回综合指数 CNE，及对应关联声学参量集合
 */
function calculateShortCNE(currentDB, totalSeconds, timeTerm, totalEnergySum, currentKFactor) {
  if (totalSeconds <= 0) {
    return {
      cne: 0,
      leq: 0,
      kFactor: 0,
      totalEnergySum,
    };
  }

  const leqResult = calculateLeqIncremental(currentDB, totalSeconds, totalEnergySum);
  const cne = calculateCNEFromLeq(leqResult.leq, timeTerm, currentKFactor);

  return {
    cne,
    leq: leqResult.leq,
    kFactor: currentKFactor,
    totalEnergySum: leqResult.totalEnergySum,
  };
}

/**
 * IEC 61672 标准 A 计权数字滤波器
 * 采用级联 Biquad 直接 II 型转置结构
 * 确保高精度和数值稳定性
 * 采样率：44100 Hz（对应微信小程序麦克风采样率）
 * 若后续需要适配其他采样率，请使用 MATLAB 重新生成系数：
 * fdesign.audioweighting('wt', 'A', <新采样率>)
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
    const pole12194 = toDigitalPole(12194.217);

    // 两个 20.6Hz 极点与两个 z=1 零点。
    this.b1 = [1.0, -2.0, 1.0];
    this.a1 = [1.0, -2 * pole20, pole20 * pole20];
    this.z1 = [0, 0]; // 延迟线状态寄存器

    // 107.7Hz、737.9Hz 极点与两个 z=1 零点。
    this.b2 = [1.0, -2.0, 1.0];
    this.a2 = [1.0, -(pole107 + pole738), pole107 * pole738];
    this.z2 = [0, 0];

    // 两个 12.2kHz 极点与双线性变换补入的两个 z=-1 零点。
    this.b3 = [1.0, 2.0, 1.0];
    this.a3 = [1.0, -2 * pole12194, pole12194 * pole12194];
    this.z3 = [0, 0];

    // A 计权在 1kHz 的标准增益为 0dB，按实际数字滤波器响应归一。
    const sectionMagnitude = (b, a, angularFrequency) => {
      const cos1 = Math.cos(angularFrequency);
      const sin1 = Math.sin(angularFrequency);
      const cos2 = Math.cos(2 * angularFrequency);
      const sin2 = Math.sin(2 * angularFrequency);
      const numeratorRe = b[0] + b[1] * cos1 + b[2] * cos2;
      const numeratorIm = -b[1] * sin1 - b[2] * sin2;
      const denominatorRe = a[0] + a[1] * cos1 + a[2] * cos2;
      const denominatorIm = -a[1] * sin1 - a[2] * sin2;
      return Math.sqrt(
        (numeratorRe * numeratorRe + numeratorIm * numeratorIm) /
        (denominatorRe * denominatorRe + denominatorIm * denominatorIm)
      );
    };
    const oneKhz = 2 * Math.PI * 1000 / sampleRate;
    const magnitudeAtOneKhz =
      sectionMagnitude(this.b1, this.a1, oneKhz) *
      sectionMagnitude(this.b2, this.a2, oneKhz) *
      sectionMagnitude(this.b3, this.a3, oneKhz);
    this.gain = 1 / magnitudeAtOneKhz;
  }

  /**
    * 处理单帧 PCM 数据，返回 A 计权后的音频。
    * @param {Int16Array|Float32Array} inputBuffer 原始 PCM 数据。
    * @param {boolean} [normalize=true] 是否将 16 位整数归一化为 [-1, 1]。
    *   - true：输入视为 Int16 PCM，内部先除以 32768。
    *   - false：输入已是浮点归一化数据，直接进入滤波器。
    * @returns {Float32Array} A 计权后的音频数据（浮点数）。
    * Side effect: 会更新内部延迟线状态 z1/z2/z3；同一实例必须连续使用，不能每帧重建。
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

      // 4. 级联 Biquad 3
      let y3 = this.b3[0] * y2 + this.z3[0];
      this.z3[0] = this.b3[1] * y2 - this.a3[1] * y3 + this.z3[1];
      this.z3[1] = this.b3[2] * y2 - this.a3[2] * y3;

      // 5. 输出
      output[i] = y3;
    }

    return output;
  }
}

module.exports = {
  calculateRMS,
  calculateDb,
  calculateLeqIncremental,
  calculateLeqFromEnergy,
  calculateCNEFromLeq,
  estimateKFactorSliding,
  calculateShortCNE,
  AWeightingFilter,
};
