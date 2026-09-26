// utils/canvas-spectrogram.js
// 作用：实现时频热力图（频谱图）的滚动渲染，使用 ImageData 像素级操作。

const { FFT_CONFIG } = require('./fft');

/**
 * 17 色色阶（来自 NoiseCapture 项目）
 * 映射 dB 值范围 [0, 70] 到颜色：深绿 → 绿 → 黄 → 橙 → 红
 * @type {string[]}
 */
const SPECTROGRAM_COLOR_RAMP = [
  '#303030', '#2D3C2D', '#2A482A', '#275427', '#246024', '#216C21',
  '#3F8E19', '#61A514', '#82BB0F', '#A4D20A', '#C5E805', '#E7FF00',
  '#EBD400', '#EFAA00', '#F37F00', '#F75500', '#FB2A00',
];

const SPECTROGRAM_BG_RGBA = [255, 255, 255, 255];

/**
 * 预计算色阶的 RGBA 值（避免每次解析 hex 颜色字符串）
 * 索引 0..16 → [r, g, b, 255]，存储为 Uint8ClampedArray (17*4 = 68 字节)
 * @type {Uint8ClampedArray}
 */
const RAMP_RGBA = new Uint8ClampedArray(SPECTROGRAM_COLOR_RAMP.length * 4);
(function initRampRGBA() {
  for (let i = 0; i < SPECTROGRAM_COLOR_RAMP.length; i++) {
    const hex = SPECTROGRAM_COLOR_RAMP[i];
    RAMP_RGBA[i * 4] = parseInt(hex.slice(1, 3), 16);     // R
    RAMP_RGBA[i * 4 + 1] = parseInt(hex.slice(3, 5), 16); // G
    RAMP_RGBA[i * 4 + 2] = parseInt(hex.slice(5, 7), 16); // B
    RAMP_RGBA[i * 4 + 3] = 255;                             // A
  }
})();

/**
 * 将 dB 值映射到色阶索引 (0..16)
 * @param {number} db - dB SPL 值
 * @param {number} dbMin - 最小 dB 值 (如 0)
 * @param {number} dbMax - 最大 dB 值 (如 70)
 * @returns {number} 整数索引 0..16
 */
function dbToRampIndex(db, dbMin, dbMax) {
  const normalized = (db - dbMin) / (dbMax - dbMin);
  const index = Math.floor(normalized * (SPECTROGRAM_COLOR_RAMP.length - 1));
  return Math.max(0, Math.min(SPECTROGRAM_COLOR_RAMP.length - 1, index));
}

/**
 * 频谱图状态对象（创建一次，跨帧复用）
 * @typedef {object} SpectrogramState
 * @property {ImageData} imageData - Canvas ImageData
 * @property {Uint8ClampedArray} pixels - imageData.data 别名
 * @property {number} width - 像素宽度
 * @property {number} height - 像素高度
 * @property {number} dbMin - dB 下限
 * @property {number} dbMax - dB 上限
 * @property {Uint16Array} freqToRow - 频率 bin → 像素行的查找表
 */

/**
 * 创建频谱图状态
 * @param {number} width - 像素宽度
 * @param {number} height - 像素高度
 * @param {object} [options] - 配置选项
 * @param {number} [options.dbMin=0] - dB 下限
 * @param {number} [options.dbMax=70] - dB 上限
 * @param {number} [options.fMin=20] - 最低频率 (Hz)
 * @param {number} [options.fMax=8000] - 最高频率 (Hz)
 * @returns {SpectrogramState}
 */
function createSpectrogramState(width, height, options = {}) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const {
    dbMin = 0,
    dbMax = 70,
    fMin = 20,
    fMax = FFT_CONFIG.NYQUIST, // 8000 Hz
  } = options;

  // 创建 ImageData（初始为黑色/透明）
  // 注意：需要通过 Canvas API 创建，这里先返回配置，实际创建在 initSpectrogramCanvas 中
  const imageData = null; // 将在初始化时设置
  const pixels = null;

  // 预计算频率 bin → 像素行的查找表（对数刻度）
  // 公式：row = height - 1 - round(height * log(f/fMin) / log(fMax/fMin))
  const binCount = FFT_CONFIG.BIN_COUNT;
  const freqToRow = new Uint16Array(binCount);
  const logRatio = Math.log(fMax / fMin);

  for (let k = 0; k < binCount; k++) {
    const freq = k * FFT_CONFIG.FREQ_RESOLUTION; // bin k 对应的频率
    if (freq < fMin) {
      freqToRow[k] = height - 1; // 最低频率在底部
    } else if (freq > fMax) {
      freqToRow[k] = 0; // 最高频率在顶部
    } else {
      // 对数映射：row 0 = 最高频，row H-1 = 最低频
      freqToRow[k] = Math.round(
        (height - 1) * (1 - Math.log(freq / fMin) / logRatio)
      );
    }
  }

  // 预计算每行覆盖的完整 bin 范围，避免单 bin 抽样漏掉窄带峰值。
  const rowBinStart = new Uint16Array(height);
  const rowBinEnd = new Uint16Array(height);
  const rowDenominator = Math.max(1, height - 1);
  for (let row = 0; row < height; row++) {
    const upperRatio = Math.max(0, Math.min(1, 1 - (row - 0.5) / rowDenominator));
    const lowerRatio = Math.max(0, Math.min(1, 1 - (row + 0.5) / rowDenominator));
    const highFreq = fMin * Math.exp(upperRatio * logRatio);
    const lowFreq = fMin * Math.exp(lowerRatio * logRatio);
    let startBin = Math.max(1, Math.ceil(lowFreq / FFT_CONFIG.FREQ_RESOLUTION));
    let endBin = Math.min(binCount - 1, Math.floor(highFreq / FFT_CONFIG.FREQ_RESOLUTION));
    if (startBin > endBin) {
      const nearest = Math.max(1, Math.min(binCount - 1, Math.round(Math.sqrt(lowFreq * highFreq) / FFT_CONFIG.FREQ_RESOLUTION)));
      startBin = nearest;
      endBin = nearest;
    }
    rowBinStart[row] = startBin;
    rowBinEnd[row] = endBin;
  }

  return {
    imageData,
    pixels,
    width,
    height,
    dbMin,
    dbMax,
    freqToRow,
    rowBinStart,
    rowBinEnd,
  };
}

/**
 * 初始化频谱图的 ImageData（在 Canvas 节点就绪后调用）
 * @param {SpectrogramState} state - 频谱图状态
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D 上下文
 * @returns {void}
 */
function initSpectrogramImageData(state, ctx) {
  state.imageData = ctx.createImageData(state.width, state.height);
  state.pixels = state.imageData.data;
  fillSpectrogramBackground(state);
}

/**
 * 向频谱图追加一列 FFT 结果
 * 将 ImageData 左移 stripWidth 像素，在右侧写入新列
 * 使用 log 频率 Y 映射：像素行 0 = 最高频率，行 H-1 = 最低频率
 * @param {SpectrogramState} state - 频谱图状态
 * @param {Float64Array} spectrumDB - 1024 bin 的 dB SPL 频谱
 * @param {number} [stripWidth=4] - 每个时间步的像素宽度
 * @returns {void}
 */
function appendSpectrogramColumn(state, spectrumDB, stripWidth = 4) {
  const { pixels, width, height, dbMin, dbMax, rowBinStart, rowBinEnd } = state;
  if (!pixels) return;

  const bytesPerRow = width * 4;
  const shiftBytes = stripWidth * 4;

  // 1. 将所有行左移 stripWidth 像素
  for (let y = 0; y < height; y++) {
    const rowOffset = y * bytesPerRow;
    pixels.copyWithin(rowOffset, rowOffset + shiftBytes, rowOffset + bytesPerRow);
  }

  // 2. 逐行写入新列（确保每行都有数据，消除低频空白）
  const xStart = width - stripWidth;
  for (let row = 0; row < height; row++) {
    let db = -Infinity;
    const endBin = Math.min(rowBinEnd[row], spectrumDB.length - 1);
    for (let binIdx = rowBinStart[row]; binIdx <= endBin; binIdx++) {
      if (Number.isFinite(spectrumDB[binIdx]) && spectrumDB[binIdx] > db) db = spectrumDB[binIdx];
    }
    if (!Number.isFinite(db)) continue;

    const rampIdx = dbToRampIndex(db, dbMin, dbMax);
    const rIdx = rampIdx * 4;
    const r = RAMP_RGBA[rIdx];
    const g = RAMP_RGBA[rIdx + 1];
    const b = RAMP_RGBA[rIdx + 2];

    for (let dx = 0; dx < stripWidth; dx++) {
      const pixelOffset = (row * width + xStart + dx) * 4;
      pixels[pixelOffset] = r;
      pixels[pixelOffset + 1] = g;
      pixels[pixelOffset + 2] = b;
    }
  }
}

/**
 * 渲染频谱图 ImageData 到 Canvas
 * putImageData 不尊重 canvas transform（如 DPR scale），
 * 因此先写入逻辑尺寸的临时 canvas，再用 drawImage 缩放绘制。
 * @param {CanvasRenderingContext2D} ctx - 目标 2D 上下文（已应用 DPR scale）
 * @param {SpectrogramState} state - 频谱图状态
 * @param {object} [offscreenCanvas] - 逻辑尺寸的离屏 canvas（用于 putImageData 中转）
 * @param {number} [leftOffset=0] - 左侧偏移量（像素），用于为频率标签留出空间
 * @returns {void}
 */
function drawSpectrogramFrame(ctx, state, offscreenCanvas, leftOffset) {
  if (!state.imageData) return;
  const xOff = leftOffset || 0;
  if (offscreenCanvas) {
    const offCtx = offscreenCanvas.getContext('2d');
    offCtx.putImageData(state.imageData, 0, 0);
    ctx.drawImage(offscreenCanvas, 0, 0, state.width, state.height, xOff, 0, state.width, state.height);
  } else {
    ctx.putImageData(state.imageData, xOff, 0);
  }
}

/**
 * 绘制频谱图的频率轴标签（对数刻度）
 * @param {CanvasRenderingContext2D} ctx - 2D 上下文（已应用 DPR scale）
 * @param {SpectrogramState} state - 频谱图状态
 * @param {string} textColor - 标签颜色
 * @returns {void}
 */
function drawSpectrogramLabels(ctx, state, textColor) {
  const { height, dbMin, dbMax } = state;

  // 标准频率标签位置 (Hz)
  const labelFrequencies = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const fMin = 20;
  const fMax = FFT_CONFIG.NYQUIST;
  const logRatio = Math.log(fMax / fMin);

  const labelX = 34;
  const unitX = 16;

  ctx.fillStyle = textColor;
  ctx.font = '8px Arial';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const freq of labelFrequencies) {
    if (freq < fMin || freq > fMax) continue;

    const row = Math.round(
      (height - 1) * (1 - Math.log(freq / fMin) / logRatio)
    );

    let label;
    if (freq >= 1000) {
      label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
    } else {
      label = freq.toString();
    }

    ctx.fillText(label, labelX, row);
  }

  // 绘制单位
  ctx.font = '9px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Hz', unitX, height / 2);

  // 绘制 dB 色阶图例（右侧）
  const legendWidth = 10;
  const legendX = state.width - legendWidth - 6;
  const legendHeight = height - 20;
  const legendTop = 10;

  for (let i = 0; i < legendHeight; i++) {
    const db = dbMax - (i / legendHeight) * (dbMax - dbMin);
    const rampIdx = dbToRampIndex(db, dbMin, dbMax);
    const rIdx = rampIdx * 4;

    ctx.fillStyle = `rgb(${RAMP_RGBA[rIdx]},${RAMP_RGBA[rIdx + 1]},${RAMP_RGBA[rIdx + 2]})`;
    ctx.fillRect(legendX, legendTop + i, legendWidth, 1);
  }

  // 色阶标签
  ctx.fillStyle = textColor;
  ctx.font = '7px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${dbMax}dB`, legendX + legendWidth + 2, legendTop);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${dbMin}dB`, legendX + legendWidth + 2, legendTop + legendHeight);
}

/**
 * 清空频谱图（重置为黑色）
 * @param {SpectrogramState} state - 频谱图状态
 * @returns {void}
 */
function clearSpectrogram(state) {
  fillSpectrogramBackground(state);
}

function fillSpectrogramBackground(state) {
  if (!state || !state.pixels) return;
  const { pixels } = state;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = SPECTROGRAM_BG_RGBA[0];
    pixels[i + 1] = SPECTROGRAM_BG_RGBA[1];
    pixels[i + 2] = SPECTROGRAM_BG_RGBA[2];
    pixels[i + 3] = SPECTROGRAM_BG_RGBA[3];
  }
}

module.exports = {
  SPECTROGRAM_COLOR_RAMP,
  RAMP_RGBA,
  dbToRampIndex,
  createSpectrogramState,
  initSpectrogramImageData,
  appendSpectrogramColumn,
  drawSpectrogramFrame,
  drawSpectrogramLabels,
  clearSpectrogram,
};
