// pages/advanced-calibrate/advanced-calibrate.js
// 作用：提供进阶的声学偏移量校准、历史预设加载以及外部校准参数导入功能。
const app = getApp();
const dataModel = require('../../utils/data-model');
const { OFFSET_IMPORT_RANGE } = require('../../utils/constants');
const { getMeasurementCaptureProfile, getCurrentDeviceCalibrationId, getCalibrationInstallationId } = require('../../utils/recorder-session');
Page({

  data: {
    currentOffset: dataModel.getOffset(),
  },

  onShow() {
    const status = dataModel.getOffsetStatus({ captureProfile: getMeasurementCaptureProfile(), deviceId: getCurrentDeviceCalibrationId() });
    this.setData({
      currentOffset: dataModel.getOffset(),
      calibrationLabel: status.label || status.reason,
      calibrationDate: status.meta && status.meta.calibratedAt ? new Date(status.meta.calibratedAt).toLocaleDateString() : '--',
      validUntil: status.meta && status.meta.validUntil ? new Date(status.meta.validUntil).toLocaleDateString() : '--',
    });
  },

  invalidateChangedInput() {
    wx.showModal({ title: '采集条件已变化', content: '更换麦克风、耳机或录音输入后，旧参数应重新校准。确认使当前校准失效？',
      success: result => { if (result.confirm) { dataModel.invalidateOffset(); this.onShow(); } } });
  },

  exportCalibration() {
    const status = dataModel.getOffsetStatus({ captureProfile: getMeasurementCaptureProfile(), deviceId: getCurrentDeviceCalibrationId() });
    if (!status.valid) { wx.showToast({ title: status.reason, icon: 'none' }); return; }
    // 导出的普通 JSON 同时保留绑定和原日期，不声称 Base64 是加密。
    wx.setClipboardData({ data: JSON.stringify({ ...status.meta, offset: status.offset,
      source: 'NoiseCalibration', friendlyName: this.getQuickDeviceInfo().friendlyName }) });
  },

  fetchDeviceInfo(){
    const {brand, model, friendlyName} = this.getQuickDeviceInfo();
    const r = `品牌：${brand}\n型号：${model}\n友好名称：${friendlyName}\n当前偏移量：${this.data.currentOffset}`
    wx.showModal({
      title: '设备信息详情',
      editable: false,
      showCancel: false,
      content: r,
      success (res) {
        if (res.confirm) {
          console.log(`device info ok with "${r}"`)
        } 
      }
    })
  },

  getQuickDeviceInfo() {
    const deviceInfo = wx.getDeviceInfo();
    
    // 处理大小写兼容
    const brand = deviceInfo.brand.charAt(0).toUpperCase() + deviceInfo.brand.slice(1);
    const model = deviceInfo.model; 
    
    // 同样使用防重复拼接逻辑
    const friendlyName = model.toLowerCase().startsWith(brand.toLowerCase()) 
        ? model 
        : `${brand} ${model}`;
  
    return {
      brand: brand,
      model: model,
      friendlyName: friendlyName
    };
  },

  goToAdvancedCalibration()
  {
    wx.navigateTo({
      url: '/pages/advanced-calibrate/calibrate/calibrate',
    });
  },

  importCalibration() {
    const that = this;
    wx.getClipboardData({
      success(res) {
        // 去除前后空格
        const clipboardText = res.data.trim(); 
        
        if (!clipboardText) {
          wx.showToast({ title: '未检测到有效的校准信息', icon: 'none' });
          return;
        }

        try {
          // 1. 将 Base64 字符串解码为 ArrayBuffer (微信原生 API)
          const buffer = clipboardText.startsWith('{') ? null : wx.base64ToArrayBuffer(clipboardText);
          
          // 2. 将 ArrayBuffer 转换为 UTF-8 字符串 (支持中文防乱码)
          const decodedJsonString = buffer ? that.decodeUtf8BufferToString(buffer) : clipboardText;
          console.log("decoded: "+ decodedJsonString);

          // 3. 解析 JSON
          const data = JSON.parse(decodedJsonString);

          // 4. 校验来源并应用数据
          if (data.source === "NoiCali" || data.source === 'NoiseCalibration') {
            const offset = typeof data.offset === 'number' || (typeof data.offset === 'string' && data.offset.trim()) ? Number(data.offset) : NaN;
            const deviceName = data.friendlyName;
            const expectedProfile = getMeasurementCaptureProfile();
            const expectedDeviceId = getCurrentDeviceCalibrationId();

            if (!Number.isFinite(offset) || offset < OFFSET_IMPORT_RANGE.MIN || offset > OFFSET_IMPORT_RANGE.MAX) {
              throw new Error("Invalid offset range");
            }
            if (data.captureProfile !== expectedProfile || data.deviceId !== expectedDeviceId) {
              throw new Error('Calibration device or capture profile mismatch');
            }
            if (data.installationId !== getCalibrationInstallationId()) {
              throw new Error('Imported calibration is not bound to this installation; recalibration required');
            }
            if (!Number.isFinite(data.calibratedAt) || !Number.isFinite(data.validUntil)
                || data.validUntil <= Date.now() || data.calibratedAt > Date.now()) {
              throw new Error('Imported calibration date is missing or expired');
            }
            
            // 存入缓存
            dataModel.setOffset(offset, {
              captureProfile: expectedProfile,
              deviceId: expectedDeviceId,
              source: 'NoiCali-import',
              calibratedAt: data.calibratedAt,
              validUntil: data.validUntil,
            });

            wx.showModal({
              title: '参数导入成功',
              content: `校准设备：${deviceName}\n偏移量：${offset.toFixed(2)} dB`,
              showCancel: false
            });

            // 清空剪贴板避免重复读取旧数据
            wx.setClipboardData({ data: ' ' });
            
            // 刷新页面数据
            that.onShow();
          } else {
            throw new Error("Invalid Source");
          }
        } catch (e) {
          console.error("解密或解析失败", e);
          wx.showToast({ title: '参数无效、过期或未绑定本安装，请重新校准', icon: 'none', duration: 3500 });
        }
      }
    });
  },

  /**
   * 辅助函数：降级处理 ArrayBuffer 转 UTF-8 字符串
   * 作用是为了在低版本环境中，将加密/导出的 Base64 对应 ArrayBuffer 解码。
   * @param {ArrayBuffer} buffer - 待解析的 ArrayBuffer 二进制数据。
   * @return {string} 返回转码后的 UTF-8 字符串。
   */
  decodeUtf8BufferToString(buffer) {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    const array = new Uint8Array(buffer);
    let out = '', i = 0;
    const continuation = value => (value & 0xC0) === 0x80;
    while (i < array.length) {
      const first = array[i++];
      if (first <= 0x7F) { out += String.fromCharCode(first); continue; }
      let needed, codePoint, minimum;
      if (first >= 0xC2 && first <= 0xDF) { needed = 1; codePoint = first & 0x1F; minimum = 0x80; }
      else if (first >= 0xE0 && first <= 0xEF) { needed = 2; codePoint = first & 0x0F; minimum = 0x800; }
      else if (first >= 0xF0 && first <= 0xF4) { needed = 3; codePoint = first & 0x07; minimum = 0x10000; }
      else throw new Error('Invalid UTF-8 leading byte');
      if (i + needed > array.length) throw new Error('Truncated UTF-8 sequence');
      for (let j = 0; j < needed; j++) {
        const next = array[i++];
        if (!continuation(next)) throw new Error('Invalid UTF-8 continuation byte');
        codePoint = (codePoint << 6) | (next & 0x3F);
      }
      if (codePoint < minimum || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        throw new Error('Invalid UTF-8 code point');
      }
      if (codePoint <= 0xFFFF) out += String.fromCharCode(codePoint);
      else {
        const adjusted = codePoint - 0x10000;
        out += String.fromCharCode(0xD800 + (adjusted >> 10), 0xDC00 + (adjusted & 0x3FF));
      }
    }
    return out;
  },

  // 一键匹配并应用云端预设校准参数
  applyPresetCalibration() {
    // 1. 获取当前设备信息
    const deviceInfo = wx.getDeviceInfo();
    
    // 微信返回的 model 通常为 "iPhone 16 Pro<iPhone17,1>" 或 "Xiaomi 2410DPN6CC"
    // 为了匹配绝对精准，我们将读取到的字符串去除所有空格并转为小写
    const currentModel = deviceInfo.model.replace(/\s+/g, '').toLowerCase();
    
    // 2. 建立硬编码的“云端”预设数据库 (基于实验室 1kHz 80dB 测定均值)
    const presetDatabase =[
      { id: '2410dpn6cc', name: 'Xiaomi 15 Pro', offset: 118.806247, captureProfile: 'pcm-44100-mono-camcorder-v1' },
      { id: 'iphone14,7', name: 'iPhone 14', offset: 98.146667, captureProfile: 'pcm-44100-mono-camcorder-v1' },
      { id: 'iphone17,1', name: 'iPhone 16 Pro', offset: 98.210000, captureProfile: 'pcm-44100-mono-camcorder-v1' },
      { id: 'iphone11,2', name: 'iPhone XS', offset: 95.076667, captureProfile: 'pcm-44100-mono-camcorder-v1' },
      { id: '24115ra8ec', name: 'Redmi Note 14 Pro', offset: 99.940508, captureProfile: 'pcm-44100-mono-camcorder-v1' },
      { id: 'dnp-an00', name: 'HONOR 400 Pro', offset: 102.209364, captureProfile: 'pcm-44100-mono-camcorder-v1' }
    ];

    // 3. 遍历匹配设备底层型号
    let matchedDevice = null;
    for (let i = 0; i < presetDatabase.length; i++) {
      // 使用 includes 包含匹配，以防微信 API 在型号前后加上品牌名或括号
      if (currentModel.includes(presetDatabase[i].id)
        && presetDatabase[i].captureProfile === getMeasurementCaptureProfile()) {
        matchedDevice = presetDatabase[i];
        break;
      }
    }

    // 4. 根据匹配结果执行 UI 交互
    if (matchedDevice) {
      wx.showModal({
        title: '发现设备预设校准',
        content: `识别到您的设备为：${matchedDevice.name}\n实验室均值偏移量：${matchedDevice.offset} dB\n是否立即应用该参数？`,
        success: (res) => {
          if (res.confirm) {
            // 应用参数到本地永久缓存
            dataModel.setOffset(matchedDevice.offset, {
              captureProfile: getMeasurementCaptureProfile(),
              deviceId: getCurrentDeviceCalibrationId(),
              source: 'laboratory-preset',
            });
            
            // 校准页面上的数值也能立即刷新，可以在这里 setData
            this.setData({
              currentOffset: matchedDevice.offset.toFixed(2)
            });

            // 提示用户
            wx.showToast({
              title: '参数已应用',
              icon: 'success',
              duration: 2000
            });
            
            console.log(`[AutoCalib] 成功匹配并应用 ${matchedDevice.name} 的参数: ${matchedDevice.offset}`);
          }
        }
      });
    } else {
      // 未匹配到的情况：显示用户的真实设备信息，方便上报
      wx.showModal({
        title: '未找到预设参数',
        content: `当前设备标识 (${deviceInfo.model}) 暂无实验室校准数据，请继续使用本页面的专业工具进行现场标定。`,
        showCancel: false
      });
    }
  }


})
