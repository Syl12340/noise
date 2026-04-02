// pages/index/index.js
// 作用：提供应用首页导航，连接核心声学监测、结果记录、校准及科普指南等页面。
Page({
  data: { 
  },
  goToResult: function() {
    wx.navigateTo({
      url: '/pages/result/result'
    });
  },
  
  goToPilot(){
    wx.navigateTo({
      url: '/pages/pilot/pilot'
    })
  },

  goToKnowledge: function() {
    wx.navigateTo({
      url: '/pages/knowledge/knowledge'
    });
  },

  goToAbout: function() {
    wx.navigateTo({
      url: '/pages/about/about'
    });
  },
})
