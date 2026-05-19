// pages/main/main.js
// 作用：实施核心的实时噪声监测，基于 Z 计权计算短期等效连续声级（CNE）和暴露风险，并处理预警与录音缓存波形图绘制。

const DEBUG = false; // 设为 true 以启用详细日志

const app = getApp();
const recorderManager = wx.getRecorderManager();
const {
  calculateRMS,
  calculateDb,
  calculateShortCNE,
  AWeightingFilter,
  estimateKFactorSliding,
} = require('../../utils/audio-math');
const { LIMITS, CANVAS_CONFIG, THEME_COLORS } = require('../../utils/constants');
const { computeSpectrum } = require('../../utils/fft');
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
const {
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
  drawSpectrogramFrame: renderSpectrogramFrame,
  drawSpectrogramLabels,
  clearSpectrogram,
} = require('../../utils/canvas/index');
let audioCtx, canvasf, ctxf, dpr;

// === FFT / 频谱 / 频谱图状态 ===
let pcmRingBuffer = new Int16Array(CANVAS_CONFIG.FFT.SIZE); // PCM 环形缓冲区
let pcmWriteIndex = 0;    // 当前写入位置
let fftSampleCount = 0;    // 距上次 FFT 的采样计数
let spectrumBandLevels = null; // 最新 1/3 倍频程频段数据
let spectrogramState = null;   // 频谱图状态对象
let currentViewMode = 'waveform'; // 当前视图模式

// 各视图的 Canvas 上下文
let canvasSpectrum = null, ctxSpectrum = null;
let canvasSpectrogram = null, ctxSpectrogram = null;
let spectrogramOffCanvas = null; // 离屏 canvas，用于 putImageData 中转

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
 * - timeTerm: 预期暴露时长时间项（= 10×log10(T/T0)，T0=28800s）
 * - frameCount: 已收到的音频帧总数
 * - lastFrameTimestamp: 上一帧到达时的时间戳（毫秒）
 * - elapsedMsAccumulator: 帧间隔累积时间（毫秒），达 1000ms 时输出一个秒级数据点
 * - totalEnergySum: CNE 计算中的能量累计器（单位：10^(dB/10)）
 * - instantLimit: 示波器的瞬时边界线阈值（通常为 80dB）
 * - isMainMonitoringActive: 标志当前 main 监测会话是否有效（阻断退出后的迟到帧）
 * - currentMainPage: 当前激活的 main 页面实例引用（用于正确的 setData 上下文）
 */
let timeTerm = 0;
let frameCount = 0;
let lastFrameTimestamp = 0;
let elapsedMsAccumulator = 0;
let uiElapsedMsAccumulator = 0;
let totalEnergySum = 0;
let instantLimit = LIMITS.INSTANT_DB_LIMIT_DEFAULT;
let currentRiskLevels = [];
let currentMainPage = null;
let isMainMonitoringActive = false;
let mainRecorderStartTimerId = null;

let globalSize = CANVAS_CONFIG.MONITOR.GLOBAL_SIZE;
const scaleX = CANVAS_CONFIG.MONITOR.SCALE_X;
const scaleY = CANVAS_CONFIG.MONITOR.SCALE_Y;

/**
 * 将声压级数据点存入波形数组，用于 Canvas 渲染
 * @param {number} currentTime - 当前秒数索引
 * @param {number} dBSPL - Z 计权声压级（dB SPL）
 * @return {void}
 * 第一个数据点会被补到 index 0（虽然 time 从 1 开始）
 */
function recordArray(currentTime, dBSPL) {
  recordArrayPoint(dBArray, currentTime, dBSPL);
}

/**
 * 在新一轮环境声学采样流程建立之前初始化数据及图形域。
 * 清空之前缓存的统计数组、积分计数器和风险评估状态记录，
 * 保障单次连续监控的数据流不致发生交叉覆盖现象。
 * @sideeffect 重启 `dBArray`、`cne` 等业务标量及清除告警阻塞标志位。
 */
function resetMonitorSessionState() {
  dBArray = [];
  time = 0;
  frameCount = 0;
  lastFrameTimestamp = 0;
  elapsedMsAccumulator = 0;
  uiElapsedMsAccumulator = 0;
  cne = 0;
  totalEnergySum = 0;
  isAlarming = false;
  hasAlerted = false;
  startDate = Date.now();

  // 重置 FFT 状态
  pcmRingBuffer.fill(0);
  pcmWriteIndex = 0;
  fftSampleCount = 0;
  spectrumBandLevels = null;
  // 频谱图状态保留画布尺寸，仅清空像素
  if (spectrogramState) {
    clearSpectrogram(spectrogramState);
  }
}

/**
 * 高吞吐量实录帧音频流的主要处理流水线。
 * 利用主线程逐行读取每次麦克风底层传来的脉冲编码信号，
 * 按顺序实施 Z 计权有效推导与 A 计权等响度数字滤波分析；
 * 计算单秒能量均值，然后实时渲染到前端 Canvas 和风险显示接口。
 * @param {object} page - 环境所依附的前端 Page 沙盒内实例
 * @param {object} res - 硬件麦克风实时返回的帧向音频缓冲内存块
 * @sideeffect 在闭包下修改记录队列，并驱动相关健康暴露与弹窗预警机制。
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

  // === 新增：累积原始 PCM 到环形缓冲区用于 FFT ===
  const frameLen = buffer.length;
  for (let i = 0; i < frameLen; i++) {
    pcmRingBuffer[pcmWriteIndex] = buffer[i];
    pcmWriteIndex = (pcmWriteIndex + 1) % CANVAS_CONFIG.FFT.SIZE;
  }
  fftSampleCount += frameLen;

  // 按步进长度触发 FFT，提升频谱时间分辨率
  const fftHopSize = CANVAS_CONFIG.FFT.HOP_SIZE || 1600;
  if (fftSampleCount >= fftHopSize) {
    fftSampleCount -= fftHopSize;

    // 从环形缓冲区提取有序样本
    const fftSize = CANVAS_CONFIG.FFT.SIZE;
    const fftInput = new Int16Array(fftSize);
    const startRead = pcmWriteIndex; // 最旧的样本位置
    for (let i = 0; i < fftSize; i++) {
      fftInput[i] = pcmRingBuffer[(startRead + i) % fftSize];
    }

    // 计算 FFT 频谱
    const spectrumDB = computeSpectrum(fftInput, offset);

    // 更新 1/3 倍频程频段
    spectrumBandLevels = computeThirdOctaveBands(spectrumDB);

    // 追加到频谱图
    if (spectrogramState) {
      appendSpectrogramColumn(spectrogramState, spectrumDB, CANVAS_CONFIG.SPECTROGRAM.STRIP_WIDTH);
    }

    // 触发当前活跃视图的重绘
    drawActiveView();
  }

  frameCount++;
  const now = Date.now();
  if (lastFrameTimestamp === 0) {
    lastFrameTimestamp = now;
    return;
  }

  elapsedMsAccumulator += (now - lastFrameTimestamp);
  uiElapsedMsAccumulator += (now - lastFrameTimestamp);
  lastFrameTimestamp = now;

  if (uiElapsedMsAccumulator >= 500) {
    uiElapsedMsAccumulator -= 500;

    page.setData({
      dbfs: dbfsZ.toFixed(2),
      dbspl: dbsplZ.toFixed(2),
    });
  }

  if (elapsedMsAccumulator < 1000) {
    return;
  }

  elapsedMsAccumulator -= 1000;
  time++;

  recordArray(time, dbsplZ);

  // 仅在波形模式下每秒重绘波形
  if (currentViewMode === 'waveform') {
    draw(ctxf, time);
  }

  const currentKFactor = estimateKFactorSliding(dBArray, time, 10);

  const cneResult = calculateShortCNE(
    dbsplA,
    time,
    timeTerm,
    totalEnergySum,
    currentKFactor
  );
  cne = cneResult.cne;
  totalEnergySum = cneResult.totalEnergySum;

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


// 绑定 main 页录音生命周期监听（仅注册一次）。
// 注册 recorderManager.onStop / onInterruptionEnd 回调。
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


//取消待启动的 main 录音定时任务。
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

// === Canvas 绘制函数组（极致性能优化）===
//采用单一 beginPath/stroke 递推绘制网格与阈值线，最小化状态变更

/**
 * 绘制背景网格和瞬时阈值线
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} leftBoundary - 左边界 X 坐标
 * @param {number} rightBoundary - 右边界 X 坐标
 * @param {number} thresholdLine - 瞬时边界线（dB），可选
 */
function mesh(ctx, leftBoundary, rightBoundary, thresholdLine) {
  drawCanvasMesh(ctx, {
    leftBoundary,
    rightBoundary,
    thresholdLine,
    thresholdVisible: thresholdLine !== undefined && thresholdLine !== null,
    scaleY,
    gridColor: THEME_COLORS.GRID,
    primaryColor: THEME_COLORS.PRIMARY,
    thresholdLineWidth: 0.35,
  });
}

/**
 * 绘制坐标轴标签与刻度
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} thresholdLine - 瞬时阈值线，用于在右侧标注其 dB 值
 */
function mark(ctx, thresholdLine) {
  drawCanvasMark(ctx, {
    globalSize,
    scaleY,
    thresholdLine,
    thresholdVisible: thresholdLine !== undefined && thresholdLine !== null,
    neutralColor: THEME_COLORS.NEUTRAL,
    primaryColor: THEME_COLORS.PRIMARY,
  });
}

/**
 * 绘制完整的波形与图形框架
 * 步骤：清空 → 绘网格 → 绘刻度 → 计算裁剪窗口 → 逐段绘波形
 * @param {CanvasContext} ctx - Canvas 2D 上下文
 * @param {number} currentTime - 当前已统计的秒数
 */
function draw(ctx, currentTime) {
  drawWaveformFrame(ctx, {
    clearRect: [-10, -globalSize - 50, globalSize + 100, globalSize + 100],
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
      const status = getRiskStatusByCNE(currentDB);
      if (status.key === 'EXTREME') return THEME_COLORS.PRIMARY;
      if (status.key === 'ATTENTION' || status.key === 'MEDIUM' || status.key === 'HIGH') return THEME_COLORS.WARN;
      return THEME_COLORS.SAFE_ASSIST;
    },
  });
}

/**
 * 绘制当前活跃视图
 * 根据 currentViewMode 分发到对应的渲染函数
 * @returns {void}
 */
function drawActiveView() {
  if (currentViewMode === 'spectrum' && spectrumBandLevels && ctxSpectrum) {
    drawSpectrumFrame(ctxSpectrum, {
      bandLevels: spectrumBandLevels,
      canvasWidth: globalSize,
      canvasHeight: globalSize,
      dbMin: CANVAS_CONFIG.SPECTRUM.DB_MIN,
      dbMax: CANVAS_CONFIG.SPECTRUM.DB_MAX,
      barColor: THEME_COLORS.SAFE_ASSIST,
      gridColor: THEME_COLORS.GRID,
      textColor: THEME_COLORS.NEUTRAL,
      primaryColor: THEME_COLORS.PRIMARY,
    });
  } else if (currentViewMode === 'spectrogram' && spectrogramState && ctxSpectrogram) {
    renderSpectrogramFrame(ctxSpectrogram, spectrogramState, spectrogramOffCanvas);
    drawSpectrogramLabels(ctxSpectrogram, spectrogramState, THEME_COLORS.NEUTRAL);
  }
}

/**
 * 初始化前景波形 Canvas 的节点与坐标变换。
 * @param {object} query 由 wx.createSelectorQuery() 创建的查询实例。
 * Side effect: 更新全局 canvasf/ctxf/dpr，并设置像素比缩放与坐标系平移。
 */
function initCanvasFront(query){
  initCanvasFrontAsync(query, null)
    .then((res) => {
      canvasf = res.canvas;
      ctxf = res.ctx;
      dpr = res.dpr;
      if (Number.isFinite(res.baseline) && res.baseline > 0) {
        globalSize = res.baseline;
      }
    })
    .catch((error) => {
      console.warn('[main] init canvas failed:', error);
    });
}

/**
 * 基于当前配置好的风险层级动态判断风险
 * @param {number} cneValue - 当前 CNE 值
 * @returns {{text: string, bgClass: string}}
 */
function getRiskStatusByCNE(cneValue) {
  if (!Number.isFinite(cneValue)) {
    return { key: 'SAFE', text: '安全', bgClass: 'detail-safe' };
  }

  const levels = (Array.isArray(currentRiskLevels) && currentRiskLevels.length > 0)
    ? currentRiskLevels
    : buildRiskLevels(riskConfig);

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (cneValue < level.upper) {
      return { key: level.key, text: level.text, bgClass: level.bgClass };
    }
  }

  const lastLevel = levels[levels.length - 1];
  return { key: lastLevel.key, text: lastLevel.text, bgClass: lastLevel.bgClass };
}

/**
 * 生成本次记录的风险分段快照，便于回溯启用状态与区间划分。
 * @returns {{enabled: object, levels: Array}} 风险分段快照。
 */
function getRiskSegmentSnapshot() {
  const config = riskConfig || {};
  const enabled = config.enabled || {};
  const levels = (Array.isArray(currentRiskLevels) && currentRiskLevels.length > 0)
    ? currentRiskLevels
    : buildRiskLevels(config);

  let lowerBound = -Infinity;
  const levelSnapshots = levels.map((level) => {
    const snapshot = {
      key: level.key,
      text: level.text,
      lower: Number.isFinite(lowerBound) ? lowerBound : null,
      upper: Number.isFinite(level.upper) ? level.upper : null,
    };
    lowerBound = level.upper;
    return snapshot;
  });

  return {
    enabled: {
      safe: true,
      attention: enabled.attention !== false,
      medium: enabled.medium !== false,
      high: enabled.high !== false,
      extreme: true,
    },
    levels: levelSnapshots,
  };
}

// ================= 页面主逻辑 =================

Page({
  data:{
    dbfs: '0.00',
    dbspl: '0.00',
    cne: '0.00',
    threat: "暂无数据",
    threatClass:"detail-init",
    viewMode: 'waveform', // 当前视图模式：waveform | spectrum | spectrogram
  },

  // 核心录音参数：必须使用 camcorder 声源绕过通话降噪处理，并保持长时连续采样。
  mainRecordParams: createCamcorderRecordParams({
    duration: 600000,
  }),

  onReady() {
    const query = wx.createSelectorQuery();
    initCanvasFront(query);
    // 频谱和频谱图 Canvas 延迟到首次切换时初始化（避免 display:none 时尺寸为 0）
  },

  /**
   * 切换可视化视图模式
   * @param {object} e - 点击事件，dataset.mode 包含目标模式
   */
  switchView(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode && mode !== currentViewMode) {
      currentViewMode = mode;
      this.setData({ viewMode: mode }, () => {
        wx.nextTick(() => {
          if (mode === 'waveform') {
            draw(ctxf, time);
            return;
          }

          if (mode === 'spectrum') {
            if (!ctxSpectrum) {
              this.initSpectrumCanvas(drawActiveView);
            } else {
              drawActiveView();
            }
            return;
          }

          if (mode === 'spectrogram') {
            if (!ctxSpectrogram) {
              this.initSpectrogramCanvas(drawActiveView);
            } else {
              drawActiveView();
            }
          }
        });
      });
    }
  },

  /**
   * 初始化频谱 Canvas（坐标原点在左下角，与波形一致）
   */
  initSpectrumCanvas(onReady) {
    const query = wx.createSelectorQuery();
    query.select('#canvas-spectrum').fields({ node: true, size: true }).exec((res) => {
      if (res && res[0] && res[0].node) {
        const logicalSize = Math.min(res[0].width, res[0].height);
        if (Number.isFinite(logicalSize) && logicalSize > 0) {
          globalSize = logicalSize;
        }
        canvasSpectrum = res[0].node;
        ctxSpectrum = canvasSpectrum.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        canvasSpectrum.width = res[0].width * dpr;
        canvasSpectrum.height = res[0].height * dpr;
        ctxSpectrum.scale(dpr, dpr);
        ctxSpectrum.translate(0, globalSize);
        if (typeof onReady === 'function') {
          onReady();
        }
      }
    });
  },

  /**
   * 初始化频谱图 Canvas（坐标原点在左上角，标准像素坐标）
   */
  initSpectrogramCanvas(onReady) {
    const query = wx.createSelectorQuery();
    query.select('#canvas-spectrogram').fields({ node: true, size: true }).exec((res) => {
      if (res && res[0] && res[0].node) {
        const logicalSize = Math.min(res[0].width, res[0].height);
        if (Number.isFinite(logicalSize) && logicalSize > 0) {
          globalSize = logicalSize;
        }
        canvasSpectrogram = res[0].node;
        ctxSpectrogram = canvasSpectrogram.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        canvasSpectrogram.width = res[0].width * dpr;
        canvasSpectrogram.height = res[0].height * dpr;
        ctxSpectrogram.scale(dpr, dpr);

        const logicalW = res[0].width;
        const logicalH = res[0].height;

        // 创建离屏 canvas（逻辑尺寸），用于 putImageData 中转
        spectrogramOffCanvas = wx.createOffscreenCanvas({ type: '2d', width: logicalW, height: logicalH });

        // 创建频谱图状态（逻辑尺寸）
        spectrogramState = createSpectrogramState(logicalW, logicalH, {
          dbMin: CANVAS_CONFIG.SPECTROGRAM.DB_MIN,
          dbMax: CANVAS_CONFIG.SPECTROGRAM.DB_MAX,
        });

        // 在离屏 canvas 上创建 ImageData
        initSpectrogramImageData(spectrogramState, spectrogramOffCanvas.getContext('2d'));

        if (typeof onReady === 'function') {
          onReady();
        }
      }
    });
  },

  onShow() {
    const mode = this.data.viewMode || 'waveform';
    currentViewMode = mode;

    if (mode === 'spectrum' && !ctxSpectrum) {
      this.initSpectrumCanvas(drawActiveView);
    } else if (mode === 'spectrogram' && !ctxSpectrogram) {
      this.initSpectrogramCanvas(drawActiveView);
    }

    this.startMainMonitoring();
  },

  onHide() {
    this.stopMainMonitoring();
  },

  onUnload() {
    this.stopMainMonitoring();
    this.resetViewCaches();
  },

  resetViewCaches() {
    canvasSpectrum = null;
    ctxSpectrum = null;
    canvasSpectrogram = null;
    ctxSpectrogram = null;
    spectrogramOffCanvas = null;
    spectrogramState = null;
    spectrumBandLevels = null;
    currentViewMode = 'waveform';
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
      timeTerm = 10 * Math.log10(expectedExposure / 28800);
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
      riskSegments: getRiskSegmentSnapshot(),
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
   * 终止录音、关闭音频上下文，并阻断后续帧回调写入。
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