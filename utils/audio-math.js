// utils/audio-math.js
const { CNE_FORMULA } = require('./constants');

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
 * 增量估算波值因子 (K-Factor)
 * K-Factor 用于描述信号变化的剧烈程度：
 * - K = 0：平稳信号（min ~ max 范围 <= 15dB）
 * - K = 1：波动信号（min ~ max 范围 > 15dB）
 * @param {number} currentDB - 当前秒的声压级
 * @param {number} globalMaxDB - 全局最大值
 * @param {number} globalMinDB - 全局最小值
 * @returns {object} { kFactor: 波值因子, globalMaxDB: 更新后最大值, globalMinDB: 更新后最小值 }
 */
function estimateKFactorIncremental(currentDB, globalMaxDB, globalMinDB) {
  const nextMax = currentDB > globalMaxDB ? currentDB : globalMaxDB;
  const nextMin = currentDB < globalMinDB ? currentDB : globalMinDB;
  const range = nextMax - nextMin;
  return {
    kFactor: range > 15 ? 1 : 0,
    globalMaxDB: nextMax,
    globalMinDB: nextMin,
  };
}

/**
 * 计算引入脉冲惩罚后的累积噪声能量 (CNE, Cumulative Noise Energy)。
 * 这是一个综合了时域等效声压级（Leq）、预定日接触持续时长以及 K-Factor 波动惩罚影响的关键职业卫生学曝光评估指标，
 * 其结果是对基础声学变量（A计权真实声压）经过一系列等效缩放与惩罚加权后的评价数值。
 * @param {number} currentDB - 当前秒的 A 计权瞬态真实声压值 (dB)
 * @param {number} totalSeconds - 本次测量有效时长基数
 * @param {number} timeTerm - 基于预估接触时域加权得到的时间平移项参数
 * @param {number} totalEnergySum - 历史统计所推导出的对质量级宏观累积能量
 * @param {number} globalMaxDB - 测量周期声压上限，用于 K-Factor 波形波动校验
 * @param {number} globalMinDB - 测量周期声压下限，用于 K-Factor 波形波动校验
 * @returns {object} 返回综合指数 CNE，及对应关联声学参量集合
 */
function calculateShortCNE(currentDB, totalSeconds, timeTerm, totalEnergySum, globalMaxDB, globalMinDB) {
  if (totalSeconds <= 0) {
    return {
      cne: 0,
      leq: 0,
      kFactor: 0,
      totalEnergySum,
      globalMaxDB,
      globalMinDB,
    };
  }

  const leqResult = calculateLeqIncremental(currentDB, totalSeconds, totalEnergySum);
  const kResult = estimateKFactorIncremental(currentDB, globalMaxDB, globalMinDB);
  const cne =
    leqResult.leq +
    timeTerm +
    kResult.kFactor * CNE_FORMULA.K_FACTOR_WEIGHT -
    CNE_FORMULA.BASE_OFFSET;

  return {
    cne,
    leq: leqResult.leq,
    kFactor: kResult.kFactor,
    totalEnergySum: leqResult.totalEnergySum,
    globalMaxDB: kResult.globalMaxDB,
    globalMinDB: kResult.globalMinDB,
  };
}

/**
 * IEC 61672 标准 A 计权数字滤波器
 * 采用级联 Biquad 直接 II 型转置结构
 * 确保高精度和数值稳定性
 * 采样率：16000 Hz（对应微信小程序麦克风采样率）
 * 若后续需要适配其他采样率，请使用 MATLAB 重新生成系数：
 * fdesign.audioweighting('wt', 'A', <新采样率>)
 */
class AWeightingFilter {
  constructor() {
    // 全局增益系数
    this.gain = 0.582348555848;

    // 第 1 级 Biquad - 处理高频与极低频极点
    this.b1 = [1.0, 2.0, 1.0];
    this.a1 = [1.0, 0.228919690196, 0.013106399039];
    this.z1 = [0, 0]; // 延迟线状态寄存器

    // 第 2 级 Biquad - 处理中低频曲线
    this.b2 = [1.0, -2.0, 1.0];
    this.a2 = [1.0, -1.986682054238, 0.986701889814];
    this.z2 = [0, 0];

    // 第 3 级 Biquad - 处理低频衰减
    this.b3 = [1.0, -2.0, 1.0];
    this.a3 = [1.0, -1.996160359265, 0.996165502446];
    this.z3 = [0, 0];
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
  estimateKFactorIncremental,
  calculateShortCNE,
  AWeightingFilter,
};
