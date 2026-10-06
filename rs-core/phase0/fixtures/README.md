# Phase 0 基线样本向量集说明与规范 (Fixtures Specification)

**版本标识**：Phase 0 基线样本向量与金标准规范 (第二轮运行时修正版)  
**基线 Git 提交**：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`  
**维护工具**：`rs-core/tools/freeze-vectors.cjs` 与 `rs-core/tools/run-phase0.py`  
**执行状态（2026-10-05）**：父代理审查及预检后，AGY在新建受限执行会话中完成manifest、freeze、verify、regression。26组/138个数据文件双次生成与重算无差异，回归符合锁定基线，科学门槛失败保留。完整范围与独立审计见 ../PHASE0_REVIEW_REPORT.md；不是Rust或真机验证。

---

## 1. Fixture 目录架构与文件规范

每个独立的信号样本保存于 `rs-core/phase0/fixtures/<fixture_id>/` 子目录，包含以下标准文件：

```text
phase0/fixtures/
├── <fixture_id>/
│   ├── pcm.i16le              # 原始音频脉冲编码调制流 (44.1 kHz, Mono, 16-bit Signed Little-Endian)
│   ├── chunks.json            # 模拟硬件回调帧切片边界与真实处置状态 (CommittedNormal / TerminalRejected 等)
│   ├── events.json            # 完整重播控制事件序列 (start, chunk, switchView, emitSystemEvent, stopNormal, stopTimeout 等)
│   ├── metadata.json          # 确定性样本元数据 (采样率、时长、PCM SHA-256、基线提交、固定校准、预警阈值、时钟模型)
│   ├── expected.json          # 基线 Golden Outputs (状态、有效样本/能量、终态声学证据 terminalEvidence、收据列表、秒窗口、FFT汇总)
│   └── spectra.f64le          # 可选：逐次真实 FFT 的16384-bin谱按观测顺序拼接，IEEE-754 binary64 LE
├── decision_boundaries.json   # CNE 风险等级决策边界金标准语料库 (基于 pages/main/main.js:getRiskStatusByCNE 真实导出)
├── filter_coefficients.bin    # 44.1 kHz AWeightingFilter 真实参数二进制 (IEEE-754 binary64 LE, 142 个 double, 1136 字节)
├── filter_coefficients.json   # 44.1 kHz AWeightingFilter 真实参数清单 (双二阶参数、FIR 129 抽头、增益、SHA-256)
├── manifest.json              # PCM/expected及系数身份；全量138文件哈希另见reports/fixture-independent-audit.json
└── README.md                  # 本说明规范文档 (非生成 payload，在 freeze/verify 比对中被严格排除)
```

---

## 2. 文件级字段规范与运行时语义

### 2.1 `chunks.json`
定义音频流在送入 `handleRecordedFrame` 时的物理回调分块及其真实处置结果（Dispositions）：
```json
[
  {
    "index": 0,
    "sampleStart": 0,
    "sampleEnd": 1024,
    "length": 1024,
    "disposition": "CommittedNormal",
    "inspector": {
      "samples": 1024,
      "clipped": false,
      "rails": 0,
      "maxRails": 0,
      "railRun": 0,
      "maxRailRun": 0,
      "plateauSuspected": false,
      "clippedIntervals": []
    },
    "sampleCount": 1024,
    "energySum": 5.12,
    "invalidReason": null
  }
]
```

真实处置状态枚举（依据基线 `handleRecordedFrame` 与 `inspectPcm` 实际判定）：
- `CommittedNormal`: 正常接收，通过质量检查，A 计权累加；
- `CommittedWithWarning`: 存在非致命异常（`nearFullScale` 或 `plateauSuspected`），正常累加并记录证据；
- `TerminalRejected(Clipped)`: 满幅削波超限，整块声学拒绝，终止会话，禁止尾滤波；
- `TerminalRejected(DigitalSilence)`: 连续 50ms (2205 样本) 静音超限，整块拒绝并终止；
- `Rejected(InvalidFormat)`: 奇数字节或畸变格式，整块拒绝并标记 invalid；
- `IgnoredAfterTermination`: 会话终止后排队到来的迟到块，被适配层直接忽略；
- `IgnoredEmptyChunk`: 0 长度空块，静默返回，不推进计数与状态。

### 2.2 `events.json`
记录完整的可重播控制事件序列（包含开始参数、样本对齐事件、原生停止控制方式与重复停止验证）：
```json
[
  { "event": "start", "clock": 100050, "sampleRate": 44100, "totalSamples": 44100, "chunkSize": 1024 },
  { "event": "switchView", "mode": "spectrum", "atSample": 33792, "sampleCursor": 33792 },
  { "event": "stopNormal", "requestedDurationMs": 1000 }
]
```

### 2.3 `metadata.json`
记录确定性样本配置与上下文，严格声明非临床认证的测试用途：
```json
{
  "id": "fix03_sine_1khz_clean_1s",
  "description": "1000 Hz 纯正弦波 (峰值 -20 dBFS, RMS 约 -23.01 dBFS)，1.0s (44100 样本)",
  "sampleRate": 44100,
  "totalSamples": 44100,
  "durationSeconds": 1.0,
  "pcmSha256": "3a7b...",
  "baselineCommit": "3a0d6765147c56d2a73e1cec78f6106ae2e681ab",
  "calibration": {
    "noCalibration": false,
    "offset": 100.0,
    "source": "advanced-1khz-calibration",
    "evidenceComplete": true,
    "riskEligible": true,
    "referenceInstrument": "synthetic-test-only"
  },
  "alarm": {
    "allowAlarm": false,
    "noiseAlarmLevel": 100.0
  },
  "viewMode": "waveform",
  "clockModel": "deterministic-virtual-clock-50ms-startup"
}
```

### 2.4 `expected.json`
基线权威状态金标准：
- `dataQuality`: 最终质量等级（`valid` / `partial` / `unverified` / `invalid` / `uncompleted`）；
  - 正常完整录音在按样本精确控制 Stop duration 后评定为 `valid`；
  - 声学拒绝或严重异常终止评定为 `invalid`；
- `sampleCount`: 参与 A 滤波积分的有效样本总数（对于声学终止用例，记录终止前已积分的真实计数值，绝不硬编码为 0）；
- `aWeightedEnergy`: 累计 A 能量（对于声学终止用例，记录终止前真实积分能量）；
- `terminalEvidence`: 终态声学证据（包含 `measurementInvalidReason`, `inputOverloaded`, `totalAWeightedSampleCount`, `totalAWeightedEnergySum`, `silentSampleCount`, `consecutiveSilentSampleCount`, `inspector` 完整结构及真实 `clippedIntervals` 坐标）；
- `secondWindows`: 在 `finalizeMeasurementSecond` 清零重置前采集的**完整秒区间统计序列**；
- `secondEvents`: 秒事件完成回调列表（`time`, `cne`, `threat`, `totalAWeightedSampleCount` 等）；
- `receipts`: 每帧硬件回调后的瞬态收据完整列表；
- `spectrum`: FFT 谱状态；
  - 仅在基线真实执行 `updateSpectrumFromRingBuffer` 时标记为 `available` 并写入 `spectra.f64le`；
  - 波形视图模式未请求计算 FFT 时如实标记为 `unavailable` (`reason: 'view_mode_not_spectrum'`)；
- `finalSnapshotSummary`: 归档快照概要（声学终止未完成测量时为 `null`，绝不调用 `page.archive()` 伪造快照）。

---

## 3. 26 组全量声学 Fixture 清单矩阵

由修正后的 `tools/freeze-vectors.cjs` 规范生成的 26 组标准用例矩阵：

| 标识 (ID) | 信号特征与长度 | 核心验证目的与状态转移期望 | 预期数据质量 (`dataQuality`) | 频谱状态 (`spectrum`) |
| :--- | :--- | :--- | :--- | :--- |
| `fix01_silence_50ms_rejected` | 连续全零，2205 样本 (50ms) | 连续静音达 50ms 门限，整块声学拒绝，Q-only 终止，记录 terminalEvidence，无 tail | `invalid` | `unavailable` |
| `fix02_silence_short_accepted` | 短时静音，1323 样本 (30ms) | 静音未达 50ms 门限，正常接受，但因全零无有效能量，最终标记 invalid | `invalid` | `unavailable` |
| `fix03_sine_1khz_clean_1s` | 1000 Hz 正弦波，44100 样本 (1.0s) | 标准 1 秒整数秒边界结算，时钟严格核验，正常尾滤波 | `valid` | `unavailable` (波形视图) |
| `fix04_sine_1khz_3s_multisecond` | 1000 Hz 正弦波，132300 样本 (3.0s) | 跨越 3 个秒级结算边界 (`time=1, 2, 3`)，区间 Z 声级与累计 A 能量对照 | `valid` | `unavailable` |
| `fix05_non_integer_freq` | 999.3 Hz + 50.7 Hz，66150 样本 (1.5s) | 缓冲满后切入频谱，冻结非整周期泄漏的实际谱与积分 | `valid` | `available` |
| `fix06_multitone_third_octave` | 250, 1000, 4000 Hz 叠加，88200 样本 (2.0s)| 从首块起请求频谱，冻结首次满窗及8192-hop的29带功率分布 | `valid` | `available` |
| `fix07_dc_constant_rejected` | 持续常数直流 (Step=8192)，44100 样本 | 低于2205样本门限的前序小块可进入DC；达到门限的当前整块拒绝，终止且无tail | `invalid` | `unavailable` |
| `fix08_near_full_scale_warning` | 峰值 32150 样本，44100 样本 (1.0s) | 超过 32112 门限，标记 `nearFullScaleObserved=true` 警告，Q+D 提交 | `valid` | `unavailable` |
| `fix09_plateau_warning` | 正半周峰值 11 点平顶波形，44100 样本 | 满足峰值折返条件，触发 `plateauSuspected=true` 警告，Q+D 提交 | `valid` | `unavailable` |
| `fix10_clipping_overload_rejected`| 10ms 滑动窗口内含 3 个 rail，44100 样本 | 满幅超限触发削波拒绝，生成 `TerminalRejected(Clipped)`，终止会话，禁止 tail | `invalid` | `unavailable` |
| `fix11_ignored_after_termination` | 第 3 块削波终止，后续 3 块排队 | 终止后已在队列中的块由适配器结算为 `IgnoredAfterTermination`，不送入核心 | `invalid` | `unavailable` |
| `fix12_two_level_energy` | 前 0.5s 极弱，后 0.5s 大能量，44100 样本 | 瞬态块 RMS 跳跃与累计 Leq 平滑响应比对 | `valid` | `unavailable` |
| `fix13_multi_window_chunk_large` | 32768 样本大块 (chunk 16384) | 跨越多个 hop 步长 (8192) 与滑动窗口边界 | `valid` | `unavailable` |
| `fix14_short_recording_half_second`| 0.5s (22050 样本) 极短录音 | 未达首个秒边界 (`time=0`) 即停止，验证无秒事件时的尾滤波处理 | `valid` | `unavailable` |
| `fix15_view_switch_active_spectrum`| 满 32768 点后切换视图至 spectrum | 主动查询频谱，基线真实执行 `updateSpectrumFromRingBuffer` 并生成 `spectra.f64le` | `valid` | `available` (16384 bins) |
| `fix16_view_switch_spectrogram` | 满 32768 点后切换视图至 spectrogram | 频谱图模式下列追加，真实执行 `updateSpectrumFromRingBuffer` 并生成 `spectra.f64le` | `valid` | `available` (16384 bins) |
| `fix17_odd_length_corrupted_frame` | 第 2 帧为 2047 字节奇数长度 | 触发数据格式无效异常，立即安全停止，结果置为 invalid | `invalid` | `unavailable` |
| `fix18_empty_chunk_ignored` | 中途注入 0 长度空块 | 验证基线静默返回、不推进计数的幂等行为 | `valid` | `unavailable` |
| `fix19_stop_timeout_unverified` | 录音停止超时 (2250ms 无原生 Stop 回调) | 触发兜底超时，置失效原因并跳过尾滤波，归档为 Invalid (canSave=false) | `invalid` | `unavailable` |
| `fix20_interruption_begin` | 中途触发 `InterruptionBegin` | 模拟系统来电中断，标记测量被系统中断，停止录音并置为 invalid | `invalid` | `unavailable` |
| `fix21_capture_duration_partial` | 原生时长偏差产生 220 样本差额 | 采样数与原生时长偏差超 46 样本，dataQuality 降级为 `partial` (可保存片段) | `partial` | `unavailable` |
| `fix22_repeat_stop_idempotent` | 正常停止后重复分发 Stop 回调 | 验证核心只读快照与尾滤波不重复累加的幂等性 | `valid` | `unavailable` |
| `fix23_no_calibration_estimate` | 未校准状态使用案例 (环境初始无校准) | 沿用未校准估算，不认证为参考测量 (`riskEligible=false`, `canSave=true`) | `valid` | `unavailable` |
| `fix24_native_duration_unverified`| 原生 Stop 回调无 duration 字段 | captureIntegrity 降为 `unverified`，可保存估算记录但范围为 received-audio | `unverified` | `unavailable` |
| `fix25_single_chunk_multisecond_spanning` | 单 chunk 达到 88200 样本 (2.0s) | 单次回调内连续跨越两个秒级边界，验证内部循环结算与 time 连续递增 | `valid` | `unavailable` |
| `fix26_cne_alarm_modal_triggered` | 高能量暴露 (CNE >= 85.0 阈值, allowAlarm=true) | 真实触发基线报警模态弹窗 `wx.showModal` 与长震动 (`modalTriggered=true`) | `valid` | `unavailable` |

---

## 4. 44.1 kHz A 计权滤波器真实参数冻结 (`filter_coefficients.*`)

从基线真实 `utils/audio-math.js:AWeightingFilter` 对象直接导出精确参数（仅限当前 44.1 kHz，绝不拟合近似）：

1. **`filter_coefficients.bin`**:
   - 格式：IEEE-754 binary64 Little-Endian 二进制流；
   - 长度：142 个 double 浮点数，总计 1136 字节；
   - 顺序：
     1. Biquad 1 分子系数 `b1[3]`
     2. Biquad 1 分母系数 `a1[3]`
     3. Biquad 2 分子系数 `b2[3]`
     4. Biquad 2 分母系数 `a2[3]`
     5. 滤波器增益 `gain` (1 个 double)
     6. FIR 高频校正抽头 `fir[129]` (129 个 double)

2. **`filter_coefficients.json`**:
   - 结构化 JSON 清单，记录两节双二阶参数、FIR 129 抽头数值、增益与二进制产物的 SHA-256 校验和。

---

## 5. 应用层决策边界语料库 (`decision_boundaries.json`)

针对应用层风险判定与报警逻辑，在关键分贝门限边界注入微小偏置进行断言：
- **基准锚点**：`SAFE_MAX = 80.0`, `ATTENTION_MAX = 85.0`, `MEDIUM_MAX = 94.0`, `HIGH_MAX = 105.0`, `noiseAlarmLevel = 100.0`；
- **判定边界对齐**：
  - `79.999 dB` -> `SAFE`
  - `80.000 dB` -> `SAFE`
  - `80.001 dB` -> `ATTENTION`
  - `84.999 dB` -> `ATTENTION`
  - `85.000 dB` -> `MEDIUM`
  - `93.999 dB` -> `MEDIUM`
  - `94.000 dB` -> `HIGH`
  - `99.999 dB` -> `HIGH`
  - `100.000 dB` -> `HIGH`
  - `100.001 dB` -> `HIGH`
  - `104.999 dB` -> `HIGH`
  - `105.000 dB` -> `EXTREME`

---

## 6. 自动化编排工具协议与执行说明

工具 `run-phase0.py` 严格遵循父代理纠错规范：

1. **`manifest` 子命令**：
   - 核验 `_work/baseline/` 目录下全部 174 个文件（含补齐的 `images/` 和 `docs/`）散列与 `BASELINE_SOURCE_MANIFEST.json` 完全一致；
   - 具备路径穿越防御，禁止任何非法路径。

2. **`freeze` 子命令**：
   - 严禁直接写入最终目录；
   - 先在 `rs-core/_work/temp_stage` 下建立两个独立的候选目录（`freeze_cand1_*` 与 `freeze_cand2_*`），分别运行生成工具；
   - 全量比对两个候选目录中的所有 payload 文件散列（PCM、chunks、events、metadata、expected、spectra、decision_boundaries、filter_coefficients、manifest），严格排除 `README.md`；
   - 若已有 `manifest.json` 金标准产物，**严格拒绝覆写**（不提供 `--force` 绕过，更新必须通过独立版本审查）；
   - 复制 payload 产物至 `phase0/fixtures` 并输出 `reports/freeze-summary.json`；
   - 通过受控 `safe_clean_stage` 安全清理候选目录。

3. **`verify` 子命令**：
   - 在临时候选目录全量重算；
   - 比对候选产物与 `phase0/fixtures/` 中 Golden 产物的所有 payload 文件散列（严格排除 `README.md`）；
   - **绝对不修改、不新建 Golden Fixture**，仅生成比对报告 `reports/verify-report.json`。

4. **`regression` 子命令**：
   - 在隔离工作区复制完整源码（包含 `images/` 与 `docs/`）；
   - 严格断言回归标准：
     - 5 工程脚本 (`rc-repairs`, `scientific-followup`, `scientific-repairs`, `revision-regression`, `recorder-usability`): 必须退出 0，通过用例计数恰好为 138；
     - `paper-engineering-repairs`: 必须退出 0，通过用例计数恰好为 14 (工程用例总计 152 全过)；
     - `package-integrity`: 必须退出 0 且 status='PASS'；
     - `algorithm-evaluation`: 必须退出 1，测试统计必须为 total=83, passed=82, failed=1, errors=0，且保留失败用例名称严格吻合 baseline 已知门槛测试 `"Vowel pipeline F0=400 Hz"`；
     - `formant-validation` 与 `formant-holdout`: 必须退出 1，且输出完整 aggregate 结构与数值必须与 baseline 提交报告 100% 匹配；
     - 汇总保存真实脚本计数、保留门槛失败、异常、耗时与日志。符合基线预期时入口退出0；子门槛脚本退出1仍保留，不等于科学门槛通过。新异常或不符合基线时入口非零。
   - 安全清理沙盒目录。

### 已授权执行的命令行
以下四条已执行。冻结产物已存在，再次freeze应拒绝覆写；后续复核使用verify或新版本候选目录。
```bash
# 1. 核验基线源码清单完整性 (含 174 个文件)
python tools/run-phase0.py manifest

# 2. 生成并冻结 26 组 Fixtures (双候选确定性核验 + 保护已有 Golden)
python tools/run-phase0.py freeze

# 3. 校验现有 Fixtures (只读候选重算比对，不写 Golden)
python tools/run-phase0.py verify

# 4. 在隔离临时沙盒执行基线回归测试套件 (包含 images 与门槛校验)
python tools/run-phase0.py regression
```
