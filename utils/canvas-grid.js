const { CANVAS_CONFIG } = require('./constants');

// utils/canvas-grid.js
/**
 * 绘制 Canvas 背景网格与可选阈值线。
 * @param {CanvasRenderingContext2D|object} ctx - 2D 绘图上下文。
 * @param {object} options - 绘制参数。
 * @param {number} options.leftBoundary - 网格左边界 X 坐标。
 * @param {number} options.rightBoundary - 网格右边界 X 坐标。
 * @param {number} options.thresholdLine - 阈值线对应的 dB 值。
 * @param {boolean} options.thresholdVisible - 是否绘制阈值线。
 * @param {number} options.scaleY - Y 轴缩放比例。
 * @param {string} options.gridColor - 网格线颜色。
 * @param {string} options.primaryColor - 阈值线颜色。
 * @param {number} options.thresholdLineWidth - 阈值线宽度。
 * @returns {void}
 */
function drawCanvasMesh(ctx, options) {
  const {
    leftBoundary,
    rightBoundary,
    thresholdLine,
    thresholdVisible,
    scaleY,
    gridColor,
    primaryColor,
    thresholdLineWidth,
  } = options;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.2;
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let db = 0; db <= 130; db += 10) {
    const y = db * scaleY;
    ctx.moveTo(leftBoundary, -y);
    ctx.lineTo(rightBoundary, -y);
  }
  ctx.stroke();

  if (thresholdVisible) {
    ctx.beginPath();
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = thresholdLineWidth;
    ctx.setLineDash([5, 3]);
    const targetY = thresholdLine * scaleY;
    ctx.moveTo(leftBoundary, -targetY);
    ctx.lineTo(rightBoundary, -targetY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * 绘制 Canvas 坐标轴文字与刻度值。
 * @param {CanvasRenderingContext2D|object} ctx - 2D 绘图上下文。
 * @param {object} options - 标注参数。
 * @param {number} options.globalSize - 画布全局尺寸。
 * @param {number} options.scaleY - Y 轴缩放比例。
 * @param {number} options.thresholdLine - 阈值线对应的 dB 值。
 * @param {boolean} options.thresholdVisible - 是否显示阈值文字。
 * @param {string} options.neutralColor - 默认文字颜色。
 * @param {string} options.primaryColor - 阈值文字颜色。
 * @returns {void}
 */
function drawCanvasMark(ctx, options) {
  const {
    globalSize,
    scaleY,
    thresholdLine,
    thresholdVisible,
    neutralColor,
    primaryColor,
  } = options;
  const axisPadding = CANVAS_CONFIG.AXIS_PADDING;

  ctx.fillStyle = neutralColor;
  ctx.font = '10px Arial';

  ctx.textAlign = 'left';
  ctx.fillText('SPL [dB(Z)]', axisPadding.LEFT, -globalSize + axisPadding.TOP + 6);

  ctx.textAlign = 'right';
  for (let db = 130; db >= 0; db -= 10) {
    const y = db * scaleY;
    ctx.fillText(`${db}`, globalSize - axisPadding.RIGHT, -y + 3);
  }

  if (thresholdVisible) {
    ctx.fillStyle = primaryColor;
    ctx.fillText(`${thresholdLine}`, globalSize - axisPadding.RIGHT, -(thresholdLine * scaleY) + 3);
  }
}

module.exports = {
  drawCanvasMesh,
  drawCanvasMark,
};
