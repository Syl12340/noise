// utils/phonetic/frame-segment.js
// 帧切分与 Hamming 窗加窗

/**
 * 预计算 Hamming 窗系数
 * w(n) = 0.54 - 0.46 * cos(2*pi*n / (N-1))
 * @param {number} N - 窗长
 * @returns {Float64Array}
 */
function hammingWindow(N) {
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N - 1));
  }
  return w;
}

/**
 * 将连续信号切分为重叠帧并加 Hamming 窗。
 * @param {Float32Array} signal - 预加重后的浮点信号
 * @param {number} frameSize - 每帧样本数
 * @param {number} hopSize - 帧移样本数
 * @returns {Float64Array[]} 帧数组，每帧已加窗
 */
function segmentFrames(signal, frameSize, hopSize) {
  const window = hammingWindow(frameSize);
  const frames = [];
  let start = 0;

  while (start + frameSize <= signal.length) {
    const frame = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      frame[i] = signal[start + i] * window[i];
    }
    frames.push(frame);
    start += hopSize;
  }

  return frames;
}

/**
 * 计算信号可切分的帧数
 * @param {number} signalLength - 信号总样本数
 * @param {number} frameSize - 帧长
 * @param {number} hopSize - 帧移
 * @returns {number}
 */
function countFrames(signalLength, frameSize, hopSize) {
  if (signalLength < frameSize) return 0;
  return Math.floor((signalLength - frameSize) / hopSize) + 1;
}

module.exports = { hammingWindow, segmentFrames, countFrames };
