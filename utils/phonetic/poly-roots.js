// utils/phonetic/poly-roots.js
// 多项式求根：Durand-Kerner 复数迭代
// 用于从 LPC 系数中提取共振峰

/**
 * 求实系数多项式的全部根。
 * 多项式: p[0]*z^n + p[1]*z^(n-1) + ... + p[n]
 * 使用 Durand-Kerner 同步迭代，并用相对残差验证收敛。
 * @param {Float64Array} coefficients - 多项式系数 [a0, a1, ..., an]，a0 为首项
 * @returns {Array<{re: number, im: number}>} 根的数组（复数）
 */
function findRoots(coefficients) {
  const n = coefficients.length - 1;
  if (n <= 0) return [];

  // 归一化首项系数为 1
  const c0 = coefficients[0];
  if (!Number.isFinite(c0) || Math.abs(c0) < 1e-30) {
    throw new Error('多项式首项系数必须为非零有限数');
  }
  const normed = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    if (!Number.isFinite(coefficients[i])) {
      throw new Error('多项式系数必须全部为有限数');
    }
    normed[i] = coefficients[i] / c0;
  }

  if (n === 1) {
    return [{ re: -normed[1], im: 0 }];
  }

  return durandKerner(normed);
}

function evaluatePolynomial(coefficients, z) {
  let re = coefficients[0];
  let im = 0;
  for (let i = 1; i < coefficients.length; i++) {
    const nextRe = re * z.re - im * z.im + coefficients[i];
    im = re * z.im + im * z.re;
    re = nextRe;
  }
  return { re, im };
}

function relativeResidual(coefficients, z) {
  const value = evaluatePolynomial(coefficients, z);
  const magnitude = Math.hypot(value.re, value.im);
  const absZ = Math.hypot(z.re, z.im);
  let scale = Math.abs(coefficients[0]);
  for (let i = 1; i < coefficients.length; i++) {
    scale = scale * absZ + Math.abs(coefficients[i]);
  }
  return magnitude / Math.max(1, scale);
}

function durandKerner(coefficients) {
  const degree = coefficients.length - 1;
  let radius = 1;
  for (let i = 1; i < coefficients.length; i++) {
    radius = Math.max(radius, 1 + Math.abs(coefficients[i]));
  }

  let roots = Array.from({ length: degree }, (_, i) => {
    const angle = 2 * Math.PI * (i + 0.25) / degree;
    const radialScale = 1 + 0.01 * i / degree;
    return {
      re: radius * radialScale * Math.cos(angle),
      im: radius * radialScale * Math.sin(angle),
    };
  });

  const maxIterations = 2000;
  let converged = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const nextRoots = new Array(degree);
    let maxDelta = 0;

    for (let i = 0; i < degree; i++) {
      const root = roots[i];
      const value = evaluatePolynomial(coefficients, root);
      let denomRe = 1;
      let denomIm = 0;

      for (let j = 0; j < degree; j++) {
        if (j === i) continue;
        const diffRe = root.re - roots[j].re;
        const diffIm = root.im - roots[j].im;
        const nextRe = denomRe * diffRe - denomIm * diffIm;
        denomIm = denomRe * diffIm + denomIm * diffRe;
        denomRe = nextRe;
      }

      let denomAbsSq = denomRe * denomRe + denomIm * denomIm;
      if (denomAbsSq < 1e-30) {
        denomRe += 1e-12 * (i + 1);
        denomIm += 1e-12 * (degree - i);
        denomAbsSq = denomRe * denomRe + denomIm * denomIm;
      }

      const deltaRe = (value.re * denomRe + value.im * denomIm) / denomAbsSq;
      const deltaIm = (value.im * denomRe - value.re * denomIm) / denomAbsSq;
      nextRoots[i] = { re: root.re - deltaRe, im: root.im - deltaIm };
      maxDelta = Math.max(maxDelta, Math.hypot(deltaRe, deltaIm));
    }

    roots = nextRoots;
    let maxResidual = 0;
    let maxRootMagnitude = 0;
    for (const root of roots) {
      maxResidual = Math.max(maxResidual, relativeResidual(coefficients, root));
      maxRootMagnitude = Math.max(maxRootMagnitude, Math.hypot(root.re, root.im));
    }

    if (maxDelta <= 1e-12 * (1 + maxRootMagnitude) && maxResidual <= 1e-10) {
      converged = true;
      break;
    }
  }

  const finalResidual = roots.reduce(
    (maxValue, root) => Math.max(maxValue, relativeResidual(coefficients, root)),
    0
  );
  if (!Number.isFinite(finalResidual) || roots.some(root => !Number.isFinite(root.re) || !Number.isFinite(root.im))
      || (!converged && finalResidual > 1e-7)) {
    throw new Error(`多项式求根未收敛：最大相对残差 ${finalResidual}`);
  }

  return roots
    .map(root => ({
      re: Math.abs(root.re) < 1e-12 ? 0 : root.re,
      im: Math.abs(root.im) < 1e-10 ? 0 : root.im,
    }))
    .sort((a, b) => a.re - b.re || a.im - b.im);
}

module.exports = { findRoots };
