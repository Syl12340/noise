// pages/my/my.js
// 作用：渲染“我的”用户中心页面，管理用户登录状态并发起配置、历史记录查阅流程。
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
      this._login()
      /*
      wx.showModal({
        title: '登录未开放',
        content: '正在测试中',
        showCancel: false,       
        confirmText: '知道了',
        confirmColor: THEME_COLORS.PRIMARY
      });
      */
    }catch(e){
      console.log(e);
      wx.showModal({
        title: '登录失败',
        content: '登录状态异常',
        showCancel: false,       
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
      showCancel: false,      
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
  }else{
    wx.getUserProfile({
      desc: '用于完善用户资料',
      success: (profileRes) => {
        const profile = profileRes.userInfo || {};

        wx.login({
          success (res) {
            if (res.code) {
              wx.request({
                url: serverAPILogin,
                data: {
                  code: res.code,
                  userInfo: {
                    nickName: profile.nickName || '',
                    avatarUrl: profile.avatarUrl || ''
                  }
                },
                header: {
                  'content-type': 'application/json'
                },
                method: 'POST',
                success(loginRes) {
                  const data = loginRes.data || {};
                  const serverUserInfo = data.userInfo || {};

                  if (!data.success) {
                    isLoggedIn = false;
                    my.setData({ isLoggedIn: false });
                    wx.showModal({
                      title: '登录失败',
                      content: data.message || '登录失败，请稍后重试',
                      showCancel: false,
                      confirmText: '知道了',
                      confirmColor: THEME_COLORS.PRIMARY
                    });
                    return;
                  }

                  const nicknameCandidates = [
                    serverUserInfo.nickname,
                    serverUserInfo.nickName,
                    data.nickname,
                    profile.nickName
                  ];
                  const resolvedNickname = nicknameCandidates.find(
                    (name) => typeof name === 'string' && name.trim().length > 0
                  ) || '微信用户';

                  const avatarCandidates = [
                    serverUserInfo.avatarUrl,
                    serverUserInfo.avatar_url,
                    data.avatarUrl,
                    profile.avatarUrl
                  ];
                  const resolvedAvatar = avatarCandidates.find(
                    (url) => typeof url === 'string' && url.trim().length > 0
                  ) || '';

                  const userInfo = {
                    token: data.token || '',
                    userId: serverUserInfo.userId || serverUserInfo.id || data.userId || null,
                    nickname: resolvedNickname,
                    avatarUrl: resolvedAvatar,
                    group: (
                      serverUserInfo.userGroup ??
                      serverUserInfo.user_group ??
                      data.userGroup ??
                      data.user_group ??
                      (data.data && (data.data.userGroup ?? data.data.user_group)) ??
                      null
                    ),
                    groupType: null
                  };

                  isLoggedIn = true;
                  my.setData({
                    isLoggedIn: true,
                    userInfo
                  }, () => {
                    isNewUser = !!data.isNewUser;
                    my.checkUserGroup();
                    my.saveLoginState();
                    my.syncLoginState(app);

                    if (my.data.isLoggedIn && isNewUser) {
                      my.welcome(my.data.userInfo.userId);
                    }
                  });
                },
                fail(err) {
                  console.log('登录请求失败', err);
                  wx.showModal({
                    title: '登录失败',
                    content: '网络异常，请稍后重试',
                    showCancel: false,
                    confirmText: '知道了',
                    confirmColor: THEME_COLORS.PRIMARY
                  });
                }
              });
            } else {
              console.log('登录失败！' + res.errMsg)
            }
          }
        })
      },
      fail: () => {
        wx.showModal({
          title: '提示',
          content: '需要授权后才能登录',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: THEME_COLORS.PRIMARY
        });
      }
    });
  }
  },

  welcome(uid){
    const str = `
    欢迎您使用本小程序！
    您是我们的第${uid}位用户！`
    wx.showModal({
      title: '欢迎使用',
      content: str,
      showCancel: false,       
      confirmText: '知道了',
      confirmColor: THEME_COLORS.PRIMARY
    });
  },

  bindGetUserInfo (e) {
    const userInfo = e.detail.userInfo || {};
    wx.setStorageSync('userInfo', {
      ...this.data.userInfo,
      nickname: userInfo.nickName || this.data.userInfo.nickname,
      avatarUrl: userInfo.avatarUrl || this.data.userInfo.avatarUrl
    });
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
          app.globalData.isLoggedIn = false;
          app.globalData.userInfo = {};
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
    const rawType = this.data.userInfo.group;
    const type = rawType === null || rawType === undefined || rawType === '' ? null : Number(rawType);
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
          const profile = res.userInfo || {};
          const mergedUserInfo = {
            ...this.data.userInfo,
            nickname: profile.nickName || this.data.userInfo.nickname,
            avatarUrl: profile.avatarUrl || this.data.userInfo.avatarUrl
          };
          wx.setStorageSync('userInfo', mergedUserInfo);
          this.setData({ userInfo: mergedUserInfo });
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
    const rawUserInfo = wx.getStorageSync('userInfo') || {};
    const userInfo = {
      ...rawUserInfo,
      userId: rawUserInfo.userId || rawUserInfo.id || null,
      nickname: rawUserInfo.nickname || rawUserInfo.nickName || null,
      avatarUrl: rawUserInfo.avatarUrl || rawUserInfo.avatar_url || null,
      group: (
        rawUserInfo.group ??
        rawUserInfo.userGroup ??
        rawUserInfo.user_group ??
        (rawUserInfo.data && (rawUserInfo.data.userGroup ?? rawUserInfo.data.user_group)) ??
        null
      ),
      token: rawUserInfo.token || null
    };
    console.log("loadloginstate from wx: ",userInfo);
    if(isLoggedIn){
      this.setData({
        'isLoggedIn': true,
        'userInfo':userInfo,
      },()=>{
        this.checkUserGroup();
      });
      console.log("loadloginstate data: ",this.data.userInfo);
    } else {
      this.setData({
        'isLoggedIn': false,
        'userInfo': {
          userId:null,
          nickname:null,
          avatarUrl:null,
          group:null,
          groupType:null,
          token:null,
        }
      });
    }
  },
  syncLoginState(app){
    app.globalData.isLoggedIn = this.data.isLoggedIn;
    app.globalData.userInfo = this.data.userInfo;
  },

});