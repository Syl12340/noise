// app.js
const dataModel = require('./utils/data-model');
const { APP_CONFIG } = require('./utils/constants');

function resolveServer() {
  const override = wx.getStorageSync('serverOverride');
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }

  const env = wx.getStorageSync('serverEnv') || 'default';
  return APP_CONFIG.SERVER_BY_ENV[env] || APP_CONFIG.SERVER_BY_ENV.default;
}

App({
  globalData:{
    version: "Beta 1.2.0.20260406.0",
    vstamp:"b.1.2.0.20260406.0",
    init: false,
    server: resolveServer(),
    isLoggedIn: wx.getStorageSync('isLoggedIn'),
    userInfo:wx.getStorageSync('userInfo'),
  },

  ioLog(key, value, option){
    if(option === "set"){
      wx.setStorageSync(key, value);
      console.log(`[Storage IO] ${option} ${key} : ${value}`);
    }else if(option === "get"){
      let res = wx.getStorageSync(key);
      console.log(`[Storage IO] ${option} ${key} : ${res}`);
      return res;
    }else{
      console.log("[Storage IO] Invaild IOlog.")
      return -1;
    }
    
  },

  initApp(){
    console.log("app initialize");
    wx.showLoading({
      title: '初始化',
    });
    var initDataArray = new Array();
    const defaults = dataModel.getDefaults();
    this.ioLog('expectedExposure', defaults.expectedExposure, 'set')
    this.ioLog('noiseAlarmLevel', defaults.noiseAlarmLevel, 'set');
    this.ioLog('alarm', defaults.alarm, 'set');
    this.ioLog('offset', defaults.offset, 'set');
    //this.ioLog('savedResult', initDataArray, 'set');
    this.ioLog('init', true, 'set');
    setTimeout(function () {
      wx.hideLoading()
    }, 1500)
  },

  onLaunch () {
    console.log("app start");
    this.globalData.init = wx.getStorageSync('init'); 
    wx.getSetting({
      success(res) {
        if (!res.authSetting['scope.record']) {
          wx.authorize({
            desc: '用于分析环境噪声分贝声压级和噪声累积能量',
            scope: 'scope.record',
            success () {
              // 用户已经同意小程序使用录音功能，后续调用 wx.startRecord 接口不会弹窗询问
              console.log("record authorized");
              wx.showToast({
                title: '您已授权录音',
                icon: 'success',
                duration: 1000
              });
            },
            fail (){
              console.log('reject record');
            }
          })
        }
      }
    })
    if(!this.globalData.init){
      this.initApp();
      this.globalData.init = true;
    }
  },
})
