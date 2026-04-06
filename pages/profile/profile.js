// pages/profile/profile.js
// 作用：管理并展示修改用户的基本信息（如昵称、头像），支持同步配置到云端服务器。
var avatarUrl, nickname;
const app = getApp();
const server = app.globalData.server;
const APISetProfile = "/api/user/setMyProfile";
const serverAPISetProfile = server + APISetProfile;
const { THEME_COLORS } = require('../../utils/constants');
Page({

  data: {
    avatarUrl:avatarUrl,
    nickname:nickname,
    hasUserInfo: false,
    canIUseGetUserProfile: wx.canIUse('getUserProfile'),
    canIUseNicknameComp: wx.canIUse('input.type.nickname'),
  },

  onChooseAvatar(e) {
    const { avatarUrl } = e.detail 
    this.setData({
      'avatarUrl': avatarUrl,
    })

  },
  setNickname(e) {
    console.log(e);
    nickname = e.detail.value;
    this.setData({
      'nickname': nickname,
    })
  },

  postData(){
    // 根据业务发展规划，暂不实现。
  },
  back(){
    wx.showModal({
      title: '提示',
      content: '修改头像昵称功能正在测试中',
      showCancel: false,      
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
  }
})