// utils/constants.js
const RISK_THRESHOLDS = {
  SAFE_MAX: 80,
  ATTENTION_MAX: 85,
  MEDIUM_MAX: 94,
  HIGH_MAX: 105,
};

const RISK_LEVEL_KEYS = {
  SAFE: 'safe',
  ATTENTION: 'attention',
  MEDIUM: 'medium',
  HIGH: 'high',
  EXTREME: 'extreme',
};

const RISK_LIMIT_RANGE = {
  ATTENTION_MAX: { min: 75, max: 90 },
  MEDIUM_MAX: { min: 80, max: 100 },
  HIGH_MAX: { min: 90, max: 120 },
};

const CNE_FORMULA = {
  K_FACTOR_WEIGHT: 3,
  REFERENCE_EXPOSURE_SECONDS: 28800,
};

const STORAGE_DEFAULTS = {
  offset: 100,
  expectedExposure: 2,
  noiseAlarmLevel: 100,
  alarm: true,
};

const OFFSET_IMPORT_RANGE = {
  MIN: -200,
  MAX: 200,
};

const LIMITS = {
  INSTANT_DB_LIMIT_DEFAULT: 80,
  CALIB_TARGET_SPL: 80.0,
};

const CANVAS_CONFIG = {
  MONITOR: {
    GLOBAL_SIZE: 320,
    SCALE_X: 30,
    SCALE_Y: 2,
  },
  AXIS_PADDING: {
    LEFT: 28,    // 左侧Y轴标签空间
    RIGHT: 20,   // 右侧Y轴标签空间
    TOP: 12,     // 顶部空间
    BOTTOM: 30,  // 底部空间（容纳 X 轴标签）
  },
  CALIBRATE: {
    GLOBAL_SIZE: 300,
    SCALE_X: 30,
    SCALE_Y: 3,
  },
  SPECTRUM: {
    GLOBAL_SIZE: 320,
    DB_MIN: 20,
    DB_MAX: 120,
  },
  SPECTROGRAM: {
    GLOBAL_SIZE: 300,
    DB_MIN: 0,
    DB_MAX: 70,
    STRIP_WIDTH: 4,
  },
  FFT: {
    SIZE: 2048,
    SAMPLE_RATE: 44100,
    HOP_SIZE: 1600,
  },
};

const APP_CONFIG = {
  SERVER_BY_ENV: {
    default: 'https://project.stu.ecnu.edu.cn/noise',
    dev: 'https://project.stu.ecnu.edu.cn/noise',
    prod: 'https://project.stu.ecnu.edu.cn/noise',
  },
};

const THEME_COLORS = {
  PRIMARY: '#A41F35',
  PRIMARY_RGB: '164, 31, 53',
  WARN: '#FFB819',
  SAFE_ASSIST: '#40B4E5',
  DARK_GRAY: '#555759',
  GRID: 'rgba(100, 150, 180, 0.4)',
  NEUTRAL: '#90a4ae',
  SAFE_BG: 'rgba(64, 180, 229, 0.25)',
  WARN_BG: 'rgba(255, 184, 25, 0.25)',
  HIGH_BG: '#A41F35',
};

module.exports = {
  RISK_THRESHOLDS,
  RISK_LEVEL_KEYS,
  RISK_LIMIT_RANGE,
  CNE_FORMULA,
  STORAGE_DEFAULTS,
  OFFSET_IMPORT_RANGE,
  LIMITS,
  CANVAS_CONFIG,
  APP_CONFIG,
  THEME_COLORS,
};
