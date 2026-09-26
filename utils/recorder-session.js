// utils/recorder-session.js
// recorder-session.js - recorderManager 与 WebAudio 资源清理辅助函数。

const CAMCORDER_RECORD_BASE = {
  sampleRate: 44100,
  numberOfChannels: 1,
  encodeBitRate: 44100 * 2,
  format: 'PCM',
  frameSize: 16,
};

function getPreferredAudioSource() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    return String(info.platform || '').toLowerCase() === 'android' ? 'voice_recognition' : 'auto';
  } catch (error) {
    return 'auto';
  }
}

function getMeasurementCaptureProfile() {
  let system = 'unknown';
  try { system = (wx.getDeviceInfo ? wx.getDeviceInfo().system : '') || 'unknown'; } catch (error) { /* 保留未知标记 */ }
  return 'pcm-44100-mono-' + getPreferredAudioSource() + '-v3-' + system;
}

// 安装级标识用于阻止同型号参数的静默导入；不冒充硬件唯一标识。
function getCalibrationInstallationId() {
  const key = 'calibrationInstallationId';
  let id = wx.getStorageSync(key);
  if (typeof id !== 'string' || !id.startsWith('install-')) {
    id = 'install-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    wx.setStorageSync(key, id);
  }
  return id;
}

function getCurrentDeviceCalibrationId() {
  try {
    const info = wx.getDeviceInfo
      ? wx.getDeviceInfo()
      : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    if (!info.brand && !info.model) return 'unknown-device';
    return `${info.brand || ''}|${info.model || ''}|${info.platform || ''}`
      .replace(/\s+/g, '')
      .toLowerCase();
  } catch (error) {
    return 'unknown-device';
  }
}

const recorderListenerBindings = new WeakMap();
const recorderFrameListeners = new WeakMap();
const sessions = new WeakMap();

function sessionFor(recorder) {
  if (sessions.has(recorder)) return sessions.get(recorder);
  const session = { state: 'idle', nativeIdle: true, startFailed: false, owner: 0, activeOwner: 0, pending: null, timer: null, listeners: new Set() };
  sessions.set(recorder, session);
  const change = state => {
    session.state = state;
    for (const listener of session.listeners) listener(state);
  };
  const clearTimer = () => { if (session.timer !== null) clearTimeout(session.timer); session.timer = null; };
  session.change = change;
  session.clearTimer = clearTimer;
  session.armTimeout = () => {
    clearTimer();
    session.timer = setTimeout(() => {
      session.timer = null;
      session.pending = null;
      change('error');
      try { recorder.stop(); } catch (error) { /* 已报告错误状态 */ }
    }, 2000);
  };
  session.startPending = () => {
    const request = session.pending;
    if (request && request.owner !== session.owner) session.pending = null;
    if (!session.pending || session.state !== 'idle') return;
    session.pending = null;
    session.activeOwner = request.owner;
    session.nativeIdle = false;
    session.startFailed = false;
    change('starting');
    session.armTimeout();
    try { recorder.start(request.params); } catch (error) {
      clearTimer(); session.nativeIdle = true; session.startFailed = true; change('error');
    }
  };
  if (typeof recorder.onStart === 'function') recorder.onStart(() => {
    if (session.state !== 'starting') return;
    clearTimer(); change('recording');
  });
  recorder.onStop(() => {
    session.nativeIdle = true;
    clearTimer();
    // 等当前 onStop 的所有订阅者执行完再启动下一会话。
    change('idle');
    if (session.pending) session.timer = setTimeout(() => { session.timer = null; session.startPending(); }, 0);
  });
  if (typeof recorder.onError === 'function') recorder.onError(() => {
    clearTimer(); session.pending = null; session.nativeIdle = true; session.startFailed = true; change('error');
  });
  for (const event of ['onInterruptionBegin', 'onPause']) if (typeof recorder[event] === 'function') {
    recorder[event](() => { clearTimer(); session.pending = null; change('interrupted'); });
  }
  return session;
}

function cancelRecorderStart(recorder) {
  if (!recorder) return;
  const session = sessionFor(recorder);
  session.pending = null;
  if (session.state === 'idle') session.clearTimer();
}

function isRecorderTransitioning(recorder) { return !!sessionFor(recorder).pending; }
function observeRecorderState(recorder, listener) {
  const session = sessionFor(recorder);
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

/**
 * 安全停止录音。
 * @param {object} recorderManager 微信录音管理器实例。
 * Side effect: 尝试停止当前录音会话。
 */
function safeStopRecorder(recorderManager) {
  if (!recorderManager) {
    return;
  }

  try {
    const session = sessionFor(recorderManager);
    session.pending = null;
    if (session.nativeIdle) { session.clearTimer(); session.change('idle'); return; }
    if (session.state === 'stopping') return;
    session.change('stopping');
    session.armTimeout();
    recorderManager.stop();
  } catch (e) {
    const session = sessionFor(recorderManager);
    session.clearTimer(); session.pending = null; session.change('error');
    console.log(e);
  }
}

/**
 * 安全启动录音。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {object} recordParams 录音参数。
 * @param {number} [delayMs=0] 兼容旧接口，启动以原生停止回调为准。
 * @returns {boolean} true 表示已安排或已完成启动；false 表示参数非法或启动失败。
 * Side effect: 可能异步调用 recorderManager.start。
 */
function safeStartRecorder(recorderManager, recordParams, delayMs = 0) {
  if (!recorderManager || !recordParams) {
    return false;
  }

  const session = sessionFor(recorderManager);
  if (session.nativeIdle && session.state === 'error') session.change('idle');
  session.startFailed = false;
  session.pending = { params: recordParams, owner: session.owner };
  if (session.state === 'idle') session.startPending();
  else if (session.state !== 'stopping') {
    session.change('stopping');
    session.armTimeout();
    try { recorderManager.stop(); } catch (error) { session.clearTimer(); session.pending = null; session.change('error'); return false; }
  }
  // 兼容旧调用参数；不再用固定毫秒数猜测原生停止完成时间。
  return !session.startFailed && session.state !== 'error';
}

/**
 * 等当前原生录音停止后启动新会话。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {object} recordParams 录音参数。
 * @param {number} [delayMs=0] 停止后启动的延迟，单位毫秒。
 * @returns {boolean} 是否已接受启动请求。待启动请求可通过 cancelRecorderStart 取消。
 * Side effect: 必要时调用 stop，收到 onStop 后才启动；页面退出时取消待启动请求。
 */
function restartRecorderSession(recorderManager, recordParams, delayMs = 0) {
  if (!recorderManager || !recordParams) {
    return false;
  }

  return safeStartRecorder(recorderManager, recordParams, delayMs);
}

/**
 * 为 recorderManager 安装当前唯一的帧回调。
 * 同一个 recorderManager 在任一时刻只允许保留一个活跃帧监听器。
 * 当页面切换时，新的回调会替换旧回调，防止跨页回调串写。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {Function} frameListener 当前页面帧处理回调。
 * @returns {boolean} true 表示绑定成功；false 表示参数非法或绑定失败。
 * Side effect: 会替换此前通过本辅助函数注册的 onFrameRecorded 回调。
 */
function bindRecorderFrameListener(recorderManager, frameListener) {
  if (!recorderManager || typeof frameListener !== 'function') {
    return false;
  }

  const previousListener = recorderFrameListeners.get(recorderManager);
  if (previousListener && typeof recorderManager.offFrameRecorded === 'function') {
    try {
      recorderManager.offFrameRecorded(previousListener);
    } catch (e) {
      console.log(e);
    }
  }

  try {
    const session = sessionFor(recorderManager);
    const owner = ++session.owner;
    const guardedListener = res => {
      if (session.owner !== owner || session.activeOwner !== owner) return;
      if (session.state === 'starting' && typeof recorderManager.onStart !== 'function') {
        session.clearTimer(); session.change('recording');
      }
      if (session.state === 'recording' || session.state === 'stopping') frameListener(res);
    };
    recorderManager.onFrameRecorded(guardedListener);
    recorderFrameListeners.set(recorderManager, guardedListener);
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}

/**
 * 清理当前通过辅助函数绑定的帧回调。
 * @param {object} recorderManager 微信录音管理器实例。
 * Side effect: 移除 onFrameRecorded 回调并清空内部映射。
 */
function clearRecorderFrameListener(recorderManager) {
  if (!recorderManager) {
    return;
  }

  const previousListener = recorderFrameListeners.get(recorderManager);
  if (previousListener && typeof recorderManager.offFrameRecorded === 'function') {
    try {
      recorderManager.offFrameRecorded(previousListener);
    } catch (e) {
      console.log(e);
    }
  }

  recorderFrameListeners.delete(recorderManager);
  sessionFor(recorderManager).owner++;
}

/**
 * 安全关闭音频上下文。
 * @param {object} audioCtx WebAudio 上下文实例。
 * @returns {null} 统一返回 null，便于外部直接回写变量。
 * Side effect: 尝试释放 WebAudio 资源。
 */
function safeCloseAudioContext(audioCtx) {
  try {
    if (audioCtx) {
      audioCtx.close();
    }
  } catch (e) {
    console.log(e);
  }

  return null;
}

/**
 * 创建测量用 PCM 录音参数。函数名为兼容旧调用保留。
 * @param {object} [overrides={}] 需要覆盖的参数。
 * @returns {object} 录音参数对象。
 * Side effect: none.
 */
function createCamcorderRecordParams(overrides = {}) {
  return {
    ...CAMCORDER_RECORD_BASE,
    audioSource: getPreferredAudioSource(),
    ...overrides,
  };
}

/**
 * 以 key 维度保证监听器仅注册一次。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {string} bindingKey 本次注册的唯一键。
 * @param {Function} register 注册函数，内部执行 onFrameRecorded/onStop 等绑定。
 * @returns {boolean} true 表示本次完成注册；false 表示此前已注册。
 * 更新监听器注册状态并可能执行回调绑定。适用于 onStop/onInterruptionEnd 这类生命周期监听，
 * 不适用于需要按页面切换动态替换的 onFrameRecorded（应使用 bindRecorderFrameListener）。
 */
function bindRecorderListenersOnce(recorderManager, bindingKey, register) {
  if (!recorderManager || !bindingKey || typeof register !== 'function') {
    return false;
  }

  let bindingSet = recorderListenerBindings.get(recorderManager);
  if (!bindingSet) {
    bindingSet = new Set();
    recorderListenerBindings.set(recorderManager, bindingSet);
  }

  if (bindingSet.has(bindingKey)) {
    return false;
  }

  sessionFor(recorderManager); // 状态监听先于页面监听注册，onStop 才能先完成交接。
  register(recorderManager);
  bindingSet.add(bindingKey);
  return true;
}

module.exports = {
  safeStopRecorder,
  cancelRecorderStart,
  isRecorderTransitioning,
  observeRecorderState,
  safeStartRecorder,
  restartRecorderSession,
  bindRecorderFrameListener,
  clearRecorderFrameListener,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  getPreferredAudioSource,
  getMeasurementCaptureProfile,
  getCurrentDeviceCalibrationId,
  getCalibrationInstallationId,
  bindRecorderListenersOnce,
};
