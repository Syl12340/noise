// utils/phonetic/phonetic-config.js
// 语音学分析模块共享配置常量

const PHONETIC_CONFIG = {
  SAMPLE_RATE: 44100,        // 采样率 (Hz)
  FRAME_SIZE: 1102,          // 共振峰/声强帧长 = 25ms @ 44100Hz
  ANALYSIS_SAMPLE_RATE: 12000, // 抗混叠后用于 F0 / LPC / 自相关分析
  ANALYSIS_FRAME_SIZE: 300, // 25 ms
  ANALYSIS_HOP_SIZE: 120,   // 10 ms
  PITCH_FRAME_SIZE: 1024,   // 85.3 ms @ 12 kHz，覆盖低基频及越界检查
  HOP_SIZE: 441,             // 帧移 = 10ms @ 44100Hz
  LPC_ORDER: 12,             // 在 12 kHz 分析信号上拟合
  PRE_EMPHASIS_COEFF: 0.97,  // 预加重系数
  YIN_THRESHOLD: 0.1,        // YIN 绝对阈值
  YIN_FMIN: 40,              // 最低基频 (Hz)
  YIN_FMAX: 1200,            // 最高基频 (Hz)，范围外候选不回填为低八度
  FORMANT_MIN_FREQ: 90,      // 共振峰最低频率 (Hz)
  FORMANT_MAX_FREQ: 5000,    // 共振峰最高频率 (Hz)
  FORMANT_MAX_BW: 500,       // 共振峰最大带宽 (Hz)
  SGRAM_FFT_SIZE: 1024,      // 语谱图 FFT 点数
  SGRAM_WINDOW_SEC: 0.005,   // 语谱图窗长 5ms → 宽带
  MAX_RECORD_SEC: 5,         // 最大录音时长 (秒)
  CAPTURE_END_TOLERANCE_SEC: 0.25, // 容纳停止边界；保留真实样本，不截断或补零
};

module.exports = { PHONETIC_CONFIG };
