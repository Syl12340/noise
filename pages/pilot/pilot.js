// pages/pilot/pilot.js
// 作用：提供应用快速启动导览及核心校准、使用说明的入口集合页面。
Page({
  data: {

  },
  noiseDetect: function(){
    this.goToMain();
  },
  
  goToMain: function() {
    wx.navigateTo({
      url: '/pages/main/main'
    });
  },

  goToCalibrate: function() {
    wx.navigateTo({
      url: '/pages/calibrate/calibrate'
    });
  },

  goToUsage(){
    wx.navigateTo({
      url: '/pages/usage/usage',
    })
  },

  goToAdvancedCalibrate(){
    wx.navigateTo({
      url: '/pages/advanced-calibrate/advanced-calibrate',
    })
  },

  goToPhonetic(){
    wx.navigateTo({
      url: '/pages/phonetic/phonetic',
    })
  }
})