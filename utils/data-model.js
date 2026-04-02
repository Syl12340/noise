// utils/data-model.js
const KEYS = {
  OFFSET: 'offset',
  EXPECTED_EXPOSURE: 'expectedExposure',
  NOISE_ALARM_LEVEL: 'noiseAlarmLevel',
  ALARM: 'alarm',
  RISK_CONFIG: 'riskConfig',
};
const { STORAGE_DEFAULTS } = require('./constants');
const { getDefaultRiskConfig, normalizeRiskConfig } = require('./risk-config');

const DEFAULTS = STORAGE_DEFAULTS;

/**
 * 验证并转换值为有效的数字
 * @param {*} value - 待转换的值
 * @param {number} fallback - 转换失败时的默认值
 * @returns {number} 有效的数字或默认值
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
  return asValidNumber(wx.getStorageSync(KEYS.OFFSET), DEFAULTS.offset);
}

/**
 * 设置麦克风硬件偏移量
 * @param {number} value - 偏移量值（dB）
 * @returns {number} 设置后的偏移量
 */
function setOffset(value) {
  const offset = asValidNumber(value, DEFAULTS.offset);
  wx.setStorageSync(KEYS.OFFSET, offset);
  return offset;
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
    // P1 改进：存储读取异常时的错误处理，返回默认配置
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
  setOffset,
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
