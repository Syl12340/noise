// utils/canvas-wave.js
/**
 * 绘制单帧波形：清屏、绘背景、按段渲染波形线。
 * @param {CanvasRenderingContext2D|object} ctx - 2D 绘图上下文。
 * @param {object} options - 波形绘制参数。
 * @param {number[]} options.clearRect - 清空区域，格式为 [x, y, width, height]。
 * @param {Function} options.drawBackground - 背景绘制回调，通常用于绘制网格与刻度。
 * @param {number} options.globalSize - 画布可视区域尺寸。
 * @param {number} options.scaleX - X 轴缩放比例。
 * @param {number} options.scaleY - Y 轴缩放比例。
 * @param {number} options.currentTime - 当前秒数索引。
 * @param {Array<number>} options.dBArray - 波形数据数组。
 * @param {Function} options.getStrokeColor - 获取每一段波形颜色的回调，签名为 `(currentDB, index) => string`。
 * @returns {void}
 * @description 该函数不管理数据，只负责把缓存数组绘制到 Canvas 上。
 */
function drawWaveformFrame(ctx, options) {
  const {
    clearRect,
    drawBackground,
    globalSize,
    scaleX,
    scaleY,
    currentTime,
    dBArray,
    getStrokeColor,
  } = options;

  if (Array.isArray(clearRect) && clearRect.length === 4) {
    ctx.clearRect(clearRect[0], clearRect[1], clearRect[2], clearRect[3]);
  }

  if (typeof drawBackground === 'function') {
    drawBackground();
  }

  const maxPoints = Math.floor(globalSize / scaleX);
  const startIdx = Math.max(1, currentTime - maxPoints + 1);
  const xOffset = currentTime <= maxPoints ? 0 : (currentTime - maxPoints) * scaleX;

  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let t = startIdx; t <= currentTime; t++) {
    const currentDB = dBArray[t];
    const previousDB = dBArray[t - 1];

    if (!Number.isFinite(currentDB) || !Number.isFinite(previousDB)) {
      continue;
    }

    const startX = (t - 1) * scaleX - xOffset;
    const endX = t * scaleX - xOffset;

    ctx.beginPath();
    ctx.strokeStyle = getStrokeColor(currentDB, t);
    ctx.moveTo(startX, -previousDB * scaleY);
    ctx.lineTo(endX, -currentDB * scaleY);
    ctx.stroke();
  }
}

module.exports = {
  drawWaveformFrame,
};
