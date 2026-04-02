/**
 * main.js - 噪声监测主逻辑
 * 【重要说明】: 本计算采用 Z计权 (无计权物理真实声压)。
 * 明天实验室验证时，请务必将专业声级计设置为 Z档 或 Flat档 (非A计权档位)！
 */

// P2 改进：配置 DEBUG 日志开关
const DEBUG = false; // 设为 true 以启用详细日志

const app = getApp();
const recorderManager = wx.getRecorderManager();
const {
  calculateRMS,
  calculateDb,
  calculateShortCNE,
  AWeightingFilter,
} = require('../../utils/audio-math');
const { LIMITS, CANVAS_CONFIG, THEME_COLORS, RISK_THRESHOLDS } = require('../../utils/constants');
const { buildRiskLevels } = require('../../utils/risk-config');
const dataModel = require('../../utils/data-model');
const resultManager = require('../../utils/result-manager');
const {
  safeStopRecorder,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  bindRecorderFrameListener,
  bindRecorderListenersOnce,
  clearRecorderFrameListener,
  restartRecorderSession,
} = require('../../utils/recorder-session');
let audioCtx, canvasf, ctxf, dpr;

/**
 * === 全局状态变量（监测生命周期内持久化） ===
 * - startDate: 监测开始时间戳
 * - offset: 麦克风硬件偏移量（通过校准获得）
 * - dBArray: 每秒的 Z 计权声压级数组（用于波形图渲染）
 * - time: 当前已监测的总秒数（每秒递增 1）
 * - cne: 当前累积噪声能量值
 * - threat: 当前风险等级文本（安全/需要注意/中风险/高风险/高危）
 * - expectedExposure: 预期暴露时长（秒）
 * - noiseAlarmLevel: 触发报警的 CNE 阈值
 * - riskConfig: 完整的5级风险配置模型（包含阈值、启禁用状态等）
 * - location: 录音时的位置信息（若用户授权）
 * - allowAlarm: 是否启用报警（开关）
 * - isAlarming: 当前是否在展示报警弹框（防止重复弹框）
 * - hasAlerted: 本次监测是否已发过一次报警（确保仅弹一次）
 */
let startDate, offset, dBArray, time, cne, threat, expectedExposure, noiseAlarmLevel, riskConfig;
let location, allowAlarm = true, isAlarming = false, hasAlerted = false;

/**
 * A 计权滤波器实例。
 * 【关键】：必须在整个监测周期内保持唯一一个实例。
 * 因为滤波器内部为 IIR 结构，有状态寄存器 (z1, z2, z3) 需要跨帧记忆。
 * 若每帧重建实例，则状态丢失，滤波器输出错误。
 */
let aWeightingFilter = new AWeightingFilter();

/**
 * === 高性能帧处理变量（避免 O(n) 频繁重算） ===
 * - timeTerm: 预期暴露时长的时间项（= 10×log10(exposureSeconds)）
 * - frameCount: 已收到的音频帧总数
 * - lastFrameTimestamp: 上一帧到达时的时间戳（毫秒）
 * - elapsedMsAccumulator: 帧间隔累积时间（毫秒），达 1000ms 时输出一个秒级数据点
 * - totalEnergySum: CNE 计算中的能量累计器（单位：10^(dB/10)）
 * - globalMaxDB、globalMinDB: 用于K-Factor估算的全局最大/最小值
 * - instantLimit: 示波器的瞬时边界线阈值（通常为 80dB）
 * - isMainMonitoringActive: 标志当前 main 监测会话是否有效（阻断退出后的迟到帧）
 * - currentMainPage: 当前激活的 main 页面实例引用（用于正确的 setData 上下文）
 */
let timeTerm = 0;
let frameCount = 0;
let lastFrameTimestamp = 0;
let elapsedMsAccumulator = 0;
let totalEnergySum = 0;
let globalMaxDB = -Infinity;
let globalMinDB = Infinity;
let instantLimit = LIMITS.INSTANT_DB_LIMIT_DEFAULT;
let currentRiskLevels = [];
let currentMainPage = null;
let isMainMonitoringActive = false;
let mainRecorderStartTimerId = null;

const globalSize = CANVAS_CONFIG.MONITOR.GLOBAL_SIZE;
const scaleX = CANVAS_CONFIG.MONITOR.SCALE_X;
const scaleY = CANVAS_CONFIG.MONITOR.SCALE_Y;

/**
 * 将声压级数据点存入波形数组，用于 Canvas 渲染
 * @param {number} currentTime - 当前秒数索引
 * @param {number} dBSPL - Z 计权声压级（dB SPL）
 * 【注】第一个数据点会被补到 index 0（虽然 time 从 1 开始）
 */
function recordArray(currentTime, dBSPL) {
  if (currentTime === 1) {
    dBArray[0] = dBSPL;
  }
  dBArray[currentTime] = dBSPL;
}

/**
 * 重置一轮 main 监测会话的运行时状态。
 * Side effect: 会清空本轮录音的统计缓存、风险状态与波形缓存。
 */
function resetMonitorSessionState() {
  dBArray = [];
  time = 0;
  frameCount = 0;
  lastFrameTimestamp = 0;
  elapsedMsAccumulator = 0;
  cne = 0;
  totalEnergySum = 0;
  globalMaxDB = -Infinity;
  globalMinDB = Infinity;
  isAlarming = false;
  hasAlerted = false;
  startDate = Date.now();
}

/**
 * 处理单个录音帧的 Z/A 计权计算、秒级汇总、UI 刷新和告警判断。
 * @param {object} page 当前激活的 main 页面实例。
 * @param {object} res 录音帧回调对象。
 * Side effect: 更新页面 data、波形数组、全局统计量与告警状态。
 */
function handleRecordedFrame(page, res) {
  if (!isMainMonitoringActive || !page) {
    return;
  }

  const frameBuffer = res.frameBuffer;
  const buffer = new Int16Array(frameBuffer);

  const energyZ = calculateRMS(buffer);
  const dbfsZ = calculateDb(energyZ, 32768.0);
  const dbsplZ = dbfsZ + offset;

  const bufferA = aWeightingFilter.process(buffer, true);
  let energyA = 0;
  for (let i = 0; i < bufferA.length; i++) {
    energyA += bufferA[i] * bufferA[i];
  }
  energyA = Math.sqrt(energyA / bufferA.length);

  const dbfsA = calculateDb(energyA, 1.0);
  const dbsplA = dbfsA + offset;

  frameCount++;
  const now = Date.now();
  if (lastFrameTimestamp === 0) {
    lastFrameTimestamp = now;
    return;
  }

  elapsedMsAccumulator += (now - lastFrameTimestamp);
  lastFrameTimestamp = now;

  if (elapsedMsAccumulator < 1000) {
    return;
  }

  elapsedMsAccumulator -= 1000;
  time++;

  recordArray(time, dbsplZ);
  draw(ctxf, time);

  const cneResult = calculateShortCNE(
    dbsplA,
    time,
    timeTerm,
    totalEnergySum,
    globalMaxDB,
    globalMinDB
  );
  cne = cneResult.cne;
  totalEnergySum = cneResult.totalEnergySum;
  globalMaxDB = cneResult.globalMaxDB;
  globalMinDB = cneResult.globalMinDB;

  const riskStatus = getRiskStatusByCNE(cne);
  threat = riskStatus.text;

  page.setData({
    dbfs: dbfsZ.toFixed(2),
    dbspl: dbsplZ.toFixed(2),
    cne: cne.toFixed(2),
    threat,
    threatClass: riskStatus.bgClass
  });

  if (allowAlarm && cne >= noiseAlarmLevel && !isAlarming && !hasAlerted) {
    isAlarming = true;
    hasAlerted = true;
    wx.showModal({
      title: '警报',
      content: '噪声累积能量预计将超过健康暴露水平',
      showCancel: false,
      complete: () => {
        isAlarming = false;
      }
    });
    page.doVibrate(5, 500);
  }
}

/**
 * 绑定 main 页当前会话的录音帧回调。
 * @returns {boolean} true 表示回调已生效；false 表示绑定失败。
 * Side effect: 会替换此前页面绑定的 onFrameRecorded 回调。
 */
function bindMainRecorderFrameListener() {
  return bindRecorderFrameListener(recorderManager, (res) => {
    const page = currentMainPage;
    if (!isMainMonitoringActive || !page) {
      return;
    }
    handleRecordedFrame(page, res);
  });
}

/**
 * 绑定 main 页录音生命周期监听（仅注册一次）。
 * @returns {void}
 * Side effect: 注册 recorderManager.onStop / onInterruptionEnd 回调。
 */
function bindMainRecorderLifecycleListeners() {
  bindRecorderListenersOnce(recorderManager, 'main-lifecycle-listeners', () => {
    recorderManager.onStop(() => {
      if (!isMainMonitoringActive || !currentMainPage) {
        return;
      }

      // 会话仍活跃但录音意外停止时，尝试自动恢复。
      scheduleMainRecorderRestart(80);
    });

    recorderManager.onInterruptionEnd(() => {
      if (!isMainMonitoringActive || !currentMainPage) {
        return;
      }

      scheduleMainRecorderRestart(80);
    });
  });
}

/**
 * 取消待启动的 main 录音定时任务。
 * @returns {void}
 * Side effect: 可能清除未执行的 setTimeout。
 */
function cancelPendingMainRecorderStart() {
  if (mainRecorderStartTimerId) {
    clearTimeout(mainRecorderStartTimerId);
    mainRecorderStartTimerId = null;
  }
}

/**
 * 在 main 会话存活时调度一次录音重启。
 * @param {number} delayMs 重启延迟，单位毫秒。
 * @returns {boolean} true 表示重启已成功调度；false 表示当前会话不满足重启条件。
 * Side effect: 会取消旧的待启动定时器，并创建新的录音重启任务。
 */
function scheduleMainRecorderRestart(delayMs) {
  if (!isMainMonitoringActive || !currentMainPage) {
    return false;
  }

  cancelPendingMainRecorderStart();
  const restartResult = restartRecorderSession(recorderManager, currentMainPage.mainRecordParams, delayMs);
  if (restartResult === false) {
    return false;
  }

  mainRecorderStartTimerId = restartResult;
  return true;
}

/**
 * === Canvas 绘制函数组（极致性能优化）===
 * 采用单一 beginPath/stroke 递推绘制网格与阈值线，最小化状态变更
 */

/**
 * 绘制背景网格和瞬时阈值线
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} leftBoundary - 左边界 X 坐标
 * @param {number} rightBoundary - 右边界 X 坐标
 * @param {number} thresholdLine - 瞬时边界线（dB），可选
 */
function mesh(ctx, leftBoundary, rightBoundary, thresholdLine) {
  // --- 1. 批量绘制基础网格 (合并路径，极省性能) ---
  ctx.strokeStyle = THEME_COLORS.GRID;
  ctx.lineWidth = 0.2;
  ctx.setLineDash([]);
  
  ctx.beginPath(); // 开启唯一主路径
  for (let db = 0; db <= 130; db += 10) {
    const y = db * scaleY;
    ctx.moveTo(leftBoundary, -y);
    ctx.lineTo(rightBoundary, -y);
  }
  ctx.stroke(); // 循环外一次性渲染所有基础网格！

  // --- 2. 绘制独立的瞬时边界高亮线 ---
  if (thresholdLine !== undefined && thresholdLine !== null) {
    ctx.beginPath();
    ctx.strokeStyle = THEME_COLORS.PRIMARY;
    ctx.lineWidth = 0.35; 
    ctx.setLineDash([5, 3]); 
    
    const targetY = thresholdLine * scaleY;
    ctx.moveTo(leftBoundary, -targetY);
    ctx.lineTo(rightBoundary, -targetY);
    ctx.stroke();
    
    ctx.setLineDash([]); // 重置虚线配置
  }
}

/**
 * 绘制坐标轴标签与刻度
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} thresholdLine - 瞬时阈值线，用于在右侧标注其 dB 值
 */
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

  // --- 额外绘制红色的瞬时边界数值 ---
  if (thresholdLine !== undefined && thresholdLine !== null) {
    ctx.fillStyle = THEME_COLORS.PRIMARY;
    ctx.font = '10px Arial';
    const targetY = thresholdLine * scaleY;
    ctx.fillText(`${thresholdLine}`, globalSize - 5, -targetY - 3); 
  }
}

/**
 * 绘制完整的波形与图形框架
 * 步骤：清空 → 绘网格 → 绘刻度 → 计算裁剪窗口 → 逐段绘波形
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} currentTime - 当前已统计的秒数
 */
function draw(ctx, currentTime) {
  // 1. 基于当前坐标系精确清空绘图区域
  ctx.clearRect(-10, -globalSize - 50, globalSize + 100, globalSize + 100);
  
  // 2. 绘制静态背景 (网格与刻度)
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
    
    // 动态确定当前线段颜色 - 使用 RISK_THRESHOLDS 常量替代硬编码值
    let targetColor = THEME_COLORS.SAFE_ASSIST;
    if (currentDB >= RISK_THRESHOLDS.HIGH_MAX) targetColor = THEME_COLORS.PRIMARY;
    else if (currentDB >= RISK_THRESHOLDS.ATTENTION_MAX) targetColor = THEME_COLORS.WARN;

    let startX = (t - 1) * scaleX - xOffset;
    let endX = t * scaleX - xOffset;
    
    ctx.beginPath();
    ctx.strokeStyle = targetColor; // 仅在需要时切换状态
    ctx.moveTo(startX, -previousDB * scaleY);
    ctx.lineTo(endX, -currentDB * scaleY);
    ctx.stroke();
  }
}

/**
 * 初始化前景波形 Canvas 的节点与坐标变换。
 * @param {object} query 由 wx.createSelectorQuery() 创建的查询实例。
 * Side effect: 更新全局 canvasf/ctxf/dpr，并设置像素比缩放与坐标系平移。
 */
function initCanvasFront(query){
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
}

/**
 * 基于当前配置好的风险层级动态判断风险
 * @param {number} cneValue - 当前 CNE 值
 * @returns {{text: string, bgClass: string}}
 */
function getRiskStatusByCNE(cneValue) {
  if (!Number.isFinite(cneValue)) {
    return { text: '安全', bgClass: 'detail-safe' };
  }

  const levels = (Array.isArray(currentRiskLevels) && currentRiskLevels.length > 0)
    ? currentRiskLevels
    : buildRiskLevels(riskConfig);

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (cneValue < level.upper) {
      return { text: level.text, bgClass: level.bgClass };
    }
  }

  const lastLevel = levels[levels.length - 1];
  return { text: lastLevel.text, bgClass: lastLevel.bgClass };
}

// ================= 页面主逻辑 =================

Page({
  data:{
    dbfs: '0.00',
    dbspl: '0.00',
    cne: '0.00',
    threat: "暂无数据",
    threatClass:"detail-init",
  },

  // 核心录音参数：必须使用 camcorder 声源绕过通话降噪处理，并保持长时连续采样。
  mainRecordParams: createCamcorderRecordParams({
    duration: 600000,
  }),
  
  onReady() {
    const query = wx.createSelectorQuery();
    initCanvasFront(query);
  },

  onShow() {
    this.startMainMonitoring();
  },

  onHide() {
    this.stopMainMonitoring();
  },

  onUnload() {
    this.stopMainMonitoring();
  },

  /**
   * 初始化一轮 main 监测会话所需的配置、缓存和计时起点。
   * @returns {boolean} true 表示初始化成功；false 表示本轮会话不应启动。
   * Side effect: 读取本地配置、重建 A 计权滤波器、重置会话状态。
   */
  initMonitor() {
    try {
      audioCtx = wx.createWebAudioContext();

      aWeightingFilter = new AWeightingFilter(); 
      
      offset = dataModel.getOffset();
      expectedExposure = dataModel.getExpectedExposureSeconds();
      noiseAlarmLevel = dataModel.getNoiseAlarmLevel();
      riskConfig = dataModel.getRiskConfig();
      currentRiskLevels = buildRiskLevels(riskConfig);
      allowAlarm = dataModel.getAlarmEnabled();
      timeTerm = 10 * Math.log10(expectedExposure);
      resetMonitorSessionState();

      if (DEBUG) {
        console.log('[initMonitor] currentRiskLevels:', currentRiskLevels);
      }
  
      console.log(`[initMonitor] offset:${offset}, expectedExposure:${expectedExposure}, noiseAlarmLevel:${noiseAlarmLevel}, allowAlarm:${allowAlarm}`);
      return true;
    } catch(e) {
      console.log(e);
      isMainMonitoringActive = false;
      return false;
    } 
  },

  /**
   * 启动 main 页监测会话。
   * @returns {boolean} true 表示已成功进入可采样状态；false 表示启动失败。
   * Side effect: 重置会话状态、绑定录音监听器并启动录音。
   */
  startMainMonitoring() {
    currentMainPage = this;
    isMainMonitoringActive = false;
    cancelPendingMainRecorderStart();

    if (!this.initMonitor()) {
      this.stopMainMonitoring();
      return false;
    }

    const isFrameListenerBound = bindMainRecorderFrameListener();
    if (!isFrameListenerBound) {
      this.stopMainMonitoring();
      return false;
    }

    bindMainRecorderLifecycleListeners();
    isMainMonitoringActive = true;
    const restartResult = restartRecorderSession(recorderManager, this.mainRecordParams, 50);
    if (restartResult === false) {
      this.stopMainMonitoring();
      return false;
    }
    mainRecorderStartTimerId = restartResult;
    return true;
  },

  /**
   * 生成当前监测结果的归档对象。
   * @returns {object} 可持久化的结果快照。
   * Side effect: none.
   */
  archive() {
    const currentDate = Date.now();
    const duration = (currentDate - startDate) / 1000; 
    const formattedDate = new Date(currentDate).toLocaleString("zh-CN");
    
    const deviceInfo = wx.getDeviceInfo();
    const deviceName = deviceInfo.brand + ' ' + deviceInfo.model;
    const systemName = deviceInfo.system;
    
    return {
      name: null,
      date: formattedDate,
      duration: duration.toFixed(3),
      exposure: expectedExposure,
      cne: parseFloat(this.data.cne),
      threat: this.data.threat,
      location: location,
      extra: null,
      device: deviceName,
      system: systemName,
      offset: offset,
      vstamp: app.globalData.vstamp,
    };
  },

  /**
   * 保存当前监测结果到本地历史记录。
   * Side effect: 写入本地结果存储并弹出成功提示。
   */
  saveResult(){
    console.group('save')
    const archivedSnapshot = this.archive();
    console.log("archived: ", archivedSnapshot)
    const savedResult = resultManager.add(archivedSnapshot);
    console.log("formed: ", savedResult);
    console.groupEnd();
    wx.showToast({
      title: '保存结果',
      icon: 'success',
      duration: 1000
    });
  },

  /**
   * 处理“保存记录”点击事件。
   * Side effect: 触发结果归档写入和提示弹窗。
   */
  handleSaveResult(){
    try{
      this.saveResult();
    }catch(e){
      console.log(e);
    };
  },

  // 向后兼容旧模板事件名。
  _saveResult(){
    return this.handleSaveResult();
  },

  /**
   * 停止 main 页监测会话并释放资源。
   * Side effect: 终止录音、关闭音频上下文，并阻断后续帧回调写入。
   */
  stopMainMonitoring: function() {
    isMainMonitoringActive = false;
    currentMainPage = null;
    cancelPendingMainRecorderStart();
    safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    audioCtx = safeCloseAudioContext(audioCtx);
  },

  cleanupMonitoring: function() {
    this.stopMainMonitoring();
  },

  stopNoiseMonitoring: function() {
    this.stopMainMonitoring();
    wx.navigateBack();
  },

  recordMyLocation() {
    wx.showLoading({ title: '获取位置信息' });
    wx.getLocation({
      type: 'gcj02',
      altitude: true,
      isHighAccuracy: true,
      highAccuracyExpireTime: 3500,
      success (res) {
        location = {
          latitude: res.latitude,
          longitude: res.longitude,
          altitude: res.altitude,
          accuracy: res.accuracy,
        }
      },
      complete() {
        wx.hideLoading();
      }
    });
  },

  /**
   * 触发指定次数的长震动提醒。
   * @param {number} count 震动次数，必须大于 0。
   * @param {number} interval 每次震动间隔，单位毫秒。
   * Side effect: 调用系统震动能力。
   */
  doVibrate(count, interval = 600) {
    if (count <= 0) return;
    wx.vibrateLong(); // 触发长震动 (约400ms)
    let currentCount = 1;
    const timer = setInterval(() => {
      if (currentCount >= count) {
        clearInterval(timer);
        return;
      }
      wx.vibrateLong();
      currentCount++;
    }, interval);
  },

  /**
   * 启动 main 页录音监测。
   * 兼容旧入口：保留原方法名，内部统一走 startMainMonitoring。
   * @returns {boolean} true 表示本次进入监测流程。
   */
  noiseDetect: function () {
    return this.startMainMonitoring();
  },
  
});