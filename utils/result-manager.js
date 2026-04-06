// utils/result-manager.js
const STORAGE_KEY = 'savedResult';

function getAll() {
  const data = wx.getStorageSync(STORAGE_KEY);
  return Array.isArray(data) ? data : [];
}

function setAll(records) {
  const next = Array.isArray(records) ? records : [];
  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}

/**
 * 通过后进先出 (LIFO) 方式向持久化缓存新增采样记录。
 * 用于实现单次监测完成后的安全数据落盘保存与展示刷新。
 * 
 * @param {object} record - 包含时间地理和统计量度等特征数据的单个快照对象
 * @returns {Array} 推入后的全部序列数组
 */
function add(record) {
  const records = getAll();
  records.unshift(record);
  return setAll(records);
}

function rename(index, name) {
  const records = getAll();
  if (!records[index]) {
    return records;
  }
  records[index].name = name;
  return setAll(records);
}

function remove(index, count) {
  const records = getAll();
  if (count === -1) {
    records.splice(index, records.length);
  } else {
    records.splice(index, count);
  }
  return setAll(records);
}

function clear() {
  return setAll([]);
}

module.exports = {
  getAll,
  setAll,
  add,
  rename,
  remove,
  clear,
};
