// utils/recorder-session.js
// recorder-session.js - recorderManager 与 WebAudio 资源清理辅助函数。

const CAMCORDER_RECORD_BASE = {
  sampleRate: 44100,
  numberOfChannels: 1,
  encodeBitRate: 44100 * 2,
  format: 'PCM',
  frameSize: 16,
};

const sourceCapabilities = new Map();
function captureEnvironmentKey() {
  try {
    const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    const app = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};
    return [device.brand, device.model, device.system, app.version, app.SDKVersion].join('|');
  } catch (error) { return 'unknown-environment'; }
}
function classifyRecorderError(error) {
  const message = String(error && (error.errMsg || error.message) || error || '');
  if (/permission|authoriz|auth deny|access denied|权限|授权|拒绝/i.test(message)) return 'permission';
  // Explicit format/rate complaints take precedence even if the message also
  // echoes audioSource. Switching sources cannot repair those parameters.
  if (/(sample.?rate|channel|format|encode|采样率|格式).{0,25}(invalid|unsupported|not support|无效|错误|不支持)|(invalid|unsupported|not support|无效|错误|不支持).{0,25}(sample.?rate|channel|format|encode|采样率|格式)/i.test(message)) return 'configuration';
  if (/audio[ _-]?source.*(unsupported|not support|invalid|unavailable)|(unsupported|not support|invalid).*audio[ _-]?source|录音源.*(不支持|不可用|无效)/i.test(message)) return 'unsupported-source';
  if (/sample.?rate|channel|format|encode|参数|采样率|格式/i.test(message)) return 'configuration';
  if (/busy|interrupt|占用|中断/i.test(message)) return 'interruption';
  return 'unknown';
}
function getPreferredAudioSource() {
  if (sourceCapabilities.has(captureEnvironmentKey())) return 'auto';
  // Android's native VOICE_RECOGNITION defaults to no AGC/noise suppression.
  // WeChat mapping and actual OEM processing remain unverified. Never pass a
  // native UNPROCESSED enum to the mini-program API without documented support.
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    if (info.platform === 'android' || /android/i.test(info.system || '')) return 'voice_recognition';
  } catch (error) { /* Unknown platform retains the compatible default. */ }
  return 'auto';
}

function getMeasurementCaptureProfile(audioSource = getPreferredAudioSource()) {
  let system = 'unknown';
  try { system = (wx.getDeviceInfo ? wx.getDeviceInfo().system : '') || 'unknown'; } catch (error) { /* 保留未知标记 */ }
  return 'pcm-44100-mono-' + audioSource + '-v5-' + system;
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
  const session = { state: 'idle', nativeIdle: true, startFailed: false, owner: 0, activeOwner: 0, pending: null, timer: null, listeners: new Set(), events: new Map(), dispatchingStop: false,
    systemInterrupted: false, handoffInterruption: false };
  sessions.set(recorder, session);
  const publish = (event, payload) => {
    const listeners = session.events.get(event);
    if (listeners) for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener(payload);
    }
  };
  const change = state => {
    session.state = state;
    for (const listener of session.listeners) listener(state);
  };
  const clearTimer = () => { if (session.timer !== null) clearTimeout(session.timer); session.timer = null; };
  session.change = change;
  session.clearTimer = clearTimer;
  session.armTimeout = (timeoutMs = 2000) => {
    clearTimer();
    if (session.systemInterrupted) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      session.pending = null;
      change('error');
      try { recorder.stop(); } catch (error) { /* 已报告错误状态 */ }
    }, timeoutMs);
  };
  session.startPending = () => {
    const request = session.pending;
    if (request && request.owner !== session.owner) session.pending = null;
    if (!session.pending || session.state !== 'idle' || session.dispatchingStop || session.systemInterrupted) return;
    session.pending = null;
    session.activeOwner = request.owner;
    session.activeParams = { ...request.params };
    session.initialAudioSource = request.initialAudioSource || request.params.audioSource || 'auto';
    session.sourceFallback = !!request.sourceFallback;
    session.attempts = request.attempts || [];
    session.attempts.push({ audioSource: request.params.audioSource || 'auto', outcome: 'starting' });
    session.nativeIdle = false;
    session.startFailed = false;
    change('starting');
    // 原生启动可能包含首次麦克风授权；停止确认仍沿用较短的默认超时。
    session.armTimeout(15000);
    try { recorder.start({ ...request.params }); } catch (error) {
      if (session.trySourceFallback(error)) return;
      session.recordError(error);
      clearTimer(); session.nativeIdle = true; session.startFailed = true; change('error');
      publish('Error', error);
      session.offerCompatibility();
    }
  };
  session.trySourceFallback = error => {
    const message = String(error && (error.errMsg || error.message) || error || '');
    const unsupportedSource = classifyRecorderError(error) === 'unsupported-source';
    if (session.state !== 'starting' || session.activeOwner !== session.owner
        || !session.activeParams || session.activeParams.audioSource !== 'voice_recognition'
        || session.sourceFallback || !unsupportedSource) return false;
    clearTimer();
    session.recordError(error);
    sourceCapabilities.set(captureEnvironmentKey(), 'unsupported');
    session.nativeIdle = true;
    session.pending = { params: { ...session.activeParams, audioSource: 'auto' }, owner: session.owner,
      initialAudioSource: session.initialAudioSource, sourceFallback: true, attempts: session.attempts };
    change('idle');
    publish('SourceFallback', { from: 'voice_recognition', to: 'auto', reason: message });
    // The failed attempt delivered no recording frames. Start a fresh native
    // session on the next tick, so error dispatch cannot reach the new session.
    session.timer = setTimeout(() => { session.timer = null; session.startPending(); }, 0);
    return true;
  };
  session.recordError = error => {
    session.lastErrorCategory = classifyRecorderError(error);
    session.compatibilityRetryAvailable = session.state === 'starting'
      && session.activeParams && session.activeParams.audioSource === 'voice_recognition'
      && session.lastErrorCategory === 'unknown' && !session.sourceFallback;
    const attempt = session.attempts && session.attempts[session.attempts.length - 1];
    if (attempt) { attempt.outcome = 'failed'; attempt.errorCategory = session.lastErrorCategory; }
  };
  session.offerCompatibility = () => {
    if (!session.compatibilityRetryAvailable || typeof wx.showModal !== 'function') return;
    session.compatibilityRetryAvailable = false;
    const owner = session.owner, environment = captureEnvironmentKey();
    wx.showModal({ title: '可尝试兼容录音配置',
      content: '本次启动失败原因未明确。可为下次重录选择兼容录音源。实际增益、降噪和输入路由仍需核验，记录会注明配置。',
      confirmText: '使用兼容', cancelText: '保留原配置',
      success: result => {
        if (result.confirm && session.owner === owner && ['idle', 'error'].includes(session.state)
          && captureEnvironmentKey() === environment) sourceCapabilities.set(environment, 'user-selected');
      },
    });
  };
  const isRetiring = () => session.activeOwner !== session.owner || !!session.pending;
  const schedulePending = () => {
    if (session.pending && !session.systemInterrupted) session.timer = setTimeout(() => { session.timer = null; session.startPending(); }, 0);
  };
  // 每种原生事件仅绑定一次，由本层分发。不能依赖 SDK 多次 onStop
  // 注册的叠加行为，也不能让页面 offStop 移除状态机自身的监听。
  if (typeof recorder.onStart === 'function') recorder.onStart((res) => {
    if (session.state !== 'starting' || session.activeOwner !== session.owner || session.systemInterrupted) return;
    session.compatibilityRetryAvailable = false;
    const attempt = session.attempts && session.attempts[session.attempts.length - 1];
    if (attempt) attempt.outcome = 'started';
    clearTimer(); change('recording');
    publish('Start', res);
  });
  recorder.onStop((res) => {
    if (session.nativeIdle) return; // Ignore duplicate terminal callbacks before another native start.
    session.nativeIdle = true;
    clearTimer();
    // 等当前 onStop 的所有订阅者执行完再启动下一会话。
    session.dispatchingStop = true;
    try {
      change(session.systemInterrupted && session.pending ? 'waiting-interruption' : 'idle');
      if (session.activeOwner === session.owner) publish('Stop', res);
    }
    finally { session.dispatchingStop = false; }
    schedulePending();
  });
  if (typeof recorder.onError === 'function') recorder.onError((res) => {
    // Native callbacks have no session ID. During stop/owner handoff they
    // belong to the retiring attempt, not to a request that has not started.
    // Keep waiting for Stop; an error alone does not prove hardware is idle.
    if (isRetiring() || session.state === 'idle') return;
    if (session.trySourceFallback(res)) return;
    session.recordError(res);
    clearTimer(); session.pending = null; session.nativeIdle = true; session.startFailed = true; change('error');
    publish('Error', res);
    session.offerCompatibility();
  });
  if (typeof recorder.onPause === 'function') recorder.onPause(res => {
    if (isRetiring() || session.nativeIdle) return;
    clearTimer(); change('interrupted'); publish('Pause', res);
  });
  if (typeof recorder.onInterruptionBegin === 'function') recorder.onInterruptionBegin(res => {
    if (session.systemInterrupted) return;
    session.systemInterrupted = true;
    session.interruptionOwner = session.activeOwner;
    session.handoffInterruption = isRetiring() || session.nativeIdle;
    clearTimer();
    if (session.handoffInterruption) {
      change('waiting-interruption');
      if (session.pending && typeof wx.showToast === 'function') wx.showToast({ title: '录音被系统占用，等待恢复', icon: 'none' });
    } else { change('interrupted'); publish('InterruptionBegin', res); }
  });
  if (typeof recorder.onInterruptionEnd === 'function') recorder.onInterruptionEnd(res => {
    if (!session.systemInterrupted) return;
    session.systemInterrupted = false;
    const handoff = session.handoffInterruption || session.interruptionOwner !== session.owner || !!session.pending;
    session.handoffInterruption = false;
    if (handoff) {
      if (session.nativeIdle) { change('idle'); schedulePending(); }
      else {
        change('stopping'); session.armTimeout();
        try { recorder.stop(); } catch (error) { clearTimer(); session.pending = null; change('error'); }
      }
    } else publish('InterruptionEnd', res);
  });
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

function observeRecorderEvent(recorder, event, listener) {
  const session = sessionFor(recorder);
  if (!session.events.has(event)) session.events.set(event, new Set());
  const listeners = session.events.get(event);
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  const params = { ...recordParams };
  const requestedAudioSource = params.audioSource || 'auto';
  if (sourceCapabilities.has(captureEnvironmentKey()) && params.audioSource === 'voice_recognition') params.audioSource = 'auto';
  session.pending = { params, owner: session.owner, initialAudioSource: requestedAudioSource,
    sourceFallback: params.audioSource !== requestedAudioSource };
  if (session.systemInterrupted) {
    session.change('waiting-interruption');
    if (typeof wx.showToast === 'function') wx.showToast({ title: '录音被系统占用，等待恢复', icon: 'none' });
    return true;
  }
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

function getRecorderCaptureInfo(recorder) {
  const session = sessionFor(recorder);
  const audioSource = session.activeParams && session.activeParams.audioSource || getPreferredAudioSource();
  return { requestedAudioSource: session.initialAudioSource || audioSource, selectedAudioSource: audioSource,
    sourceFallback: !!session.sourceFallback, captureProfile: getMeasurementCaptureProfile(audioSource),
    sourceAttempts: (session.attempts || []).map(attempt => ({ ...attempt })),
    sourceCapabilityScope: captureEnvironmentKey(),
    sourceCompatibilityReason: sourceCapabilities.get(captureEnvironmentKey()) || null,
    captureProcessingVerification: 'unverified' };
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
  observeRecorderEvent,
  safeStartRecorder,
  restartRecorderSession,
  bindRecorderFrameListener,
  clearRecorderFrameListener,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  getPreferredAudioSource,
  classifyRecorderError,
  getMeasurementCaptureProfile,
  getRecorderCaptureInfo,
  getCurrentDeviceCalibrationId,
  getCalibrationInstallationId,
  bindRecorderListenersOnce,
};
