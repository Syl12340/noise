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
