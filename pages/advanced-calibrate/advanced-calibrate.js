// pages/advanced-calibrate/advanced-calibrate.js
// 作用：提供进阶的声学偏移量校准、历史预设加载以及外部校准参数导入功能。
const app = getApp();
const dataModel = require('../../utils/data-model');
const { OFFSET_IMPORT_RANGE } = require('../../utils/constants');
Page({

  data: {
    currentOffset: dataModel.getOffset(),
  },

  onShow() {
    this.setData({
      currentOffset: dataModel.getOffset(),
    });
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
          const buffer = wx.base64ToArrayBuffer(clipboardText);
          
          // 2. 将 ArrayBuffer 转换为 UTF-8 字符串 (支持中文防乱码)
          let decodedJsonString = '';
          decodedJsonString = String.fromCharCode.apply(null, new Uint8Array(buffer));
          //decodedJsonString = new TextDecoder('utf-8').decode(buffer);
          console.log("decoded: "+ decodedJsonString);

          // 3. 解析 JSON
          const data = JSON.parse(decodedJsonString);

          // 4. 校验来源并应用数据
          if (data.source === "NoiCali") {
            const offset = parseFloat(data.offset);
            const deviceName = data.friendlyName;

            if (!Number.isFinite(offset) || offset < OFFSET_IMPORT_RANGE.MIN || offset > OFFSET_IMPORT_RANGE.MAX) {
              throw new Error("Invalid offset range");
            }
            
            // 存入缓存
            dataModel.setOffset(offset);

            wx.showModal({
              title: '参数导入成功',
              content: `校准设备：${deviceName}\n偏移量：${offset.toFixed(2)} dB`,
              showCancel: false
            });

            // 清空剪贴板避免重复读取旧数据
            wx.setClipboardData({ data: ' ' });
            
            // 刷新页面数据
            that.setData({ currentOffset: offset });
          } else {
            throw new Error("Invalid Source");
          }
        } catch (e) {
          console.error("解密或解析失败", e);
          wx.showToast({ title: '剪贴板内无有效的校准参数', icon: 'none' });
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
    const array = new Uint8Array(buffer);
    let out = "", i = 0, len = array.length;
    let c, char2, char3;
    while(i < len) {
        c = array[i++];
        switch(c >> 4) { 
            case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
                out += String.fromCharCode(c);
                break;
            case 12: case 13:
                char2 = array[i++];
                out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
                break;
            case 14:
                char2 = array[i++];
                char3 = array[i++];
                out += String.fromCharCode(((c & 0x0F) << 12) | ((char2 & 0x3F) << 6) | ((char3 & 0x3F) << 0));
                break;
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
      { id: '2410dpn6cc', name: 'Xiaomi 15 Pro', offset: 118.806247 },
      { id: 'iphone14,7', name: 'iPhone 14', offset: 98.146667 },
      { id: 'iphone17,1', name: 'iPhone 16 Pro', offset: 98.210000 },
      { id: 'iphone11,2', name: 'iPhone XS', offset: 95.076667 },
      { id: '24115ra8ec', name: 'Redmi Note 14 Pro', offset: 99.940508 },
      { id: 'dnp-an00', name: 'HONOR 400 Pro', offset: 102.209364 }
    ];

    // 3. 遍历匹配设备底层型号
    let matchedDevice = null;
    for (let i = 0; i < presetDatabase.length; i++) {
      // 使用 includes 包含匹配，以防微信 API 在型号前后加上品牌名或括号
      if (currentModel.includes(presetDatabase[i].id)) {
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
            dataModel.setOffset(matchedDevice.offset);
            
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