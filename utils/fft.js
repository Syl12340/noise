// utils/fft.js
// 作用：实现 radix-2 Cooley-Tukey 快速傅里叶变换（FFT），用于频谱分析。

/**
 * FFT 模块配置常量
 * @type {object}
 */
const FFT_CONFIG = {
  SIZE: 2048,           // FFT 点数（必须为 2 的幂）
  SAMPLE_RATE: 16000,   // 采样率 (Hz)
  NYQUIST: 8000,        // 奈奎斯特频率 = 采样率 / 2
  BIN_COUNT: 1024,      // 频率 bin 数量 = FFT_SIZE / 2
  FREQ_RESOLUTION: 7.8125, // 频率分辨率 = 采样率 / FFT_SIZE
};

/**
 * 预计算 Hann 窗函数系数（N=2048）
 * Hann 窗公式: w(n) = 0.5 * (1 - cos(2*pi*n/(N-1)))
 * @type {Float64Array}
 */
const HANN_WINDOW = new Float64Array(FFT_CONFIG.SIZE);
(function initHannWindow() {
  const N = FFT_CONFIG.SIZE;
  for (let n = 0; n < N; n++) {
    HANN_WINDOW[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (N - 1)));
  }
})();

// 复用的 scratch 缓冲区，避免每次 FFT 分配内存
const _scratchRe = new Float64Array(FFT_CONFIG.SIZE);
const _scratchIm = new Float64Array(FFT_CONFIG.SIZE);

/**
 * 原位 radix-2 Cooley-Tukey FFT
 * 时间抽取（DIT）蝶形运算实现
 * @param {Float64Array} re - 实部数组，长度 N（2 的幂）。会被原位修改。
 * @param {Float64Array} im - 虚部数组，长度 N。会被原位修改。
 * @param {number} N - 变换长度（必须为 2 的幂）
 * @returns {void}
 */
function fftInPlace(re, im, N) {
  // 1. 位反转置换（Bit-Reversal Permutation）
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;

    if (i < j) {
      // 交换 re[i] <-> re[j]
      let temp = re[i];
      re[i] = re[j];
      re[j] = temp;
      // 交换 im[i] <-> im[j]
      temp = im[i];
      im[i] = im[j];
      im[j] = temp;
    }
  }

  // 2. 蝶形运算（Butterfly Operations）
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < N; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let k = 0; k < halfLen; k++) {
        const tRe = curRe * re[i + k + halfLen] - curIm * im[i + k + halfLen];
        const tIm = curRe * im[i + k + halfLen] + curIm * re[i + k + halfLen];

        re[i + k + halfLen] = re[i + k] - tRe;
        im[i + k + halfLen] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;

        // 旋转因子 w = e^(-j*2*pi*k/len)
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

/**
 * 应用 Hann 窗到 PCM 样本并归一化到 [-1, 1]
 * @param {Int16Array} pcm - 原始 PCM 样本（16 位整数）
 * @param {Float64Array} out - 输出缓冲区（长度 N），窗函数处理后的浮点数据
 * @param {number} N - 窗长度
 * @returns {void}
 */
function applyHannWindow(pcm, out, N) {
  for (let i = 0; i < N; i++) {
    // 归一化 Int16 到 [-1, 1]，然后应用 Hann 窗
    out[i] = (pcm[i] / 32768.0) * HANN_WINDOW[i];
  }
}

/**
 * 完整 FFT 管道：窗函数 → FFT → 功率谱 → dB SPL
 * @param {Int16Array} pcm - 2048 个原始 PCM 样本（Int16）
 * @param {number} offset - 校准偏移量 (dB)，用于 dBFS → dB SPL 转换
 * @returns {Float64Array} 幅度谱，单位 dB SPL，长度 1024 bins
 *   bin k 对应频率 k * (16000/2048) ≈ k * 7.8125 Hz
 */
function computeSpectrum(pcm, offset) {
  const N = FFT_CONFIG.SIZE;
  const halfN = FFT_CONFIG.BIN_COUNT;

  // 复用 scratch 缓冲区
  const re = _scratchRe;
  const im = _scratchIm;

  // 1. 应用 Hann 窗并归一化
  applyHannWindow(pcm, re, N);
  // 清零虚部
  im.fill(0);

  // 2. 执行 FFT
  fftInPlace(re, im, N);

  // 3. 计算功率谱并转换为 dB SPL
  //    |X(k)| 来自未归一化 FFT，需按 N 和窗函数做幅度归一化
  //    峰值幅度 A = 2*|X(k)|/(N*CG)，RMS = A/sqrt(2)
  //    dB SPL = 20*log10(RMS) + offset
  const spectrumDB = new Float64Array(halfN);
  const coherentGain = 0.5; // Hann 窗的幅度相干增益
  const amplitudeScale = Math.SQRT2 / (N * coherentGain);

  for (let k = 0; k < halfN; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    const rms = Math.sqrt(power) * amplitudeScale;
    spectrumDB[k] = 20 * Math.log10(Math.max(rms, 1e-12)) + offset;
  }

  return spectrumDB;
}

/**
 * 获取指定 bin 索引对应的频率 (Hz)
 * @param {number} binIndex - FFT bin 索引 (0..1023)
 * @returns {number} 频率 (Hz)
 */
function binToFrequency(binIndex) {
  return binIndex * FFT_CONFIG.FREQ_RESOLUTION;
}

module.exports = {
  FFT_CONFIG,
  HANN_WINDOW,
  fftInPlace,
  applyHannWindow,
  computeSpectrum,
  binToFrequency,
};
