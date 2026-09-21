// utils/phonetic/phonetic-config.js
// 语音学分析模块共享配置常量

const PHONETIC_CONFIG = {
  SAMPLE_RATE: 44100,        // 采样率 (Hz)
  FRAME_SIZE: 1102,          // 共振峰/声强帧长 = 25ms @ 44100Hz
  PITCH_FRAME_SIZE: 2048,    // YIN 分析帧，足以覆盖 60Hz 的完整延迟搜索
  HOP_SIZE: 441,             // 帧移 = 10ms @ 44100Hz
  LPC_ORDER: 16,             // LPC 阶数（44100Hz 下推荐 16）
  PRE_EMPHASIS_COEFF: 0.97,  // 预加重系数
  YIN_THRESHOLD: 0.1,        // YIN 绝对阈值
  YIN_FMIN: 60,              // 最低基频 (Hz)
  YIN_FMAX: 500,             // 最高基频 (Hz)
  FORMANT_MIN_FREQ: 90,      // 共振峰最低频率 (Hz)
  FORMANT_MAX_FREQ: 5000,    // 共振峰最高频率 (Hz)
  FORMANT_MAX_BW: 500,       // 共振峰最大带宽 (Hz)
  SGRAM_FFT_SIZE: 1024,      // 语谱图 FFT 点数
  SGRAM_WINDOW_SEC: 0.005,   // 语谱图窗长 5ms → 宽带
  MAX_RECORD_SEC: 5,         // 最大录音时长 (秒)
};

module.exports = { PHONETIC_CONFIG };
