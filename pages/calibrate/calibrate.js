// pages/calibrate/calibrate.js
// 作用：快速环境声学校准界面，支持基于预设场景或快速采样本底噪声进行粗略校准。
const recorderManager = wx.getRecorderManager();

const { calculateRMS, calculateDb } = require('../../utils/audio-math');
const { LIMITS, CANVAS_CONFIG, THEME_COLORS } = require('../../utils/constants');
const dataModel = require('../../utils/data-model');
const { safeStopRecorder, createCamcorderRecordParams, bindRecorderFrameListener, clearRecorderFrameListener, restartRecorderSession } = require('../../utils/recorder-session');

let canvasf, ctxf, dpr;

// --- 全局状态变量 ---
let offset, dBArray, time, frameCount = 0;
let lastFrameTimestamp = 0;
let elapsedMsAccumulator = 0;
let isCalibrating = false;
let isCalibrateMonitoringActive = false;
let calibEnergySum = 0;
let calibSamples = 0;
let instantLimit = LIMITS.INSTANT_DB_LIMIT_DEFAULT;
let currentCalibratePage = null;
let calibrateRecorderStartTimerId = null;
const calibrateRecordParams = createCamcorderRecordParams();


function clearCalibrateRecorderStartTimer() {
  if (calibrateRecorderStartTimerId) {
    clearTimeout(calibrateRecorderStartTimerId);
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
  // 1. 批量绘制基础网格 (合并路径)
  ctx.strokeStyle = THEME_COLORS.GRID;
  ctx.lineWidth = 0.2;
  ctx.setLineDash([]);
  
  ctx.beginPath();
  for (let db = 0; db <= 130; db += 10) {
    const y = db * scaleY;
    ctx.moveTo(mtX, -y);
    ctx.lineTo(ltX, -y);
  }
  ctx.stroke();

  // 2. 绘制独立的瞬时边界高亮线
  if (thresholdLine) {
    ctx.beginPath();
    ctx.strokeStyle = THEME_COLORS.PRIMARY;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([5, 3]);
    const targetY = thresholdLine * scaleY;
    ctx.moveTo(mtX, -targetY);
    ctx.lineTo(ltX, -targetY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function mark(ctx, thresholdLine) {
  ctx.fillStyle = THEME_COLORS.NEUTRAL;
  ctx.font = '10px Arial';
  
  ctx.textAlign = 'left';
  ctx.fillText('SPL [dB(Z)]', 5, -globalSize + 15); 
  
  ctx.textAlign = 'right';
  for (let db = 130; db >= 0; db -= 20) {
    const y = db * scaleY;
    ctx.fillText(`${db}`, globalSize - 5, -y - 3);
  }
  if (thresholdLine) {
    ctx.fillStyle = THEME_COLORS.PRIMARY;
    ctx.fillText(`${thresholdLine}`, globalSize - 5, -(thresholdLine * scaleY) - 3);
  }
}

/**
 * 局部刷新最新瞬态波形，提升绘制流畅度
 * @param {CanvasRenderingContext2D} ctx - 绘图上下文
 * @param {number} currentTime - 最新的时间帧索引
 * @return {void}
 */
function draw(ctx, currentTime) { 
  // 1. 基于当前坐标系精确清空绘图区域
  ctx.clearRect(0, -globalSize-50, globalSize+100, globalSize+100);
  
  // 2. 绘制静态背景
  mesh(ctx, 0, globalSize, instantLimit);
  mark(ctx, instantLimit);
  
  // 3. 计算波形可视窗口
  const maxPoints = Math.floor(globalSize / scaleX); 
  const startIdx = Math.max(1, currentTime - maxPoints + 1);
  const xOffset = (currentTime <= maxPoints) ? 0 : (currentTime - maxPoints) * scaleX;
  
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  
  // 4. 动态波形分段渲染
  for (let t = startIdx; t <= currentTime; t++) {
    let currentDB = dBArray[t];
    let previousDB = dBArray[t-1];
    
    ctx.strokeStyle = currentDB >= instantLimit ? THEME_COLORS.PRIMARY : THEME_COLORS.SAFE_ASSIST;
    
    let startX = (t - 1) * scaleX - xOffset;
    let endX = t * scaleX - xOffset;
    
    ctx.beginPath();
    ctx.moveTo(startX, -previousDB * scaleY);
    ctx.lineTo(endX, -currentDB * scaleY);
    ctx.stroke();
  }
}


// ================= 页面逻辑 =================
Page({
  data: {
    dbfs: '0.00',
    dbspl: '0.00',
    presetCalibration: "未开始",
    newOffset: '0.00',
  },

  onReady() {
    const query = wx.createSelectorQuery();
    query.select('#canvas-front').fields({ node: true, size: true }).exec((res) => {
      canvasf = res[0].node;
      ctxf = canvasf.getContext('2d');
      dpr = wx.getWindowInfo().pixelRatio;
      
      // 物理像素映射
      canvasf.width = res[0].width * dpr;
      canvasf.height = res[0].height * dpr;   
      ctxf.scale(dpr, dpr);
      ctxf.translate(0, globalSize);
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
   * 
   * @sideeffect 停止录音，清除页面引用与定时器。
   */
  stopCalibrateMonitoring() {
    isCalibrateMonitoringActive = false;
    currentCalibratePage = null;
    clearCalibrateRecorderStartTimer();
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
  },


  initMonitor() {
    offset = dataModel.getOffset();
    this.setData({ newOffset: offset.toFixed(2) });
    
    dBArray =[];
    time = 0;
    frameCount = 0;
    lastFrameTimestamp = 0;
    elapsedMsAccumulator = 0;
    isCalibrating = false;
  },

  doRoughCalibrate(e) {
    const targetSPL = parseFloat(e.currentTarget.dataset.spl);
    const targetName = e.currentTarget.dataset.name;
    instantLimit = targetSPL; // 图表动态显示目标红线
    
    // 开启积分
    isCalibrating = true;
    calibEnergySum = 0;
    calibSamples = 0;
    
    wx.showLoading({ title: '环境采样中...', mask: true });

    // 采集 2 秒钟的数据求等效连续均值
    setTimeout(() => {
      isCalibrating = false;
      wx.hideLoading();
      
      if (calibSamples === 0) {
        wx.showToast({ title: '采样失败', icon: 'error' });
        return;
      }

      const meanSquare = calibEnergySum / calibSamples;
      const rms = Math.sqrt(meanSquare);
      const leqDbfs = calculateDb(rms, 1.0);
      const calibrationOffset = targetSPL - leqDbfs;

      this.setData({
        presetCalibration: targetName,
        newOffset: calibrationOffset.toFixed(2),
      });

      wx.showToast({ title: '参数已生成', icon: 'success' });
    }, 2000);
  },

  saveOffset() {
    const val = parseFloat(this.data.newOffset);
    wx.showModal({
      title: '应用校准',
      content: `确定将偏移量设为 ${val} dB 吗？`,
      success: (res) => {
        if (res.confirm) {
          dataModel.setOffset(val);
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
    const isFrameListenerBound = bindRecorderFrameListener(recorderManager, (res) => {
      const page = currentCalibratePage;
      if (!isCalibrateMonitoringActive || !page) {
        return;
      }
      const buffer = new Int16Array(res.frameBuffer);
      const dbfs = calculateDb(calculateRMS(buffer), 32768.0);
      
      // 积分采样期
      if (isCalibrating) {
        for (let i = 0; i < buffer.length; i++) {
          let s = buffer[i] / 32768.0;
          calibEnergySum += s * s;
        }
        calibSamples += buffer.length;
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
        
        if (time === 1) dBArray[0] = dbfs + offset;
        dBArray[time] = dbfs + offset;
        
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