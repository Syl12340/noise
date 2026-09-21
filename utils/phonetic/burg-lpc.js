// utils/phonetic/burg-lpc.js
// Burg 算法计算 LPC 系数
// 优势：保证稳定性（所有极点在单位圆内）、无窗效应偏差、适合短帧

/**
 * Burg 算法计算线性预测系数。
 * @param {Float64Array} signal - 加窗后的单帧信号
 * @param {number} order - LPC 阶数
 * @returns {{ a: Float64Array, error: number }} 预测系数 a[0..order]（a[0]=1）和预测误差功率
 */
function burgLPC(signal, order) {
  const N = signal.length;
  if (N <= order) {
    const a = new Float64Array(order + 1);
    a[0] = 1.0;
    return { a, error: 0 };
  }

  // 一阶递推前，前向误差对应 x[1..N-1]，后向误差对应 x[0..N-2]。
  let forward = new Float64Array(N - 1);
  let backward = new Float64Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    forward[i] = signal[i + 1];
    backward[i] = signal[i];
  }

  // LPC 系数，a[0] = 1
  const a = new Float64Array(order + 1);
  a[0] = 1.0;

  // 初始误差功率
  let errorPower = 0;
  for (let i = 0; i < N; i++) {
    errorPower += signal[i] * signal[i];
  }
  errorPower /= N;

  for (let m = 1; m <= order; m++) {
    // 计算反射系数 km
    let num = 0;
    let den = 0;
    for (let i = 0; i < forward.length; i++) {
      num += forward[i] * backward[i];
      den += forward[i] * forward[i] + backward[i] * backward[i];
    }

    const km = den > 1e-30 ? (-2.0 * num) / den : 0;

    // 更新 LPC 系数
    const aNew = new Float64Array(m + 1);
    aNew[0] = 1.0;
    for (let i = 1; i < m; i++) {
      aNew[i] = a[i] + km * a[m - i];
    }
    aNew[m] = km;
    for (let i = 0; i <= m; i++) {
      a[i] = aNew[i];
    }

    // 使用独立缓冲区，避免同一阶内覆盖仍需参与计算的旧误差。
    if (m < order) {
      const nextLength = forward.length - 1;
      const nextForward = new Float64Array(nextLength);
      const nextBackward = new Float64Array(nextLength);
      for (let i = 0; i < nextLength; i++) {
        nextForward[i] = forward[i + 1] + km * backward[i + 1];
        nextBackward[i] = backward[i] + km * forward[i];
      }
      forward = nextForward;
      backward = nextBackward;
    }

    // 更新误差功率
    errorPower *= (1.0 - km * km);
    if (errorPower < 0) errorPower = 0;
  }

  return { a, error: errorPower };
}

module.exports = { burgLPC };
