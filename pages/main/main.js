// pages/main/main.js
// 作用：实施核心的实时噪声监测，计算 Z 计权显示值、A 计权等效声级及预计暴露结果，并处理预警与录音缓存波形图绘制。

const DEBUG = false; // 设为 true 以启用详细日志

const app = getApp();
const recorderManager = wx.getRecorderManager();
const {
  calculateRMS,
  calculateDb,
  calculateLeqFromEnergy,
  calculateCNEFromLeq,
  AWeightingFilter,
} = require('../../utils/audio-math');
const { LIMITS, CANVAS_CONFIG, THEME_COLORS, CNE_FORMULA } = require('../../utils/constants');
const { computeSpectrum } = require('../../utils/fft');
const { buildRiskLevels } = require('../../utils/risk-config');
const dataModel = require('../../utils/data-model');
const { DCBlocker, inspectPcm, PcmQualityInspector } = require('../../utils/audio-quality');
const resultManager = require('../../utils/result-manager');
const { RESULT_SCHEMA_VERSION, ALGORITHM_VERSION } = require('../../utils/measurement-version');
const {
  safeStopRecorder,
  cancelRecorderStart,
  isRecorderTransitioning,
  observeRecorderState,
  observeRecorderEvent,
  safeStartRecorder,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  getMeasurementCaptureProfile,
  getRecorderCaptureInfo,
  getCurrentDeviceCalibrationId,
  bindRecorderFrameListener,
  bindRecorderListenersOnce,
  clearRecorderFrameListener,
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
let pcmRingBuffer = new Float64Array(CANVAS_CONFIG.FFT.SIZE); // 去直流后的 PCM 幅值，保留小数以免量化/溢出
let pcmWriteIndex = 0;    // 当前写入位置
let fftSampleCount = 0;    // 距上次 FFT 的采样计数
let pcmBufferedSamples = 0; // 环形缓冲区内已经写入的真实样本数
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
let monitorSessionId = 0;
const SPECTROGRAM_LABEL_AREA_WIDTH = 38;

/**
 * A 计权滤波器实例。
 * 【关键】：必须在整个监测周期内保持唯一一个实例。
 * 因为滤波器内部为 IIR 结构，有状态寄存器 (z1, z2, z3) 需要跨帧记忆。
 * 若每帧重建实例，则状态丢失，滤波器输出错误。
 */
let aWeightingFilter = new AWeightingFilter();
let dcBlocker = new DCBlocker(CANVAS_CONFIG.FFT.SAMPLE_RATE);
let inputOverloaded = false;
let inputNearFullScale = false;
let calibrationStatus = { valid: false, offset: NaN, reason: '尚未完成有效校准', meta: null };
let measurementInvalidReason = '';
let lastValidFrameAt = 0;
let mainInputWatchdogId = null;
let inputPlateauSuspected = false;
let inputQualityInspector = new PcmQualityInspector(CANVAS_CONFIG.FFT.SAMPLE_RATE);
const MAIN_INPUT_TIMEOUT_MS = 2000;
const MAIN_START_TIMEOUT_MS = 15000;
const MAIN_FIRST_FRAME_TIMEOUT_MS = 10000;
// 仅容纳原生毫秒时长的量化误差和一个样本的舍入，不允许按比例丢帧。
// 不支持可靠原生时长的平台应保留预览，不能降级为墙钟覆盖率认证。
const CAPTURE_DURATION_TOLERANCE_SAMPLES = Math.ceil(CANVAS_CONFIG.FFT.SAMPLE_RATE / 1000) + 1;
let captureIntegrity = { status: 'pending', nativeDurationMs: null, sampleDelta: null };
let deliveryDelayed = false;
let silentSampleCount = 0;
let consecutiveSilentSampleCount = 0;
let filterTail = null;
let mainCaptureStartedAt = 0;
let lastFrameLevels = null;

/**
 * === 高性能帧处理变量（避免 O(n) 频繁重算） ===
 * - timeTerm: 预期暴露时长时间项（= 10×log10(T/T0)，T0=28800s）
 * - frameCount: 已收到的音频帧总数
 * - intervalSampleCounter: 当前秒级积分区间内的样本数
 * - uiSampleCounter: 距上次 UI 瞬时值刷新的样本数
 * - totalAWeightedEnergySum/totalAWeightedSampleCount: 全部 A 计权样本的能量积分
 * - instantLimit: 示波器的瞬时边界线阈值（通常为 80dB）
 * - isMainMonitoringActive: 标志当前 main 监测会话是否有效（阻断退出后的迟到帧）
 * - currentMainPage: 当前激活的 main 页面实例引用（用于正确的 setData 上下文）
 */
let timeTerm = 0;
let frameCount = 0;
let intervalSampleCounter = 0;
let uiSampleCounter = 0;
let totalAWeightedEnergySum = 0;
let totalAWeightedSampleCount = 0;
let intervalZWeightedEnergySum = 0;
let intervalZWeightedSampleCount = 0;
let instantLimit = LIMITS.INSTANT_DB_LIMIT_DEFAULT;
let currentRiskLevels = [];
let currentMainPage = null;
let isMainMonitoringActive = false;
let mainRecorderStartTimerId = null;

let globalSize = CANVAS_CONFIG.MONITOR.GLOBAL_SIZE;
const scaleX = CANVAS_CONFIG.MONITOR.SCALE_X;
const scaleY = CANVAS_CONFIG.MONITOR.SCALE_Y;
const MAIN_CANVAS_PADDING_BOTTOM = 26;

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
function resetMonitorSessionState(page) {
  clearMainInputWatchdog();
  inputOverloaded = false;
  inputNearFullScale = false;
  inputPlateauSuspected = false;
  inputQualityInspector = new PcmQualityInspector(CANVAS_CONFIG.FFT.SAMPLE_RATE);
  measurementInvalidReason = '';
  lastValidFrameAt = 0;
  mainCaptureStartedAt = 0;
  captureIntegrity = { status: 'pending', nativeDurationMs: null, sampleDelta: null };
  deliveryDelayed = false;
  silentSampleCount = 0;
  consecutiveSilentSampleCount = 0;
  filterTail = null;
  lastFrameLevels = null;
  dcBlocker = new DCBlocker(CANVAS_CONFIG.FFT.SAMPLE_RATE);
  monitorSessionId++;
  location = null;
  dBArray = [];
  time = 0;
  frameCount = 0;
  intervalSampleCounter = 0;
  uiSampleCounter = 0;
  cne = 0;
  totalAWeightedEnergySum = 0;
  totalAWeightedSampleCount = 0;
  intervalZWeightedEnergySum = 0;
  intervalZWeightedSampleCount = 0;
  isAlarming = false;
  hasAlerted = false;
  startDate = Date.now();

  // 重置 FFT 状态
  pcmRingBuffer.fill(0);
  pcmWriteIndex = 0;
  fftSampleCount = 0;
  pcmBufferedSamples = 0;
  spectrumBandLevels = null;
  // 频谱图状态保留画布尺寸，仅清空像素
  if (spectrogramState) {
    clearSpectrogram(spectrogramState);
  }
  if (page) {
    page._completedSnapshot = null;
    page._awaitingRecorderRecovery = false;
    page.setData({
      recordingState: 'starting', recordingLabel: '正在启动录音', canSave: false,
      leqA: '--', measurementSeconds: '0.0', exposureHours: (expectedExposure / 3600).toFixed(2),
      levelScopeLabel: '本次估算 LAeq',
      calibrationLabel: calibrationStatus.label || calibrationStatus.reason,
      calibrationDateLabel: calibrationStatus.laboratoryPreset ? '参数记录日期' : '校准日期',
      calibrationDate: calibrationStatus.meta && calibrationStatus.meta.calibratedAt
        ? new Date(calibrationStatus.meta.calibratedAt).toLocaleDateString() : '--',
      dbfs: '--',
      dbspl: '--',
      cne: '--',
      threat: calibrationStatus.valid ? '等待有效采样' : calibrationStatus.reason,
      threatClass: 'detail-init',
    });
  }
}

function markMainMeasurementInvalid(reason) {
  if (!measurementInvalidReason) {
    measurementInvalidReason = reason || '录音数据不连续，本次结果无效';
  }
  clearMainInputWatchdog();
  cne = NaN;
  threat = measurementInvalidReason;
  if (currentMainPage) {
    currentMainPage.setData({
      recordingState: 'invalid', recordingLabel: '测量已失效，请重新测量', canSave: false, leqA: '--',
      dbfs: '--',
      dbspl: '--',
      cne: '--',
      threat: measurementInvalidReason,
      threatClass: 'detail-init',
    });
  }
  isMainMonitoringActive = false;
  cancelRecorderStart(recorderManager);
  safeStopRecorder(recorderManager);
}

function clearMainInputWatchdog() {
  if (mainInputWatchdogId !== null) clearInterval(mainInputWatchdogId);
  mainInputWatchdogId = null;
}

function startMainInputWatchdog() {
  clearMainInputWatchdog();
  const sessionId = monitorSessionId;
  mainInputWatchdogId = setInterval(() => {
    if (sessionId !== monitorSessionId || !isMainMonitoringActive || !currentMainPage) return;
    if (currentMainPage._awaitingRecorderRecovery) return;
    // 首次授权、原生启动和首帧交付不能套用录音中的 2 秒断流门限。
    const referenceTime = lastValidFrameAt || mainCaptureStartedAt || startDate;
    const timeoutMs = lastValidFrameAt ? MAIN_INPUT_TIMEOUT_MS
      : mainCaptureStartedAt ? MAIN_FIRST_FRAME_TIMEOUT_MS : MAIN_START_TIMEOUT_MS;
    if (Date.now() - referenceTime > timeoutMs) {
      if (lastValidFrameAt) {
        deliveryDelayed = true;
        currentMainPage.setData({ recordingLabel: '音频交付延迟；停止后按实际样本核验' });
        return;
      }
      markMainMeasurementInvalid(mainCaptureStartedAt
        ? '有效音频输入超时，请重新测量' : '录音启动超时，请检查麦克风授权');
    }
  }, 250);
}

function hasUsableMainSamples() {
  if (!isMainMonitoringActive || !calibrationStatus.valid || inputOverloaded || measurementInvalidReason || totalAWeightedSampleCount <= 0
    || !Number.isFinite(totalAWeightedEnergySum) || totalAWeightedEnergySum <= 0) {
    return false;
  }
  return lastValidFrameAt > 0 && (['valid', 'unverified', 'partial'].includes(captureIntegrity.status)
    || Date.now() - lastValidFrameAt <= MAIN_INPUT_TIMEOUT_MS);
}

function isMainMeasurementValid() {
  return captureIntegrity.status === 'valid' && hasUsableMainSamples();
}

function isMainMeasurementSaveable() {
  return ['valid', 'unverified', 'partial'].includes(captureIntegrity.status) && hasUsableMainSamples();
}

function calculateCurrentCne() {
  if (!hasUsableMainSamples()) {
    return NaN;
  }
  const cumulativeLeqA = calculateLeqFromEnergy(
    totalAWeightedEnergySum,
    totalAWeightedSampleCount,
    offset
  );
  return calculateCNEFromLeq(cumulativeLeqA, timeTerm);
}

function updateSpectrumFromRingBuffer() {
  if (!calibrationStatus.valid) {
    spectrumBandLevels = null;
    return;
  }
  const fftSize = CANVAS_CONFIG.FFT.SIZE;
  const fftInput = new Float64Array(fftSize);
  const startRead = pcmWriteIndex;
  for (let i = 0; i < fftSize; i++) {
    fftInput[i] = pcmRingBuffer[(startRead + i) % fftSize];
  }

  const spectrumDB = computeSpectrum(fftInput, offset);
  spectrumBandLevels = computeThirdOctaveBands(spectrumDB);
  if (spectrogramState) {
    appendSpectrogramColumn(spectrogramState, spectrumDB, CANVAS_CONFIG.SPECTROGRAM.STRIP_WIDTH);
  }
}

function finalizeMeasurementSecond(page, dbfsZ, dbsplZ) {
  time++;
  const intervalDbsplZ = calculateLeqFromEnergy(
    intervalZWeightedEnergySum,
    intervalZWeightedSampleCount,
    offset
  );
  intervalZWeightedEnergySum = 0;
  intervalZWeightedSampleCount = 0;

  if (calibrationStatus.valid && Number.isFinite(intervalDbsplZ)) {
    recordArray(time, intervalDbsplZ);
  }
  if (currentViewMode === 'waveform') {
    draw(ctxf, time);
  }

  cne = calculateCurrentCne();
  const riskStatus = Number.isFinite(cne) && calibrationStatus.riskEligible
    ? getRiskStatusByCNE(cne)
    : {
        text: measurementInvalidReason || calibrationStatus.reason || (Number.isFinite(cne) ? '估算结果，不作风险分级' : '等待有效采样'),
        bgClass: 'detail-init',
      };
  threat = Number.isFinite(cne) ? '预览：' + riskStatus.text + '（待完整性核验）' : riskStatus.text;
  page.setData({
    leqA: calibrationStatus.valid ? calculateLeqFromEnergy(totalAWeightedEnergySum, totalAWeightedSampleCount, offset).toFixed(2) : '--',
    measurementSeconds: (totalAWeightedSampleCount / CANVAS_CONFIG.FFT.SAMPLE_RATE).toFixed(1),
    canSave: isMainMeasurementValid(),
    dbfs: dbfsZ.toFixed(2),
    dbspl: calibrationStatus.valid && Number.isFinite(dbsplZ) ? dbsplZ.toFixed(2) : '--',
    cne: Number.isFinite(cne) ? cne.toFixed(2) : '--',
    threat: Number.isFinite(cne) && calibrationStatus.riskEligible ? threat + '；采集链未核验' : threat,
    threatClass: riskStatus.key === 'SAFE' ? 'detail-init' : riskStatus.bgClass
  });

  if (allowAlarm && calibrationStatus.riskEligible && Number.isFinite(cne) && cne >= noiseAlarmLevel && !isAlarming && !hasAlerted) {
    isAlarming = true;
    hasAlerted = true;
    wx.showModal({
      title: '警报',
      content: '按设定暴露时长换算的结果已达到当前预警阈值',
      showCancel: false,
      complete: () => {
        isAlarming = false;
      }
    });
    page.doVibrate(5, 500);
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

  const frameBuffer = res && res.frameBuffer;
  if (!frameBuffer || !Number.isFinite(frameBuffer.byteLength) || frameBuffer.byteLength % 2 !== 0) {
    markMainMeasurementInvalid('音频数据格式无效，请重新测量'); return;
  }
  const buffer = new Int16Array(frameBuffer);
  if (!buffer.length || inputOverloaded || measurementInvalidReason) return;
  const quality = inspectPcm(buffer, inputQualityInspector);
  inputNearFullScale = inputNearFullScale || quality.nearFullScale;
  inputPlateauSuspected = inputPlateauSuspected || quality.plateauSuspected;
  if (quality.clipped) {
    inputOverloaded = true;
    markMainMeasurementInvalid('输入过载，请降低电平后重新测量');
    return;
  }
  if (quality.digitalSilence) {
    // 短尾块、过零与真实静音都属于录音；不能由单块幅度证明设备故障。
    silentSampleCount += buffer.length;
    consecutiveSilentSampleCount += buffer.length;
    if (consecutiveSilentSampleCount >= Math.round(CANVAS_CONFIG.FFT.SAMPLE_RATE * 0.05)) {
      markMainMeasurementInvalid('录音连续输出数字静音，本次结果无效');
      return;
    }
  } else {
    consecutiveSilentSampleCount = 0;
  }

  const frameReceivedAt = Date.now();
  if (lastValidFrameAt && frameReceivedAt - lastValidFrameAt > MAIN_INPUT_TIMEOUT_MS) {
    deliveryDelayed = true;
  }
  lastValidFrameAt = frameReceivedAt;
  if (!page._mainStopRequested && page.data.recordingState !== 'recording') {
    page.setData({ recordingState: 'recording', recordingLabel: '实时预览，停止后核验结果' });
  }

  const bufferZ = dcBlocker.process(buffer);
  const energyZ = calculateRMS(bufferZ);
  const dbfsZ = calculateDb(energyZ, 1);
  const dbsplZ = dbfsZ + offset;
  lastFrameLevels = { dbfs: dbfsZ, dbspl: dbsplZ };
  const bufferA = aWeightingFilter.process(bufferZ, false);
  const sampleRate = CANVAS_CONFIG.FFT.SAMPLE_RATE;
  const fftSize = CANVAS_CONFIG.FFT.SIZE;
  const fftHopSize = CANVAS_CONFIG.FFT.HOP_SIZE || 1600;
  const spectrumNeeded = currentViewMode === 'spectrum' || currentViewMode === 'spectrogram';
  const uiRefreshSamples = Math.max(1, Math.round(sampleRate / 2));
  let spectrumUpdated = false;
  let uiUpdateDue = false;

  for (let i = 0; i < buffer.length; i++) {
    const normalizedZ = bufferZ[i];
    const weightedA = bufferA[i];
    const energyA = weightedA * weightedA;

    totalAWeightedEnergySum += energyA;
    totalAWeightedSampleCount++;
    intervalZWeightedEnergySum += normalizedZ * normalizedZ;
    intervalZWeightedSampleCount++;

    pcmRingBuffer[pcmWriteIndex] = normalizedZ * 32768;
    pcmWriteIndex = (pcmWriteIndex + 1) % fftSize;
    if (pcmBufferedSamples < fftSize) {
      pcmBufferedSamples++;
      if (pcmBufferedSamples === fftSize) {
        if (spectrumNeeded) {
          updateSpectrumFromRingBuffer();
          spectrumUpdated = true;
        }
        fftSampleCount = 0;
      }
    } else {
      fftSampleCount++;
      if (fftSampleCount >= fftHopSize) {
        fftSampleCount -= fftHopSize;
        if (spectrumNeeded) {
          updateSpectrumFromRingBuffer();
          spectrumUpdated = true;
        }
      }
    }

    intervalSampleCounter++;
    uiSampleCounter++;
    if (uiSampleCounter >= uiRefreshSamples) {
      uiSampleCounter -= uiRefreshSamples;
      uiUpdateDue = true;
    }
    if (intervalSampleCounter >= sampleRate) {
      intervalSampleCounter -= sampleRate;
      finalizeMeasurementSecond(page, dbfsZ, dbsplZ);
    }
  }

  if (spectrumUpdated) {
    drawActiveView();
  }
  frameCount++;
  if (uiUpdateDue) {
    page.setData({
      dbfs: dbfsZ.toFixed(2),
      dbspl: calibrationStatus.valid ? dbsplZ.toFixed(2) : '--',
    });
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
// 录音意外停止或受到系统中断后，继续采样，但将整次连续测量标记为无效。
function bindMainRecorderLifecycleListeners() {
  bindRecorderListenersOnce(recorderManager, 'main-state-observer', () => {
    observeRecorderState(recorderManager, state => {
      if (!isMainMonitoringActive || !currentMainPage) return;
      if (state === 'waiting-interruption') {
        currentMainPage._awaitingRecorderRecovery = true;
        currentMainPage.setData({ recordingState: 'starting', recordingLabel: '录音被系统占用，等待恢复', canSave: false });
      } else if (state === 'starting' && currentMainPage._awaitingRecorderRecovery) {
        currentMainPage._awaitingRecorderRecovery = false;
        startDate = Date.now();
        currentMainPage.setData({ recordingLabel: '正在启动录音' });
      }
      if (state === 'recording' && mainCaptureStartedAt === 0) mainCaptureStartedAt = Date.now();
      if (state === 'error') markMainMeasurementInvalid('录音器启动或停止失败，请重新测量');
    });
  });
  bindRecorderListenersOnce(recorderManager, 'main-lifecycle-listeners', () => {
    observeRecorderEvent(recorderManager, 'Stop', (res) => {
      if (!isMainMonitoringActive || !currentMainPage) {
        return;
      }

      if (isRecorderTransitioning(recorderManager)) return;
      if (currentMainPage._mainStopRequested) {
        currentMainPage.completeRequestedMainStop(res);
        return;
      }
      const limit = currentMainPage.mainRecordParams.duration;
      if (res && Number.isFinite(res.duration) && res.duration >= limit - 2) {
        currentMainPage._mainStopRequested = true;
        currentMainPage.completeRequestedMainStop(res);
        return;
      }
      markMainMeasurementInvalid('录音意外停止，本次结果无效');
    });

    observeRecorderEvent(recorderManager, 'SourceFallback', () => {
      if (!isMainMonitoringActive || !currentMainPage || calibrationStatus.laboratoryPreset) return;
      calibrationStatus = { ...calibrationStatus, grade: 'estimated', riskEligible: false,
        calibrationNote: '录音源不受支持，已回退；本次采集配置与原校准可能不同。', label: '录音源回退，参数估算' };
      currentMainPage.setData({ calibrationLabel: calibrationStatus.label });
    });

    if (typeof recorderManager.onInterruptionBegin === 'function') {
      observeRecorderEvent(recorderManager, 'InterruptionBegin', () => {
        if (isMainMonitoringActive) markMainMeasurementInvalid('录音被系统中断，本次结果无效');
      });
    }

    if (typeof recorderManager.onPause === 'function') {
      observeRecorderEvent(recorderManager, 'Pause', () => {
        if (isMainMonitoringActive) markMainMeasurementInvalid('录音被暂停，本次结果无效');
      });
    }

    if (typeof recorderManager.onError === 'function') {
      observeRecorderEvent(recorderManager, 'Error', () => {
        if (isMainMonitoringActive) markMainMeasurementInvalid('录音发生错误，本次结果无效');
      });
    }

    observeRecorderEvent(recorderManager, 'InterruptionEnd', () => {
      if (!isMainMonitoringActive || !currentMainPage) {
        return;
      }

      markMainMeasurementInvalid('录音已中断，请重新测量');
    });
  });
}


//取消待启动的 main 录音定时任务。
function cancelPendingMainRecorderStart() {
  cancelRecorderStart(recorderManager);
  if (mainRecorderStartTimerId) {
    if (typeof mainRecorderStartTimerId === 'number') clearTimeout(mainRecorderStartTimerId);
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
  const restartResult = safeStartRecorder(recorderManager, currentMainPage.mainRecordParams, delayMs);
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
      mesh(ctx, CANVAS_CONFIG.AXIS_PADDING.LEFT, globalSize, instantLimit);
      mark(ctx, instantLimit);
    },
    globalSize,
    leftBoundary: CANVAS_CONFIG.AXIS_PADDING.LEFT,
    scaleX,
    scaleY,
    currentTime,
    dBArray,
    getStrokeColor: (currentDB) => {
      return THEME_COLORS.NEUTRAL;
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
    renderSpectrogramFrame(
      ctxSpectrogram,
      spectrogramState,
      spectrogramOffCanvas,
      SPECTROGRAM_LABEL_AREA_WIDTH
    );
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
        globalSize = Math.max(0, res.baseline - MAIN_CANVAS_PADDING_BOTTOM);
        ctxf.translate(0, -MAIN_CANVAS_PADDING_BOTTOM);
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
    return { key: 'INVALID', text: '数据异常', bgClass: 'detail-invalid' };
  }

  const levels = (Array.isArray(currentRiskLevels) && currentRiskLevels.length > 0)
    ? currentRiskLevels
    : buildRiskLevels(riskConfig);

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.key === 'SAFE' ? cneValue <= level.upper : cneValue < level.upper) {
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
    recordingState: 'idle', recordingLabel: '尚未启动', canSave: false,
    leqA: '--', levelScopeLabel: '本次估算 LAeq', measurementSeconds: '0.0', exposureHours: '--', calibrationLabel: '', calibrationDate: '--', calibrationDateLabel: '校准日期',
    dbfs: '0.00',
    dbspl: '0.00',
    cne: '0.00',
    threat: "暂无数据",
    threatClass:"detail-init",
    viewMode: 'waveform', // 当前视图模式：waveform | spectrum | spectrogram
  },

  // 核心录音参数：按平台选择测量用途声源，并保持长时连续采样。
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
            if (pcmBufferedSamples === CANVAS_CONFIG.FFT.SIZE) updateSpectrumFromRingBuffer();
            if (!ctxSpectrum) {
              this.initSpectrumCanvas(drawActiveView);
            } else {
              drawActiveView();
            }
            return;
          }

          if (mode === 'spectrogram') {
            if (pcmBufferedSamples === CANVAS_CONFIG.FFT.SIZE) updateSpectrumFromRingBuffer();
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
        canvasSpectrum = res[0].node;
        ctxSpectrum = canvasSpectrum.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        canvasSpectrum.width = res[0].width * dpr;
        canvasSpectrum.height = res[0].height * dpr;
        ctxSpectrum.scale(dpr, dpr);
        // 以 canvas 的逻辑高度作为底部基线，避免 globalSize 与实际像素尺寸不一致导致底部被裁剪
        ctxSpectrum.translate(0, res[0].height);
        ctxSpectrum.translate(0, -MAIN_CANVAS_PADDING_BOTTOM);
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
        canvasSpectrogram = res[0].node;
        ctxSpectrogram = canvasSpectrogram.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        const logicalW = Math.max(1, Math.round(res[0].width));
        const logicalH = Math.max(1, Math.round(res[0].height));
        canvasSpectrogram.width = Math.max(1, Math.round(logicalW * dpr));
        canvasSpectrogram.height = Math.max(1, Math.round(logicalH * dpr));
        ctxSpectrogram.scale(canvasSpectrogram.width / logicalW, canvasSpectrogram.height / logicalH);

        const plotW = Math.max(1, Math.round(logicalW - SPECTROGRAM_LABEL_AREA_WIDTH));

        // 创建离屏 canvas（逻辑尺寸），用于 putImageData 中转
        spectrogramOffCanvas = wx.createOffscreenCanvas({ type: '2d', width: plotW, height: logicalH });

        // 创建频谱图状态（逻辑尺寸）
        spectrogramState = createSpectrogramState(plotW, logicalH, {
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
    const ownsSession = currentMainPage === this;
    this.stopMainMonitoring();
    if (ownsSession || !currentMainPage) this.resetViewCaches();
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
      
      calibrationStatus = dataModel.getOffsetStatus({
        captureProfile: getMeasurementCaptureProfile(),
        deviceId: getCurrentDeviceCalibrationId(),
      });
      // 校准决定结果的解释与标记，不决定用户是否能够录音和保存。
      // 没有校准条件时沿用可解析的偏移量进行估算，不认证为参考声压测量。
      if (!calibrationStatus.valid) {
        calibrationStatus = { ...calibrationStatus, valid: true, grade: 'estimated',
          riskEligible: false, calibrationVerified: false,
          calibrationNote: calibrationStatus.reason, reason: '',
          label: calibrationStatus.meta && calibrationStatus.meta.source ? '历史参数估算' : '未校准估算' };
      }
      offset = calibrationStatus.offset;
      expectedExposure = dataModel.getExpectedExposureSeconds();
      noiseAlarmLevel = dataModel.getNoiseAlarmLevel();
      riskConfig = dataModel.getRiskConfig();
      currentRiskLevels = buildRiskLevels(riskConfig);
      allowAlarm = dataModel.getAlarmEnabled();
      timeTerm = 10 * Math.log10(expectedExposure / CNE_FORMULA.REFERENCE_EXPOSURE_SECONDS);
      resetMonitorSessionState(this);

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
    const restartResult = safeStartRecorder(recorderManager, this.mainRecordParams, 50);
    if (restartResult === false) {
      this.stopMainMonitoring();
      return false;
    }
    mainRecorderStartTimerId = restartResult;
    startMainInputWatchdog();
    return true;
  },

  /**
   * 生成当前监测结果的归档对象。
   * @returns {object} 可持久化的结果快照。
   * Side effect: none.
   */
  archive() {
    if (this._completedSnapshot) return this._completedSnapshot;
    const currentDate = Date.now();
    const duration = totalAWeightedSampleCount / CANVAS_CONFIG.FFT.SAMPLE_RATE;
    const captureElapsedSeconds = mainCaptureStartedAt > 0
      ? Math.max(0, (currentDate - mainCaptureStartedAt) / 1000) : 0;
    const expectedCaptureSeconds = captureIntegrity.nativeDurationMs !== null
      ? captureIntegrity.nativeDurationMs / 1000 : captureElapsedSeconds;
    const captureCoverageRatio = expectedCaptureSeconds > 0
      ? Math.min(1, duration / expectedCaptureSeconds) : (duration > 0 ? 1 : 0);
    const formattedDate = new Date(currentDate).toLocaleString("zh-CN");
    const valid = isMainMeasurementValid();
    const saveable = isMainMeasurementSaveable();
    const qualityReason = measurementInvalidReason || calibrationStatus.reason
      || (captureIntegrity.status === 'partial' ? '音频时长不一致，仅代表已接收片段'
        : captureIntegrity.status === 'unverified' ? '录音时长未核验，仅代表已接收音频'
        : valid ? '' : '请停止测量并完成音频完整性核验');
    const snapshotCne = saveable ? calculateCurrentCne() : NaN;
    const snapshotRiskStatus = !saveable ? { text: qualityReason, bgClass: 'detail-init' }
      : !valid ? { text: '片段估算，不作整段风险分级', bgClass: 'detail-init' }
      : calibrationStatus.riskEligible ? getRiskStatusByCNE(snapshotCne)
        : { text: '估算结果，不作风险分级', bgClass: 'detail-init' };
    
    const deviceInfo = wx.getDeviceInfo();
    const deviceName = deviceInfo.brand + ' ' + deviceInfo.model;
    const systemName = deviceInfo.system;
    
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      recordId: 'noise-' + startDate + '-' + monitorSessionId + '-' + totalAWeightedSampleCount,
      startedAt: startDate,
      endedAt: currentDate,
      sampleRate: CANVAS_CONFIG.FFT.SAMPLE_RATE,
      sampleCount: totalAWeightedSampleCount,
      measurementScope: valid ? 'whole-recording' : 'received-audio',
      aWeightedEnergy: totalAWeightedEnergySum,
      leqA: saveable ? calculateLeqFromEnergy(totalAWeightedEnergySum, totalAWeightedSampleCount, offset) : null,
      cneUnrounded: Number.isFinite(snapshotCne) ? snapshotCne : null,
      parameters: { dcHighpassHz: 2, referenceExposureSeconds: CNE_FORMULA.REFERENCE_EXPOSURE_SECONDS,
        fftSize: CANVAS_CONFIG.FFT.SIZE, weighting: 'A',
        boundaryConvention: 'zero-extended-finite-record', filterTail },
      coverage: { receivedSamples: totalAWeightedSampleCount, receivedSeconds: duration,
        elapsedSeconds: (currentDate - startDate) / 1000,
        captureElapsedSeconds, captureCoverageRatio,
        integrityStatus: captureIntegrity.status, nativeDurationMs: captureIntegrity.nativeDurationMs,
        sampleDelta: captureIntegrity.sampleDelta, toleranceSamples: CAPTURE_DURATION_TOLERANCE_SAMPLES,
        lastFrameAt: lastValidFrameAt },
      calibrationGrade: calibrationStatus.grade || 'unknown',
      calibrationLabel: calibrationStatus.label,
      calibrationNote: calibrationStatus.calibrationNote || '',
      calibrationVerified: false,
      calibrationProcessCompleted: !!calibrationStatus.riskEligible,
      riskEstimate: valid && calibrationStatus.riskEligible ? snapshotRiskStatus.text : null,
      name: null,
      date: formattedDate,
      duration: duration.toFixed(3),
      exposure: expectedExposure,
      cne: Number.isFinite(snapshotCne) ? parseFloat(snapshotCne.toFixed(2)) : null,
      threat: valid && calibrationStatus.riskEligible ? snapshotRiskStatus.text + '（条件估计；采集链未核验）' : snapshotRiskStatus.text,
      threatClass: snapshotRiskStatus.bgClass === 'detail-safe' ? 'detail-init' : snapshotRiskStatus.bgClass,
      location: location,
      extra: null,
      riskSegments: getRiskSegmentSnapshot(),
      device: deviceName,
      system: systemName,
      offset: offset,
      calibration: calibrationStatus.meta,
      ...getRecorderCaptureInfo(recorderManager),
      calibrationFrequencyHz: dataModel.getCalibrationFrequency(calibrationStatus.meta || {}),
      frequencyResponseVerification: 'unverified',
      broadbandInterpretation: 'single-point-offset-estimate',
      dataQuality: valid ? 'valid' : saveable ? captureIntegrity.status : hasUsableMainSamples() ? 'pending' : 'invalid',
      plateauSuspected: inputPlateauSuspected,
      nearFullScaleObserved: inputNearFullScale,
      deliveryDelayed, silentSampleCount,
      captureChainVerification: 'unverified',
      captureChainNote: '录音源请求及回退已记录；平台未提供实际输入路由、AGC 或降噪状态核验。实验室校准须与本次麦克风、连接方式和增益一致。',
      declaredInputChain: this.data.declaredInputChain || '',
      qualityReason,
      vstamp: app.globalData.vstamp,
    };
  },

  /**
   * 保存当前监测结果到本地历史记录。
   * Side effect: 写入本地结果存储并弹出成功提示。
   */
  saveResult(){
    const archivedSnapshot = this._completedSnapshot || this.archive();
    if (!['valid', 'unverified', 'partial'].includes(archivedSnapshot.dataQuality) || !Number.isFinite(archivedSnapshot.cne)) {
      const reason = archivedSnapshot.qualityReason || '请停止测量并完成音频完整性核验';
      wx.showToast({ title: reason, icon: 'none', duration: 3000 });
      return;
    }
    console.group('save')
    console.log("archived: ", archivedSnapshot)
    const savedResult = resultManager.add(archivedSnapshot);
    this.setData({ canSave: false });
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
      wx.showToast({ title: '保存失败，结果仍保留，请重试', icon: 'none' });
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
  releaseMainMonitoringResources(stopNativeRecorder = true) {
    isMainMonitoringActive = false;
    clearMainInputWatchdog();
    currentMainPage = null;
    cancelPendingMainRecorderStart();
    if (stopNativeRecorder) safeStopRecorder(recorderManager);
    clearRecorderFrameListener(recorderManager);
    audioCtx = safeCloseAudioContext(audioCtx);
    this.cancelVibration();
  },

  stopMainMonitoring: function() {
    this.cancelVibration();
    this._mainStopRequested = false;
    if (this._mainStopFallbackTimer) {
      clearTimeout(this._mainStopFallbackTimer);
      this._mainStopFallbackTimer = null;
    }
    if (currentMainPage !== this) return;
    this.releaseMainMonitoringResources(true);
  },

  cleanupMonitoring: function() {
    this.stopMainMonitoring();
  },

  stopNoiseMonitoring: function() {
    if (!isMainMonitoringActive || currentMainPage !== this || this._mainStopRequested) return;
    this._mainStopRequested = true;
    clearMainInputWatchdog();
    cancelPendingMainRecorderStart();
    this.setData({ recordingState: 'stopping', recordingLabel: '正在完成录音并接收尾帧', canSave: false });
    this._mainStopFallbackTimer = setTimeout(() => {
      this._mainStopFallbackTimer = null;
      if (!this._mainStopRequested) return;
      if (!measurementInvalidReason) measurementInvalidReason = '录音停止未确认，本次结果无效';
      this.completeRequestedMainStop();
    }, 2250);
    safeStopRecorder(recorderManager);
  },

  completeRequestedMainStop(res) {
    if (!this._mainStopRequested) return;
    this._mainStopRequested = false;
    if (this._mainStopFallbackTimer) {
      clearTimeout(this._mainStopFallbackTimer);
      this._mainStopFallbackTimer = null;
    }
    const nativeDurationMs = res && res.duration;
    const durationAvailable = Number.isFinite(nativeDurationMs) && nativeDurationMs > 0;
    const sampleDelta = durationAvailable
      ? totalAWeightedSampleCount - nativeDurationMs * CANVAS_CONFIG.FFT.SAMPLE_RATE / 1000 : null;
    const complete = durationAvailable && Math.abs(sampleDelta) <= CAPTURE_DURATION_TOLERANCE_SAMPLES;
    captureIntegrity = { status: complete ? 'valid' : durationAvailable ? 'partial' : 'unverified',
      nativeDurationMs: durationAvailable ? nativeDurationMs : null, sampleDelta };
    if (!filterTail && totalAWeightedSampleCount > 0 && !measurementInvalidReason) {
      filterTail = require('../../utils/audio-math').integrateFilterTail(
        aWeightingFilter, totalAWeightedEnergySum, CANVAS_CONFIG.FFT.SAMPLE_RATE);
      totalAWeightedEnergySum += filterTail.energy;
    }
    this._completedSnapshot = this.archive();
    this.releaseMainMonitoringResources(false);
    const valid = ['valid', 'unverified', 'partial'].includes(this._completedSnapshot.dataQuality);
    this.setData({ recordingState: valid ? 'stopped' : 'invalid',
      recordingLabel: !valid ? '测量未通过核验，请重新测量'
        : this._completedSnapshot.dataQuality === 'partial' ? '录音时长不一致，可保存已接收片段'
        : this._completedSnapshot.dataQuality === 'unverified' ? '录音已停止，时长未核验，可保存估算记录' : '测量已停止，以下为本次摘要',
      canSave: valid,
      levelScopeLabel: this._completedSnapshot.dataQuality === 'valid' ? '本次估算 LAeq' : '片段估算 LAeq',
      measurementSeconds: this._completedSnapshot.duration,
      dbfs: valid && lastFrameLevels ? lastFrameLevels.dbfs.toFixed(2) : '--',
      dbspl: valid && lastFrameLevels ? lastFrameLevels.dbspl.toFixed(2) : '--',
      threat: this._completedSnapshot.threat,
      threatClass: this._completedSnapshot.threatClass,
      leqA: Number.isFinite(this._completedSnapshot.leqA) ? this._completedSnapshot.leqA.toFixed(1) : '--',
      cne: Number.isFinite(this._completedSnapshot.cne) ? this._completedSnapshot.cne.toFixed(1) : '--' });
  },

  restartMeasurement() {
    this.stopMainMonitoring();
    this.startMainMonitoring();
  },

  setInputChainNote(e) {
    if (this._completedSnapshot) return;
    this.setData({ declaredInputChain: String(e.detail.value).slice(0, 200) });
  },

  leaveMeasurement() {
    this.stopMainMonitoring();
    wx.navigateBack();
  },

  recordMyLocation() {
    const requestSessionId = monitorSessionId;
    wx.showLoading({ title: '获取位置信息' });
    wx.getLocation({
      type: 'gcj02',
      altitude: true,
      isHighAccuracy: true,
      highAccuracyExpireTime: 3500,
      success (res) {
        if (requestSessionId !== monitorSessionId) {
          return;
        }
        location = {
          latitude: res.latitude,
          longitude: res.longitude,
          altitude: res.altitude,
          accuracy: res.accuracy,
        };
      },
      fail() {
        if (requestSessionId === monitorSessionId) {
          location = null;
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
    // 机身振动会机械耦合到麦克风，定量采集期间仅保留视觉告警。
    if (count <= 0 || isMainMonitoringActive) return false;
    this.cancelVibration();
    wx.vibrateLong(); // 触发长震动 (约400ms)
    let currentCount = 1;
    this._vibrationTimer = setInterval(() => {
      if (currentCount >= count) {
        this.cancelVibration();
        return;
      }
      wx.vibrateLong();
      currentCount++;
    }, interval);
    return true;
  },

  cancelVibration() {
    if (this._vibrationTimer) {
      clearInterval(this._vibrationTimer);
      this._vibrationTimer = null;
    }
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
