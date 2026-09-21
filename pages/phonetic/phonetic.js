// pages/phonetic/phonetic.js
// 语音学分析页面：录音 → 主线程分步分析 → Canvas 渲染语谱图/共振峰/基频
// 注：Worker API 在部分环境不可用，改为录音完成后在主线程分步执行分析

const { PHONETIC_CONFIG } = require('../../utils/phonetic/phonetic-config');
const { preEmphasis } = require('../../utils/phonetic/pre-emphasis');
const { yinPitchTrack } = require('../../utils/phonetic/yin-pitch');
const { formantTrack } = require('../../utils/phonetic/formant-extract');
const { generateSpectrogram } = require('../../utils/phonetic/spectrogram-gen');
const { calculateHNR, calculatePitchPeriodVariability, calculateIntensity } = require('../../utils/phonetic/voice-metrics');
const { runTaskQueue } = require('../../utils/phonetic/task-scheduler');
const {
  safeStartRecorder,
  safeStopRecorder,
  bindRecorderFrameListener,
  clearRecorderFrameListener,
} = require('../../utils/recorder-session');
const { THEME_COLORS, CANVAS_CONFIG } = require('../../utils/constants');

const SAMPLE_RATE = PHONETIC_CONFIG.SAMPLE_RATE;
const MAX_DURATION = PHONETIC_CONFIG.MAX_RECORD_SEC * 1000;

const recordParams = {
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 1,
  encodeBitRate: SAMPLE_RATE * 2,
  format: 'PCM',
  frameSize: 16,
  audioSource: 'camcorder',
  duration: MAX_DURATION,
};

let pcmChunks = [];
let totalSamples = 0;
let isRecording = false;
let canvasSpectrogram = null, ctxSpectrogram = null;
let canvasOverlay = null, ctxOverlay = null;
let analysisResult = null;
let cachedSpectrogramImage = null; // OffscreenCanvas 缓存，避免切回时重算
let cachedSpectrogramSize = null;
let dragStartX = null;
let dragEndX = null;
let isDragging = false;
let currentPhoneticPage = null;
let analysisGeneration = 0;

// F2 共振峰颜色（橙色，主题变量中无对应项）
const F2_COLOR = '#FF8800';

const recorderManager = wx.getRecorderManager();

Page({
  data: {
    state: 'idle',
    recordTime: 0,
    progress: 0,
    progressStage: '',
    f0: '--',
    f1: '--',
    f2: '--',
    f3: '--',
    hnr: '--',
    jitter: '--',
    intensity: '--',
    selectedTime: null,
    viewMode: 'spectrogram',
    selectionStart: null,
    selectionEnd: null,
    selDuration: '--',
    selMeanF0: '--',
    selMaxIntensity: '--',
  },

  onUnload() {
    this.cleanup();
  },

  onHide() {
    if (isRecording) this.stopRecording();
  },

  bindRecorderLifecycleListeners() {
    this.clearRecorderLifecycleListeners();

    this._stopListener = () => {
      if (!isRecording || currentPhoneticPage !== this) return;
      isRecording = false;
      this.clearRecorderLifecycleListeners();
      this.onRecordingComplete();
    };
    this._interruptionEndListener = () => {
      if (!isRecording || currentPhoneticPage !== this) return;
      isRecording = false;
      this.clearRecorderLifecycleListeners();
      this.onRecordingComplete();
    };
    this._errorListener = (error) => {
      if (currentPhoneticPage !== this) return;
      console.error('[phonetic-recording] failed:', error);
      isRecording = false;
      if (this._recordTimer) {
        clearInterval(this._recordTimer);
        this._recordTimer = null;
      }
      clearRecorderFrameListener(recorderManager);
      this.clearRecorderLifecycleListeners();
      this.setData({ state: 'idle', recordTime: 0 });
      wx.showToast({ title: '录音启动失败，请检查权限', icon: 'none' });
    };

    recorderManager.onStop(this._stopListener);
    recorderManager.onInterruptionEnd(this._interruptionEndListener);
    if (typeof recorderManager.onError === 'function') {
      recorderManager.onError(this._errorListener);
    }
  },

  clearRecorderLifecycleListeners() {
    if (this._stopListener && typeof recorderManager.offStop === 'function') {
      recorderManager.offStop(this._stopListener);
    }
    if (this._interruptionEndListener && typeof recorderManager.offInterruptionEnd === 'function') {
      recorderManager.offInterruptionEnd(this._interruptionEndListener);
    }
    if (this._errorListener && typeof recorderManager.offError === 'function') {
      recorderManager.offError(this._errorListener);
    }
    this._stopListener = null;
    this._interruptionEndListener = null;
    this._errorListener = null;
  },

  startRecording() {
    analysisGeneration++;
    currentPhoneticPage = this;
    pcmChunks = [];
    totalSamples = 0;
    analysisResult = null;
    isRecording = false;

    const frameListenerBound = bindRecorderFrameListener(recorderManager, (res) => {
      if (!isRecording) return;
      const buffer = new Int16Array(res.frameBuffer);
      pcmChunks.push(new Int16Array(buffer));
      totalSamples += buffer.length;
    });
    if (!frameListenerBound) {
      wx.showToast({ title: '无法监听录音数据', icon: 'none' });
      return;
    }

    this.bindRecorderLifecycleListeners();
    const startResult = safeStartRecorder(recorderManager, recordParams);
    if (startResult === false) {
      clearRecorderFrameListener(recorderManager);
      this.clearRecorderLifecycleListeners();
      this.setData({ state: 'idle', recordTime: 0 });
      wx.showToast({ title: '录音启动失败，请检查权限', icon: 'none' });
      return;
    }

    isRecording = true;
    this.setData({
      state: 'recording',
      recordTime: 0,
      progress: 0,
      progressStage: '',
      f0: '--', f1: '--', f2: '--', f3: '--',
      hnr: '--', jitter: '--', intensity: '--',
      selectedTime: null,
    });
    this._recordTimer = setInterval(() => {
      if (!isRecording) return;
      const t = this.data.recordTime + 0.1;
      this.setData({ recordTime: Math.round(t * 10) / 10 });
      if (t >= PHONETIC_CONFIG.MAX_RECORD_SEC) this.stopRecording();
    }, 100);
  },

  stopRecording() {
    if (!isRecording) return;
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
  },

  /**
   * 录音完成后在主线程分步执行分析。
   * 使用 setTimeout 分步让出主线程，使进度 UI 得以更新。
   */
  onRecordingComplete() {
    if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
    clearRecorderFrameListener(recorderManager);

    if (totalSamples === 0) {
      wx.showToast({ title: '未采集到音频数据', icon: 'none' });
      this.setData({ state: 'idle' });
      return;
    }

    this.setData({ state: 'analyzing', progress: 5, progressStage: '合并音频数据...' });

    // 合并 PCM 块
    const pcm = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of pcmChunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    pcmChunks = [];

    const sampleRate = SAMPLE_RATE;
    const duration = pcm.length / sampleRate;

    // 基于 Promise 任务队列的分步分析
    const generation = ++analysisGeneration;
    const isCancelled = () => generation !== analysisGeneration || currentPhoneticPage !== this;
    let rawSignal, signal, pitchTrack;

    runTaskQueue([
      {
        name: '预加重处理...', weight: 10,
        fn: () => {
          rawSignal = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) {
            rawSignal[i] = pcm[i] / 32768.0;
          }
          signal = preEmphasis(pcm, PHONETIC_CONFIG.PRE_EMPHASIS_COEFF);
        },
      },
      {
        name: '计算声强...', weight: 15,
        fn: () => calculateIntensity(rawSignal, sampleRate, PHONETIC_CONFIG.FRAME_SIZE, PHONETIC_CONFIG.HOP_SIZE),
      },
      {
        name: '基频提取...', weight: 25,
        fn: () => {
          pitchTrack = yinPitchTrack(signal, sampleRate, {
            frameSize: PHONETIC_CONFIG.PITCH_FRAME_SIZE,
            hopSize: PHONETIC_CONFIG.HOP_SIZE,
            threshold: PHONETIC_CONFIG.YIN_THRESHOLD,
            fmin: PHONETIC_CONFIG.YIN_FMIN,
            fmax: PHONETIC_CONFIG.YIN_FMAX,
          });
          return pitchTrack;
        },
      },
      {
        name: '音质分析...', weight: 15,
        fn: () => {
          const hnrValues = pitchTrack
            .filter(pt => pt.f0 > 0 && pt.aperiodicity > 0 && pt.aperiodicity < 1)
            .map(pt => calculateHNR(pt.aperiodicity));
          const avgHNR = hnrValues.length > 0
            ? hnrValues.reduce((a, b) => a + b, 0) / hnrValues.length
            : null;
          const jitter = calculatePitchPeriodVariability(pitchTrack);
          return { avgHNR, jitter };
        },
      },
      {
        name: '共振峰提取...', weight: 20,
        fn: () => formantTrack(signal, sampleRate, {
          frameSize: PHONETIC_CONFIG.FRAME_SIZE,
          hopSize: PHONETIC_CONFIG.HOP_SIZE,
          lpcOrder: PHONETIC_CONFIG.LPC_ORDER,
          minFreq: PHONETIC_CONFIG.FORMANT_MIN_FREQ,
          maxFreq: PHONETIC_CONFIG.FORMANT_MAX_FREQ,
          maxBandwidth: PHONETIC_CONFIG.FORMANT_MAX_BW,
        }),
      },
      {
        name: '生成语谱图...', weight: 15,
        fn: () => generateSpectrogram(signal, sampleRate, {
          fftSize: PHONETIC_CONFIG.SGRAM_FFT_SIZE,
          windowSec: PHONETIC_CONFIG.SGRAM_WINDOW_SEC,
          hopSec: 0.002,
          dbMin: -80,
          dbMax: 0,
        }),
      },
    ], (stage, percent) => {
      if (!isCancelled()) {
        this.setData({ progress: percent, progressStage: stage });
      }
    }, { isCancelled }).then(([_, intensityTrack, __, voiceMetrics, formantTracks, spectrogram]) => {
      if (isCancelled()) return;
      analysisResult = {
        spectrogram, pitchTrack, formantTracks, intensityTrack, duration, signal,
        avgHNR: voiceMetrics.avgHNR, jitter: voiceMetrics.jitter,
      };
      this.setData({
        state: 'result', progress: 100, progressStage: '分析完成',
        hnr: Number.isFinite(voiceMetrics.avgHNR) ? voiceMetrics.avgHNR.toFixed(1) : '--',
        jitter: Number.isFinite(voiceMetrics.jitter) ? (voiceMetrics.jitter * 100).toFixed(2) : '--',
      });
      this.renderResult();
    }).catch((error) => {
      if (error && error.name === 'AbortError') return;
      console.error('[phonetic-analysis] failed:', error);
      this.setData({ state: 'idle', progress: 0, progressStage: '' });
      wx.showToast({ title: '分析失败，请重新录音', icon: 'none' });
    });
  },

  initSpectrogramCanvas(callback, retries) {
    retries = retries || 0;
    const query = wx.createSelectorQuery();
    query.select('#canvas-spectrogram').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        if (retries < 3) { setTimeout(() => this.initSpectrogramCanvas(callback, retries + 1), 200); }
        return;
      }
      canvasSpectrogram = res[0].node;
      ctxSpectrogram = canvasSpectrogram.getContext('2d');
      const dpr = wx.getWindowInfo().pixelRatio;
      canvasSpectrogram.width = res[0].width * dpr;
      canvasSpectrogram.height = res[0].height * dpr;
      ctxSpectrogram.scale(dpr, dpr);
      ctxSpectrogram.imageSmoothingEnabled = false;
      this._sgWidth = res[0].width;
      this._sgHeight = res[0].height;
      if (callback) callback();
    });
  },

  initOverlayCanvas(callback, retries) {
    retries = retries || 0;
    const query = wx.createSelectorQuery();
    query.select('#canvas-overlay').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        if (retries < 3) { setTimeout(() => this.initOverlayCanvas(callback, retries + 1), 200); }
        return;
      }
      canvasOverlay = res[0].node;
      ctxOverlay = canvasOverlay.getContext('2d');
      const dpr = wx.getWindowInfo().pixelRatio;
      canvasOverlay.width = res[0].width * dpr;
      canvasOverlay.height = res[0].height * dpr;
      ctxOverlay.scale(dpr, dpr);
      if (callback) callback();
    });
  },

  renderResult() {
    this.initSpectrogramCanvas(() => {
      this.initOverlayCanvas(() => {
        this.drawSpectrogram();
        this.drawOverlay();
        this.updateValueCards(0);
      });
    });
  },

  drawSpectrogram() {
    if (!analysisResult || !ctxSpectrogram) return;
    const { spectrogram } = analysisResult;
    const { data, width, height } = spectrogram;
    const canvasW = this._sgWidth;
    const canvasH = this._sgHeight;
    const plotLeft = 34;
    const plotRight = canvasW - 10;
    const plotWidth = Math.max(1, plotRight - plotLeft);

    const offCanvas = wx.createOffscreenCanvas({ type: '2d', width: plotWidth, height: canvasH });
    const offCtx = offCanvas.getContext('2d');
    offCtx.imageSmoothingEnabled = false;
    const imageData = offCtx.createImageData(plotWidth, canvasH);
    const pixels = imageData.data;

    const fMin = 50;
    const fMax = SAMPLE_RATE / 2;
    const logRatio = Math.log(fMax / fMin);

    for (let px = 0; px < plotWidth; px++) {
      const frameIdx = Math.floor((px / plotWidth) * width);
      if (frameIdx >= data.length) continue;
      const spectrum = data[frameIdx];
      for (let py = 0; py < canvasH; py++) {
        const freqRatio = 1 - py / canvasH;
        const freq = fMin * Math.exp(freqRatio * logRatio);
        const binIdx = Math.floor((freq / fMax) * (height - 1));
        const clampedBin = Math.max(0, Math.min(height - 1, binIdx));
        const intensity = spectrum[clampedBin];
        // Praat 惯例：白底=静音，深色=高能量
        const gray = Math.floor((1 - intensity) * 255);
        const lowFreqThickness = clampedBin < Math.round(height * 0.18) ? 2 : 1;
        for (let dy = 0; dy < lowFreqThickness; dy++) {
          const writeY = Math.min(canvasH - 1, py + dy);
          const pixelOffset = (writeY * plotWidth + px) * 4;
          pixels[pixelOffset] = gray;
          pixels[pixelOffset + 1] = gray;
          pixels[pixelOffset + 2] = gray;
          pixels[pixelOffset + 3] = 255;
        }
      }
    }

    offCtx.putImageData(imageData, 0, 0);
    ctxSpectrogram.clearRect(0, 0, canvasW, canvasH);
    ctxSpectrogram.imageSmoothingEnabled = false;
    ctxSpectrogram.drawImage(offCanvas, plotLeft, 0);
    this.drawSpectrogramLabels(canvasW, canvasH, fMin, fMax, ctxSpectrogram);
    cachedSpectrogramImage = offCanvas;
    cachedSpectrogramSize = { width: canvasW, height: canvasH };
  },

  drawSpectrogramLabels(w, h, fMin, fMax, ctx) {
    if (!ctx) ctx = ctxSpectrogram;
    if (!ctx) return;
    ctx.fillStyle = THEME_COLORS.NEUTRAL;
    ctx.font = '10px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const labelFreqs = [100, 200, 500, 1000, 2000, 4000];
    const logRatio = Math.log(fMax / fMin);
    for (const freq of labelFreqs) {
      if (freq < fMin || freq > fMax) continue;
      const y = h * (1 - Math.log(freq / fMin) / logRatio);
      const label = freq >= 1000 ? (freq / 1000) + 'k' : freq.toString();
      ctx.fillText(label, 30, y);
      ctx.strokeStyle = THEME_COLORS.GRID;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(34, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();
    }

    if (analysisResult) {
      const dur = analysisResult.duration;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const timeStep = dur <= 2 ? 0.5 : 1;
      for (let t = 0; t <= dur; t += timeStep) {
        const x = 34 + (t / dur) * (w - 44);
        ctx.fillText(t.toFixed(1) + 's', x, h + 4);
      }
    }

    ctx.fillStyle = THEME_COLORS.NEUTRAL;
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Hz', 14, h / 2);
  },

  drawOverlay() {
    if (!analysisResult || !ctxOverlay) return;
    const w = this._sgWidth;
    const h = this._sgHeight;
    const { duration, pitchTrack, formantTracks, intensityTrack } = analysisResult;
    ctxOverlay.clearRect(0, 0, w, h);

    const fMin = 50;
    const fMax = SAMPLE_RATE / 2;
    const logRatio = Math.log(fMax / fMin);
    const plotLeft = 34;
    const plotRight = w - 10;
    const plotWidth = plotRight - plotLeft;

    const freqToY = (freq) => {
      if (freq <= 0 || freq < fMin) return h;
      return h * (1 - Math.log(Math.min(freq, fMax) / fMin) / logRatio);
    };
    const timeToX = (time) => plotLeft + (time / duration) * plotWidth;

    // 声强包络线（亮黄色平滑线，映射到画布下方 40% 区域）
    if (intensityTrack && intensityTrack.length > 1) {
      const intensityToY = (db) => {
        const norm = Math.max(0, Math.min(1, (db + 80) / 80));
        return h * (0.6 + 0.4 * (1 - norm));
      };
      ctxOverlay.strokeStyle = '#FFD700';
      ctxOverlay.lineWidth = 1.2;
      ctxOverlay.globalAlpha = 0.6;
      ctxOverlay.beginPath();
      let iStarted = false;
      for (const pt of intensityTrack) {
        const x = timeToX(pt.time);
        const y = intensityToY(pt.db);
        if (!iStarted) { ctxOverlay.moveTo(x, y); iStarted = true; }
        else ctxOverlay.lineTo(x, y);
      }
      ctxOverlay.stroke();
      ctxOverlay.globalAlpha = 1;
    }

    // 基频曲线
    ctxOverlay.strokeStyle = THEME_COLORS.SAFE_ASSIST;
    ctxOverlay.lineWidth = 1.5;
    ctxOverlay.beginPath();
    let started = false;
    for (const pt of pitchTrack) {
      if (pt.f0 <= 0) { started = false; continue; }
      const x = timeToX(pt.time);
      const y = freqToY(pt.f0);
      if (!started) { ctxOverlay.moveTo(x, y); started = true; }
      else ctxOverlay.lineTo(x, y);
    }
    ctxOverlay.stroke();

    // 共振峰轨迹（连线 + 节点，Praat 标准显示方式）
    const formantColors = [THEME_COLORS.PRIMARY, F2_COLOR, THEME_COLORS.WARN];
    const formantKeys = ['F1', 'F2', 'F3'];
    for (let fi = 0; fi < 3; fi++) {
      const color = formantColors[fi];

      // 连线
      ctxOverlay.strokeStyle = color;
      ctxOverlay.lineWidth = 1.2;
      ctxOverlay.beginPath();
      let lineStarted = false;
      for (const ft of formantTracks) {
        const formant = ft[formantKeys[fi]];
        if (!formant || formant.freq <= 0) { lineStarted = false; continue; }
        const x = timeToX(ft.time);
        const y = freqToY(formant.freq);
        if (!lineStarted) { ctxOverlay.moveTo(x, y); lineStarted = true; }
        else ctxOverlay.lineTo(x, y);
      }
      ctxOverlay.stroke();

      // 节点标记
      ctxOverlay.fillStyle = color;
      for (const ft of formantTracks) {
        const formant = ft[formantKeys[fi]];
        if (!formant || formant.freq <= 0) continue;
        const x = timeToX(ft.time);
        const y = freqToY(formant.freq);
        ctxOverlay.beginPath();
        ctxOverlay.arc(x, y, 1.5, 0, Math.PI * 2);
        ctxOverlay.fill();
      }
    }

  },

  onOverlayTouchStart(e) {
    if (!analysisResult || this.data.state !== 'result') return;
    const x = Math.max(34, Math.min(this._sgWidth - 10, e.touches[0].x));
    dragStartX = x;
    dragEndX = x;
    isDragging = true;
  },

  onOverlayTouchMove(e) {
    if (!isDragging) return;
    dragEndX = Math.max(34, Math.min(this._sgWidth - 10, e.touches[0].x));
    this.drawOverlay();
    this.drawSelection();
  },

  onOverlayTouchEnd() {
    if (!isDragging) return;
    isDragging = false;

    const w = this._sgWidth;
    const duration = analysisResult.duration;
    const plotLeft = 34;
    const plotWidth = w - 44;

    const x1 = Math.min(dragStartX, dragEndX);
    const x2 = Math.max(dragStartX, dragEndX);
    const time1 = Math.max(0, ((x1 - plotLeft) / plotWidth) * duration);
    const time2 = Math.min(duration, ((x2 - plotLeft) / plotWidth) * duration);

    // 短距离点击 → 单点选择
    if (x2 - x1 < 8) {
      const time = (time1 + time2) / 2;
      this.updateValueCards(time);
      this.setData({
        selectedTime: Math.round(time * 1000) / 1000,
        selectionStart: null,
        selectionEnd: null,
      });
      this.drawOverlay();
      const ctx = ctxOverlay;
      const px = plotLeft + (time / duration) * plotWidth;
      ctx.strokeStyle = `rgba(${THEME_COLORS.PRIMARY_RGB}, 0.5)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this._sgHeight);
      ctx.stroke();
      return;
    }

    // 拖拽选区 → 显示选区统计
    this.setData({
      selectionStart: time1.toFixed(2),
      selectionEnd: time2.toFixed(2),
      selectedTime: null,
    });
    this.computeSelectionStats(time1, time2);
    this.drawOverlay();
    this.drawSelection();
  },

  drawSelection() {
    if (!ctxOverlay || dragStartX === null || dragEndX === null) return;
    const x1 = Math.min(dragStartX, dragEndX);
    const x2 = Math.max(dragStartX, dragEndX);
    const ctx = ctxOverlay;
    ctx.fillStyle = `rgba(${THEME_COLORS.PRIMARY_RGB}, 0.15)`;
    ctx.fillRect(x1, 0, x2 - x1, this._sgHeight);
    ctx.strokeStyle = `rgba(${THEME_COLORS.PRIMARY_RGB}, 0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, this._sgHeight);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, this._sgHeight);
    ctx.stroke();
  },

  computeSelectionStats(t1, t2) {
    if (!analysisResult) return;
    const { pitchTrack, intensityTrack } = analysisResult;

    // 选区内 F0 均值
    let f0Sum = 0, f0Count = 0;
    for (const pt of pitchTrack) {
      if (pt.time >= t1 && pt.time <= t2 && pt.f0 > 0) {
        f0Sum += pt.f0;
        f0Count++;
      }
    }
    const meanF0 = f0Count > 0 ? (f0Sum / f0Count).toFixed(1) : '--';

    // 选区内最大声强
    let maxInt = -Infinity;
    if (intensityTrack) {
      for (const it of intensityTrack) {
        if (it.time >= t1 && it.time <= t2 && it.db > maxInt) maxInt = it.db;
      }
    }

    this.setData({
      selDuration: (t2 - t1).toFixed(2),
      selMeanF0: meanF0,
      selMaxIntensity: maxInt > -Infinity ? maxInt.toFixed(1) : '--',
    });
  },

  updateValueCards(time) {
    if (!analysisResult) return;
    const { pitchTrack, formantTracks, intensityTrack } = analysisResult;

    let closestPitch = null, minDist = Infinity;
    for (const pt of pitchTrack) {
      const d = Math.abs(pt.time - time);
      if (d < minDist) { minDist = d; closestPitch = pt; }
    }

    let closestFormant = null;
    minDist = Infinity;
    for (const ft of formantTracks) {
      const d = Math.abs(ft.time - time);
      if (d < minDist) { minDist = d; closestFormant = ft; }
    }

    let closestIntensity = null;
    minDist = Infinity;
    if (intensityTrack) {
      for (const it of intensityTrack) {
        const d = Math.abs(it.time - time);
        if (d < minDist) { minDist = d; closestIntensity = it; }
      }
    }

    this.setData({
      f0: closestPitch && closestPitch.f0 > 0 ? closestPitch.f0.toFixed(1) : '--',
      f1: closestFormant && closestFormant.F1.freq > 0 ? closestFormant.F1.freq.toFixed(1) : '--',
      f2: closestFormant && closestFormant.F2.freq > 0 ? closestFormant.F2.freq.toFixed(1) : '--',
      f3: closestFormant && closestFormant.F3.freq > 0 ? closestFormant.F3.freq.toFixed(1) : '--',
      intensity: closestIntensity ? closestIntensity.db.toFixed(1) : '--',
    });
  },

  resetToIdle() {
    analysisGeneration++;
    analysisResult = null;
    pcmChunks = [];
    totalSamples = 0;
    this.setData({
      state: 'idle', recordTime: 0, progress: 0, progressStage: '',
      f0: '--', f1: '--', f2: '--', f3: '--',
      hnr: '--', jitter: '--', intensity: '--',
      selectedTime: null,
      selectionStart: null, selectionEnd: null,
      selDuration: '--', selMeanF0: '--', selMaxIntensity: '--',
    });
    if (ctxSpectrogram) ctxSpectrogram.clearRect(0, 0, this._sgWidth, this._sgHeight);
    if (ctxOverlay) ctxOverlay.clearRect(0, 0, this._sgWidth, this._sgHeight);
    this.setData({ viewMode: 'spectrogram' });
    cachedSpectrogramImage = null;
    cachedSpectrogramSize = null;
    dragStartX = null; dragEndX = null;
  },

  switchView(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.viewMode) return;
    // 清除旧视图的 canvas 引用（wx:if 会销毁 DOM 元素）
    canvasSpectrogram = null; ctxSpectrogram = null;
    canvasOverlay = null; ctxOverlay = null;
    this._ltasCtx = null;
    this._vowelCtx = null;
    this.setData({ viewMode: mode }, () => {
      // 等 setData 回调 DOM 更新后再初始化 canvas
      if (mode === 'spectrogram') this.restoreSpectrogram();
      else if (mode === 'ltas') this.drawLTAS();
      else if (mode === 'vowel') this.drawVowelSpace();
    });
  },

  /** 从缓存恢复语谱图，无缓存则完整重绘 */
  restoreSpectrogram() {
    this.initSpectrogramCanvas(() => {
      this.initOverlayCanvas(() => {
        const cacheValid = !!cachedSpectrogramImage
          && !!cachedSpectrogramSize
          && cachedSpectrogramSize.width === this._sgWidth
          && cachedSpectrogramSize.height === this._sgHeight;

        if (cacheValid) {
          ctxSpectrogram.clearRect(0, 0, this._sgWidth, this._sgHeight);
          ctxSpectrogram.imageSmoothingEnabled = false;
          ctxSpectrogram.drawImage(cachedSpectrogramImage, 34, 0);
          this.drawSpectrogramLabels(this._sgWidth, this._sgHeight, 50, SAMPLE_RATE / 2, ctxSpectrogram);
        } else {
          cachedSpectrogramImage = null;
          cachedSpectrogramSize = null;
          this.drawSpectrogram();
          this.drawOverlay();
          return;
        }
        this.drawOverlay();
      });
    });
  },

  initLTASCanvas(callback, retries) {
    retries = retries || 0;
    const query = wx.createSelectorQuery();
    query.select('#canvas-ltas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        if (retries < 3) { setTimeout(() => this.initLTASCanvas(callback, retries + 1), 200); }
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getWindowInfo().pixelRatio;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      this._ltasCanvas = canvas;
      this._ltasCtx = ctx;
      this._ltasW = res[0].width;
      this._ltasH = res[0].height;
      if (callback) callback();
    });
  },

  drawLTAS() {
    if (!analysisResult) return;
    this.initLTASCanvas(() => {
      const ctx = this._ltasCtx;
      const w = this._ltasW;
      const h = this._ltasH;

      // 直接从信号计算 LTAS，绕过语谱图归一化数据
      const { signal, duration } = analysisResult;
      const sampleRate = SAMPLE_RATE;
      const fftSize = 2048;
      const windowLen = fftSize;
      const hopLen = Math.floor(fftSize / 2);
      const binCount = fftSize / 2;
      const hann = new Float64Array(windowLen);
      for (let n = 0; n < windowLen; n++) hann[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (windowLen - 1)));

      // 累加每帧功率谱
      const avgPower = new Float64Array(binCount);
      let frameCount = 0;
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);

      for (let start = 0; start + windowLen <= signal.length; start += hopLen) {
        for (let i = 0; i < windowLen; i++) { re[i] = signal[start + i] * hann[i]; im[i] = 0; }
        for (let i = windowLen; i < fftSize; i++) { re[i] = 0; im[i] = 0; }
        this._fftInPlace(re, im, fftSize);
        for (let k = 0; k < binCount; k++) avgPower[k] += re[k] * re[k] + im[k] * im[k];
        frameCount++;
      }

      if (frameCount === 0) return;
      const invFrames = 1 / frameCount;
      const coherentGain = 0.5;
      const ampScale = 2.0 / (windowLen * coherentGain);

      // 转 dB
      const avgDb = new Float64Array(binCount);
      let dbMax = -Infinity, dbMin = Infinity;
      for (let k = 0; k < binCount; k++) {
        const rms = Math.sqrt(avgPower[k] * invFrames) * ampScale / Math.SQRT2;
        avgDb[k] = 20 * Math.log10(Math.max(rms, 1e-12));
        if (avgDb[k] > dbMax) dbMax = avgDb[k];
        if (avgDb[k] < dbMin) dbMin = avgDb[k];
      }

      // 留一些余量
      dbMax = Math.ceil(dbMax / 10) * 10;
      dbMin = Math.floor(dbMin / 10) * 10;
      if (dbMax <= dbMin) dbMax = dbMin + 20;

      const plotLeft = 40;
      const plotRight = w - 16;
      const plotTop = 20;
      const plotBottom = h - 30;
      const plotW = plotRight - plotLeft;
      const plotH = plotBottom - plotTop;

      const fMin = 50;
      const fMax = 8000;
      const logMin = Math.log(fMin);
      const logMax = Math.log(fMax);
      const freqRes = sampleRate / fftSize;

      ctx.clearRect(0, 0, w, h);

      // 坐标轴
      ctx.strokeStyle = THEME_COLORS.GRID;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, plotTop);
      ctx.lineTo(plotLeft, plotBottom);
      ctx.lineTo(plotRight, plotBottom);
      ctx.stroke();

      // 频率标签
      ctx.fillStyle = THEME_COLORS.NEUTRAL;
      ctx.font = '10px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const freqLabels = [50, 100, 200, 500, 1000, 2000, 4000, 8000];
      for (const f of freqLabels) {
        const x = plotLeft + ((Math.log(f) - logMin) / (logMax - logMin)) * plotW;
        ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f + '', x, plotBottom + 6);
        ctx.strokeStyle = THEME_COLORS.GRID;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }

      // dB 标签：选择合理的刻度步长，最多显示 ~6 个刻度
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const dbRange = dbMax - dbMin;
      const approxStep = Math.ceil(dbRange / 6 / 10) * 10; // 每 6 段分布，向上取整到 10 的倍数
      const dbStep = Math.max(10, approxStep);
      for (let db = dbMin; db <= dbMax; db += dbStep) {
        const y = plotBottom - ((db - dbMin) / (dbMax - dbMin)) * plotH;
        ctx.fillText(db + '', plotLeft - 6, y);
      }

      // 绘制 LTAS 曲线
      ctx.strokeStyle = THEME_COLORS.PRIMARY;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let k = 1; k < binCount; k++) {
        const freq = k * freqRes;
        if (freq < fMin || freq > fMax) continue;
        const x = plotLeft + ((Math.log(freq) - logMin) / (logMax - logMin)) * plotW;
        const y = plotBottom - ((avgDb[k] - dbMin) / (dbMax - dbMin)) * plotH;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 标题
      ctx.fillStyle = THEME_COLORS.NEUTRAL;
      ctx.font = '11px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('长期平均频谱 (LTAS)', w / 2, 4);
    });
  },

  /** 内联 radix-2 FFT（供 LTAS 使用，避免模块间循环引用） */
  _fftInPlace(re, im, N) {
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const angle = -2 * Math.PI / len;
      const wRe = Math.cos(angle), wIm = Math.sin(angle);
      for (let i = 0; i < N; i += len) {
        let cRe = 1, cIm = 0;
        for (let k = 0; k < half; k++) {
          const tRe = cRe * re[i + k + half] - cIm * im[i + k + half];
          const tIm = cRe * im[i + k + half] + cIm * re[i + k + half];
          re[i + k + half] = re[i + k] - tRe;
          im[i + k + half] = im[i + k] - tIm;
          re[i + k] += tRe;
          im[i + k] += tIm;
          const nRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nRe;
        }
      }
    }
  },

  initVowelCanvas(callback, retries) {
    retries = retries || 0;
    const query = wx.createSelectorQuery();
    query.select('#canvas-vowel').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        if (retries < 3) { setTimeout(() => this.initVowelCanvas(callback, retries + 1), 200); }
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getWindowInfo().pixelRatio;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      this._vowelCanvas = canvas;
      this._vowelCtx = ctx;
      this._vowelW = res[0].width;
      this._vowelH = res[0].height;
      if (callback) callback();
    });
  },

  drawVowelSpace() {
    if (!analysisResult) return;
    this.initVowelCanvas(() => {
      const ctx = this._vowelCtx;
      const w = this._vowelW;
      const h = this._vowelH;
      const { formantTracks } = analysisResult;

      // 收集有效 F1/F2 数据点
      const points = [];
      for (const ft of formantTracks) {
        if (ft.F1.freq > 0 && ft.F2.freq > 0) {
          points.push({ f1: ft.F1.freq, f2: ft.F2.freq });
        }
      }

      const plotLeft = 50;
      const plotRight = w - 16;
      const plotTop = 20;
      const plotBottom = h - 45;
      const plotW = plotRight - plotLeft;
      const plotH = plotBottom - plotTop;

      // F1 轴：200~1000 Hz（下大上小，还原口腔开口度）
      const f1Min = 200, f1Max = 1000;
      // F2 轴：800~2800 Hz（左大右小，还原舌位前后）
      const f2Min = 800, f2Max = 2800;

      ctx.clearRect(0, 0, w, h);

      // 坐标轴
      ctx.strokeStyle = THEME_COLORS.GRID;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, plotTop);
      ctx.lineTo(plotLeft, plotBottom);
      ctx.lineTo(plotRight, plotBottom);
      ctx.stroke();

      // F1 标签（纵轴，下大上小）
      ctx.fillStyle = THEME_COLORS.NEUTRAL;
      ctx.font = '10px Arial';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let f1 = f1Min; f1 <= f1Max; f1 += 200) {
        const y = plotTop + ((f1 - f1Min) / (f1Max - f1Min)) * plotH;
        ctx.fillText(f1 + '', plotLeft - 6, y);
        ctx.strokeStyle = THEME_COLORS.GRID;
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
      }

      // F2 标签（横轴，左大右小）
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let f2 = f2Min; f2 <= f2Max; f2 += 400) {
        const x = plotRight - ((f2 - f2Min) / (f2Max - f2Min)) * plotW;
        ctx.fillText(f2 + '', x, plotBottom + 6);
        ctx.strokeStyle = THEME_COLORS.GRID;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }

      // 轴标签
      ctx.fillStyle = THEME_COLORS.NEUTRAL;
      ctx.font = '11px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('F2 (Hz)', (plotLeft + plotRight) / 2, h - 14);
      ctx.save();
      ctx.translate(12, (plotTop + plotBottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('F1 (Hz)', 0, 0);
      ctx.restore();

      // 绘制数据点
      ctx.fillStyle = THEME_COLORS.PRIMARY;
      for (const pt of points) {
        const x = plotRight - ((pt.f2 - f2Min) / (f2Max - f2Min)) * plotW;
        const y = plotTop + ((pt.f1 - f1Min) / (f1Max - f1Min)) * plotH;
        if (x >= plotLeft && x <= plotRight && y >= plotTop && y <= plotBottom) {
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 标题
      ctx.fillStyle = THEME_COLORS.NEUTRAL;
      ctx.font = '11px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('元音空间图 (F1-F2)', w / 2, 4);
    });
  },

  cleanup() {
    analysisGeneration++;
    isRecording = false;
    if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    this.clearRecorderLifecycleListeners();
    if (currentPhoneticPage === this) currentPhoneticPage = null;
    pcmChunks = [];
    canvasSpectrogram = null; ctxSpectrogram = null;
    canvasOverlay = null; ctxOverlay = null;
    analysisResult = null;
    cachedSpectrogramImage = null;
    cachedSpectrogramSize = null;
  },
});
