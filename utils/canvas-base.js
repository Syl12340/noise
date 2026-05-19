// utils/canvas-base.js
/**
 * 异步初始化前景 Canvas 节点与 2D 绘图上下文。
 * 会自动按设备像素比重设画布尺寸，并将坐标系平移到指定基线位置。
 * @param {object} query - 由 `wx.createSelectorQuery()` 创建的查询实例。
 * @param {number} globalSize - 画布基线偏移值，用于 `ctx.translate(0, globalSize)`。
 * @param {string} [selectorId='#canvas-front'] - Canvas 节点选择器。
 * @returns {Promise<{canvas: object, ctx: object, dpr: number}>} 返回 canvas 节点、2D context 和设备像素比。
 * @throws {Error} 当未找到 Canvas 节点或执行过程中发生异常时抛出。
 */
function initCanvasFrontAsync(query, globalSize, selectorId = '#canvas-front') {
  return new Promise((resolve, reject) => {
    try {
      query.select(selectorId).fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('Canvas node not found'));
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        const baseline = Number.isFinite(globalSize) ? globalSize : Math.min(res[0].width, res[0].height);

        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;

        ctx.scale(dpr, dpr);
        ctx.translate(0, baseline);

        resolve({ canvas, ctx, dpr, baseline });
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 将当前秒级声压级写入波形缓存数组。
 * 第 1 秒的数据会同步补写到索引 0，确保折线从首点正确起始。
 * @param {Array<number>} targetArray - 用于存放波形数据的数组。
 * @param {number} currentTime - 当前秒数索引。
 * @param {number} dBSPL - 当前时刻的 Z 计权声压级。
 * @returns {void}
 * @description 该函数仅负责数组写入，不处理绘制或校验。
 */
function recordArrayPoint(targetArray, currentTime, dBSPL) {
  if (currentTime === 1) {
    targetArray[0] = dBSPL;
  }
  targetArray[currentTime] = dBSPL;
}

module.exports = {
  initCanvasFrontAsync,
  recordArrayPoint,
};
