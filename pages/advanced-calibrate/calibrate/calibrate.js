// pages/advanced-calibrate/calibrate/calibrate.js
// 作用：专业环境声学校准，通过标准 1kHz 纯音和长时间能量积分算法，计算设备麦克风偏移量。
/**
 * 仅保留 1 kHz 纯音单点参考校准（参考声级由用户按仪器读数填写）
 * 采用 3秒倒计时(防震防遮挡) + 5秒等效连续声级(Leq)积分算法
 */

const recorderManager = wx.getRecorderManager();
const { calculateRMS, calculateDb } = require('../../../utils/audio-math');
const { OFFSET_IMPORT_RANGE, THEME_COLORS } = require('../../../utils/constants');
const dataModel = require('../../../utils/data-model');
const { DCBlocker, inspectPcm, PcmQualityInspector } = require('../../../utils/audio-quality');
const { inspectCalibrationTone } = require('../../../utils/calibration-quality');
const {
  safeStopRecorder,
  cancelRecorderStart,
  isRecorderTransitioning,
  observeRecorderEvent,
  observeRecorderState,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  getMeasurementCaptureProfile,
  getCurrentDeviceCalibrationId,
  bindRecorderListenersOnce,
  bindRecorderFrameListener,
  clearRecorderFrameListener,
  restartRecorderSession,
} = require('../../../utils/recorder-session');
let audioCtx;

// --- 全局物理计算变量 ---
let offset = 0;
let dBArray =[];
let time = 0;
let frameCount = 0; 

// 校准专用积分变量 (置于 Page 外避免 setData 拖慢后台采样性能)
let isCalibrating = false;
let calibEnergySum = 0;
let calibSamples = 0;
const CALIB_SAMPLE_RATE = 44100;
const CALIB_REQUIRED_SAMPLES = CALIB_SAMPLE_RATE * 5;
let dcBlocker = new DCBlocker(CALIB_SAMPLE_RATE);
let calibSignal = null;
let calibrationClipped = false;
let calibrationQualityInspector = new PcmQualityInspector(44100);
let calibrationInterrupted = false;
let advancedMonitoringPaused = false;
const MIN_CALIBRATION_RMS = 1e-6;
let currentAdvancedCalibratePage = null;
let isAdvancedMonitoringActive = false;
let advancedRecorderRestartTimerId = null;
let calibrationCountdownTimerId = null;
let calibrationIntegrationTimerId = null;

// 清理进阶校准页待启动录音定时器。
//Side effect: 清除尚未执行的录音重启任务。
function clearAdvancedRecorderRestartTimer() {
  cancelRecorderStart(recorderManager);
  if (advancedRecorderRestartTimerId) {
    if (typeof advancedRecorderRestartTimerId === 'number') clearTimeout(advancedRecorderRestartTimerId);
    advancedRecorderRestartTimerId = null;
  }
}

function clearCalibrationTimers() {
  if (calibrationCountdownTimerId) {
    clearTimeout(calibrationCountdownTimerId);
    calibrationCountdownTimerId = null;
  }
  if (calibrationIntegrationTimerId) {
    clearTimeout(calibrationIntegrationTimerId);
    calibrationIntegrationTimerId = null;
  }
  isCalibrating = false;
}

/**
 * 记录声强数据到缓存数组
 * @param {number} currentTime - 记录点时间坐标或帧数索引
 * @param {number} dBSPL - 计算所得的实际声压级别
 */
function recordArray(currentTime, dBSPL) {
  dBArray[currentTime] = dBSPL;
}


// ================= 页面主逻辑 =================
Page({
  data: {
    dbfs: '0.00',
    dbspl: '0.00',
    newOffset: '0.00',
    referenceLevel: '80', referenceInstrument: '', inputChain: '',
    referenceUncertainty: '', verificationResidual: '--',
    
    // --- 新增：专门用于大字提示的 UI 状态 ---
    statusText: '等待开始...\n请将麦克风靠近声级计',
    statusColor: THEME_COLORS.DARK_GRAY,
    isCalibratingUI: false // 处于校准流程中时，为 true (可用于隐藏 Canvas)
  },
  isPageActive: false,
  _calibrationGeneration: 0,
  _pendingCalibrationResult: null,
  // 核心录音配置：与主测量使用相同的平台采集配置。
  advancedCalibrateRecordParams: {
    ...createCamcorderRecordParams(),
    duration: 600000,
  },
  
  onShow() {
    this.invalidateCalibrationResult();
    advancedMonitoringPaused = false;
    this.isPageActive = true;
    isAdvancedMonitoringActive = true;
    currentAdvancedCalibratePage = this;
    this.initMonitor();
    this.setupRecorderListeners(); // 新增：统一挂载录音监听器
    this.noiseDetect();
  },

  onHide() { 
    this.isPageActive = false;
    if (currentAdvancedCalibratePage === this) {
      this.stopNoiseMonitoring();
      isAdvancedMonitoringActive = false;
      currentAdvancedCalibratePage = null;
    }
  },
  
  onUnload() { 
    this.onHide();
  },

  initMonitor() {
    try {
      offset = dataModel.getOffset();
      audioCtx = wx.createWebAudioContext();
      dBArray = [0];
      time = 0;
      frameCount = 0;
      dcBlocker = new DCBlocker(CALIB_SAMPLE_RATE);
      isCalibrating = false;
      this.setData({ isCalibratingUI: false });
    } catch(e) { console.error(e); }
  },

  invalidateCalibrationResult() {
    this._calibrationGeneration = (this._calibrationGeneration || 0) + 1;
    this._pendingCalibrationResult = null;
    this._calibrationStartPending = false;
  },

  /**
   * 初始化并绑定录音相关的事件监听器，处理由于系统中断或异常导致的录音停止。
   * 在发生中断（如电话接入）或意外结束时，尝试自动恢复或重启录音流程，以确保校准数据的连续性。
   * 
   * @sideeffect 配置并注册录音机的各类生命周期回调（如 onStop、onInterruptionEnd 等）。
   */
  setupRecorderListeners() {
    bindRecorderListenersOnce(recorderManager, 'advanced-calibrate-listeners', () => {
      observeRecorderState(recorderManager, state => {
        const page = currentAdvancedCalibratePage;
        if (!isAdvancedMonitoringActive || !page || advancedMonitoringPaused) return;
        if (state === 'waiting-interruption' && page._calibrationStartPending) {
          page.setData({ statusText: '录音被系统占用，等待恢复…', statusColor: THEME_COLORS.DARK_GRAY });
        } else if (state === 'recording' && page._calibrationStartPending) {
          page._calibrationStartPending = false;
          page.beginCalibrationCountdown();
        } else if (state === 'error') page.failCalibration('录音启动或停止失败，请重试');
      });
      // 1. 监听意外停止
      observeRecorderEvent(recorderManager, 'Stop', (res) => {
        if (isRecorderTransitioning(recorderManager)) return;
        const page = currentAdvancedCalibratePage;
        if (!isAdvancedMonitoringActive || !page || advancedMonitoringPaused) {
          return;
        }
        console.log('[Recorder] Stopped', res);
        if (isCalibrating || page.data.isCalibratingUI) {
          calibrationInterrupted = true;
          page.failCalibration('录音中断，请重新校准');
        }
        // 核心修复：如果页面还在前台，说明是被系统弹窗打断的，自动重启！
        if (page.isPageActive) {
          console.log('[Recorder] 尝试自动恢复录音...');
          clearAdvancedRecorderRestartTimer();
          advancedRecorderRestartTimerId = restartRecorderSession(
            recorderManager,
            page.advancedCalibrateRecordParams,
            500
          );
        }
      });

      // 2. 监听系统级打断恢复 (如接完电话切回)
      observeRecorderEvent(recorderManager, 'InterruptionEnd', () => {
        const page = currentAdvancedCalibratePage;
        if (isAdvancedMonitoringActive && page && page.isPageActive && !advancedMonitoringPaused) {
          if (isCalibrating || page.data.isCalibratingUI) {
            calibrationInterrupted = true;
            page.failCalibration('录音中断，请重新校准');
          }
          clearAdvancedRecorderRestartTimer();
          advancedRecorderRestartTimerId = restartRecorderSession(
            recorderManager,
            page.advancedCalibrateRecordParams,
            120
          );
        }
      });

      const failInterruptedCalibration = () => {
        const page = currentAdvancedCalibratePage;
        if (isAdvancedMonitoringActive && page && (isCalibrating || page.data.isCalibratingUI)) {
          calibrationInterrupted = true;
          page.failCalibration('录音中断或出错，请重新校准');
        }
      };
      observeRecorderEvent(recorderManager, 'InterruptionBegin', failInterruptedCalibration);
      observeRecorderEvent(recorderManager, 'Pause', failInterruptedCalibration);
      observeRecorderEvent(recorderManager, 'Error', failInterruptedCalibration);

    });

    bindRecorderFrameListener(recorderManager, (res) => {
      const page = currentAdvancedCalibratePage;
      if (!isAdvancedMonitoringActive || !page) {
        return;
      }

      const frameBuffer = res && res.frameBuffer;
      if (!frameBuffer || !Number.isFinite(frameBuffer.byteLength) || frameBuffer.byteLength % 2 !== 0) {
        if (isCalibrating) {
          calibrationInterrupted = true;
          page.failCalibration('音频数据格式无效，请重新校准');
        }
        return;
      }
      const pcm = new Int16Array(frameBuffer);
      if (!pcm.length) return;
      const buffer = dcBlocker.process(pcm);
      
      // -- 常规瞬间计算 --
      const energy = calculateRMS(buffer);
      const dbfs = calculateDb(energy, 1);
      const dbspl = dbfs + offset;

      if (!page.data.isCalibratingUI) {
        frameCount++;
        if (frameCount % 2 === 0) {
          time++;
          recordArray(time, dbspl); 
        }
      }

      // -- 核心优化：校准能量积分 (Leq) --
      if (isCalibrating) {
        const count = Math.min(buffer.length, CALIB_REQUIRED_SAMPLES - calibSamples);
        calibrationClipped = calibrationClipped || inspectPcm(pcm.subarray(0, count), calibrationQualityInspector).clipped;
        for (let i = 0; i < count; i++) {
          const sample = buffer[i];
          calibEnergySum += (sample * sample);
          calibSignal[calibSamples + i] = sample;
        }
        calibSamples += count;
        if (calibSamples === CALIB_REQUIRED_SAMPLES) {
          clearCalibrationTimers();
          page.finalizeCalibration();
        }
      }

      page.setData({
        dbfs: dbfs.toFixed(2),
        dbspl: dbspl.toFixed(2),
      });
    });
  },

  //停止录音、移除帧监听、清理音频上下文与重启定时器。
  stopNoiseMonitoring(options = {}) {
    if (currentAdvancedCalibratePage !== this) return;
    if (!options.preserveCalibrationResult) this.invalidateCalibrationResult();
    advancedMonitoringPaused = true;
    clearAdvancedRecorderRestartTimer();
    clearCalibrationTimers();
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    audioCtx = safeCloseAudioContext(audioCtx);
  },

  // ================= 严格校准交互流程 =================

  // 1. 单点参考校准入口（仅 1 kHz，参考声级由用户填写）
  setReferenceField(e) {
    if (this.data.isCalibratingUI) return;
    const key = e.currentTarget.dataset.key;
    if (['referenceLevel', 'referenceInstrument', 'inputChain', 'referenceUncertainty'].includes(key)) {
      this.setData({ [key]: e.detail.value });
    }
  },

  verifyCurrentCalibration() {
    const meta = wx.getStorageSync('offsetMeta') || {};
    if (!meta.source) {
      wx.showToast({ title: '没有可复测的校准记录', icon: 'none' });
      return;
    }
    this.startCalibrationProcess({ verification: true });
  },

  startCalibrationProcess(options = {}) {
    if (isCalibrating || this.data.isCalibratingUI) return;
    const referenceLevelDb = Number(this.data.referenceLevel);
    const uncertaintyText = String(this.data.referenceUncertainty).trim();
    const uncertaintyDb = uncertaintyText ? Number(uncertaintyText) : null;
    if (!String(this.data.referenceLevel).trim() || !Number.isFinite(referenceLevelDb)
        || referenceLevelDb < 40 || referenceLevelDb > 120
        || (uncertaintyDb !== null && (!Number.isFinite(uncertaintyDb) || uncertaintyDb < 0))) {
      wx.showToast({ title: '请输入 40–120 dB 参考读数及有效不确定度', icon: 'none' });
      return;
    }
    this._referenceEvidence = { referenceLevelDb, frequencyHz: 1000, integrationSeconds: 5,
      referenceInstrument: String(this.data.referenceInstrument).trim(), uncertaintyDb, uncertaintyCoverageFactor: 2,
      inputChain: String(this.data.inputChain).trim() };
    this._verificationMode = options.verification === true;
    this._verificationOffset = dataModel.getOffset();
    this._verificationMeta = wx.getStorageSync('offsetMeta') || {};
    this.invalidateCalibrationResult();
    clearCalibrationTimers();
    clearAdvancedRecorderRestartTimer();
    advancedMonitoringPaused = false;
    this.setupRecorderListeners();
    this._calibrationStartPending = true;
    this.setData({ isCalibratingUI: true, statusText: '正在启动录音…', statusColor: THEME_COLORS.DARK_GRAY });
    advancedRecorderRestartTimerId = restartRecorderSession(recorderManager, this.advancedCalibrateRecordParams, 0);
  },

  beginCalibrationCountdown() {
    let countdown = 3;
    const showCountdown = () => {
      calibrationCountdownTimerId = null;
      if (!this.isPageActive || currentAdvancedCalibratePage !== this) {
        return;
      }
      if (countdown > 0) {
        // 倒数标红，提示退后
        this.setData({
          statusText: `准备中：${countdown} 秒\n保持参考纯音稳定，请勿触碰设备`,
          statusColor: THEME_COLORS.PRIMARY
        });
        countdown--;
        calibrationCountdownTimerId = setTimeout(showCountdown, 1000);
      } else {
        this.executeIntegration();
      }
    };
    showCountdown();
  },

  // 2. 执行5秒物理采样积分
  executeIntegration() {
    if (!this.isPageActive || currentAdvancedCalibratePage !== this) {
      return;
    }
    calibEnergySum = 0;
    calibSamples = 0;
    calibSignal = new Float32Array(CALIB_REQUIRED_SAMPLES);
    calibrationClipped = false;
    calibrationQualityInspector = new PcmQualityInspector(CALIB_SAMPLE_RATE);
    calibrationInterrupted = false;
    isCalibrating = true;

    // 录制标绿
    this.setData({
      statusText: `正在采集中 (5秒)...\n保持参考纯音稳定，避免其他声响`,
      statusColor: THEME_COLORS.WARN
    });

    calibrationIntegrationTimerId = setTimeout(() => {
      calibrationIntegrationTimerId = null;
      if (!this.isPageActive || currentAdvancedCalibratePage !== this) {
        isCalibrating = false;
        return;
      }
      this.failCalibration('采样不足 5 秒，请检查录音后重试');
    }, 7000); // 超时只判失败，成功由真实样本数触发。
  },

  failCalibration(message) {
    this.invalidateCalibrationResult();
    clearCalibrationTimers();
    calibSignal = null;
    this.setData({ newOffset: '--', statusText: message, statusColor: THEME_COLORS.PRIMARY, isCalibratingUI: false });
  },

  // 3. 计算最终结果并准备保存
  finalizeCalibration() {
    if (calibSamples !== CALIB_REQUIRED_SAMPLES || !calibSignal || calibrationInterrupted) {
      this.setData({
        statusText: '采样失败',
        statusColor: THEME_COLORS.PRIMARY,
        isCalibratingUI: false
      });
      return;
    }

    // 计算5秒平均能量 -> 求RMS -> 转对数dBFS
    const meanSquare = calibEnergySum / calibSamples;
    const rms = Math.sqrt(meanSquare);
    const leqDbfs = calculateDb(rms, 1.0);
    
    // 偏移量 = 用户填写的参考声级 - 测得数字分贝。
    const calibrationOffset = this._referenceEvidence.referenceLevelDb - leqDbfs;
    const toneQuality = inspectCalibrationTone(calibSignal, CALIB_SAMPLE_RATE);

    const hasValidSignal = Number.isFinite(meanSquare)
      && Number.isFinite(rms)
      && rms > MIN_CALIBRATION_RMS
      && !calibrationClipped
      && toneQuality.valid;
    const hasValidOffset = Number.isFinite(calibrationOffset)
      && calibrationOffset >= OFFSET_IMPORT_RANGE.MIN
      && calibrationOffset <= OFFSET_IMPORT_RANGE.MAX;

    if (!hasValidSignal || !hasValidOffset) {
      this.failCalibration(calibrationClipped ? '输入达到满幅，不能校准' : '校准失败：需要稳定、足够强的 1kHz 纯音');
      return;
    }

    const evidence = { ...this._referenceEvidence, measuredDbfs: leqDbfs,
      measuredAt: Date.now(), samples: calibSamples, sampleRate: CALIB_SAMPLE_RATE,
      toneQuality, scope: '1-kHz-at-reference-level' };
    if (this._verificationMode) {
      const residualDb = leqDbfs + this._verificationOffset - evidence.referenceLevelDb;
      const decision = dataModel.evaluateReferenceCheck(residualDb, this._verificationMeta.evidence, evidence);
      if (this._verificationMeta.source !== 'laboratory-preset'
          && this._verificationMeta.captureProfile !== getMeasurementCaptureProfile()) decision.status = 'inconclusive';
      const verificationStatus = decision.status;
      this.stopNoiseMonitoring();
      calibSignal = null;
      // 复测只追加证据，不改变偏移量、有效状态、等级、绑定或有效期。
      const appended = dataModel.appendReferenceCheck(this._verificationOffset,
        { ...evidence, ...decision, captureProfile: getMeasurementCaptureProfile(), status: verificationStatus }, this._verificationMeta);
      this.setData({ verificationResidual: residualDb.toFixed(2), isCalibratingUI: false,
        statusText: appended
          ? `复测完成：残差 ${residualDb.toFixed(2)} dB，漂移限值 ±${decision.residualLimitDb.toFixed(2)} dB，${{ passed: '通过', failed: '超限', inconclusive: '证据不足' }[verificationStatus]}；不验证全频带准确度，可继续检测和保存。`
          : '复测完成，但原校准已变化，复测证据未写入。' });
      return;
    }

    this.setData({
      newOffset: calibrationOffset.toFixed(2),
      statusText: `校准完成！\nLeq dBFS: ${leqDbfs.toFixed(2)}\n计算偏移量: ${calibrationOffset.toFixed(2)} dB`,
      statusColor: THEME_COLORS.SAFE_ASSIST,
      isCalibratingUI: false
    });
    const candidate = {
      generation: this._calibrationGeneration,
      offset: calibrationOffset,
      captureProfile: getMeasurementCaptureProfile(),
      deviceId: getCurrentDeviceCalibrationId(),
      evidence,
    };
    this._pendingCalibrationResult = candidate;
    this.stopNoiseMonitoring({ preserveCalibrationResult: true });
    calibSignal = null;
    this.saveOffset(candidate);
  },

  // 4. 保存并应用逻辑
  saveOffset(candidate = this._pendingCalibrationResult) {
    let that = this;
    let offsetVal = candidate && candidate.offset;

    if (!candidate || candidate !== this._pendingCalibrationResult
      || !Number.isFinite(offsetVal)
      || offsetVal < OFFSET_IMPORT_RANGE.MIN
      || offsetVal > OFFSET_IMPORT_RANGE.MAX) {
      wx.showToast({ title: '校准结果无效，请重新校准', icon: 'none' });
      return;
    }
    
    wx.showModal({
      title: "应用校准结果",
      content: `1kHz基准计算偏移量为：${offsetVal} dB\n是否立即覆盖当前设备配置？`,
      success(res) {
        const stillCurrent = that.isPageActive
          && currentAdvancedCalibratePage === that
          && that._pendingCalibrationResult === candidate
          && that._calibrationGeneration === candidate.generation;
        if (res.confirm && stillCurrent) {
          dataModel.setOffset(offsetVal, {
            captureProfile: candidate.captureProfile,
            deviceId: candidate.deviceId,
            source: 'advanced-1khz-calibration',
            evidence: candidate.evidence,
            inputChain: candidate.evidence.inputChain,
            scope: '1-kHz-at-reference-level',
          });
          offset = offsetVal; 
          wx.showToast({ title: '校准已生效', icon: 'success' });
        } else if (res.confirm) {
          wx.showToast({ title: '校准结果已过期，请重新校准', icon: 'none' });
        }
        if (that._pendingCalibrationResult === candidate) that._pendingCalibrationResult = null;
      },
      complete() {
        if (isAdvancedMonitoringActive && that.isPageActive
          && currentAdvancedCalibratePage === that && that._calibrationGeneration === candidate.generation) {
          advancedMonitoringPaused = false;
          that.setupRecorderListeners();
          clearAdvancedRecorderRestartTimer();
          advancedRecorderRestartTimerId = restartRecorderSession(recorderManager, that.advancedCalibrateRecordParams, 0);
        }
      }
    });
  },

  // ================= 实时后台采样 =================
  noiseDetect() {
    if (!isAdvancedMonitoringActive) {
      return;
    }
    clearAdvancedRecorderRestartTimer();
    advancedRecorderRestartTimerId = restartRecorderSession(recorderManager, this.advancedCalibrateRecordParams, 0);
  }
});
