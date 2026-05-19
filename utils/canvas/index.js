// utils/canvas/index.js
const { initCanvasFrontAsync, recordArrayPoint } = require('../canvas-base');
const { drawCanvasMesh, drawCanvasMark } = require('../canvas-grid');
const { drawWaveformFrame } = require('../canvas-wave');
const { computeThirdOctaveBands, drawSpectrumFrame } = require('../canvas-spectrum');
const {
  createSpectrogramState,
  initSpectrogramImageData,
  appendSpectrogramColumn,
  drawSpectrogramFrame,
  drawSpectrogramLabels,
  clearSpectrogram,
} = require('../canvas-spectrogram');

module.exports = {
  initCanvasFrontAsync,
  recordArrayPoint,
  drawCanvasMesh,
  drawCanvasMark,
  drawWaveformFrame,
  computeThirdOctaveBands,
  drawSpectrumFrame,
  createSpectrogramState,
  initSpectrogramImageData,
  appendSpectrogramColumn,
  drawSpectrogramFrame,
  drawSpectrogramLabels,
  clearSpectrogram,
};
