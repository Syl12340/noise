// pages/result/result.js
// 作用：展示历史噪声监测的详细结果列表，提供分级颜色标注与折叠面板交互。
const resultManager = require('../../utils/result-manager');
const { THEME_COLORS } = require('../../utils/constants');
const { RISK_META } = require('../../utils/risk-config');

/**
 * 根据风险等级文本获取对应的 CSS 颜色类名
 * @param {string} threat - 风险等级文本（安全/需要注意/中风险/高风险/高危）
 * @returns {string} CSS 类名（bg-safe/bg-attention/bg-medium/bg-high/bg-extreme）
 */
function getThreatColorClass(threat) {
  const mapping = {
    '安全': 'bg-safe',
    '需要注意': 'bg-attention',
    '中风险': 'bg-medium',
    '高风险': 'bg-high',
    '高危': 'bg-extreme',
  };
  return mapping[threat] || 'bg-safe';
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
  return mapping[threat] || 'text-safe';
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
    const savedResult = resultManager.getAll();
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

  /**
   * 页面显示时触发，加载历史记录列表
   */
  onShow: function () {
    const savedResult = resultManager.getAll();
    this.setData({
      savedResult,
      activeIndex: -1,
      isEmpty: savedResult.length === 0,
    });
    console.log('result: ', this.data.savedResult);
  },

  /**
   * 处理卡片点击事件，展开/收起详情区
   * @param {object} e - 事件对象
   */
  handleCardTap(e) {
    console.log(e);
    const index = e.currentTarget.dataset.index;
    if (this.data.activeIndex === index) {
      this.setData({ activeIndex: -1 });
    } else {
      this.setData({ activeIndex: index });
    }
  },

  /**
   * 处理卡片长按事件，弹出操作菜单（查看位置/重命名/删除）
   * @param {object} e - 事件对象
   */
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

  /**
   * 弹出模态框确认是否清空所有记录
   */
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

  /**
   * 清空所有监测记录
   */
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

  /**
   * 弹出重命名对话框
   * @param {number} index - 要重命名的记录索引
   */
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
