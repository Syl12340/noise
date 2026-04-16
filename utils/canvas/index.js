// utils/canvas/index.js
const { initCanvasFrontAsync, recordArrayPoint } = require('../canvas-base');
const { drawCanvasMesh, drawCanvasMark } = require('../canvas-grid');
const { drawWaveformFrame } = require('../canvas-wave');

module.exports = {
  initCanvasFrontAsync,
  recordArrayPoint,
  drawCanvasMesh,
  drawCanvasMark,
  drawWaveformFrame,
};
