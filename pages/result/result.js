// pages/result/result.js
// 作用：展示历史噪声监测的详细结果列表，提供分级颜色标注与折叠面板交互。
const resultManager = require('../../utils/result-manager');
const { THEME_COLORS } = require('../../utils/constants');
const { RISK_META } = require('../../utils/risk-config');

/**
 * 依据健康风险等级进行 UI 控件的颜色类名映射。
 * 将后台获取的严重程度评价转换为视觉上醒目的 CSS 显示类名，
 * 供结果态势列表渲染使用。
 * @param {string} threat - 计算所得的对应风险等级文本
 * @returns {string} 前端定义的表示危害程度的 CSS 颜色声明
 */
function getThreatColorClass(threat) {
  const mapping = {
    '安全': 'bg-safe',
    '需要注意': 'bg-attention',
    '中风险': 'bg-medium',
    '高风险': 'bg-high',
    '高危': 'bg-extreme',
  };
  return mapping[threat] || 'bg-unknown';
}

/**
 * 根据风险等级文本获取对应的文本颜色类名
 * @param {string} threat - 风险等级文本
 * @returns {string} 文本颜色类名（text-safe/text-attention/text-medium/text-high/text-extreme）
 */
function getThreatTextClass(threat) {
  const mapping = {
    '安全': 'text-safe',
    '需要注意': 'text-attention',
    '中风险': 'text-medium',
    '高风险': 'text-high',
    '高危': 'text-extreme',
  };
  return mapping[threat] || 'text-unknown';
}

/**
 * 将 dB 数值格式化为易读文本。
 * @param {number} value - 待格式化数值。
 * @returns {string} 格式化后的 dB 值字符串。
 */
function formatDbValue(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
}

/**
 * 将风险区间对象格式化为文本区间。
 * @param {{lower: number|null, upper: number|null}} level - 风险区间对象。
 * @returns {string} 区间描述。
 */
function formatRiskRange(level) {
  const lower = level ? level.lower : null;
  const upper = level ? level.upper : null;
  const hasLower = Number.isFinite(lower);
  const hasUpper = Number.isFinite(upper);

  if (hasLower && hasUpper) {
    return `${formatDbValue(lower)}-${formatDbValue(upper)} dB(A)`;
  }

  if (!hasLower && hasUpper) {
    return `<${formatDbValue(upper)} dB(A)`;
  }

  if (hasLower && !hasUpper) {
    return `>=${formatDbValue(lower)} dB(A)`;
  }

  return '全范围';
}

/**
 * 依据记录中的 riskSegments 快照生成历史详情展示文案。
 * @param {object} record - 单条历史记录。
 * @returns {string[]} 风险规则摘要行列表。
 */
function buildRiskSegmentSummary(record) {
  const snapshot = record && record.riskSegments;
  if (!snapshot || !snapshot.enabled || !Array.isArray(snapshot.levels)) {
    return ['未记录风险分段快照'];
  }

  const levelMap = snapshot.levels.reduce((acc, level) => {
    if (level && level.key) {
      acc[level.key] = level;
    }
    return acc;
  }, {});

  const keyOrder = ['SAFE', 'ATTENTION', 'MEDIUM', 'HIGH', 'EXTREME'];
  const enabledMap = {
    SAFE: snapshot.enabled.safe !== false,
    ATTENTION: snapshot.enabled.attention !== false,
    MEDIUM: snapshot.enabled.medium !== false,
    HIGH: snapshot.enabled.high !== false,
    EXTREME: snapshot.enabled.extreme !== false,
  };

  return keyOrder.map((key) => {
    const meta = RISK_META[key];
    const label = meta ? meta.text : key;
    if (!enabledMap[key]) {
      return `${label}：未启用`;
    }

    const level = levelMap[key];
    if (!level) {
      return `${label}：已启用（区间缺失）`;
    }

    return `${label}：${formatRiskRange(level)}`;
  });
}

/**
 * 为结果页渲染附加展示字段（不回写存储）。
 * @param {object[]} records - 原始历史记录列表。
 * @returns {object[]} 附带展示字段的记录列表。
 */
function normalizeRecordsForDisplay(records) {
  return records.map((value) => {
    const record = value && typeof value === 'object' ? value : {};
    const valid = record.dataQuality === 'valid' && Number.isFinite(record.cne);
    const reference = valid && record.calibrationGrade === 'reference';
    const knownRisk = ['安全', '需要注意', '中风险', '高风险', '高危'].includes(record.threat);
    const qualityLabel = record.dataQuality === 'invalid' ? '无效记录'
      : !valid ? '旧记录或质量信息缺失，不能确认有效性'
      : !reference ? '估算记录，不作风险分级' : !knownRisk ? '风险状态未知' : '参考校准记录';
    return { ...record, qualityLabel,
      threatDisplay: reference && knownRisk ? record.threat : qualityLabel,
      cneDisplay: valid ? record.cne.toFixed(2) : '--',
      comparisonNote: record.algorithmVersion ? '算法 ' + record.algorithmVersion + '；比较前请核对校准与参数' : '未记录算法版本，不建议直接比较',
      threatColorClass: reference && knownRisk ? getThreatColorClass(record.threat) : 'bg-unknown',
      threatTextClass: reference && knownRisk ? getThreatTextClass(record.threat) : 'text-unknown',
      riskSegmentSummary: buildRiskSegmentSummary(record) };
  });
}

Page({
  data: {
    savedResult: [],
    activeIndex: -1,
    isEmpty: true,
  },

  /**
   * 刷新数据，重新加载所有监测记录
   * 如果当前展开的索引超出新数组长度，则收起
   */
  refresh() {
    const savedResult = normalizeRecordsForDisplay(resultManager.getAll());
    let nextActiveIndex = this.data.activeIndex;
    if (nextActiveIndex >= savedResult.length) {
      nextActiveIndex = -1;
    }

    this.setData({
      savedResult,
      activeIndex: nextActiveIndex,
      isEmpty: savedResult.length === 0,
    });
  },

  onShow: function () {
    const savedResult = normalizeRecordsForDisplay(resultManager.getAll());
    this.setData({
      savedResult,
      activeIndex: -1,
      isEmpty: savedResult.length === 0,
    });
    console.log('result: ', this.data.savedResult);
  },

  handleCardTap(e) {
    console.log(e);
    const index = e.currentTarget.dataset.index;
    if (this.data.activeIndex === index) {
      this.setData({ activeIndex: -1 });
    } else {
      this.setData({ activeIndex: index });
    }
  },

  handleCardLongPress(e) {
    let instance = this;
    const index = e.currentTarget.dataset.index;
    let options = ['查看记录位置', '重命名记录', '删除此记录'];
    console.group('handleCardLongPress');
    console.log(e);
    wx.showActionSheet({
      itemList: options,
      success(res) {
        if (res.tapIndex === 0) {
          instance.checkLocation(index);
        }
        if (res.tapIndex === 1) {
          instance.rename(index);
        }
        if (res.tapIndex === 2) {
          instance.delete(index, 1);
        }
      },
      fail(res) {
        console.log(res.errMsg);
      },
      complete() {
        console.groupEnd();
      },
    });
  },

  confirmDeleteAll() {
    console.group('delete all');
    let instance = this;
    let str = '您即将删除所有记录';
    wx.showModal({
      title: '清空记录',
      content: str,
      confirmColor: THEME_COLORS.PRIMARY,
      success(res) {
        if (res.confirm) {
          console.log('delete all');
          instance.deleteAll();
        } else if (res.cancel) {
          console.log('delete aborted by user');
        }
      },
      complete() {
        console.log('complete');
        console.groupEnd();
      },
    });
  },

  deleteAll() {
    this.delete(0, -1);
    wx.showToast({
      title: '记录已清空',
      icon: 'success',
      duration: 1000,
    });
  },

  /**
   * 删除指定索引的记录（或清空所有）
   * @param {number} index - 要删除的记录索引
   * @param {number} count - 删除数量（-1 表示清空全部）
   */
  delete(index, count) {
    if (count === -1) {
      resultManager.clear();
      this.refresh();
      wx.showToast({
        title: '已删除',
        icon: 'success',
        duration: 1500,
      });
      console.log('result: ', this.data.savedResult);
      return;
    }
    console.log(`delete item[${index}]`);
    resultManager.remove(index, count);
    this.refresh();
    wx.showToast({
      title: '已删除',
      icon: 'success',
      duration: 1500,
    });
    console.log('result: ', this.data.savedResult);
  },

  rename(index) {
    var instance = this;
    let savedResult = resultManager.getAll();
    var recordName = savedResult[index].name || '未命名的记录';
    wx.showModal({
      title: '重命名记录',
      content: '',
      editable: true,
      placeholderText: recordName,
      success(res) {
        if (res.confirm) {
          console.log(`rename item[${index}] to ${res.content}`);
          resultManager.rename(index, res.content);
          instance.refresh();
          console.log('result: ', instance.data.savedResult);
        } else if (res.cancel) {
          console.log('rename aborted by user');
        }
      },
    });
  },

  /**
   * 检查并显示记录的位置信息（若存在）
   * @param {number} index - 记录索引
   */
  checkLocation(index) {
    try {
      this._checkLocation(index);
    } catch (e) {
      console.log(e);
      wx.showToast({
        title: '没有位置信息',
        icon: 'error',
        duration: 2000,
      });
    }
  },

  /**
   * 使用微信内置地图打开记录位置
   * @param {number} index - 记录索引
   */
  _checkLocation(index) {
    var instance = this;
    let savedResult = resultManager.getAll();
    var name = savedResult[index].name;
    var location = savedResult[index].location;
    var latitude = location.latitude;
    var longitude = location.longitude;
    wx.openLocation({
      name: name || '噪声监测地点',
      address: '请以实际地点为准',
      latitude,
      longitude,
      scale: 18,
    });
  },
});
