// utils/phonetic/pre-emphasis.js
// 预加重滤波器：一阶高通，提亮高频共振峰

/**
 * 对 PCM 信号施加预加重滤波。
 * y[n] = x[n] - coeff * x[n-1]
 * @param {Int16Array} pcm - 原始 16-bit PCM 数据
 * @param {number} [coeff=0.97] - 预加重系数
 * @returns {Float32Array} 归一化并预加重后的浮点信号 [-1, 1]
 */
function preEmphasis(pcm, coeff = 0.97) {
  const n = pcm.length;
  const out = new Float32Array(n);
  out[0] = pcm[0] / 32768.0;
  for (let i = 1; i < n; i++) {
    out[i] = (pcm[i] / 32768.0) - coeff * ((pcm[i - 1]) / 32768.0);
  }
  return out;
}

module.exports = { preEmphasis };
