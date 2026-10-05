// utils/data-model.js
const KEYS = {
  OFFSET: 'offset',
  OFFSET_VALID: 'offsetValid',
  OFFSET_META: 'offsetMeta',
  EXPECTED_EXPOSURE: 'expectedExposure',
  NOISE_ALARM_LEVEL: 'noiseAlarmLevel',
  ALARM: 'alarm',
  RISK_CONFIG: 'riskConfig',
};
const { OFFSET_IMPORT_RANGE, STORAGE_DEFAULTS } = require('./constants');
const { getDefaultRiskConfig, normalizeRiskConfig } = require('./risk-config');
const { getCalibrationInstallationId } = require('./recorder-session');
const { laboratoryVerificationHistory } = require('./laboratory-verification');

const DEFAULTS = STORAGE_DEFAULTS;
let calibrationRevision = 0;

function getCalibrationFrequency(meta = {}) {
  if (Number.isFinite(meta.calibrationFrequencyHz) && meta.calibrationFrequencyHz > 0) return meta.calibrationFrequencyHz;
  return meta.source === 'advanced-1khz-calibration' ? 1000 : null;
}

function evaluateReferenceCheck(residualDb, originalEvidence, checkEvidence, residualLimitDb = 1) {
  const hasUncertainty = evidence => evidence && Number.isFinite(evidence.uncertaintyDb)
    && evidence.uncertaintyDb >= 0 && evidence.uncertaintyCoverageFactor === 2;
  // Conservative sum of declared expanded uncertainties; application drift
  // check only, not a complete laboratory uncertainty budget.
  const combinedUncertaintyDb = hasUncertainty(originalEvidence) && hasUncertainty(checkEvidence)
    ? originalEvidence.uncertaintyDb + checkEvidence.uncertaintyDb : null;
  const absolute = Math.abs(residualDb);
  const status = !Number.isFinite(residualDb) || combinedUncertaintyDb === null ? 'inconclusive'
    : absolute + combinedUncertaintyDb <= residualLimitDb ? 'passed'
    : absolute - combinedUncertaintyDb > residualLimitDb ? 'failed' : 'inconclusive';
  return { status, residualDb, residualLimitDb, combinedUncertaintyDb,
    decisionRule: 'fixed-drift-limit-with-declared-expanded-uncertainty-guard-band' };
}

/**
 * 数据非空强验证及防篡改容错适配器。
 * 对小程序基础缓存中提取的无模式字符串或隐式丢失状态进行检测和拦截；
 * 如遇非法取值或 `NaN` 等异常表现则透明降级到缺省安全边界值。
 * @param {*} value - 解析中涉及到的不固定域变量
 * @param {number} fallback - 数据毁损时对应的默认安全缺省变量常量
 * @returns {number} 用于声学算式的正规 64 位浮点有效表示数字
 */
function asValidNumber(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 验证并转换值为有效的正数
 * @param {*} value - 待转换的值
 * @param {number} fallback - 转换失败时的默认值
 * @returns {number} 有效的正数或默认值
 */
function asPositiveNumber(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 获取麦克风硬件偏移量
 * @returns {number} 偏移量（dB）
 */
function getOffset() {
  const stored = wx.getStorageSync(KEYS.OFFSET);
  const offset = typeof stored === 'number' || (typeof stored === 'string' && stored.trim() !== '')
    ? Number(stored) : NaN;
  if (!Number.isFinite(offset) || offset < OFFSET_IMPORT_RANGE.MIN || offset > OFFSET_IMPORT_RANGE.MAX) {
    wx.setStorageSync(KEYS.OFFSET_VALID, false);
    wx.removeStorageSync(KEYS.OFFSET_META);
    wx.setStorageSync(KEYS.OFFSET, DEFAULTS.offset);
    return DEFAULTS.offset;
  }
  return offset;
}

function hasCompleteReferenceEvidence(evidence) {
  return !!evidence
    && String(evidence.referenceInstrument || '').trim().length > 0
    && String(evidence.inputChain || '').trim().length > 0
    && Number.isFinite(evidence.uncertaintyDb)
    && evidence.uncertaintyDb >= 0;
}

function getOffsetStatus(expected = {}) {
  const offset = getOffset();
  const validity = wx.getStorageSync(KEYS.OFFSET_VALID);
  const valid = validity === true;
  const meta = wx.getStorageSync(KEYS.OFFSET_META) || {};
  // 已应用的实验室预校准保留可用性；旧日期、安装标识或采集配置
  // 仅属于历史来源信息，不追加失效拦截，也不改写原始校准记录。
  if (meta.source === 'laboratory-preset' && validity !== false) {
    const historical = !Number.isFinite(meta.validUntil) || meta.validUntil <= Date.now();
    return { valid: true, offset, reason: '', meta, grade: 'estimated', riskEligible: false,
      laboratoryPreset: true, historical,
      label: historical ? '实验室预校准（历史参数）' : '实验室预校准' };
  }
  if (!valid) return { valid: false, offset, reason: '设备尚未完成有效校准', meta };
  if (expected.captureProfile && meta.captureProfile !== expected.captureProfile) {
    return { valid: false, offset, reason: '采集配置已变化，需要重新校准', meta };
  }
  if (expected.deviceId === 'unknown-device' || meta.deviceId === 'unknown-device') {
    return { valid: false, offset, reason: '无法确认设备身份，校准参数不可用', meta };
  }
  if (expected.deviceId && meta.deviceId !== expected.deviceId) {
    return { valid: false, offset, reason: '校准参数不属于当前设备', meta };
  }
  if (meta.installationId !== getCalibrationInstallationId()) {
    return { valid: false, offset, reason: '校准尚未绑定当前安装，请重新校准', meta };
  }
  if (!Number.isFinite(meta.calibratedAt) || !Number.isFinite(meta.validUntil)
      || meta.calibratedAt > Date.now() + 300000 || meta.validUntil <= Date.now()) {
    return { valid: false, offset, reason: '校准已过期或日期无效，请重新校准', meta };
  }
  const evidenceComplete = hasCompleteReferenceEvidence(meta.evidence);
  const grade = meta.grade === 'reference' && evidenceComplete ? 'reference' : 'estimated';
  const referenceCheckFailed = !!(meta.referenceCheck && meta.referenceCheck.status === 'failed');
  const referenceCheckInconclusive = !!(meta.referenceCheck && meta.referenceCheck.status === 'inconclusive');
  const incompleteReference = meta.source === 'advanced-1khz-calibration' && !evidenceComplete;
  return { valid: true, offset, reason: '', meta, grade,
    riskEligible: grade === 'reference' && !referenceCheckFailed && !referenceCheckInconclusive,
    label: grade === 'reference'
      ? (referenceCheckFailed ? '1 kHz 参考校准（复测偏差超限）'
        : referenceCheckInconclusive ? '1 kHz 参考校准（复测证据不足）' : '1 kHz 单点参考校准')
      : incompleteReference ? '估算参数（参考证据不完整）' : '估算参数（非参考校准）' };
}

/**
 * 设置麦克风硬件偏移量
 * @param {number} value - 偏移量值（dB）
 * @returns {number} 设置后的偏移量
 */
function setOffset(value, metadata = {}) {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < OFFSET_IMPORT_RANGE.MIN || parsed > OFFSET_IMPORT_RANGE.MAX) {
    throw new RangeError(`校准偏移量必须在 ${OFFSET_IMPORT_RANGE.MIN}~${OFFSET_IMPORT_RANGE.MAX} dB 之间`);
  }
  // 有效标记最后提交，避免写入中途失败后沿用旧的有效状态。
  wx.setStorageSync(KEYS.OFFSET_VALID, false);
  wx.setStorageSync(KEYS.OFFSET, parsed);
  const calibratedAt = Number.isFinite(metadata.calibratedAt) ? metadata.calibratedAt : Date.now();
  const evidenceComplete = hasCompleteReferenceEvidence(metadata.evidence);
  const grade = metadata.source === 'advanced-1khz-calibration' && evidenceComplete
    ? 'reference' : 'estimated';
  wx.setStorageSync(KEYS.OFFSET_META, {
    calibrationId: 'cal-' + Date.now().toString(36) + '-' + (++calibrationRevision) + '-' + Math.random().toString(36).slice(2),
    captureProfile: metadata.captureProfile || null,
    deviceId: metadata.deviceId || null,
    source: metadata.source || 'manual',
    presetCaptureProfile: metadata.presetCaptureProfile || null,
    importedFrom: metadata.importedFrom || null,
    evidence: metadata.evidence || null,
    evidenceComplete,
    referenceCheck: metadata.referenceCheck || null,
    laboratoryVerification: metadata.laboratoryVerification || null,
    laboratoryVerificationHistory: laboratoryVerificationHistory(metadata),
    inputChain: metadata.inputChain || '',
    scope: metadata.scope || 'single-offset-only',
    calibrationFrequencyHz: getCalibrationFrequency(metadata),
    frequencyResponseVerification: 'unverified',
    captureChainVerification: 'unverified',
    calibratedAt,
    installationId: getCalibrationInstallationId(),
    grade,
    // 应用复核策略，不是仪器或临床认证的有效期。
    validUntil: Math.min(calibratedAt + 90 * 24 * 3600 * 1000,
      Number.isFinite(metadata.validUntil) ? metadata.validUntil : Infinity),
  });
  wx.setStorageSync(KEYS.OFFSET_VALID, true);
  return parsed;
}

// A verification run appends evidence only. It must not change the offset,
// validity flag, installation binding, grade, calibration time, or expiry.
function appendReferenceCheck(expectedOffset, referenceCheck, expectedMeta) {
  const currentOffset = getOffset();
  const meta = wx.getStorageSync(KEYS.OFFSET_META) || {};
  const revision = value => {
    if (!value) return null;
    if (value.calibrationId) return value.calibrationId;
    const { referenceCheck: ignored, laboratoryVerification: ignoredLaboratory, laboratoryVerificationHistory: ignoredHistory, ...immutable } = value;
    return JSON.stringify(immutable);
  };
  if (!Number.isFinite(expectedOffset) || currentOffset !== expectedOffset || !meta.source
      || !expectedMeta || revision(meta) !== revision(expectedMeta)) return false;
  wx.setStorageSync(KEYS.OFFSET_META, { ...meta, referenceCheck });
  return true;
}

function appendLaboratoryVerification(expectedOffset, laboratoryVerification, expectedMeta) {
  const meta = wx.getStorageSync(KEYS.OFFSET_META) || {};
  const revision = value => {
    if (!value) return null;
    if (value.calibrationId) return value.calibrationId;
    const { referenceCheck, laboratoryVerification: ignored, laboratoryVerificationHistory: ignoredHistory, ...immutable } = value;
    return JSON.stringify(immutable);
  };
  if (getOffset() !== expectedOffset || !expectedMeta || !meta.source
    || revision(meta) !== revision(expectedMeta)) return false;
  const history = laboratoryVerificationHistory(meta);
  history.push(laboratoryVerification);
  wx.setStorageSync(KEYS.OFFSET_META, { ...meta, laboratoryVerification, laboratoryVerificationHistory: history });
  return true;
}

function invalidateOffset() {
  wx.setStorageSync(KEYS.OFFSET_VALID, false);
}

/**
 * 获取预期暴露时长（小时）
 * @returns {number} 预期暴露时长（h）
 */
function getExpectedExposureHours() {
  return asPositiveNumber(wx.getStorageSync(KEYS.EXPECTED_EXPOSURE), DEFAULTS.expectedExposure);
}

/**
 * 获取预期暴露时长（秒）
 * @returns {number} 预期暴露时长（s）
 */
function getExpectedExposureSeconds() {
  return getExpectedExposureHours() * 3600;
}

/**
 * 设置预期暴露时长（小时）
 * @param {number} value - 预期暴露时长（h）
 * @returns {number} 设置后的预期暴露时长（h）
 */
function setExpectedExposureHours(value) {
  const hours = asPositiveNumber(value, DEFAULTS.expectedExposure);
  wx.setStorageSync(KEYS.EXPECTED_EXPOSURE, hours);
  return hours;
}

/**
 * 获取噪声报警阈值
 * @returns {number} 噪声报警阈值（CNE）
 */
function getNoiseAlarmLevel() {
  return asValidNumber(wx.getStorageSync(KEYS.NOISE_ALARM_LEVEL), DEFAULTS.noiseAlarmLevel);
}

/**
 * 设置噪声报警阈值
 * @param {number} value - 噪声报警阈值（CNE）
 * @returns {number} 设置后的噪声报警阈值（CNE）
 */
function setNoiseAlarmLevel(value) {
  const level = asValidNumber(value, DEFAULTS.noiseAlarmLevel);
  wx.setStorageSync(KEYS.NOISE_ALARM_LEVEL, level);
  return level;
}

/**
 * 获取报警是否启用
 * @returns {boolean} 报警是否启用
 */
function getAlarmEnabled() {
  const value = wx.getStorageSync(KEYS.ALARM);
  return value === '' ? DEFAULTS.alarm : value !== false;
}

/**
 * 设置报警是否启用
 * @param {boolean} value - 是否启用报警
 * @returns {boolean} 设置后的报警状态
 */
function setAlarmEnabled(value) {
  const enabled = value !== false;
  wx.setStorageSync(KEYS.ALARM, enabled);
  return enabled;
}

/**
 * 获取风险配置对象
 * @returns {object} 风险配置对象（包含启禁用状态和阈值）
 */
function getRiskConfig() {
  try {
    const value = wx.getStorageSync(KEYS.RISK_CONFIG);
    if (!value) {
      return getDefaultRiskConfig();
    }
    return normalizeRiskConfig(value);
  } catch (error) {
    // 存储读取异常时的错误处理，返回默认配置
    console.error('getRiskConfig storage error:', error);
    return getDefaultRiskConfig();
  }
}

/**
 * 设置风险配置对象
 * @param {object} config - 风险配置对象
 * @returns {object} 规范化后的风险配置对象
 */
function setRiskConfig(config) {
  const normalized = normalizeRiskConfig(config);
  wx.setStorageSync(KEYS.RISK_CONFIG, normalized);
  return normalized;
}

/**
 * 获取所有默认配置值
 * @returns {object} 包含所有默认值的对象
 */
function getDefaults() {
  return {
    offset: DEFAULTS.offset,
    expectedExposure: DEFAULTS.expectedExposure,
    noiseAlarmLevel: DEFAULTS.noiseAlarmLevel,
    alarm: DEFAULTS.alarm,
    riskConfig: getDefaultRiskConfig(),
  };
}

module.exports = {
  KEYS,
  getDefaults,
  getOffset,
  getOffsetStatus,
  setOffset,
  appendReferenceCheck,
  appendLaboratoryVerification,
  evaluateReferenceCheck,
  getCalibrationFrequency,
  invalidateOffset,
  getExpectedExposureHours,
  getExpectedExposureSeconds,
  setExpectedExposureHours,
  getNoiseAlarmLevel,
  setNoiseAlarmLevel,
  getAlarmEnabled,
  setAlarmEnabled,
  getRiskConfig,
  setRiskConfig,
};
