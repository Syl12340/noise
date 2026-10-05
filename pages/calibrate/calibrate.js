// pages/calibrate/calibrate.js
// 作用：快速环境声学校准界面，支持基于预设场景或快速采样本底噪声进行粗略校准。
const recorderManager = wx.getRecorderManager();

const { calculateRMS, calculateDb } = require('../../utils/audio-math');
const { LIMITS, CANVAS_CONFIG, THEME_COLORS, OFFSET_IMPORT_RANGE } = require('../../utils/constants');
const dataModel = require('../../utils/data-model');
const { DCBlocker, inspectPcm, PcmQualityInspector } = require('../../utils/audio-quality');
const {
  initCanvasFrontAsync,
  recordArrayPoint,
  drawCanvasMesh,
  drawCanvasMark,
  drawWaveformFrame,
} = require('../../utils/canvas/index');
const {
  safeStopRecorder,
  cancelRecorderStart,
  isRecorderTransitioning,
  observeRecorderEvent,
  observeRecorderState,
  createCamcorderRecordParams,
  getMeasurementCaptureProfile,
  getCurrentDeviceCalibrationId,
  bindRecorderFrameListener,
  bindRecorderListenersOnce,
  clearRecorderFrameListener,
  restartRecorderSession,
} = require('../../utils/recorder-session');

let canvasf, ctxf, dpr;

// --- 全局状态变量 ---
let offset, dBArray, time, frameCount = 0;
let lastFrameTimestamp = 0;
let elapsedMsAccumulator = 0;
let isCalibrating = false;
let isCalibrateMonitoringActive = false;
let calibEnergySum = 0;
let calibSamples = 0;
let calibPcmMin = 32767;
let calibPcmMax = -32768;
let dcBlocker = new DCBlocker(44100);
let calibClipped = false;
let calibQualityInspector = new PcmQualityInspector(44100);
let roughCalibrationTimer = null;
let calibrationInterrupted = false;
const ROUGH_CALIBRATION_REQUIRED_SAMPLES = 44100 * 2;
let instantLimit = LIMITS.INSTANT_DB_LIMIT_DEFAULT;
let currentCalibratePage = null;
let calibrateRecorderStartTimerId = null;
const calibrateRecordParams = createCamcorderRecordParams();


function clearCalibrateRecorderStartTimer() {
  cancelRecorderStart(recorderManager);
  if (calibrateRecorderStartTimerId) {
    if (typeof calibrateRecorderStartTimerId === 'number') clearTimeout(calibrateRecorderStartTimerId);
    calibrateRecorderStartTimerId = null;
  }
}

const globalSize = CANVAS_CONFIG.CALIBRATE.GLOBAL_SIZE;
const scaleX = CANVAS_CONFIG.CALIBRATE.SCALE_X;
const scaleY = CANVAS_CONFIG.CALIBRATE.SCALE_Y;

// ================= Canvas 渲染引擎  =================
/**
 * 绘制图表背景网格与界限线
 * @param {CanvasRenderingContext2D} ctx - Canvas 绘制上下文
 * @param {number} mtX - 网格左边缘 X 坐标
 * @param {number} ltX - 网格右边缘 X 坐标
 * @param {number} thresholdLine - 高亮阈值线数值
 * @return {void}
 */
function mesh(ctx, mtX, ltX, thresholdLine) {
  drawCanvasMesh(ctx, {
    leftBoundary: mtX,
    rightBoundary: ltX,
    thresholdLine,
    thresholdVisible: !!thresholdLine,
    scaleY,
    gridColor: THEME_COLORS.GRID,
    primaryColor: THEME_COLORS.PRIMARY,
    thresholdLineWidth: 0.5,
  });
}

function mark(ctx, thresholdLine) {
  drawCanvasMark(ctx, {
    globalSize,
    scaleY,
    thresholdLine,
    thresholdVisible: !!thresholdLine,
    neutralColor: THEME_COLORS.NEUTRAL,
    primaryColor: THEME_COLORS.PRIMARY,
  });
}

/**
 * 局部刷新最新瞬态波形，提升绘制流畅度
 * @param {CanvasRenderingContext2D} ctx - 绘图上下文
 * @param {number} currentTime - 最新的时间帧索引
 * @return {void}
 */
function draw(ctx, currentTime) { 
  drawWaveformFrame(ctx, {
    clearRect: [0, -globalSize - 50, globalSize + 100, globalSize + 100],
    drawBackground: () => {
      mesh(ctx, 0, globalSize, instantLimit);
      mark(ctx, instantLimit);
    },
    globalSize,
    scaleX,
    scaleY,
    currentTime,
    dBArray,
    getStrokeColor: (currentDB) => {
      return currentDB >= instantLimit ? THEME_COLORS.PRIMARY : THEME_COLORS.SAFE_ASSIST;
    },
  });
}


// ================= 页面逻辑 =================
Page({
  data: {
    dbfs: '0.00',
    dbspl: '0.00',
    presetCalibration: "未开始",
    newOffset: '--',
    canSaveCalibration: false,
    recordingReady: false,
    recordingState: 'idle',
  },

  onReady() {
    const query = wx.createSelectorQuery();
    initCanvasFrontAsync(query, globalSize)
      .then((res) => {
        canvasf = res.canvas;
        ctxf = res.ctx;
        dpr = res.dpr;
      })
      .catch((error) => {
        console.warn('[calibrate] init canvas failed:', error);
      });
  },

  onShow() {
    currentCalibratePage = this;
    isCalibrateMonitoringActive = true;
    this.initMonitor();
    this.noiseDetect();
  },

  onHide() {
    this.stopCalibrateMonitoring();
  },
  /**
   * 停止并销毁录音机数据事件与监听钩子，阻断物理设备的调用防止内存泄露。
   * 该机制主要用于确保在退出页面时，底层音频流和尚未触发的定时任务被正确清除。
   * @sideeffect 停止录音，清除页面引用与定时器。
   */
  stopCalibrateMonitoring() {
    if (currentCalibratePage !== this) return;
    this.completedCalibration = null;
    this.setData({ canSaveCalibration: false });
    if (roughCalibrationTimer) clearTimeout(roughCalibrationTimer);
    roughCalibrationTimer = null;
    isCalibrating = false;
    wx.hideLoading();
    isCalibrateMonitoringActive = false;
    currentCalibratePage = null;
    clearCalibrateRecorderStartTimer();
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
  },


  initMonitor() {
    dcBlocker = new DCBlocker(44100);
    offset = dataModel.getOffset();
    this.completedCalibration = null;
    this.pendingCalibrationTarget = null;
    this.setData({ newOffset: '--', presetCalibration: '未开始', canSaveCalibration: false, recordingReady: false, recordingState: 'idle' });
    
    dBArray =[];
    time = 0;
    frameCount = 0;
    lastFrameTimestamp = 0;
    elapsedMsAccumulator = 0;
    isCalibrating = false;
  },

  doRoughCalibrate(e) {
    if (isCalibrating) return;
    const targetSPL = parseFloat(e.currentTarget.dataset.spl);
    const targetName = e.currentTarget.dataset.name;
    this.completedCalibration = null;
    this.setData({ newOffset: '--', canSaveCalibration: false });
    if (!isCalibrateMonitoringActive || !Number.isFinite(targetSPL)) return;
    instantLimit = targetSPL; // 图表动态显示目标红线
    
    // 开启积分
    isCalibrating = true;
    calibEnergySum = 0;
    calibSamples = 0;
    calibPcmMin = 32767;
    calibPcmMax = -32768;
    calibClipped = false;
    calibQualityInspector = new PcmQualityInspector(44100);
    calibrationInterrupted = false;
    
    wx.showLoading({ title: '环境采样中...', mask: true });

    this.pendingCalibrationTarget = { targetSPL, targetName };
    // 原生启动等待由录音管理器处理，不能提前耗尽两秒采样的时间预算。
    if (this.data.recordingReady) this.armRoughCalibrationTimeout();
    else if (this.data.recordingState !== 'starting') this.noiseDetect();
  },

  armRoughCalibrationTimeout() {
    if (roughCalibrationTimer) clearTimeout(roughCalibrationTimer);
    roughCalibrationTimer = setTimeout(() => {
      roughCalibrationTimer = null;
      if (isCalibrating) this.failRoughCalibration('采样不足 2 秒，请重试');
    }, 3500);

  },

  failRoughCalibration(message) {
    this.completedCalibration = null;
    if (roughCalibrationTimer) clearTimeout(roughCalibrationTimer);
    roughCalibrationTimer = null;
    isCalibrating = false;
    wx.hideLoading();
    this.setData({ newOffset: '--', canSaveCalibration: false });
    wx.showToast({ title: message, icon: 'none', duration: 2500 });
  },

  finalizeRoughCalibration() {
    const target = this.pendingCalibrationTarget;
    if (!target || calibSamples !== ROUGH_CALIBRATION_REQUIRED_SAMPLES || calibrationInterrupted) {
      this.failRoughCalibration('录音不连续，校准无效');
      return;
    }
    if (roughCalibrationTimer) clearTimeout(roughCalibrationTimer);
    roughCalibrationTimer = null;
    isCalibrating = false;
    wx.hideLoading();

    const rms = Math.sqrt(calibEnergySum / calibSamples);
    if (calibPcmMax - calibPcmMin <= 2) {
      this.failRoughCalibration('输入无有效交流信号，校准无效');
      return;
    }
    if (!Number.isFinite(rms) || rms < 1e-5 || calibClipped) {
      this.failRoughCalibration('输入过弱或过载，校准无效');
      return;
    }
    const leqDbfs = calculateDb(rms, 1.0);
    const calibrationOffset = target.targetSPL - leqDbfs;
    if (!Number.isFinite(calibrationOffset) || calibrationOffset < OFFSET_IMPORT_RANGE.MIN || calibrationOffset > OFFSET_IMPORT_RANGE.MAX) {
      this.failRoughCalibration('校准偏移量超出有效范围');
      return;
    }
    this.completedCalibration = {
      offset: calibrationOffset,
      captureProfile: getMeasurementCaptureProfile(),
      deviceId: getCurrentDeviceCalibrationId(),
      source: 'rough-calibration',
      calibratedAt: Date.now(),
    };
    this.setData({
      presetCalibration: target.targetName,
      newOffset: calibrationOffset.toFixed(2),
      canSaveCalibration: true,
    });
    wx.showToast({ title: '参数已生成', icon: 'success' });
  },

  saveOffset() {
    const completed = this.completedCalibration;
    if (!completed || isCalibrating || !isCalibrateMonitoringActive) {
      wx.showToast({ title: '请先完成一次有效校准', icon: 'none' });
      return;
    }
    const val = completed.offset;
    wx.showModal({
      title: '应用校准',
      content: `确定将偏移量设为 ${val.toFixed(2)} dB 吗？`,
      success: (res) => {
        if (res.confirm && isCalibrateMonitoringActive && this.completedCalibration === completed
          && completed.captureProfile === getMeasurementCaptureProfile()
          && completed.deviceId === getCurrentDeviceCalibrationId()) {
          dataModel.setOffset(val, completed);
          wx.showToast({ title: '已保存' });
          setTimeout(() => wx.navigateBack(), 1000);
        }
      }
    });
  },

  /**
   * 启动校准页录音并绑定帧处理。
   * @returns {void}
   * Side effect: 替换 recorder 帧监听并重启录音会话。
   */
  noiseDetect() {
    bindRecorderListenersOnce(recorderManager, 'rough-calibrate-listeners', () => {
      observeRecorderState(recorderManager, state => {
        const page = currentCalibratePage;
        if (!isCalibrateMonitoringActive || !page) return;
        page.setData({ recordingReady: state === 'recording', recordingState: state });
        if (state === 'recording' && isCalibrating) page.armRoughCalibrationTimeout();
        if (state === 'error' && isCalibrating) page.failRoughCalibration('录音启动或停止失败，请重试');
      });
      const failActiveCalibration = () => {
        const page = currentCalibratePage;
        if (isCalibrateMonitoringActive && page && isCalibrating) {
          calibrationInterrupted = true;
          page.failRoughCalibration('录音中断或出错，请重新校准');
        }
      };
      observeRecorderEvent(recorderManager, 'InterruptionBegin', failActiveCalibration);
      observeRecorderEvent(recorderManager, 'Pause', failActiveCalibration);
      observeRecorderEvent(recorderManager, 'Error', failActiveCalibration);
      observeRecorderEvent(recorderManager, 'Stop', () => {
        if (!isRecorderTransitioning(recorderManager)) failActiveCalibration();
      });
    });

    const isFrameListenerBound = bindRecorderFrameListener(recorderManager, (res) => {
      const page = currentCalibratePage;
      if (!isCalibrateMonitoringActive || !page) {
        return;
      }
      if (!res || !res.frameBuffer || !Number.isFinite(res.frameBuffer.byteLength) || res.frameBuffer.byteLength % 2 !== 0) {
        if (isCalibrating) page.failRoughCalibration('音频数据格式无效，请重试');
        return;
      }
      const pcm = new Int16Array(res.frameBuffer);
      if (!pcm.length) return;
      const buffer = dcBlocker.process(pcm);
      const dbfs = calculateDb(calculateRMS(buffer), 1);
      
      // 积分采样期
      if (isCalibrating) {
        const count = Math.min(buffer.length, ROUGH_CALIBRATION_REQUIRED_SAMPLES - calibSamples);
        const calibrationPcm = pcm.subarray(0, count);
        const inputQuality = inspectPcm(calibrationPcm, calibQualityInspector);
        calibClipped = calibClipped || inputQuality.clipped;
        for (let i = 0; i < count; i++) {
          calibPcmMin = Math.min(calibPcmMin, calibrationPcm[i]);
          calibPcmMax = Math.max(calibPcmMax, calibrationPcm[i]);
          const s = buffer[i];
          calibEnergySum += s * s;
        }
        calibSamples += count;
        if (calibSamples === ROUGH_CALIBRATION_REQUIRED_SAMPLES) {
          page.finalizeRoughCalibration();
        }
      }

      frameCount++;
      const now = Date.now();
      if (lastFrameTimestamp === 0) {
        lastFrameTimestamp = now;
        return;
      }
      elapsedMsAccumulator += (now - lastFrameTimestamp);
      lastFrameTimestamp = now;
      
      if (elapsedMsAccumulator >= 1000) {
        elapsedMsAccumulator -= 1000;
        time++;
        
        recordArrayPoint(dBArray, time, dbfs + offset);
        
        draw(ctxf, time);
        
        page.setData({ 
          dbfs: dbfs.toFixed(2), 
          dbspl: (dbfs + offset).toFixed(2) 
        });
      }
    });

    if (!isFrameListenerBound) {
      return;
    }

    if (!isCalibrateMonitoringActive) {
      return;
    }

    clearCalibrateRecorderStartTimer();
    calibrateRecorderStartTimerId = restartRecorderSession(recorderManager, calibrateRecordParams, 50);
  },

  stopNoiseMonitoring() {
    this.stopCalibrateMonitoring();
    wx.navigateBack();
  },

  onUnload() {
    this.stopCalibrateMonitoring();
  }
});
