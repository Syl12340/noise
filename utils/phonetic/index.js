// utils/phonetic/index.js
// 语音学分析算法库统一导出

const { PHONETIC_CONFIG } = require('./phonetic-config');
const { preEmphasis } = require('./pre-emphasis');
const { hammingWindow, segmentFrames, countFrames } = require('./frame-segment');
const { yinPitchFrame, yinPitchTrack } = require('./yin-pitch');
const { burgLPC } = require('./burg-lpc');
const { findRoots } = require('./poly-roots');
const { extractFormantsFromLPC, extractFormants, formantTrack } = require('./formant-extract');
const { generateSpectrogram } = require('./spectrogram-gen');
const { calculateHNR, calculatePitchPeriodVariability, calculateJitter, calculateIntensity } = require('./voice-metrics');
const { runTaskQueue } = require('./task-scheduler');

module.exports = {
  PHONETIC_CONFIG,
  preEmphasis,
  hammingWindow,
  segmentFrames,
  countFrames,
  yinPitchFrame,
  yinPitchTrack,
  burgLPC,
  findRoots,
  extractFormantsFromLPC,
  extractFormants,
  formantTrack,
  generateSpectrogram,
  calculateHNR,
  calculatePitchPeriodVariability,
  calculateJitter,
  calculateIntensity,
  runTaskQueue,
};
