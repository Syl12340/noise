// pages/settings/settings.js
// 作用：呈现用户应用偏好与安全参数配置界面，负责风险等级阈值和提醒开关的修改及持久化。
const dataModel = require('../../utils/data-model');
const { OFFSET_IMPORT_RANGE } = require('../../utils/constants');
const {
  getDefaultRiskConfig,
  normalizeRiskConfig,
  validateRiskConfig,
  getEnabledRiskLevels,
} = require('../../utils/risk-config');

function clampOffset(value) {
  return Math.min(OFFSET_IMPORT_RANGE.MAX, Math.max(OFFSET_IMPORT_RANGE.MIN, value));
}

Page({
  data: {
    duration: dataModel.getExpectedExposureHours(),
    energy: dataModel.getNoiseAlarmLevel(),
    unitIndex: 0,
    units: [{ name: 'dB SPL' }],
    alarm: dataModel.getAlarmEnabled(),
    offset: dataModel.getOffset(),
    darkMode: false,
    syncCloud: false,
    intervalIndex: 1,
    intervals: [1, 5, 10, 30, 60],
    riskConfig: getDefaultRiskConfig(),
    riskEnabledValues: getEnabledRiskLevels(getDefaultRiskConfig()),
  },

  onShow() {
    try {
      const riskConfig = dataModel.getRiskConfig();
      this.setData({
        duration: dataModel.getExpectedExposureHours(),
        energy: dataModel.getNoiseAlarmLevel(),
        alarm: dataModel.getAlarmEnabled(),
        offset: dataModel.getOffset(),
        riskConfig,
        riskEnabledValues: getEnabledRiskLevels(riskConfig),
      });
    } catch (error) {
      console.log('local variable unavailable.', error);
      this.reset();
    }
  },

  changeDuration(e) {
    const delta = parseFloat(e.currentTarget.dataset.delta || 0);
    const current = parseFloat(this.data.duration || 0);

    let newVal = Math.max(0.5, current + delta);
    newVal = Math.round(newVal * 2) / 2;

    this.setData({
      duration: newVal.toFixed(1),
    });
  },

  changeEnergy(e) {
    const val = parseFloat(e.detail.value);
    this.setData({ energy: Number.isFinite(val) ? val : dataModel.getNoiseAlarmLevel() });
  },

  changeUnit(e) {
    this.setData({ unitIndex: e.detail.value });
  },

  toggleAlarm(e) {
    this.setData({ alarm: e.detail.value });
  },

  changeOffset(e) {
    const val = parseFloat(e.detail.value);
    this.setData({ offset: Number.isFinite(val) ? clampOffset(val) : dataModel.getOffset() });
  },

  toggleDark() {
    // 根据业务发展规划，暂不实现。
  },

  toggleSync(e) {
    this.setData({ syncCloud: e.detail.value });
  },

  changeInterval(e) {
    this.setData({ intervalIndex: e.detail.value });
  },

  // 共享的风险配置更新方法，减少代码重复
  _updateRiskConfig(config) {
    this.setData({
      riskConfig: config,
      riskEnabledValues: getEnabledRiskLevels(config),
    });
  },

  onRiskEnabledChange(e) {
    const selected = e.detail.value || [];
    const config = normalizeRiskConfig(this.data.riskConfig);
    config.enabled.attention = true;
    config.enabled.medium = selected.indexOf('medium') >= 0;
    config.enabled.high = selected.indexOf('high') >= 0;

    this._updateRiskConfig(config);
  },

  onRiskLimitInput(e) {
    const key = e.currentTarget.dataset.key;
    const parsed = parseFloat(e.detail.value);
    if (!key) {
      return;
    }

    const config = JSON.parse(JSON.stringify(this.data.riskConfig || getDefaultRiskConfig()));
    const oldVal = config.limits[key];

    if (!Number.isFinite(parsed)) {
      this.setData({ [`riskConfig.limits.${key}`]: oldVal });
      return;
    }

    config.limits[key] = parsed;

    const validation = validateRiskConfig(config);
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none', duration: 2500 });
      this.setData({ [`riskConfig.limits.${key}`]: oldVal });
      return;
    }

    this._updateRiskConfig(normalizeRiskConfig(config));
  },

  requestRecord() {
    wx.openSetting();
  },

  clearCache() {
    wx.showToast({ title: '已清除缓存', icon: 'success' });
  },

  save() {
    const duration = parseFloat(this.data.duration);
    const energy = parseFloat(this.data.energy);
    const offset = parseFloat(this.data.offset);
    const normalizedOffset = Number.isFinite(offset) ? clampOffset(offset) : dataModel.getOffset();

    const candidateRiskConfig = normalizeRiskConfig(this.data.riskConfig);
    const validation = validateRiskConfig(candidateRiskConfig);
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' });
      return;
    }

    dataModel.setExpectedExposureHours(Number.isFinite(duration) && duration > 0 ? duration : dataModel.getExpectedExposureHours());
    dataModel.setNoiseAlarmLevel(Number.isFinite(energy) ? energy : dataModel.getNoiseAlarmLevel());
    dataModel.setAlarmEnabled(this.data.alarm);
    dataModel.setOffset(normalizedOffset);
    dataModel.setRiskConfig(candidateRiskConfig);

    this.setData({
      offset: normalizedOffset,
      riskConfig: candidateRiskConfig,
      riskEnabledValues: getEnabledRiskLevels(candidateRiskConfig),
    });

    wx.showToast({
      title: '设置已保存',
      icon: 'success',
      duration: 2000,
    });
    setTimeout(() => {
      wx.navigateBack();
    }, 2000);
  },

  reset() {
    const defaults = dataModel.getDefaults();
    this.setData({
      duration: defaults.expectedExposure,
      energy: defaults.noiseAlarmLevel,
      unitIndex: 0,
      alarm: defaults.alarm,
      offset: defaults.offset,
      darkMode: false,
      syncCloud: false,
      intervalIndex: 1,
      riskConfig: defaults.riskConfig,
      riskEnabledValues: getEnabledRiskLevels(defaults.riskConfig),
    });
    wx.showToast({ title: '已恢复默认，请点击保存', icon: 'none' });
  },
});
