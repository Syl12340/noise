var isLoggedIn=false, isNewUser=false;
const app = getApp();
const server = app.globalData.server;
const APILogin = "/api/auth/login";
const serverAPILogin = server + APILogin;
const { THEME_COLORS } = require('../../utils/constants');

Page({
  data: {
    version: app.globalData.version,
    userInfo: {
      userId:null,
      nickname:null,
      avatarUrl:null,
      group:null,
      groupType:null,
      token:null,
    },
    canIUse: wx.canIUse('button.open-type.getUserInfo'),
    isLoggedIn:isLoggedIn,
  },

  onShow() {
    this.loadLoginState();
  },

  goToUserProfile() {
    if(!isLoggedIn){
      wx.showModal({
      title: '提示',
      content: '请登录后查看',
      showCancel: false,       // 只有一个“确定”按钮
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
    }else{
      wx.navigateTo({
        url: '/pages/profile/profile'
      });
    }
    
  },

  goToSettings: function() {
    wx.navigateTo({
      url: '/pages/settings/settings'
    });
  },

  login(){
    try{
      //this._login()
      
      wx.showModal({
        title: '登录未开放',
        content: '正在测试中',
        showCancel: false,       // 只有一个“确定”按钮
        confirmText: '知道了',
        confirmColor: THEME_COLORS.PRIMARY
      });
    }catch(e){
      console.log(e);
      wx.showModal({
        title: '登录失败',
        content: '登录状态异常',
        showCancel: false,       // 只有一个“确定”按钮
        confirmText: '知道了',
        confirmColor: THEME_COLORS.PRIMARY
      });
    }
  },

  _login(){
  var my = this;
  if(isLoggedIn){
    console.log(my.data);
    wx.showModal({
      title: '登录提示',
      content: '您已登录',
      showCancel: false,       // 只有一个“确定”按钮
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
  }else{
    wx.login({
      success (res) {
        if (res.code) {
          //发起网络请求
          console.log(res.code);
          wx.request({
            url: serverAPILogin, 
            data: {
              code: res.code,
              extra: ''
            },
            header: {
              'content-type': 'application/json' // 默认值
            },
            method:'POST',
            complete(res){
              console.log(res.data);
              isLoggedIn = res.data.success;
              my.setData({
                'isLoggedIn' : res.data.success,
                'userInfo':{
                  token : res.data.token,
                  userId : res.data.userId,
                  nickname : res.data.nickname,
                  avatarUrl : res.data.avatarUrl,
                  group : res.data.userGroup,
                  groupType:null,
                }
              }, () => {
                // 在setData回调中执行后续操作
                isNewUser = res.data.isNewUser;
                console.log('3', my.data);
                my.checkUserGroup();
                my.saveLoginState();
                my.syncLoginState(app);
                
                if (my.data.isLoggedIn && isNewUser) {
                  my.welcome(my.data.userInfo.userId);
                }
              });
            }
          })
        } else {
          console.log('登录失败！' + res.errMsg)
        }
      },
      complete(res){
      }
    })
  }
  },

  welcome(uid){
    const str = `
    欢迎您使用本小程序！
    您是我们的第${uid}位用户！`
    wx.showModal({
      title: '欢迎使用',
      content: str,
      showCancel: false,       // 只有一个“确定”按钮
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
  },

  bindGetUserInfo (e) {
    wx.setStorageSync('userInfo', e.detail.userInfo);
  },

  // 退出登录
  logout() {
    wx.showModal({
      title: '提示',
      content: '确定退出登录？',
      success: (res) => {
        if (res.confirm) {
          isLoggedIn = false;
          wx.setStorageSync('isLoggedIn', false);
          wx.removeStorageSync('userInfo');
          this.setData({ 
            'userInfo': {
              userId:null,
              nickname:null,
              avatarUrl:null,
              group:null,
              groupType:null,
              token:null,
            },
            'isLoggedIn': false,
          });
          wx.showToast({ title: '已退出' });
        }
      }
    });
  },
  checkUserGroup(){
    const type = this.data.userInfo.group;
    let groupType = '';
    
    if (type === 0) {
      groupType = '管理员';
    } else if (type === 1) {
      groupType = '开发组';
    } else if (type === 2) {
      groupType = '内测组';
    } else {
      groupType = '体验用户';
    }
    
    // 使用路径更新，避免覆盖整个userInfo对象
    this.setData({
      'userInfo.groupType': groupType
    });
  },

  // 点击头像登录（需用户授权）
  onAvatarTap() {
    if (!this.data.userInfo.nickname) {
      wx.getUserProfile({
        desc: '用于完善用户资料',
        success: (res) => {
          const userInfo = res.userInfo;
          wx.setStorageSync('userInfo', userInfo);
          this.setData({ userInfo });
        }
      });
    }
  },

  saveLoginState(){
    console.log('saveloginstate: ', this.data.userInfo);
    wx.setStorageSync('userInfo', this.data.userInfo);
    wx.setStorageSync('isLoggedIn', this.data.isLoggedIn);
  },
  loadLoginState(){
    isLoggedIn = wx.getStorageSync('isLoggedIn');
    const userInfo = wx.getStorageSync('userInfo') || {};
    console.log("loadloginstate from wx: ",userInfo);
    if(isLoggedIn){
      this.setData({
        'isLoggedIn': true,
        'userInfo':userInfo,
      },()=>{
        this.checkUserGroup();
      });
      console.log("loadloginstate data: ",this.data.userInfo);
    }
  },
  syncLoginState(app){
    app.globalData.isLoggedIn = this.data.isLoggedIn;
    app.globalData.userInfo = this.data.userInfo;
  },

});