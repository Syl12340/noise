// utils/phonetic/spectrogram-gen.js
// 宽带语谱图生成：短窗 STFT → 功率谱 → dB 映射

/**
 * 生成宽带语谱图数据。
 * 使用较短的 FFT 窗（如 5ms）以获得宽带语谱图效果。
 * @param {Float32Array} signal - 预加重后的浮点信号
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {number} [options.fftSize=1024] - FFT 点数
 * @param {number} [options.windowSec=0.005] - 窗长（秒）
 * @param {number} [options.hopSec=0.002] - 帧移（秒）
 * @param {number} [options.dbMin=-80] - dBFS 下限
 * @param {number} [options.dbMax=0] - dBFS 上限
 * @returns {{ data: Float32Array[], width: number, height: number, times: Float64Array }}
 */
function generateSpectrogram(signal, sampleRate, options = {}) {
  const {
    fftSize = 1024,
    windowSec = 0.005,
    hopSec = 0.002,
    dbMin = -80,
    dbMax = 0,
  } = options;

  const windowLen = Math.round(windowSec * sampleRate);
  const hopLen = Math.round(hopSec * sampleRate);
  const binCount = fftSize / 2;

  // Hann 窗
  const window = new Float64Array(windowLen);
  for (let n = 0; n < windowLen; n++) {
    window[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (windowLen - 1)));
  }

  // 计算帧数
  const frameCount = Math.max(0, Math.floor((signal.length - windowLen) / hopLen) + 1);
  const times = new Float64Array(frameCount);
  const data = [];

  // FFT scratch buffers
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hopLen;
    times[frame] = (start + windowLen / 2) / sampleRate;

    // 加窗 + 零填充到 fftSize
    for (let i = 0; i < fftSize; i++) {
      re[i] = i < windowLen ? signal[start + i] * window[i] : 0;
      im[i] = 0;
    }

    // FFT（in-place Cooley-Tukey）
    fftInPlaceLocal(re, im, fftSize);

    // 功率谱 → dB
    const spectrum = new Float32Array(binCount);
    const scale = 2.0 / (windowLen * 0.5); // Hann 窗相干增益补偿

    for (let k = 0; k < binCount; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      const rms = Math.sqrt(power) * scale / Math.SQRT2;
      let db = 20 * Math.log10(Math.max(rms, 1e-12));
      // 裁剪到 [dbMin, dbMax] 并归一化到 [0, 1]
      db = Math.max(dbMin, Math.min(dbMax, db));
      spectrum[k] = (db - dbMin) / (dbMax - dbMin);
    }

    data.push(spectrum);
  }

  return { data, width: frameCount, height: binCount, times };
}

/**
 * 本地 FFT 实现（复用 fft.js 的 radix-2 算法逻辑）
 * 为避免 Worker 中引用路径问题，内联一份
 */
function fftInPlaceLocal(re, im, N) {
  // 位反转置换
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let temp = re[i]; re[i] = re[j]; re[j] = temp;
      temp = im[i]; im[i] = im[j]; im[j] = temp;
    }
  }

  // 蝶形运算
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
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

module.exports = { generateSpectrogram };
