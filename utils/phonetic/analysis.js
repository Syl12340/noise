// 前台与 Worker 共用流水线；长循环按帧让出事件循环。
const { PHONETIC_CONFIG: C } = require('./phonetic-config');
const { centeredSignal, inspectPcm, PcmQualityInspector } = require('../audio-quality');
const { resampleLowPassAsync, emphasizeFloat } = require('./resample');
const { yinPitchTrackAsync } = require('./yin-pitch');
const { formantTrackAsync } = require('./formant-extract');
const { estimateHarmonicityAsync, summarizeHarmonicity } = require('./harmonicity');
const { generateSpectrogramAsync } = require('./spectrogram-gen');
const { calculateIntensity, calculatePitchPeriodVariability } = require('./voice-metrics');
const versions = require('../measurement-version');
const { addSupport } = require('./time-support');
const { summarizeCoverage } = require('./coverage');

function invalidateIntervals(track, intervals) {
  for (const row of track) if (row.support && intervals.some(interval =>
    row.support.start < interval.end && row.support.end > interval.start)) {
    if ('f0' in row) row.f0 = 0;
    if ('db' in row) row.db = null;
    if (row.F1) {
      for (const key of ['F1', 'F2', 'F3']) row[key] = { freq: 0, bandwidth: 0 };
      row.exploratory = {};
    }
    row.reason = 'clipped-input';
  }
}

function validateParameters(input = {}) {
  const parameters = { lpcOrder: 12, maxFormant: 5000, windowMs: 25, task: 'sustained', ...input };
  if (![8, 10, 12, 14].includes(parameters.lpcOrder)
    || ![4000, 4500, 5000, 5500, 6000, 7000, 8000].includes(parameters.maxFormant)
    || ![25, 40].includes(parameters.windowMs)
    || !['sustained', 'connected'].includes(parameters.task)) throw new Error('分析参数无效');
  return { lpcOrder: parameters.lpcOrder, maxFormant: parameters.maxFormant,
    windowMs: parameters.windowMs, task: parameters.task };
}

function validateCaptureLength(sampleCount, sampleRate) {
  return Number.isInteger(sampleCount) && sampleCount > 0
    && Number.isFinite(sampleRate) && sampleRate > 0
    && sampleCount <= (C.MAX_RECORD_SEC + C.CAPTURE_END_TOLERANCE_SEC) * sampleRate;
}

async function analyzePcm(pcm, sampleRate = C.SAMPLE_RATE, options = {}) {
  const parameters = validateParameters(options.parameters);
  if (!(pcm instanceof Int16Array) || !pcm.length) throw new Error('录音为空');
  if (![12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)
    || !validateCaptureLength(pcm.length, sampleRate)) throw new Error('采样率或录音长度无效');
  if (parameters.maxFormant + 1000 > sampleRate / 2) throw new Error('共振峰上限超出输入采样率支持的频带');
  const cuts = Array.from(new Set((Array.isArray(options.discontinuityBoundariesSeconds) ? options.discontinuityBoundariesSeconds : [])
    .filter(value => Number.isFinite(value) && value > 0 && value < pcm.length / sampleRate)
    .map(value => Math.round(value * sampleRate)).filter(value => value > 0 && value < pcm.length))).sort((a, b) => a - b);
  if (cuts.length) return analyzeSegments(pcm, sampleRate, options, cuts);
  const inputQuality = inspectPcm(pcm, new PcmQualityInspector(sampleRate));
  const invalidIntervals = inputQuality.clippingEvidence.intervals;
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
  addSupport(pitchTrack, C.PITCH_FRAME_SIZE / rate, 128 / sampleRate);
  for (const row of pitchTrack) if (row.support.start < 0 || row.support.end > pcm.length / sampleRate) {
    row.f0 = 0; row.reason = 'incomplete-filter-support';
  }
  invalidateIntervals(pitchTrack, invalidIntervals);
  stage('计算音质', 45);
  const harmonicity = await estimateHarmonicityAsync(analysis, rate, {
    ...pitchOptions,
    pitchTrack,
    requirePitch: true,
    minPeakCorrelation: 0.2,
  });
  stage('比较共振峰模型', 60);
  // maximum formant 同时控制 LPC 输入带宽与采样率。Nyquist 在目标
  // ceiling 上方保留 1 kHz 保护带，供有限长抗混叠滤波器完成过渡。
  const formantRate = 2 * (parameters.maxFormant + 1000);
  const formantSignal = await resampleLowPassAsync(signal, sampleRate, formantRate,
    parameters.maxFormant + 500, { isCancelled });
  const preEmphasisFrequencyHz = -Math.log(C.PRE_EMPHASIS_COEFF)
    * C.ANALYSIS_SAMPLE_RATE / (2 * Math.PI);
  const preEmphasisCoefficient = Math.exp(-2 * Math.PI * preEmphasisFrequencyHz / formantRate);
  // 同一阶数在更窄的拟合频带中会提高极点密度并增加伪峰；随采样率
  // 缩放阶数，使界面阶数表示 12 kHz 基准下的模型复杂度。
  const effectiveFormantOrder = Math.max(4,
    Math.round(parameters.lpcOrder * formantRate / C.ANALYSIS_SAMPLE_RATE));
  const formantTracks = await formantTrackAsync(emphasizeFloat(formantSignal, preEmphasisCoefficient), formantRate, {
    frameSize: Math.round(formantRate * parameters.windowMs / 1000),
    hopSize: Math.round(formantRate * 0.01),
    lpcOrder: effectiveFormantOrder, minFreq: C.FORMANT_MIN_FREQ, maxFreq: parameters.maxFormant,
    maxBandwidth: C.FORMANT_MAX_BW, pitchTrack, compareOrders: true, isCancelled,
    filterMarginSeconds: 128 / sampleRate + 1 / formantRate,
  });
  stage('生成语谱图', 85);
  const spectrogram = await generateSpectrogramAsync(emphasizeFloat(signal, C.PRE_EMPHASIS_COEFF), sampleRate, {
    fftSize: C.SGRAM_FFT_SIZE, windowSec: C.SGRAM_WINDOW_SEC, hopSec: 0.002,
    dbMin: -80, dbMax: 0, isCancelled,
  });
  const intensityTrack = calculateIntensity(signal, sampleRate, Math.round(sampleRate * .025), Math.round(sampleRate * .01));
  const pitchWindowSeconds = C.PITCH_FRAME_SIZE / rate;
  const lpcWindowSeconds = Math.round(formantRate * parameters.windowMs / 1000) / formantRate;
  // Per-row support includes the actual chosen pitch window. Tracking decision
  // context is separately recorded, and may extend back to the segment start.
  addSupport(intensityTrack, Math.round(sampleRate * .025) / sampleRate);
  addSupport(harmonicity.track, pitchWindowSeconds, 128 / sampleRate);
  for (const track of [formantTracks, intensityTrack, harmonicity.track]) invalidateIntervals(track, invalidIntervals);
  Object.assign(harmonicity, summarizeHarmonicity(harmonicity.track, C.ANALYSIS_HOP_SIZE / rate));

  stage('分析完成', 100);
  const result = { ...versions,
    formantStatus: { classification: 'experimental-candidates', quantitativeUseValidated: false,
      reason: 'Cross-model agreement does not establish accuracy; see the frozen synthetic validation report.' },
    parameters: { ...parameters, sampleRate, analysisRate: rate,
      formantAnalysisRate: formantRate, formantGuardBandHz: 1000,
      preEmphasisFrequencyHz, effectiveFormantOrder,
      formantInputWindowSeconds: lpcWindowSeconds, formantTrackingContext: 'since-last-tracker-reset',
       hnrLowpassHz: 5500, hnrAnalysisRate: rate, hnrFrameSeconds: C.PITCH_FRAME_SIZE / rate,
       hnrCorrelationMethod: 'normalized-fractional-delay-sinc-129', hnrInterpolationHalfSamples: 64,
      nominalRecordingSeconds: C.MAX_RECORD_SEC, captureEndToleranceSeconds: C.CAPTURE_END_TOLERANCE_SEC,
      pitchFrameSize: C.PITCH_FRAME_SIZE, hopSize: C.ANALYSIS_HOP_SIZE,
      fmin: C.YIN_FMIN, fmax: C.YIN_FMAX, minFundamentalRatio: 1.5, compareOrders: true,
      discontinuityBoundariesSeconds: [] },
    signal, sampleRate, duration: pcm.length / sampleRate, spectrogram, pitchTrack, formantTracks,
    inputQuality, invalidIntervals,
    intensityTrack, harmonicity, avgHNR: harmonicity.avgHNR,
    jitter: inputQuality.clipped ? null : calculatePitchPeriodVariability(pitchTrack),
    coverage: summarizeCoverage(pcm.length, sampleRate, parameters, pitchTrack, formantTracks,
      [{ startSample: 0, endSample: pcm.length, status: 'analyzed' }]) };
  if (options.includeSensitivity) await require('./model-sensitivity').assessModelSensitivity(pcm, sampleRate, result, options, analyzePcm);
  return result;
}

async function analyzeSegments(pcm, sampleRate, options, cuts) {
  const endpoints = [0, ...cuts, pcm.length];
  const pieces = [];
  const analysisSegments = [];
  const signal = new Float32Array(pcm.length);
  for (let i = 0; i + 1 < endpoints.length; i++) {
    const start = endpoints[i], end = endpoints[i + 1];
    const segment = { start: start / sampleRate, end: end / sampleRate, startSample: start, endSample: end, status: 'analyzed' };
    analysisSegments.push(segment);
    let result;
    try { result = await analyzePcm(pcm.subarray(start, end), sampleRate, {
      ...options, discontinuityBoundariesSeconds: [],
      onProgress: options.onProgress ? (name, percent) => options.onProgress(name,
        Math.round((start + (end - start) * percent / 100) / pcm.length * 100)) : undefined,
    }); } catch (error) {
      if (error.name === 'AbortError' || options.isCancelled && options.isCancelled()) throw error;
      segment.status = 'failed'; segment.reason = 'segment-analysis-failure';
      // Preserve received PCM for browsing, but do not include this interval in quantitative summaries.
      signal.set(centeredSignal(pcm.subarray(start, end)), start);
      continue;
    }
    signal.set(result.signal, start);
    if (result.modelSensitivity) segment.modelSensitivity = result.modelSensitivity;
    const shift = start / sampleRate;
    for (const track of [result.pitchTrack, result.formantTracks, result.intensityTrack, result.harmonicity.track]) {
      for (const row of track) {
        row.time += shift;
        row.segmentIndex = i;
        for (const model of row.sensitivityModels || []) if (Number.isFinite(model.time)) model.time += shift;
        for (const key of ['support', 'decisionSupport']) if (row[key]) {
          row[key].start += shift; row[key].end += shift;
        }
        if (row.support && (row.support.start < shift || row.support.end > end / sampleRate)) {
          if ('f0' in row) row.f0 = 0;
          if ('db' in row) row.db = null;
          if (row.F1) {
            for (const key of ['F1', 'F2', 'F3']) row[key] = { freq: 0, bandwidth: 0 };
            row.exploratory = {};
          }
          row.reason = 'capture-gap-boundary';
        }
      }
    }
    result.spectrogram.times = Float64Array.from(result.spectrogram.times, time => time + shift);
    result.invalidIntervals = result.invalidIntervals.map(interval => ({ start: interval.start + shift, end: interval.end + shift }));
    pieces.push(result);
  }
  if (!pieces.length) throw new Error('所有片段均分析失败，可重新录制');
  const first = pieces[0];
  const pitchTrack = pieces.flatMap(piece => piece.pitchTrack);
  const formantTracks = pieces.flatMap(piece => piece.formantTracks);
  const hnrTrack = pieces.flatMap(piece => piece.harmonicity.track);
  const harmonicity = { track: hnrTrack,
    signalFrames: pieces.reduce((sum, piece) => sum + piece.harmonicity.signalFrames, 0),
    cappedFrames: pieces.reduce((sum, piece) => sum + piece.harmonicity.cappedFrames, 0),
    ...summarizeHarmonicity(hnrTrack, C.ANALYSIS_HOP_SIZE / C.ANALYSIS_SAMPLE_RATE) };
  const data = pieces.flatMap(piece => piece.spectrogram.data);
  return { ...first, signal, duration: pcm.length / sampleRate, pitchTrack, formantTracks,
    intensityTrack: pieces.flatMap(piece => piece.intensityTrack), harmonicity, avgHNR: harmonicity.avgHNR,
    // Missing-sample timing is unknown; never infer continuity for perturbation metrics.
    jitter: null,
    parameters: { ...first.parameters, discontinuityBoundariesSeconds: cuts.map(cut => cut / sampleRate),
      discontinuityPolicy: 'segment-before-dsp', timeAxis: 'received-samples' },
    analysisSegments,
    modelSensitivity: options.includeSensitivity ? { classification: 'experimental',
      downgraded: pieces.reduce((sum, piece) => sum + (piece.modelSensitivity ? piece.modelSensitivity.downgraded : 0), 0),
      segments: analysisSegments.map((segment, index) => ({ segmentIndex: index, start: segment.start,
        end: segment.end, status: segment.status, ...segment.modelSensitivity })) } : undefined,
    invalidIntervals: [...pieces.flatMap(piece => piece.invalidIntervals), ...analysisSegments.filter(segment => segment.status === 'failed')],
    inputQuality: { clipped: pieces.some(piece => piece.inputQuality.clipped),
      plateauSuspected: pieces.some(piece => piece.inputQuality.plateauSuspected),
      failedSegments: analysisSegments.filter(segment => segment.status === 'failed').length },
    spectrogram: { ...first.spectrogram, data, width: data.length,
      times: Float64Array.from(pieces.flatMap(piece => Array.from(piece.spectrogram.times))) },
    coverage: summarizeCoverage(pcm.length, sampleRate, first.parameters, pitchTrack, formantTracks, analysisSegments) };
}
module.exports = { analyzePcm, validateParameters, validateCaptureLength };
