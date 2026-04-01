const { RISK_THRESHOLDS, RISK_LIMIT_RANGE } = require('./constants');

/**
 * 风险等级元数据
 * 包含所有5个风险等级的文本描述和 CSS 样式类名映射
 */
const RISK_META = {
  SAFE: { text: '安全', bgClass: 'detail-safe' },
  ATTENTION: { text: '需要注意', bgClass: 'detail-attention' },
  MEDIUM: { text: '中风险', bgClass: 'detail-medium' },
  HIGH: { text: '高风险', bgClass: 'detail-high' },
  EXTREME: { text: '高危', bgClass: 'detail-extreme' },
};

/**
 * 获取默认风险配置
 * 用户未自定义配置时的标准配置
 * @returns {object} 默认风险配置对象
 */
function getDefaultRiskConfig() {
  return {
    safeMax: RISK_THRESHOLDS.SAFE_MAX,
    limits: {
      attentionMax: RISK_THRESHOLDS.ATTENTION_MAX,
      mediumMax: RISK_THRESHOLDS.MEDIUM_MAX,
      highMax: RISK_THRESHOLDS.HIGH_MAX,
    },
    enabled: {
      attention: true,
      medium: true,
      high: true,
    },
  };
}

/**
 * 尝试解析数值，失败时返回默认值
 * @param {*} value - 待解析值
 * @param {number} fallback - 解析失败时的后备值
 * @returns {number} 有效的数值或后备值
 */
function parseNumber(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 将数值限制在指定范围内
 * @param {number} value - 原始值
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number} 限制后的值
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 规范化风险配置
 * 确保配置中的所有数值都在有效范围内
 * @param {object} input - 用户输入的配置对象
 * @returns {object} 规范化后的配置对象
 */
function normalizeRiskConfig(input) {
  const defaults = getDefaultRiskConfig();
  const source = input || {};

  // 启禁用状态规范化
  const enabled = {
    attention: true,
    medium: source.enabled ? source.enabled.medium !== false : defaults.enabled.medium,
    high: source.enabled ? source.enabled.high !== false : defaults.enabled.high,
  };

  // 分段上限值规范化与范围限制
  const limits = {
    attentionMax: clamp(
      parseNumber(source.limits && source.limits.attentionMax, defaults.limits.attentionMax),
      RISK_LIMIT_RANGE.ATTENTION_MAX.min,
      RISK_LIMIT_RANGE.ATTENTION_MAX.max
    ),
    mediumMax: clamp(
      parseNumber(source.limits && source.limits.mediumMax, defaults.limits.mediumMax),
      RISK_LIMIT_RANGE.MEDIUM_MAX.min,
      RISK_LIMIT_RANGE.MEDIUM_MAX.max
    ),
    highMax: clamp(
      parseNumber(source.limits && source.limits.highMax, defaults.limits.highMax),
      RISK_LIMIT_RANGE.HIGH_MAX.min,
      RISK_LIMIT_RANGE.HIGH_MAX.max
    ),
  };

  return {
    safeMax: defaults.safeMax,
    limits,
    enabled,
  };
}

/**
 * 验证风险配置的合法性
 * @param {object} config - 待验证的配置对象
 * @returns {object} { ok: boolean, message: string } - 验证结果与错误信息
 */
function validateRiskConfig(config) {
  const normalized = normalizeRiskConfig(config);
  const limits = normalized.limits;

  // 检查：需要注意不能禁用
  if (normalized.enabled.attention === false) {
    return { ok: false, message: '“需要注意”是锚点分段，不能禁用。' };
  }

  // 动态递增校验：仅校验当前启用的分段
  let prevMax = normalized.safeMax;

  if (limits.attentionMax <= prevMax) {
    return { ok: false, message: `“需要注意”上限必须大于 ${prevMax} dB` };
  }
  prevMax = limits.attentionMax;

  if (normalized.enabled.medium) {
    if (limits.mediumMax <= prevMax) {
      return { ok: false, message: `“中风险”上限必须大于 ${prevMax} dB` };
    }
    prevMax = limits.mediumMax;
  }

  if (normalized.enabled.high) {
    if (limits.highMax <= prevMax) {
      return { ok: false, message: `“高风险”上限必须大于 ${prevMax} dB` };
    }
  }

  return { ok: true, message: '' };
}

/**
 * 获取启用的风险等级键值
 * 根据配置提取所有启用的风险等级的 key 列表（用于复选框状态）
 * @param {object} riskConfig - 风险配置对象
 * @returns {array} 启用的风险等级键值数组，如 ['attention', 'medium', 'high']
 */
function getEnabledRiskLevels(riskConfig) {
  const normalized = normalizeRiskConfig(riskConfig);
  const levels = ['attention'];
  if (normalized.enabled.medium) {
    levels.push('medium');
  }
  if (normalized.enabled.high) {
    levels.push('high');
  }
  return levels;
}

/**
 * 根据配置建立风险等级列表
 * 动态生成按用户配置启禁用状态的风险等级序列
 * @param {object} riskConfig - 风险配置对象
 * @returns {array} 风险等级列表，每项包含 { key, upper, text, bgClass }
 */
function buildRiskLevels(riskConfig) {
  const normalized = normalizeRiskConfig(riskConfig);
  const levelSequence = [
    { key: 'SAFE', upper: normalized.safeMax, text: RISK_META.SAFE.text, bgClass: RISK_META.SAFE.bgClass },
    { key: 'ATTENTION', upper: normalized.limits.attentionMax, text: RISK_META.ATTENTION.text, bgClass: RISK_META.ATTENTION.bgClass },
  ];

  // 根据启禁用状态动态加入中/高风险等级
  if (normalized.enabled.medium) {
    levelSequence.push({ key: 'MEDIUM', upper: normalized.limits.mediumMax, text: RISK_META.MEDIUM.text, bgClass: RISK_META.MEDIUM.bgClass });
  }

  if (normalized.enabled.high) {
    levelSequence.push({ key: 'HIGH', upper: normalized.limits.highMax, text: RISK_META.HIGH.text, bgClass: RISK_META.HIGH.bgClass });
  }

  // 高危为最后的兜底等级
  levelSequence.push({ key: 'EXTREME', upper: Infinity, text: RISK_META.EXTREME.text, bgClass: RISK_META.EXTREME.bgClass });
  return levelSequence;
}

module.exports = {
  RISK_META,
  getDefaultRiskConfig,
  normalizeRiskConfig,
  validateRiskConfig,
  buildRiskLevels,
  getEnabledRiskLevels,
};
