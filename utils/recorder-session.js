// utils/recorder-session.js
// recorder-session.js - recorderManager 与 WebAudio 资源清理辅助函数。

const CAMCORDER_RECORD_BASE = {
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'PCM',
  frameSize: 16,
  audioSource: 'camcorder',
};

const recorderListenerBindings = new WeakMap();
const recorderFrameListeners = new WeakMap();

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
    recorderManager.stop();
  } catch (e) {
    console.log(e);
  }
}

/**
 * 安全启动录音。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {object} recordParams 录音参数。
 * @param {number} [delayMs=0] 启动前延迟，单位毫秒。
 * @returns {boolean} true 表示已安排或已完成启动；false 表示参数非法或启动失败。
 * Side effect: 可能异步调用 recorderManager.start。
 */
function safeStartRecorder(recorderManager, recordParams, delayMs = 0) {
  if (!recorderManager || !recordParams) {
    return false;
  }

  const start = () => {
    try {
      recorderManager.start(recordParams);
      return true;
    } catch (e) {
      console.log(e);
      return false;
    }
  };

  if (delayMs > 0) {
    return setTimeout(start, delayMs);
  }

  return start();
}

/**
 * 先停止，再延迟启动录音。
 * @param {object} recorderManager 微信录音管理器实例。
 * @param {object} recordParams 录音参数。
 * @param {number} [delayMs=0] 停止后启动的延迟，单位毫秒。
 * @returns {boolean|number} 立即启动时返回布尔值；延迟启动时返回 timerId 以便外部取消。
 * Side effect: 会调用一次 stop，再按 delay 尝试 start；调用方应在页面退出时 clearTimeout(timerId)。
 */
function restartRecorderSession(recorderManager, recordParams, delayMs = 0) {
  if (!recorderManager || !recordParams) {
    return false;
  }

  safeStopRecorder(recorderManager);
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
    recorderManager.onFrameRecorded(frameListener);
    recorderFrameListeners.set(recorderManager, frameListener);
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
 * 创建 camcorder 录音参数。
 * @param {object} [overrides={}] 需要覆盖的参数。
 * @returns {object} 录音参数对象。
 * Side effect: none.
 */
function createCamcorderRecordParams(overrides = {}) {
  return {
    ...CAMCORDER_RECORD_BASE,
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

  register(recorderManager);
  bindingSet.add(bindingKey);
  return true;
}

module.exports = {
  safeStopRecorder,
  safeStartRecorder,
  restartRecorderSession,
  bindRecorderFrameListener,
  clearRecorderFrameListener,
  safeCloseAudioContext,
  createCamcorderRecordParams,
  bindRecorderListenersOnce,
};