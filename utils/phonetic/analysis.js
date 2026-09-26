// 前台与 Worker 共用流水线；长循环按帧让出事件循环。
const { PHONETIC_CONFIG: C } = require('./phonetic-config');
const { centeredSignal, inspectPcm } = require('../audio-quality');
const { resampleLowPassAsync, emphasizeFloat } = require('./resample');
const { yinPitchTrackAsync } = require('./yin-pitch');
const { formantTrackAsync } = require('./formant-extract');
const { estimateHarmonicityAsync } = require('./harmonicity');
const { generateSpectrogramAsync } = require('./spectrogram-gen');
const { calculateIntensity, calculatePitchPeriodVariability } = require('./voice-metrics');
const versions = require('../measurement-version');

function validateParameters(input = {}) {
  const parameters = { lpcOrder: 12, maxFormant: 5000, windowMs: 25, task: 'sustained', ...input };
  if (![8, 10, 12, 14].includes(parameters.lpcOrder)
    || ![4000, 4500, 5000].includes(parameters.maxFormant)
    || ![25, 40].includes(parameters.windowMs)
    || !['sustained', 'connected'].includes(parameters.task)) throw new Error('分析参数无效');
  return { lpcOrder: parameters.lpcOrder, maxFormant: parameters.maxFormant,
    windowMs: parameters.windowMs, task: parameters.task };
}

async function analyzePcm(pcm, sampleRate = C.SAMPLE_RATE, options = {}) {
  const parameters = validateParameters(options.parameters);
  if (!(pcm instanceof Int16Array) || !pcm.length || inspectPcm(pcm).clipped) throw new Error('录音为空或达到满幅');
  if (![12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)
    || pcm.length > C.MAX_RECORD_SEC * sampleRate) throw new Error('采样率或录音长度无效');
  const isCancelled = options.isCancelled || (() => false);
  const stage = (name, percent) => {
    if (isCancelled()) { const error = new Error('分析已取消'); error.name = 'AbortError'; throw error; }
    if (options.onProgress) options.onProgress(name, percent);
  };
  stage('去直流与抗混叠重采样', 5);
  const signal = centeredSignal(pcm);
  const rate = C.ANALYSIS_SAMPLE_RATE;
  const analysis = await resampleLowPassAsync(signal, sampleRate, rate, 5500, { isCancelled });
  const pitchOptions = { frameSize: C.PITCH_FRAME_SIZE, hopSize: C.ANALYSIS_HOP_SIZE,
    threshold: C.YIN_THRESHOLD, fmin: C.YIN_FMIN, fmax: C.YIN_FMAX, isCancelled };
  stage('提取基频', 25);
  const pitchTrack = await yinPitchTrackAsync(analysis, rate, pitchOptions);
  stage('计算音质', 45);
  const harmonicity = await estimateHarmonicityAsync(analysis, rate, pitchOptions);
  stage('比较共振峰模型', 60);
  const formantTracks = await formantTrackAsync(emphasizeFloat(analysis, C.PRE_EMPHASIS_COEFF), rate, {
    frameSize: Math.round(rate * parameters.windowMs / 1000), hopSize: C.ANALYSIS_HOP_SIZE,
    lpcOrder: parameters.lpcOrder, minFreq: C.FORMANT_MIN_FREQ, maxFreq: parameters.maxFormant,
    maxBandwidth: C.FORMANT_MAX_BW, pitchTrack, compareOrders: true, isCancelled,
  });
  stage('生成语谱图', 85);
  const spectrogram = await generateSpectrogramAsync(emphasizeFloat(signal, C.PRE_EMPHASIS_COEFF), sampleRate, {
    fftSize: C.SGRAM_FFT_SIZE, windowSec: C.SGRAM_WINDOW_SEC, hopSec: 0.002,
    dbMin: -80, dbMax: 0, isCancelled,
  });
  const intensityTrack = calculateIntensity(signal, sampleRate, Math.round(sampleRate * .025), Math.round(sampleRate * .01));
  stage('分析完成', 100);
  return { ...versions,
    formantStatus: { classification: 'experimental-candidates', quantitativeUseValidated: false,
      reason: 'Cross-model agreement does not establish accuracy; see the frozen synthetic validation report.' },
    parameters: { ...parameters, sampleRate, analysisRate: rate,
      pitchFrameSize: C.PITCH_FRAME_SIZE, hopSize: C.ANALYSIS_HOP_SIZE,
      fmin: C.YIN_FMIN, fmax: C.YIN_FMAX, minFundamentalRatio: 1.5, compareOrders: true },
    signal, sampleRate, duration: pcm.length / sampleRate, spectrogram, pitchTrack, formantTracks,
    intensityTrack, harmonicity, avgHNR: harmonicity.avgHNR,
    jitter: calculatePitchPeriodVariability(pitchTrack),
    coverage: { pitchTotal: pitchTrack.length, pitchAccepted: pitchTrack.filter(row => row.f0 > 0).length,
      formantTotal: formantTracks.length,
      formantsAccepted: ['F1', 'F2', 'F3'].map(key => formantTracks.filter(row => row[key].freq > 0).length) } };
}
module.exports = { analyzePcm, validateParameters };
