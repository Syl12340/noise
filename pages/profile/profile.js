// pages/profile/profile.js
// 作用：管理并展示修改用户的基本信息（如昵称、头像），支持同步配置到云端服务器。
const app = getApp();
const server = app.globalData.server;
const APISetProfile = "/api/user/setMyProfile";
const serverAPISetProfile = server + APISetProfile;
const APIUploadAvatar = "/api/user/uploadAvatar";
const serverAPIUploadAvatar = server + APIUploadAvatar;
const { THEME_COLORS } = require('../../utils/constants');
Page({

  data: {
    avatarUrl: '',
    nickname: '',
    token: '',
    hasUserInfo: false,
    submitting: false,
    canIUseGetUserProfile: wx.canIUse('getUserProfile'),
    canIUseNicknameComp: wx.canIUse('input.type.nickname'),
  },

  onShow() {
    const userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo || {};
    this.setData({
      avatarUrl: userInfo.avatarUrl || '',
      nickname: userInfo.nickname || userInfo.nickName || '',
      token: userInfo.token || '',
      hasUserInfo: !!(userInfo.nickname || userInfo.nickName || userInfo.avatarUrl)
    });
  },

  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    this.setData({
      avatarUrl,
      hasUserInfo: true
    });
    wx.setStorageSync('avatarTempPath', avatarUrl);
  },

  setNickname(e) {
    const nickname = (e.detail.value || '').trim();
    this.setData({
      nickname,
      hasUserInfo: true
    });
  },

  getUserProfile() {
    wx.getUserProfile({
      desc: '用于完善用户资料',
      success: (res) => {
        const profile = res.userInfo || {};
        this.setData({
          nickname: profile.nickName || this.data.nickname,
          avatarUrl: profile.avatarUrl || this.data.avatarUrl,
          hasUserInfo: true
        });
      }
    });
  },

  uploadAvatarIfNeeded(token, currentAvatarUrl, callback) {
    if (!currentAvatarUrl || !currentAvatarUrl.startsWith('wxfile://')) {
      callback(null, currentAvatarUrl || '');
      return;
    }

    const fsManager = wx.getFileSystemManager();
    fsManager.readFile({
      filePath: currentAvatarUrl,
      encoding: 'base64',
      success: (fileRes) => {
        const extMatch = currentAvatarUrl.match(/\.([a-zA-Z0-9]+)$/);
        const fileExt = extMatch ? extMatch[1].toLowerCase() : 'jpg';

        wx.request({
          url: serverAPIUploadAvatar,
          method: 'POST',
          header: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          data: {
            avatarBase64: fileRes.data,
            fileExt
          },
          success: (uploadRes) => {
            const result = uploadRes.data || {};
            if (!result.success || !result.avatarUrl) {
              callback(new Error(result.message || '头像上传失败'));
              return;
            }
            callback(null, result.avatarUrl);
          },
          fail: () => {
            callback(new Error('头像上传失败'));
          }
        });
      },
      fail: () => {
        callback(new Error('读取头像文件失败'));
      }
    });
  },

  postData() {
    const { nickname, avatarUrl, token, submitting } = this.data;

    if (submitting) return;

    if (!token) {
      wx.showModal({
        title: '提示',
        content: '登录状态失效，请重新登录',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: THEME_COLORS.PRIMARY
      });
      return;
    }

    if (!nickname) {
      wx.showModal({
        title: '提示',
        content: '请输入昵称',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: THEME_COLORS.PRIMARY
      });
      return;
    }

    this.setData({ submitting: true });

    this.uploadAvatarIfNeeded(token, avatarUrl, (uploadErr, remoteAvatarUrl) => {
      if (uploadErr) {
        wx.showModal({
          title: '保存失败',
          content: uploadErr.message || '头像上传失败',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: THEME_COLORS.PRIMARY
        });
        this.setData({ submitting: false });
        return;
      }

      wx.request({
        url: serverAPISetProfile,
        method: 'POST',
        header: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        data: {
          nickName: nickname,
          avatarUrl: remoteAvatarUrl || ''
        },
        success: (res) => {
          const result = res.data || {};
          if (!result.success) {
            wx.showModal({
              title: '保存失败',
              content: result.message || '资料更新失败',
              showCancel: false,
              confirmText: '知道了',
              confirmColor: THEME_COLORS.PRIMARY
            });
            return;
          }

          const oldUserInfo = wx.getStorageSync('userInfo') || {};
          const mergedUserInfo = {
            ...oldUserInfo,
            nickname,
            avatarUrl: remoteAvatarUrl || ''
          };
          wx.setStorageSync('userInfo', mergedUserInfo);
          wx.setStorageSync('avatarTempPath', avatarUrl || '');
          app.globalData.userInfo = mergedUserInfo;

          wx.showToast({
            title: '保存成功',
            icon: 'success'
          });

          setTimeout(() => {
            wx.navigateBack();
          }, 300);
        },
        fail: () => {
          wx.showModal({
            title: '保存失败',
            content: '网络异常，请稍后重试',
            showCancel: false,
            confirmText: '知道了',
            confirmColor: THEME_COLORS.PRIMARY
          });
        },
        complete: () => {
          this.setData({ submitting: false });
        }
      });
    });
  },

  back() {
    this.postData();
  }
});