// utils/canvas-spectrum.js
// 作用：实现 1/3 倍频程频谱柱状图的计算与 Canvas 渲染。

const { FFT_CONFIG } = require('./fft');
const { CANVAS_CONFIG } = require('./constants');

/**
 * 1/3 倍频程中心频率表 (Hz)
 * 覆盖 25 Hz ~ 8000 Hz，共 26 个频段
 * @type {number[]}
 */
const THIRD_OCTAVE_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000,
];

/**
 * 1/3 倍频程频段边界系数
 * f_low = center / 2^(1/6), f_high = center * 2^(1/6)
 * 2^(1/6) ≈ 1.12246
 * @type {number}
 */
const BAND_FACTOR = Math.pow(2, 1.0 / 6.0);

/**
 * 预计算每个 1/3 倍频程频段对应的 FFT bin 范围
 * @type {Array<{startBin: number, endBin: number}>}
 */
const BAND_BIN_RANGES = (function computeBandBinRanges() {
  const freqRes = FFT_CONFIG.FREQ_RESOLUTION; // 7.8125 Hz/bin
  const ranges = [];

  for (let i = 0; i < THIRD_OCTAVE_CENTERS.length; i++) {
    const center = THIRD_OCTAVE_CENTERS[i];
    const fLow = center / BAND_FACTOR;
    const fHigh = center * BAND_FACTOR;

    // 找到落在 [fLow, fHigh] 范围内的 bin 索引
    const startBin = Math.max(1, Math.ceil(fLow / freqRes));
    const endBin = Math.min(FFT_CONFIG.BIN_COUNT - 1, Math.floor(fHigh / freqRes));

    ranges.push({ startBin, endBin });
  }

  return ranges;
})();

/**
 * 从 FFT 幅度谱计算 1/3 倍频程频段声压级
 * 对每个频段，将范围内所有 FFT bin 的功率求和，再转换为 dB SPL
 * @param {Float64Array} spectrumDB - FFT 输出，1024 bins，每 bin 的 dB SPL
 * @returns {Float64Array} 各频段的 dB SPL，长度等于 THIRD_OCTAVE_CENTERS.length
 */
function computeThirdOctaveBands(spectrumDB) {
  const bandCount = THIRD_OCTAVE_CENTERS.length;
  const bandLevels = new Float64Array(bandCount);

  for (let band = 0; band < bandCount; band++) {
    const { startBin, endBin } = BAND_BIN_RANGES[band];

    if (startBin > endBin) {
      // 该频段没有对应的 FFT bin（频率超出范围）
      bandLevels[band] = -Infinity;
      continue;
    }

    // 功率域求和：sum(10^(dB/10))
    let sumPower = 0;
    for (let k = startBin; k <= endBin; k++) {
      sumPower += Math.pow(10, spectrumDB[k] / 10);
    }

    // 转换回 dB SPL
    bandLevels[band] = 10 * Math.log10(Math.max(sumPower, 1e-20));
  }

  return bandLevels;
}

/**
 * 绘制单帧频谱柱状图
 * @param {CanvasRenderingContext2D} ctx - 2D 绘图上下文（坐标原点在左下角）
 * @param {object} options - 绘制参数
 * @param {Float64Array} options.bandLevels - 各频段 dB SPL
 * @param {number} options.canvasWidth - 画布逻辑宽度
 * @param {number} options.canvasHeight - 画布逻辑高度
 * @param {number} options.dbMin - Y 轴最小 dB 值
 * @param {number} options.dbMax - Y 轴最大 dB 值
 * @param {string} options.barColor - 柱状图填充颜色
 * @param {string} options.gridColor - 网格线颜色
 * @param {string} options.textColor - 标签文字颜色
 * @param {string} options.primaryColor - 高亮颜色
 * @returns {void}
 */
function drawSpectrumFrame(ctx, options) {
  const {
    bandLevels,
    canvasWidth,
    canvasHeight,
    dbMin,
    dbMax,
    barColor,
    gridColor,
    textColor,
    primaryColor,
  } = options;

  const bandCount = bandLevels.length;
  if (bandCount === 0) return;

  // 清空画布（注意坐标原点在左下角，Y 轴向上）
  ctx.clearRect(0, -canvasHeight, canvasWidth, canvasHeight);

  const dbRange = dbMax - dbMin;
  const axisPadding = CANVAS_CONFIG.AXIS_PADDING;
  const plotTop = axisPadding.TOP;
  const plotBottom = axisPadding.BOTTOM;
  const plotHeight = Math.max(1, canvasHeight - plotTop - plotBottom);
  const barAreaLeft = axisPadding.LEFT;
  const barAreaRight = canvasWidth - axisPadding.RIGHT;
  const barWidth = (barAreaRight - barAreaLeft) / bandCount;

  // 1. 绘制水平网格线（每 10 dB）
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.3;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let db = dbMin; db <= dbMax; db += 10) {
    const y = -plotBottom - ((db - dbMin) / dbRange) * plotHeight;
    ctx.moveTo(barAreaLeft, y);
    ctx.lineTo(barAreaRight, y);
  }
  ctx.stroke();

  // 2. 绘制 Y 轴标签（dB 值）
  ctx.fillStyle = textColor;
  ctx.font = '8px Arial';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const yLabelStep = 20;
  for (let db = dbMin; db <= dbMax; db += yLabelStep) {
    const y = -plotBottom - ((db - dbMin) / dbRange) * plotHeight;
    ctx.fillText(`${db}`, barAreaLeft - 4, y);
  }

  // 3. 绘制柱状图
  for (let i = 0; i < bandCount; i++) {
    const db = bandLevels[i];
    if (!Number.isFinite(db)) continue;

    // 将 dB 值映射到柱高
    const normalizedDb = Math.max(0, Math.min(1, (db - dbMin) / dbRange));
    const barHeight = normalizedDb * plotHeight;

    const x = barAreaLeft + i * barWidth + 1; // 留 1px 间距
    const y = -plotBottom - barHeight;

    // 根据声压级选择颜色
    ctx.fillStyle = db >= 85 ? primaryColor : barColor;
    ctx.fillRect(x, y, barWidth - 2, barHeight);
  }

  // 4. 绘制 X 轴标签（频段中心频率）
  ctx.fillStyle = textColor;
  ctx.font = '7px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // 根据可绘制宽度自适应标签间隔，避免拥挤重叠
  const plotWidth = Math.max(1, barAreaRight - barAreaLeft);
  const minLabelSpacing = 26;
  const maxLabels = Math.max(1, Math.floor(plotWidth / minLabelSpacing));
  const labelStep = Math.max(1, Math.ceil(bandCount / maxLabels));
  for (let i = 0; i < bandCount; i += labelStep) {
    const freq = THIRD_OCTAVE_CENTERS[i];
    const x = barAreaLeft + i * barWidth + barWidth / 2;

    // 格式化频率标签
    let label;
    if (freq >= 1000) {
      label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
    } else {
      label = freq.toString();
    }
    ctx.fillText(label, x, 6);
  }

  // 确保最后一个频段标签可见
  if ((bandCount - 1) % labelStep !== 0) {
    const lastIdx = bandCount - 1;
    const lastFreq = THIRD_OCTAVE_CENTERS[lastIdx];
    const lastX = barAreaLeft + lastIdx * barWidth + barWidth / 2;
    const lastLabel = lastFreq >= 1000
      ? (lastFreq / 1000).toFixed(lastFreq % 1000 === 0 ? 0 : 1) + 'k'
      : lastFreq.toString();
    ctx.fillText(lastLabel, lastX, 6);
  }

  // 5. 绘制单位标签
  ctx.fillStyle = textColor;
  ctx.font = '9px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('dB SPL', barAreaLeft, -canvasHeight + 2);

  ctx.font = '8px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('1/3 倍频程频段 (Hz)', canvasWidth / 2, 16);
}

module.exports = {
  THIRD_OCTAVE_CENTERS,
  BAND_BIN_RANGES,
  computeThirdOctaveBands,
  drawSpectrumFrame,
};
