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
  BASE_OFFSET: 44.6,
};

const STORAGE_DEFAULTS = {
  offset: 77,
  expectedExposure: 2,
  noiseAlarmLevel: 85,
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
    GLOBAL_SIZE: 300,
    SCALE_X: 30,
    SCALE_Y: 2,
  },
  CALIBRATE: {
    GLOBAL_SIZE: 300,
    SCALE_X: 30,
    SCALE_Y: 3,
  },
};

const APP_CONFIG = {
  SERVER_BY_ENV: {
    default: 'https://project.stu.ecnu.edu.cn/noise',
    dev: 'http://47.117.40.74:9999',
    prod: 'https://project.stu.ecnu.edu.cn/noise',
  },
};

const THEME_COLORS = {
  PRIMARY: '#A41F35',
  WARN: '#FFB819',
  SAFE_ASSIST: '#40B4E5',
  DARK_GRAY: '#555759',
  GRID: 'rgba(100, 150, 180, 0.3)',
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
