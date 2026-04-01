// pages/profile/profile.js
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

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {

  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

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
    wx.request({
      url: 'example.php', //仅为示例，并非真实的接口地址
      data: {
        x: '',
        y: ''
      },
      header: {
        'content-type': 'application/json' // 默认值
      },
      success (res) {
        console.log(res.data)
      }
    })
  },
  back(){
    wx.showModal({
      title: '提示',
      content: '修改头像昵称功能正在测试中',
      showCancel: false,       // 只有一个“确定”按钮
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
    //wx.navigateBack();
  }
})