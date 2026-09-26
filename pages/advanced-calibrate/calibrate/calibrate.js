// pages/advanced-calibrate/calibrate/calibrate.js
// 作用：专业环境声学校准，通过标准 1kHz 纯音和长时间能量积分算法，计算设备麦克风偏移量。
/**
 * 仅保留 1kHz 纯音标准校准 (80dB SPL)
 * 采用 3秒倒计时(防震防遮挡) + 5秒等效连续声级(Leq)积分算法
 */

const recorderManager = wx.getRecorderManager();
const { calculateRMS, calculateDb } = require('../../../utils/audio-math');
const { LIMITS, OFFSET_IMPORT_RANGE, THEME_COLORS } = require('../../../utils/constants');
const dataModel = require('../../../utils/data-model');
const { DCBlocker, inspectPcm } = require('../../../utils/audio-quality');
const { inspectCalibrationTone } = require('../../../utils/calibration-quality');
const {
  safeStopRecorder,
  cancelRecorderStart,
  isRecorderTransitioning,
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
let calibrationInterrupted = false;
let advancedMonitoringPaused = false;
const CALIB_TARGET_SPL = LIMITS.CALIB_TARGET_SPL; // 固定的 1kHz 纯音参考标准
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
    
    // --- 新增：专门用于大字提示的 UI 状态 ---
    statusText: '等待开始...\n请将麦克风靠近声级计',
    statusColor: THEME_COLORS.DARK_GRAY,
    isCalibratingUI: false // 处于校准流程中时，为 true (可用于隐藏 Canvas)
  },
  isPageActive: false,
  // 核心录音配置：与主测量使用相同的平台采集配置。
  advancedCalibrateRecordParams: {
    ...createCamcorderRecordParams(),
    duration: 10000,
  },
  
  onShow() {
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
    isAdvancedMonitoringActive = false;
    if (currentAdvancedCalibratePage === this) {
      currentAdvancedCalibratePage = null;
    }
    this.stopNoiseMonitoring(); 
  },
  
  onUnload() { 
    this.isPageActive = false;
    isAdvancedMonitoringActive = false;
    if (currentAdvancedCalibratePage === this) {
      currentAdvancedCalibratePage = null;
    }
    this.stopNoiseMonitoring(); 
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

  /**
   * 初始化并绑定录音相关的事件监听器，处理由于系统中断或异常导致的录音停止。
   * 在发生中断（如电话接入）或意外结束时，尝试自动恢复或重启录音流程，以确保校准数据的连续性。
   * 
   * @sideeffect 配置并注册录音机的各类生命周期回调（如 onStop、onInterruptionEnd 等）。
   */
  setupRecorderListeners() {
    bindRecorderListenersOnce(recorderManager, 'advanced-calibrate-listeners', () => {
      // 1. 监听意外停止
      recorderManager.onStop((res) => {
        if (isRecorderTransitioning(recorderManager)) return;
        const page = currentAdvancedCalibratePage;
        if (!isAdvancedMonitoringActive || !page || advancedMonitoringPaused) {
          return;
        }
        console.log('[Recorder] Stopped', res);
        if (isCalibrating) {
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
      recorderManager.onInterruptionEnd(() => {
        const page = currentAdvancedCalibratePage;
        if (isAdvancedMonitoringActive && page && page.isPageActive && !advancedMonitoringPaused) {
          if (isCalibrating) {
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
        if (isAdvancedMonitoringActive && page && isCalibrating) {
          calibrationInterrupted = true;
          page.failCalibration('录音中断或出错，请重新校准');
        }
      };
      if (typeof recorderManager.onInterruptionBegin === 'function') recorderManager.onInterruptionBegin(failInterruptedCalibration);
      if (typeof recorderManager.onError === 'function') recorderManager.onError(failInterruptedCalibration);

    });

    bindRecorderFrameListener(recorderManager, (res) => {
      const page = currentAdvancedCalibratePage;
      if (!isAdvancedMonitoringActive || !page) {
        return;
      }

      const pcm = new Int16Array(res.frameBuffer);
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
        calibrationClipped = calibrationClipped || inspectPcm(pcm.subarray(0, count)).clipped;
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
  stopNoiseMonitoring() {
    advancedMonitoringPaused = true;
    clearAdvancedRecorderRestartTimer();
    clearCalibrationTimers();
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    audioCtx = safeCloseAudioContext(audioCtx);
  },

  // ================= 严格校准交互流程 =================

  // 1. 唯一校准入口 (仅 1kHz, 80dB)
  startCalibrationProcess() {
    if (isCalibrating || this.data.isCalibratingUI) return;
    clearCalibrationTimers();
    clearAdvancedRecorderRestartTimer();
    advancedMonitoringPaused = false;
    this.setupRecorderListeners();
    advancedRecorderRestartTimerId = restartRecorderSession(recorderManager, this.advancedCalibrateRecordParams, 0);
    this.setData({ isCalibratingUI: true });

    let countdown = 3;
    const showCountdown = () => {
      calibrationCountdownTimerId = null;
      if (!this.isPageActive || currentAdvancedCalibratePage !== this) {
        return;
      }
      if (countdown > 0) {
        // 倒数标红，提示退后
        this.setData({
          statusText: `准备中：${countdown} 秒\n请松开手机，后退并保持绝对安静！`,
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
    calibrationInterrupted = false;
    isCalibrating = true;

    // 录制标绿
    this.setData({
      statusText: `正在采集中 (5秒)...\n请勿发出任何声响`,
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
    
    // 偏移量 = 真实基准声压(80) - 测得数字分贝
    const calibrationOffset = CALIB_TARGET_SPL - leqDbfs;

    const hasValidSignal = Number.isFinite(meanSquare)
      && Number.isFinite(rms)
      && rms > MIN_CALIBRATION_RMS
      && !calibrationClipped
      && inspectCalibrationTone(calibSignal, CALIB_SAMPLE_RATE).valid;
    const hasValidOffset = Number.isFinite(calibrationOffset)
      && calibrationOffset >= OFFSET_IMPORT_RANGE.MIN
      && calibrationOffset <= OFFSET_IMPORT_RANGE.MAX;

    if (!hasValidSignal || !hasValidOffset) {
      this.failCalibration(calibrationClipped ? '输入达到满幅，不能校准' : '校准失败：需要稳定、足够强的 1kHz 纯音');
      return;
    }

    this.setData({
      newOffset: calibrationOffset.toFixed(2),
      statusText: `校准完成！\nLeq dBFS: ${leqDbfs.toFixed(2)}\n计算偏移量: ${calibrationOffset.toFixed(2)} dB`,
      statusColor: THEME_COLORS.SAFE_ASSIST,
      isCalibratingUI: false
    });
    this.stopNoiseMonitoring();
    calibSignal = null;
    this.saveOffset();
  },

  // 4. 保存并应用逻辑
  saveOffset() {
    let that = this;
    let offsetVal = parseFloat(this.data.newOffset);

    if (!Number.isFinite(offsetVal)
      || offsetVal < OFFSET_IMPORT_RANGE.MIN
      || offsetVal > OFFSET_IMPORT_RANGE.MAX) {
      wx.showToast({ title: '校准结果无效，请重新校准', icon: 'none' });
      return;
    }
    
    wx.showModal({
      title: "应用校准结果",
      content: `1kHz基准计算偏移量为：${offsetVal} dB\n是否立即覆盖当前设备配置？`,
      success(res) {
        if (res.confirm) {
          dataModel.setOffset(offsetVal, {
            captureProfile: getMeasurementCaptureProfile(),
            deviceId: getCurrentDeviceCalibrationId(),
            source: 'advanced-1khz-calibration',
          });
          offset = offsetVal; 
          wx.showToast({ title: '校准已生效', icon: 'success' });
        }
      },
      complete() {
        if (isAdvancedMonitoringActive && that.isPageActive) {
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
