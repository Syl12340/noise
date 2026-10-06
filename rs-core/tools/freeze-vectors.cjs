/**
 * tools/freeze-vectors.cjs
 *
 * Phase 0 确定性基线样本向量生成与冻结工具
 * 基线提交: 3a0d6765147c56d2a73e1cec78f6106ae2e681ab
 *
 * 核心设计原则:
 * 1. 严格使用只读基线 `_work/baseline/` 中的 `tests/runtime.cjs` 加载真实生产代码 (`pages/main/main.js` 等)。
 * 2. 磁盘基线永远只读；中间状态观测仅在内存中针对 `main.js` 注入 hook，磁盘文件永远不改动。
 * 3. 绝不独立重写生产流水线冒充端到端 golden outputs。
 * 4. 真实反映所有 chunk 处置状态（CommittedNormal, CommittedWithWarning, TerminalRejected, Ignored 等）。
 * 5. 秒窗口在 reset 前完整采集 intervalZ 能量、样本数与累计 A 前缀。
 * 6. 纯被动只读观测 updateSpectrumFromRingBuffer，真实记录已算 FFT，绝不主动计算冒充观测。
 * 7. 二进制谱明确使用 IEEE-754 Little-Endian (f64le) 写入。
 * 8. 完整记录包含 start/stopNormal/timeout/empty 等真实控制事件流，非有限值明确标记保留不与 null 混淆。
 * 9. 支持 --output <dir> 参数，且严格限制目标路径安全边界，已有 golden manifest 严禁覆写。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const RS_CORE_ROOT = path.resolve(__dirname, '..');
const BASELINE_ROOT = path.join(RS_CORE_ROOT, '_work/baseline');
const FIXTURES_ROOT = path.join(RS_CORE_ROOT, 'phase0/fixtures');
const TEMP_STAGE_ROOT = path.join(RS_CORE_ROOT, '_work/temp_stage');

const SAMPLE_RATE = 44100;
const FFT_SIZE = 32768;
const HOP_SIZE = 8192; // 严格依据 baseline utils/constants.js CANVAS_CONFIG.FFT.HOP_SIZE (8192)

// 确保基线运行时文件存在
const RUNTIME_PATH = path.join(BASELINE_ROOT, 'tests/runtime.cjs');
if (!fs.existsSync(RUNTIME_PATH)) {
  console.error(`[freeze-vectors] 错误: 基线运行时不存在于 ${RUNTIME_PATH}`);
  console.error('[freeze-vectors] 请先由协调者执行 prepare_baseline.py');
  process.exit(1);
}

const { runtime } = require(RUNTIME_PATH);

// ---------------------------------------------------------------------------
// 辅助函数与序列化安全保护
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 确定性 JSON 序列化器：保留 NaN 与 ±Infinity 的明确表示，避免被 JSON.stringify 默认为 null 造成语义混淆。
 */
function safeJsonStringify(obj, space = 2) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return '+Infinity';
      if (value === -Infinity) return '-Infinity';
    }
    return value;
  }, space) + '\n';
}

/**
 * 生成单频正弦波 (Float64Array)
 * amplitude = 0.1 对应峰值 -20 dBFS, RMS 约 -23.01 dBFS
 */
function tone(frequencyHz, sampleCount, amplitude = 0.1, phase = 0) {
  const signal = new Float64Array(sampleCount);
  const omega = 2 * Math.PI * frequencyHz / SAMPLE_RATE;
  for (let i = 0; i < sampleCount; i++) {
    signal[i] = amplitude * Math.sin(omega * i + phase);
  }
  return signal;
}

function toInt16(floatArray) {
  const pcm = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const clamped = Math.max(-1.0, Math.min(32767.0 / 32768.0, floatArray[i]));
    pcm[i] = Math.round(clamped * 32768.0);
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// 沙盒环境与只读 Hook 注入加载器
// ---------------------------------------------------------------------------

function createInstrumentedEnvironment(options = {}) {
  const receipts = [];
  const secondWindows = [];
  const secondEvents = [];
  const observedSpectra = [];
  let capturedHookCount = 0;

  // 仅在内存中针对 main.js 注入只读观测 hook，磁盘基线永远只读不改动
  const transform = (file, code) => {
    if (file === 'pages/main/main.js') {
      // 1. 观测每个硬件帧处理后的瞬态状态与收据
      const frameMarker = 'frameCount++;';
      assert.equal(
        code.split(frameMarker).length, 2,
        `[freeze-vectors] Hook 注入失败: frameMarker 出现次数异常 (${file})`
      );

      const frameHook = `
        if (typeof globalThis.__onFrameProcessed === 'function') {
          globalThis.__onFrameProcessed({
            frameCount,
            totalAWeightedSampleCount,
            totalAWeightedEnergySum,
            lastFrameLevels: lastFrameLevels ? { ...lastFrameLevels } : null,
            inputOverloaded,
            measurementInvalidReason,
            inputNearFullScale,
            inputPlateauSuspected,
            silentSampleCount,
            consecutiveSilentSampleCount,
            pcmBufferedSamples,
          });
        }
        ${frameMarker}
      `;

      // 2. 观测秒级边界结算前夕 (在 intervalZ 能量与计数器 reset 之前采集完整窗口)
      const secondStartMarkerAlt = 'function finalizeMeasurementSecond(page, dbfsZ, dbsplZ) {';
      assert.ok(
        code.includes(secondStartMarkerAlt),
        `[freeze-vectors] Hook 注入失败: secondStartMarker (${file})`
      );

      const secondHookPre = `
        function finalizeMeasurementSecond(page, dbfsZ, dbsplZ) {
          if (typeof globalThis.__onSecondFinalizing === 'function') {
            globalThis.__onSecondFinalizing({
              boundaryIndex: time + 1,
              intervalZWeightedEnergySum,
              intervalZWeightedSampleCount,
              intervalDbsplZ: calculateLeqFromEnergy(
                intervalZWeightedEnergySum,
                intervalZWeightedSampleCount,
                offset
              ),
              totalAWeightedSampleCount,
              totalAWeightedEnergySum,
              cumulativeLeqA: calculateLeqFromEnergy(
                totalAWeightedEnergySum,
                totalAWeightedSampleCount,
                offset
              ),
              dbfsZ,
              dbsplZ,
            });
          }
      `;

      // 3. 观测秒级边界结算完毕
      const secondEndMarker = 'finalizeMeasurementSecond(page, dbfsZ, dbsplZ);';
      assert.equal(
        code.split(secondEndMarker).length, 2,
        `[freeze-vectors] Hook 注入失败: secondEndMarker 出现次数异常 (${file})`
      );

      const secondHookPost = `
        ${secondEndMarker}
        if (typeof globalThis.__onSecondFinalized === 'function') {
          globalThis.__onSecondFinalized({
            time,
            cne,
            threat,
            totalAWeightedSampleCount,
            totalAWeightedEnergySum,
          });
        }
      `;

      // 4. 只读 Hook 真实 updateSpectrumFromRingBuffer 计算处，绝不主动计算冒充观测
      const spectrumMarker = 'spectrumBandLevels = computeThirdOctaveBands(spectrumDB);';
      assert.ok(
        code.includes(spectrumMarker),
        `[freeze-vectors] Hook 注入失败: spectrumMarker (${file})`
      );

      const spectrumHook = `
        ${spectrumMarker}
        if (typeof globalThis.__onBaselineSpectrumComputed === 'function') {
          globalThis.__onBaselineSpectrumComputed({
            spectrumDB: new Float64Array(spectrumDB),
            spectrumBandLevels: spectrumBandLevels ? Array.from(spectrumBandLevels) : null,
            sampleCount: totalAWeightedSampleCount,
            pcmBufferedSamples,
            currentViewMode,
            time,
            offset,
            origin: globalThis.__spectrumOrigin || 'unknown',
          });
        }
      `;

      // 5. 闭包内部只读状态查询辅助函数
      const helpersCode = `
        globalThis.__getMainState = () => ({
          inspector: {
            samples: inputQualityInspector.samples,
            clipped: inputQualityInspector.clipped,
            rails: inputQualityInspector.rails,
            maxRails: inputQualityInspector.maxRails,
            railRun: inputQualityInspector.railRun,
            maxRailRun: inputQualityInspector.maxRailRun,
            plateauSuspected: inputQualityInspector.plateauSuspected,
            clippedIntervals: inputQualityInspector.clippedIntervals ? inputQualityInspector.clippedIntervals.map(i => ({ ...i })) : [],
          },
          totalAWeightedSampleCount,
          totalAWeightedEnergySum,
          silentSampleCount,
          consecutiveSilentSampleCount,
          inputOverloaded,
          inputNearFullScale,
          inputPlateauSuspected,
          measurementInvalidReason,
          isMainMonitoringActive,
          frameCount,
          intervalSampleCounter,
          time,
          pcmBufferedSamples,
          currentViewMode,
          lastFrameLevels: lastFrameLevels ? { ...lastFrameLevels } : null,
        });

        globalThis.__getRiskStatusByCNE = (cneVal) => getRiskStatusByCNE(cneVal);
      `;

      capturedHookCount += 4;
      let modified = code.replace(frameMarker, frameHook)
                         .replace(secondStartMarkerAlt, secondHookPre)
                         .replace(secondEndMarker, secondHookPost)
                         .replace(spectrumMarker, spectrumHook);
      return modified + '\n' + helpersCode;
    }
    return code;
  };

  const env = runtime({}, transform, options);

  // 全局回调绑定在 env.context 上
  env.context.globalThis = env.context;
  env.context.__onFrameProcessed = (data) => {
    receipts.push({ ...data });
  };
  env.context.__onSecondFinalizing = (data) => {
    secondWindows.push({ ...data });
  };
  env.context.__onSecondFinalized = (data) => {
    secondEvents.push({ ...data });
  };
  env.context.__onBaselineSpectrumComputed = (data) => {
    observedSpectra.push(data);
  };

  // 补齐 Canvas / SelectorQuery / OffscreenCanvas 模拟实现，确保 UI 与视图切换正常执行
  const mockContext2d = {
    scale: () => {},
    translate: () => {},
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    fillText: () => {},
    drawImage: () => {},
    putImageData: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  const mockCanvasNode = {
    getContext: () => mockContext2d,
    width: 300,
    height: 150,
  };
  env.wx.createSelectorQuery = () => {
    const query = {
      select: () => query,
      selectAll: () => query,
      fields: () => query,
      boundingClientRect: () => query,
      exec: (cb) => {
        if (typeof cb === 'function') {
          cb([{ node: mockCanvasNode, width: 300, height: 150 }]);
        }
        return query;
      },
    };
    return query;
  };
  env.wx.getWindowInfo = () => ({ pixelRatio: 2, windowWidth: 375, windowHeight: 667 });
  env.wx.createOffscreenCanvas = ({ width, height }) => ({
    getContext: () => mockContext2d,
    width: width || 300,
    height: height || 150,
  });

  return {
    env,
    receipts,
    secondWindows,
    secondEvents,
    observedSpectra,
    getHookCount: () => capturedHookCount,
  };
}

// ---------------------------------------------------------------------------
// 导出 44.1 kHz AWeightingFilter 真实参数 (2节双二阶 + FIR129 + Gain)
// ---------------------------------------------------------------------------

function exportFilterCoefficients(audioMathModule) {
  const filter = new audioMathModule.AWeightingFilter(SAMPLE_RATE);
  const b1 = Array.from(filter.b1);
  const a1 = Array.from(filter.a1);
  const b2 = Array.from(filter.b2);
  const a2 = Array.from(filter.a2);
  const fir = Array.from(filter.fir);
  const gain = filter.gain;

  // 142 个 IEEE-754 Float64 Little-Endian (共 1136 字节)
  // 顺序: b1[3], a1[3], b2[3], a2[3], gain[1], fir[129]
  const binBuffer = Buffer.alloc(142 * 8);
  let byteOffset = 0;

  for (const v of b1) { binBuffer.writeDoubleLE(v, byteOffset); byteOffset += 8; }
  for (const v of a1) { binBuffer.writeDoubleLE(v, byteOffset); byteOffset += 8; }
  for (const v of b2) { binBuffer.writeDoubleLE(v, byteOffset); byteOffset += 8; }
  for (const v of a2) { binBuffer.writeDoubleLE(v, byteOffset); byteOffset += 8; }
  binBuffer.writeDoubleLE(gain, byteOffset); byteOffset += 8;
  for (const v of fir) { binBuffer.writeDoubleLE(v, byteOffset); byteOffset += 8; }

  const binSha = sha256(binBuffer);

  const jsonContent = {
    description: '基线 utils/audio-math.js:AWeightingFilter 44.1 kHz 真实系数精确导出 (仅当前 44.1 kHz，绝不拟合近似)',
    sampleRate: SAMPLE_RATE,
    baselineCommit: '3a0d6765147c56d2a73e1cec78f6106ae2e681ab',
    biquad1: { b: b1, a: a1 },
    biquad2: { b: b2, a: a2 },
    gain,
    firTaps: fir.length,
    fir,
    binarySha256: binSha,
    format: 'IEEE-754 binary64 Little-Endian (142 doubles = 1136 bytes: b1[3], a1[3], b2[3], a2[3], gain, fir[129])',
  };

  const jsonStr = safeJsonStringify(jsonContent, 2);
  const jsonSha = sha256(Buffer.from(jsonStr, 'utf8'));

  return {
    binBuffer,
    binSha,
    jsonContent,
    jsonStr,
    jsonSha,
  };
}

// ---------------------------------------------------------------------------
// 26 组标准 Fixture 定义
// ---------------------------------------------------------------------------

const FIXTURE_DEFINITIONS = [
  {
    id: 'fix01_silence_50ms_rejected',
    description: '连续 50ms (2205 样本) 数字静音，触发整块声学拒绝与终止，无尾滤波',
    generateSignal: () => new Float64Array(2205),
    chunkSize: 512,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix02_silence_short_accepted',
    description: '短时静音 (30ms, 1323 样本)，未达 50ms 门限，正常接受',
    generateSignal: () => new Float64Array(1323),
    chunkSize: 441,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix03_sine_1khz_clean_1s',
    description: '1000 Hz 纯正弦波 (峰值 -20 dBFS, RMS 约 -23.01 dBFS)，1.0s (44100 样本)，标准秒边界与尾滤波',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix04_sine_1khz_3s_multisecond',
    description: '1000 Hz 纯正弦波，3.0s (132300 样本)，跨越多个秒级结算边界',
    generateSignal: () => tone(1000, 132300, 0.1),
    chunkSize: 2048,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix05_non_integer_freq',
    description: '非整周期多频叠加 (999.3 Hz + 50.7 Hz)，1.5s，验证 Hann 窗泄漏',
    generateSignal: () => {
      const s1 = tone(999.3, 66150, 0.08);
      const s2 = tone(50.7, 66150, 0.05);
      return Float64Array.from(s1, (v, i) => v + s2[i]);
    },
    chunkSize: 1600,
    events: [{ type: 'switchView', mode: 'spectrum', atSample: 32768 }, { type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix06_multitone_third_octave',
    description: '1/3 倍频程中心频率多频组合 (250, 1000, 4000 Hz)，2.0s',
    generateSignal: () => {
      const s1 = tone(250, 88200, 0.05);
      const s2 = tone(1000, 88200, 0.05);
      const s3 = tone(4000, 88200, 0.05);
      return Float64Array.from(s1, (v, i) => v + s2[i] + s3[i]);
    },
    chunkSize: 2048,
    events: [{ type: 'switchView', mode: 'spectrum', atSample: 0 }, { type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix07_dc_constant_rejected',
    description: '持续直流常数偏置 (Step = 8192)，由于无交流信号在 50ms 时被静音门限拒收',
    generateSignal: () => new Float64Array(44100).fill(8192.0 / 32768.0),
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix08_near_full_scale_warning',
    description: '大振幅正弦波 (峰值 32150，超过 32112)，标记 nearFullScale 警告，Q+D 提交',
    generateSignal: () => tone(1000, 44100, 32150.0 / 32768.0),
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix09_plateau_warning',
    description: '含有平台平顶的信号 (连续 11 点恒定且顶峰折返)，标记 plateauSuspected 警告',
    generateSignal: () => {
      const s = tone(100, 44100, 0.5);
      // 在 100 Hz 正半周峰值区域 (周期 441 点，正半周峰值在 110 点附近) 插入 11 点平顶
      // 两侧点均小于该值，精确满足 (previous - runStart) * (previous - sample) > 0 的折返条件
      const plateauVal = s[110];
      for (let i = 106; i <= 116; i++) {
        s[i] = plateauVal;
      }
      return s;
    },
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix10_clipping_overload_rejected',
    description: '输入削波 (10ms 内含 3 个 rail 满幅样本)，触发整块拒绝，Q-only 终止，禁止 tail',
    generateSignal: () => {
      const s = tone(1000, 44100, 0.2);
      s[200] = 1.0; s[205] = 1.0; s[210] = 1.0;
      return s;
    },
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix11_ignored_after_termination',
    description: '前 2 块正常，第 3 块削波终止，后续第 4-6 块在队列中被忽略 (IgnoredAfterTermination)',
    generateSignal: () => {
      const s = tone(1000, 6144, 0.1);
      s[2100] = 1.0; s[2105] = 1.0; s[2110] = 1.0;
      return s;
    },
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix12_two_level_energy',
    description: '两级能量序列 (前 0.5s 小能量，后 0.5s 大能量)，测试块 RMS 与动态变化',
    generateSignal: () => {
      const s = new Float64Array(44100);
      s.set(tone(1000, 22050, 0.01), 0);
      s.set(tone(1000, 22050, 0.3), 22050);
      return s;
    },
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix13_multi_window_chunk_large',
    description: '单帧大块 (32768 样本)，覆盖多个 hop 步长 (8192) 与滑动窗口边界',
    generateSignal: () => tone(1000, 32768, 0.1),
    chunkSize: 16384,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix14_short_recording_half_second',
    description: '短时录音 (0.5s, 22050 样本)，未达到 1 秒秒边界结算即停止，正常执行尾积分',
    generateSignal: () => tone(1000, 22050, 0.1),
    chunkSize: 1024,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix15_view_switch_active_spectrum',
    description: '在录音达到 32768 样本后切换视图至 spectrum，验证基线真实 updateSpectrumFromRingBuffer 与 29 频带输出',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'switchView', mode: 'spectrum', atSample: 33792 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix16_view_switch_spectrogram',
    description: '录音中途切换至 spectrogram，验证列追加与视图查询行为',
    generateSignal: () => tone(500, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'switchView', mode: 'spectrogram', atSample: 33792 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix17_odd_length_corrupted_frame',
    description: '中间帧字节长度为奇数 (2047 字节)，触发音频数据格式无效，会话置为 invalid',
    generateSignal: () => tone(1000, 8192, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'corruptChunkByteLength', chunkIndex: 2, byteLength: 2047 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix18_empty_chunk_ignored',
    description: '流中注入长度为 0 的空块，验证基线静默返回、不推进计数的行为',
    generateSignal: () => tone(1000, 8192, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'injectEmptyChunk', chunkIndex: 3 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix19_stop_timeout_unverified',
    description: '停止时原生 Stop 未响应 (模拟 2250ms 超时)，归档为未核验 Invalid (canSave=false)',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [{ type: 'simulateStopTimeout' }],
  },
  {
    id: 'fix20_interruption_begin',
    description: '录音中途收到系统中断 (InterruptionBegin)，导致整段测量失效',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'emitSystemEvent', event: 'InterruptionBegin', atSample: 20480 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix21_capture_duration_partial',
    description: '实际采样数与原生时长偏差超过 46 样本，导致 dataQuality 降级为 partial (可保存已接收片段)',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'forgeNativeDuration', durationMs: 995 },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix22_repeat_stop_idempotent',
    description: '正常停止后重复调用 completeRequestedMainStop，验证幂等性与尾部滤波不重复累加',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'autoStopAtEnd' },
      { type: 'repeatStopCall' },
    ],
  },
  {
    id: 'fix23_no_calibration_estimate',
    description: '未完成校准的使用案例：无有效校准偏置，沿用未校准估算，不认证为参考测量 (riskEligible=false)',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    noCalibration: true,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix24_native_duration_unverified',
    description: '原生 Stop 回调未提供有效时长 (duration 缺失)，导致 captureIntegrity 降为 unverified',
    generateSignal: () => tone(1000, 44100, 0.1),
    chunkSize: 1024,
    events: [
      { type: 'unverifiedNativeDuration' },
      { type: 'autoStopAtEnd' },
    ],
  },
  {
    id: 'fix25_single_chunk_multisecond_spanning',
    description: '单 chunk 达到 2 秒 (88200 样本)，在单次回调内跨越两个秒级边界，验证连续秒事件触发',
    generateSignal: () => tone(1000, 88200, 0.1),
    chunkSize: 88200,
    events: [{ type: 'autoStopAtEnd' }],
  },
  {
    id: 'fix26_cne_alarm_modal_triggered',
    description: '高能量暴露达成报警条件 (CNE >= 85.0 预警阈值, allowAlarm=true, riskEligible=true)，触发弹窗模态框',
    generateSignal: () => tone(1000, 44100, 0.8), // 大振幅，高声级
    chunkSize: 1024,
    allowAlarm: true,
    alarmLevel: 85.0, // 确保 CNE (~89 dB) 真实超越阈值触发报警
    events: [{ type: 'autoStopAtEnd' }],
  },
];

// ---------------------------------------------------------------------------
// 核心运行与 Golden Output 捕获
// ---------------------------------------------------------------------------

function executeFixture(def) {
  const { env, receipts, secondWindows, secondEvents, observedSpectra, getHookCount } = createInstrumentedEnvironment();

  const recorderSession = env.load('utils/recorder-session');
  const dataModel = env.load('utils/data-model');

  // 配置校准状态：未校准用例在全新 runtime 环境下直接不设置 offset 即可 (不调用不存在的 clearOffset)
  if (!def.noCalibration) {
    dataModel.setOffset(100.0, {
      captureProfile: recorderSession.getMeasurementCaptureProfile(),
      deviceId: recorderSession.getCurrentDeviceCalibrationId(),
      source: 'advanced-1khz-calibration',
      evidence: {
        referenceInstrument: 'synthetic-test-only',
        inputChain: 'synthetic-test-chain',
        uncertaintyDb: 0.2,
        uncertaintyCoverageFactor: 2,
      },
      calibratedAt: 100000,
      validUntil: 2000000000000,
    });
  }

  // 报警开关与预警阈值设置
  if (def.allowAlarm) {
    dataModel.setAlarmEnabled(true);
    dataModel.setNoiseAlarmLevel(def.alarmLevel || 85.0);
  } else {
    dataModel.setAlarmEnabled(false);
    dataModel.setNoiseAlarmLevel(100.0);
  }

  // 加载页面并在此时断言 Hook 注入数量
  env.load('pages/main/main.js');
  assert.ok(getHookCount() >= 4, '全部 4 项只读 Hook 必须注入成功');

  const page = env.page;
  page.onShow();
  env.clock.tick(50); // 推进启动阶段

  const rawSignal = def.generateSignal();
  const rawPcm = toInt16(rawSignal);
  const totalSamples = rawPcm.length;
  const chunkSize = def.chunkSize || 1024;

  const events = (def.events || []).map(e => ({ ...e }));
  const handledEventIndices = new Set();
  const timelineEvents = [];

  const initialClock = env.context.Date.now();
  timelineEvents.push({
    event: 'start',
    clock: initialClock,
    sampleRate: SAMPLE_RATE,
    totalSamples,
    chunkSize,
  });

  const chunksMeta = [];
  let sampleCursor = 0;
  let chunkIdx = 0;

  while (sampleCursor < totalSamples) {
    const remaining = totalSamples - sampleCursor;
    const thisChunkSize = Math.min(chunkSize, remaining);
    const slice = rawPcm.subarray(sampleCursor, sampleCursor + thisChunkSize);

    // 检查并触发样本对齐事件
    for (let evtIdx = 0; evtIdx < events.length; evtIdx++) {
      const evt = events[evtIdx];
      if (evt.type === 'switchView' && sampleCursor >= evt.atSample && !handledEventIndices.has(evtIdx)) {
        handledEventIndices.add(evtIdx);
        timelineEvents.push({ event: 'switchView', mode: evt.mode, atSample: evt.atSample, sampleCursor });
        env.context.__spectrumOrigin = 'view-query';
        page.switchView({ currentTarget: { dataset: { mode: evt.mode } } });
      }
      if (evt.type === 'emitSystemEvent' && sampleCursor >= evt.atSample && !handledEventIndices.has(evtIdx)) {
        handledEventIndices.add(evtIdx);
        timelineEvents.push({ event: 'emitSystemEvent', name: evt.event, atSample: evt.atSample, sampleCursor });
        env.emit(evt.event, {});
      }
    }

    // 检查是否有异常帧注入
    let frameBuffer = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    for (let evtIdx = 0; evtIdx < events.length; evtIdx++) {
      const evt = events[evtIdx];
      if (evt.type === 'corruptChunkByteLength' && chunkIdx === evt.chunkIndex && !handledEventIndices.has(evtIdx)) {
        handledEventIndices.add(evtIdx);
        timelineEvents.push({ event: 'corruptChunkByteLength', chunkIndex: evt.chunkIndex, byteLength: evt.byteLength });
        frameBuffer = new ArrayBuffer(evt.byteLength);
      }
      if (evt.type === 'injectEmptyChunk' && chunkIdx === evt.chunkIndex && !handledEventIndices.has(evtIdx)) {
        handledEventIndices.add(evtIdx);
        timelineEvents.push({ event: 'injectEmptyChunk', chunkIndex: evt.chunkIndex });
        const emptyBefore = env.context.__getMainState();
        env.emit('FrameRecorded', { frameBuffer: new ArrayBuffer(0) });
        const emptyAfter = env.context.__getMainState();
        chunksMeta.push({
          index: chunkIdx,
          sampleStart: sampleCursor,
          sampleEnd: sampleCursor,
          length: 0,
          disposition: 'IgnoredEmptyChunk',
          stateBefore: {
            sampleCount: emptyBefore.totalAWeightedSampleCount,
            invalidReason: emptyBefore.measurementInvalidReason,
          },
          stateAfter: {
            sampleCount: emptyAfter.totalAWeightedSampleCount,
            invalidReason: emptyAfter.measurementInvalidReason,
          },
        });
      }
    }

    // 按累计 sample 边界精确计算时钟增量
    const targetClock = initialClock + Math.round((sampleCursor + thisChunkSize) / SAMPLE_RATE * 1000);
    const currentClock = env.context.Date.now();
    const tickDelta = targetClock - currentClock;
    if (tickDelta > 0) {
      env.clock.tick(tickDelta);
    }

    // 帧发射前后获取真实生产判定与质量状态
    const stateBefore = env.context.__getMainState();
    env.context.__spectrumOrigin = 'scheduled-frame';
    env.emit('FrameRecorded', { frameBuffer });
    const stateAfter = env.context.__getMainState();

    // 判定真实 Disposition
    let disposition = 'CommittedNormal';
    if (!stateBefore.isMainMonitoringActive || stateBefore.inputOverloaded || stateBefore.measurementInvalidReason) {
      disposition = 'IgnoredAfterTermination';
    } else if (frameBuffer.byteLength % 2 !== 0) {
      disposition = 'Rejected(InvalidFormat)';
    } else if (stateAfter.measurementInvalidReason && !stateBefore.measurementInvalidReason) {
      if (stateAfter.inputOverloaded) {
        disposition = 'TerminalRejected(Clipped)';
      } else if (stateAfter.measurementInvalidReason.includes('数字静音')) {
        disposition = 'TerminalRejected(DigitalSilence)';
      } else {
        disposition = `TerminalRejected(${stateAfter.measurementInvalidReason})`;
      }
    } else if (stateAfter.inputNearFullScale || stateAfter.inputPlateauSuspected) {
      disposition = 'CommittedWithWarning';
    } else if (stateAfter.totalAWeightedSampleCount === stateBefore.totalAWeightedSampleCount) {
      disposition = 'Ignored';
    }

    chunksMeta.push({
      index: chunkIdx,
      sampleStart: sampleCursor,
      sampleEnd: sampleCursor + thisChunkSize,
      length: thisChunkSize,
      disposition,
      inspector: {
        samples: stateAfter.inspector.samples,
        clipped: stateAfter.inspector.clipped,
        rails: stateAfter.inspector.rails,
        maxRails: stateAfter.inspector.maxRails,
        railRun: stateAfter.inspector.railRun,
        maxRailRun: stateAfter.inspector.maxRailRun,
        plateauSuspected: stateAfter.inspector.plateauSuspected,
        clippedIntervals: stateAfter.inspector.clippedIntervals ? stateAfter.inspector.clippedIntervals.map(i => ({ ...i })) : [],
      },
      sampleCount: stateAfter.totalAWeightedSampleCount,
      energySum: stateAfter.totalAWeightedEnergySum,
      invalidReason: stateAfter.measurementInvalidReason || null,
    });

    sampleCursor += thisChunkSize;
    chunkIdx++;
  }

  // 停止行为控制：必须在 stopNoiseMonitoring 之前正确设置 recorder.stop 回调参数
  const hasStopTimeout = events.some(e => e.type === 'simulateStopTimeout');
  const forgeDurationEvt = events.find(e => e.type === 'forgeNativeDuration');
  const unverifiedDurationEvt = events.find(e => e.type === 'unverifiedNativeDuration');

  if (hasStopTimeout) {
    // 模拟原生停止超时挂起：覆写为不发出 Stop 回调
    env.recorder.stop = () => {};
    timelineEvents.push({ event: 'stopTimeout', simulatedTimeoutMs: 2250, tickMs: 2300 });
    page.stopNoiseMonitoring();
    // 推进 2300 ms 触发基线 2250 ms 兜底定时器
    env.clock.tick(2300);
  } else if (forgeDurationEvt) {
    env.recorder.stop = function() {
      if (this.running) {
        this.running = false;
        env.emit('Stop', { duration: forgeDurationEvt.durationMs });
      }
    };
    timelineEvents.push({ event: 'stopWithForgedDuration', durationMs: forgeDurationEvt.durationMs });
    page.stopNoiseMonitoring();
    env.clock.tick(10);
  } else if (unverifiedDurationEvt) {
    env.recorder.stop = function() {
      if (this.running) {
        this.running = false;
        env.emit('Stop', {}); // duration 为 undefined
      }
    };
    timelineEvents.push({ event: 'stopWithUnverifiedDuration' });
    page.stopNoiseMonitoring();
    env.clock.tick(10);
  } else {
    // 正常停止：按实际输入样本精确控制 duration = Math.round(totalSamples / 44100 * 1000)
    // 避免 Mock 启动延迟 (50ms) 污染真实输入时长，保证正常用例在 CAPTURE_DURATION_TOLERANCE_SAMPLES 门限内核验为 valid
    const normalDurationMs = Math.round(totalSamples / SAMPLE_RATE * 1000);
    env.recorder.stop = function() {
      if (this.running) {
        this.running = false;
        env.emit('Stop', { duration: normalDurationMs });
      }
    };
    timelineEvents.push({ event: 'stopNormal', requestedDurationMs: normalDurationMs });
    page.stopNoiseMonitoring();
    env.clock.tick(10);
  }

  // 重复停止调用验证幂等性
  for (const evt of events) {
    if (evt.type === 'repeatStopCall') {
      const repeatDurationMs = Math.round(totalSamples / SAMPLE_RATE * 1000);
      timelineEvents.push({ event: 'repeatStopCall', durationMs: repeatDurationMs });
      page.completeRequestedMainStop({ duration: repeatDurationMs });
    }
  }

  // 读取真实 _completedSnapshot 与 finalState
  const finalState = env.context.__getMainState();
  const completedSnapshot = page._completedSnapshot || null;

  // 区分真实 dataQuality：正常由 snapshot 决定；若因声学拒绝终止则明确为 'invalid'，未完成则明确为 'uncompleted'
  let dataQuality;
  if (completedSnapshot) {
    dataQuality = completedSnapshot.dataQuality;
  } else if (finalState.measurementInvalidReason || finalState.inputOverloaded) {
    dataQuality = 'invalid';
  } else {
    dataQuality = 'uncompleted';
  }

  // 终态声学证据 (terminalEvidence)
  const terminalEvidence = {
    measurementInvalidReason: finalState.measurementInvalidReason || null,
    inputOverloaded: !!finalState.inputOverloaded,
    totalAWeightedSampleCount: finalState.totalAWeightedSampleCount,
    totalAWeightedEnergySum: finalState.totalAWeightedEnergySum,
    silentSampleCount: finalState.silentSampleCount,
    consecutiveSilentSampleCount: finalState.consecutiveSilentSampleCount,
    inputNearFullScale: !!finalState.inputNearFullScale,
    inputPlateauSuspected: !!finalState.inputPlateauSuspected,
    inspector: {
      samples: finalState.inspector.samples,
      clipped: finalState.inspector.clipped,
      rails: finalState.inspector.rails,
      maxRails: finalState.inspector.maxRails,
      railRun: finalState.inspector.railRun,
      maxRailRun: finalState.inspector.maxRailRun,
      plateauSuspected: finalState.inspector.plateauSuspected,
      clippedIntervals: finalState.inspector.clippedIntervals ? finalState.inspector.clippedIntervals.map(i => ({ ...i })) : [],
    },
    lastFrameLevels: finalState.lastFrameLevels,
  };

  // 观测是否实际在基线生命周期中计算了 FFT (仅观测，不主动计算)
  let spectrumSummary = null;
  let rawSpectraF64 = null;
  if (observedSpectra.length > 0) {
    const lastSpectrum = observedSpectra[observedSpectra.length - 1];
    const f64 = lastSpectrum.spectrumDB;
    // 明确以 IEEE-754 binary64 Little-Endian 写入 Buffer
    rawSpectraF64 = Buffer.alloc(observedSpectra.length * f64.length * 8);
    for (let n = 0; n < observedSpectra.length; n++) {
      for (let i = 0; i < f64.length; i++) rawSpectraF64.writeDoubleLE(observedSpectra[n].spectrumDB[i], (n * f64.length + i) * 8);
    }
    spectrumSummary = {
      status: 'available',
      observationCount: observedSpectra.length,
      observations: observedSpectra.map((s, n) => ({ sampleCount: s.sampleCount, origin: s.origin,
        viewMode: s.currentViewMode, bands29: s.spectrumBandLevels, byteOffset: n * f64.length * 8,
        byteLength: f64.length * 8 })),
      binCount: f64.length,
      fftSize: FFT_SIZE,
      sha256: sha256(rawSpectraF64),
      bands29: lastSpectrum.spectrumBandLevels,
      lastObservedAtSample: lastSpectrum.sampleCount,
      viewMode: lastSpectrum.currentViewMode,
    };
  } else {
    spectrumSummary = {
      status: 'unavailable',
      reason: finalState.currentViewMode !== 'spectrum' && finalState.currentViewMode !== 'spectrogram'
        ? 'view_mode_not_spectrum'
        : finalState.pcmBufferedSamples < FFT_SIZE ? 'insufficient_samples' : 'not_queried_or_uncalibrated',
      pcmBufferedSamples: finalState.pcmBufferedSamples,
      viewMode: finalState.currentViewMode,
    };
  }

  // 断言特定 Fixture 核心行为真实发生
  if (def.allowAlarm) {
    assert.ok(env.modals.length > 0, `[fixture ${def.id}] 报警条件达成必须真实触发模态框 (modals 不能为空)`);
  }
  if (def.id === 'fix09_plateau_warning') {
    assert.ok(finalState.inputPlateauSuspected, `[fixture ${def.id}] 平顶波形必须真实触发 plateauSuspected 警告`);
  }

  return {
    rawPcm,
    chunksMeta,
    eventsMeta: timelineEvents,
    receipts,
    secondWindows,
    secondEvents,
    completedSnapshot,
    terminalEvidence,
    finalState,
    spectrumSummary,
    rawSpectraF64,
    modalTriggered: env.modals.length > 0,
    modals: env.modals.map(m => ({ title: m.title, content: m.content })),
    dataQuality,
    measurementScope: completedSnapshot ? completedSnapshot.measurementScope : null,
    canSave: page.data.canSave,
  };
}

// ---------------------------------------------------------------------------
// Domain 决策边界语料库生成
// ---------------------------------------------------------------------------

function generateDecisionBoundaryCorpus() {
  const { env, getHookCount } = createInstrumentedEnvironment();
  const constants = env.load('utils/constants');

  env.load('pages/main/main.js');
  assert.ok(getHookCount() >= 4, 'Hook 必须注入成功');

  const getRiskStatusByCNE = env.context.__getRiskStatusByCNE;
  assert.equal(typeof getRiskStatusByCNE, 'function', 'getRiskStatusByCNE 必须通过内存导出可用');

  const testCneValues = [
    79.999, 80.000, 80.001,
    84.999, 85.000, 85.001,
    93.999, 94.000, 94.001,
    104.999, 105.000, 105.001,
    99.999, 100.000, 100.001, // 围绕 100 dB 报警阈值
  ];

  const results = [];
  for (const val of testCneValues) {
    const riskStatus = getRiskStatusByCNE(val);
    results.push({
      cneInput: val,
      classifiedKey: riskStatus.key,
      classifiedText: riskStatus.text,
      classifiedBgClass: riskStatus.bgClass,
    });
  }

  return {
    description: '基线 pages/main/main.js:getRiskStatusByCNE 真实函数在各分贝门限边界的输出金标准',
    classifierSource: 'pages/main/main.js:getRiskStatusByCNE',
    riskConfigPublicExports: [
      'RISK_META',
      'getDefaultRiskConfig',
      'normalizeRiskConfig',
      'validateRiskConfig',
      'buildRiskLevels',
      'getEnabledRiskLevels',
    ],
    noteOnClassifier: 'utils/risk-config.js 未导出独立分类器；实际分类逻辑位于 pages/main/main.js 闭包',
    alarmEvaluationNote: '报警属于监测会话端到端行为(cne>=noiseAlarmLevel && allowAlarm && riskEligible)，通过真实 fixture (fix26_cne_alarm_modal_triggered) 验证，不在此独立评估',
    thresholds: constants.RISK_THRESHOLDS,
    corpus: results,
  };
}

// ---------------------------------------------------------------------------
// 主执行入口
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const isVerify = args.includes('--verify');
  if (isVerify) throw new Error('Use python tools/run-phase0.py verify for complete read-only payload verification.');
  const isDryRun = args.includes('--dry-run');

  let targetDir = FIXTURES_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      if (i + 1 < args.length) {
        targetDir = path.resolve(args[++i]);
      }
    }
  }

  // 严格路径白名单安全校验：仅允许在 rs-core/_work/temp_stage 内部或 phase0/fixtures 目录中操作
  const allowedTempStage = path.resolve(TEMP_STAGE_ROOT);
  const allowedFixturesRoot = path.resolve(FIXTURES_ROOT);
  const isInsideTempStage = targetDir.startsWith(allowedTempStage + path.sep);
  const isFixturesRoot = targetDir === allowedFixturesRoot;

  if (!isInsideTempStage && !isFixturesRoot) {
    console.error(`[freeze-vectors] 路径安全错误: 目标目录 "${targetDir}" 不在白名单允许范围内！`);
    console.error('[freeze-vectors] 仅允许 rs-core/_work/temp_stage/... 或 rs-core/phase0/fixtures');
    process.exit(1);
  }

  // 金标准防篡改守卫：若目标目录为 FIXTURES_ROOT 且已存在 manifest.json，严禁覆写！
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (isFixturesRoot && fs.existsSync(manifestPath) && !isVerify) {
    console.error('[freeze-vectors] 致命安全错误: phase0/fixtures 中已存在 manifest.json 金标准，严禁覆写！');
    console.error('[freeze-vectors] 更新金标准必须先生成至 _work/temp_stage 候选目录并经过独立审核。');
    process.exit(1);
  }

  console.log(`[freeze-vectors] 模式: ${isVerify ? '校验现有 Fixture' : '生成并冻结 Fixture'}`);
  console.log(`[freeze-vectors] 目标目录: ${targetDir}`);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  if (fs.realpathSync(targetDir).toLowerCase() !== targetDir.toLowerCase()) throw new Error('Output path contains a redirected directory; rejected.');
  if (!isDryRun && fs.readdirSync(targetDir).some(name => name !== 'README.md')) throw new Error('Output contains existing payload; refusing overwrite.');

  // 提取基线 44.1 kHz AWeightingFilter 真实参数与二进制/JSON 产物
  const { env: tmpEnv } = createInstrumentedEnvironment();
  const audioMathModule = tmpEnv.load('utils/audio-math');
  const filterCoeffs = exportFilterCoefficients(audioMathModule);

  const manifest = {
    baselineCommit: '3a0d6765147c56d2a73e1cec78f6106ae2e681ab',
    fixtureCount: FIXTURE_DEFINITIONS.length,
    filterCoefficients: {
      sampleRate: SAMPLE_RATE,
      binaryFile: 'filter_coefficients.bin',
      binarySha256: filterCoeffs.binSha,
      jsonFile: 'filter_coefficients.json',
      jsonSha256: filterCoeffs.jsonSha,
      firTaps: filterCoeffs.jsonContent.firTaps,
    },
    fixtures: {},
  };

  let allPass = true;

  for (const def of FIXTURE_DEFINITIONS) {
    const fixtureDir = path.join(targetDir, def.id);
    const result = executeFixture(def);

    const pcmBuffer = Buffer.alloc(result.rawPcm.length * 2);
    for (let i = 0; i < result.rawPcm.length; i++) pcmBuffer.writeInt16LE(result.rawPcm[i], i * 2);
    const pcmSha = sha256(pcmBuffer);

    const expectedData = {
      id: def.id,
      description: def.description,
      dataQuality: result.dataQuality,
      measurementScope: result.measurementScope,
      canSave: result.canSave,
      modalTriggered: result.modalTriggered,
      modals: result.modals,
      sampleCount: result.completedSnapshot ? result.completedSnapshot.sampleCount : result.finalState.totalAWeightedSampleCount,
      aWeightedEnergy: result.completedSnapshot ? result.completedSnapshot.aWeightedEnergy : result.finalState.totalAWeightedEnergySum,
      leqA: result.completedSnapshot ? result.completedSnapshot.leqA : null,
      cne: result.completedSnapshot ? result.completedSnapshot.cne : null,
      cneUnrounded: result.completedSnapshot ? result.completedSnapshot.cneUnrounded : null,
      filterTail: result.completedSnapshot ? result.completedSnapshot.parameters.filterTail : null,
      coverage: result.completedSnapshot ? result.completedSnapshot.coverage : null,
      qualityReason: result.completedSnapshot ? result.completedSnapshot.qualityReason : (result.finalState.measurementInvalidReason || null),
      terminalEvidence: result.terminalEvidence,
      receiptCount: result.receipts.length,
      secondWindowCount: result.secondWindows.length,
      secondEventCount: result.secondEvents.length,
      secondWindows: result.secondWindows,
      secondEvents: result.secondEvents,
      receipts: result.receipts,
      finalReceipt: result.receipts[result.receipts.length - 1] || null,
      spectrum: result.spectrumSummary,
      finalSnapshotSummary: result.completedSnapshot ? {
        threat: result.completedSnapshot.threat,
        threatClass: result.completedSnapshot.threatClass,
        silentSampleCount: result.completedSnapshot.silentSampleCount,
        plateauSuspected: result.completedSnapshot.plateauSuspected,
        nearFullScaleObserved: result.completedSnapshot.nearFullScaleObserved,
      } : null,
    };

    const expectedJsonStr = safeJsonStringify(expectedData, 2);
    const chunksJsonStr = safeJsonStringify(result.chunksMeta, 2);
    const eventsJsonStr = safeJsonStringify(result.eventsMeta, 2);
    const metadataData = {
      id: def.id,
      description: def.description,
      sampleRate: SAMPLE_RATE,
      totalSamples: result.rawPcm.length,
      durationSeconds: result.rawPcm.length / SAMPLE_RATE,
      pcmSha256: pcmSha,
      baselineCommit: '3a0d6765147c56d2a73e1cec78f6106ae2e681ab',
      calibration: {
        noCalibration: !!def.noCalibration,
        offset: def.noCalibration ? null : 100.0,
        source: def.noCalibration ? null : 'advanced-1khz-calibration',
        evidenceComplete: !def.noCalibration,
        riskEligible: !def.noCalibration,
        referenceInstrument: def.noCalibration ? null : 'synthetic-test-only',
      },
      alarm: {
        allowAlarm: !!def.allowAlarm,
        noiseAlarmLevel: def.allowAlarm ? (def.alarmLevel || 85.0) : 100.0,
      },
      viewMode: def.events && def.events.find(e => e.type === 'switchView')
        ? def.events.find(e => e.type === 'switchView').mode
        : 'waveform',
      clockModel: 'deterministic-virtual-clock-50ms-startup',
    };
    const metadataJsonStr = safeJsonStringify(metadataData, 2);

    manifest.fixtures[def.id] = {
      pcmSha256: pcmSha,
      expectedSha256: sha256(Buffer.from(expectedJsonStr, 'utf8')),
      dataQuality: result.dataQuality,
      canSave: result.canSave,
      hasSpectra: !!result.rawSpectraF64,
    };

    if (isVerify) {
      if (!fs.existsSync(fixtureDir)) {
        console.error(`[verify] 缺失目录: ${def.id}`);
        allPass = false;
        continue;
      }
      const existingExpected = fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8');
      const existingPcm = fs.readFileSync(path.join(fixtureDir, 'pcm.i16le'));
      if (sha256(existingPcm) !== pcmSha) {
        console.error(`[verify] PCM 散列不匹配: ${def.id}`);
        allPass = false;
      }
      if (existingExpected.trim() !== expectedJsonStr.trim()) {
        console.error(`[verify] Expected JSON 不匹配: ${def.id}`);
        allPass = false;
      }
      if (result.rawSpectraF64) {
        const spectraPath = path.join(fixtureDir, 'spectra.f64le');
        if (!fs.existsSync(spectraPath) || sha256(fs.readFileSync(spectraPath)) !== sha256(result.rawSpectraF64)) {
          console.error(`[verify] Spectra 散列不匹配: ${def.id}`);
          allPass = false;
        }
      }
    } else if (!isDryRun) {
      if (!fs.existsSync(fixtureDir)) {
        fs.mkdirSync(fixtureDir, { recursive: true });
      }
      fs.writeFileSync(path.join(fixtureDir, 'pcm.i16le'), pcmBuffer);
      fs.writeFileSync(path.join(fixtureDir, 'chunks.json'), chunksJsonStr, 'utf8');
      fs.writeFileSync(path.join(fixtureDir, 'events.json'), eventsJsonStr, 'utf8');
      fs.writeFileSync(path.join(fixtureDir, 'metadata.json'), metadataJsonStr, 'utf8');
      fs.writeFileSync(path.join(fixtureDir, 'expected.json'), expectedJsonStr, 'utf8');
      if (result.rawSpectraF64) {
        fs.writeFileSync(path.join(fixtureDir, 'spectra.f64le'), result.rawSpectraF64);
      }
    }

    console.log(`  [OK] ${def.id} -> quality=${result.dataQuality}, canSave=${result.canSave}, samples=${result.completedSnapshot ? result.completedSnapshot.sampleCount : result.finalState.totalAWeightedSampleCount}`);
  }

  // 生成 domain decision corpus
  const decisionCorpus = generateDecisionBoundaryCorpus();
  const decisionCorpusStr = safeJsonStringify(decisionCorpus, 2);

  if (isVerify) {
    const boundaryPath = path.join(targetDir, 'decision_boundaries.json');
    if (!fs.existsSync(boundaryPath) || sha256(fs.readFileSync(boundaryPath)) !== sha256(Buffer.from(decisionCorpusStr, 'utf8'))) {
      console.error('[verify] decision_boundaries.json 散列不匹配');
      allPass = false;
    }
    const binPath = path.join(targetDir, 'filter_coefficients.bin');
    if (!fs.existsSync(binPath) || sha256(fs.readFileSync(binPath)) !== filterCoeffs.binSha) {
      console.error('[verify] filter_coefficients.bin 散列不匹配');
      allPass = false;
    }
    const jsonPath = path.join(targetDir, 'filter_coefficients.json');
    if (!fs.existsSync(jsonPath) || sha256(fs.readFileSync(jsonPath)) !== filterCoeffs.jsonSha) {
      console.error('[verify] filter_coefficients.json 散列不匹配');
      allPass = false;
    }
  } else if (!isDryRun) {
    fs.writeFileSync(path.join(targetDir, 'filter_coefficients.bin'), filterCoeffs.binBuffer);
    fs.writeFileSync(path.join(targetDir, 'filter_coefficients.json'), filterCoeffs.jsonStr, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'decision_boundaries.json'), decisionCorpusStr, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'manifest.json'), safeJsonStringify(manifest, 2), 'utf8');
  }

  console.log(`[freeze-vectors] 处理完成: ${FIXTURE_DEFINITIONS.length} 组 fixtures, 1 组 decision boundaries, 1 组 filter coefficients.`);
  if (isVerify && !allPass) {
    console.error('[freeze-vectors] 验证失败！存在不一致项。');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  executeFixture,
  generateDecisionBoundaryCorpus,
  exportFilterCoefficients,
  createInstrumentedEnvironment,
  FIXTURE_DEFINITIONS,
};
