# Phase 0 迁移验收规范与验证矩阵 (MIGRATION_ACCEPTANCE)

**版本标识**：Phase 0 初始设计草案（父审纠错后可复核稿）  
**基线 Git 提交**：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`  
**责任归属**：Task C 独占文件（由 Antigravity 代理实施，对齐 Codex 迁移实施方案）  
**编写原则**：以 `_work/baseline/` 导出源码为事实依据，规范迁移跨语言验证标准、字段级严格性、误差预算待审项、基线已知缺陷与 Phase 0/0A 门槛。严禁拍脑袋声称冻结未复核数字，严禁将语言移植等价性混同于声学真值认证。

---

## 1. 验收目标与分级原则

### 1.1 迁移等价性目标
本验收规范的目的，是验证未来共享 Rust 声学计算核心（`noise-core`）及 WebAssembly 边界（`noise-wasm`）在复现现有基线算法逻辑时具备**确定性、数值等价性与状态一致性**。
- **不提升验证等级**：基线当前存在的科学性缺陷、频响未校准假设、共振峰/F0 弱鲁棒性等问题在迁移过程中必须持续显式标注，绝不能因“采用了 Rust 语言重构”而宣称算法精度得到提升。
- **算法修复与语言迁移严格解耦**：若在基线代码核查中发现潜在算法缺陷，必须记录为独立的待修复证据项，严禁私自修改算法逻辑并混入迁移交付中。

### 1.2 验收分级定义
1. **严格一致（Exact Match / Bit-level Match）**：整数字段、枚举状态、判定分支、有效样本计数、软件序列号与边界裁决必须 100% 保持一致，不允许存在任何误差。
2. **误差预算受控（Budget-bounded Match）**：浮点能量、声压级（dB）、等效声级（Leq）、频谱幅值及滤波尾能量，因编译器底层浮点优化、SIMD 指令集差异或 FMA（融合乘加）运算顺序，允许存在严格受控的数值公差。所有具体公差必须在观察首次 Rust 差异之前依据独立误差预算进行审定与冻结，**当前一律标为 [待审核]**。
3. **平台证据透传（Platform Passthrough）**：原生录音时长、设备标识、系统版本、地理位置、校准元数据等属于宿主采集证据，核心仅做无损接收或由适配器组装，不属于核心计算验收范畴。

---

## 2. 字段级严格性规范 (Field-Level Strictness Matrix)

对照基线结果归档生成函数 `archive()`（`_work/baseline/pages/main/main.js` [第 1029–1111 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/pages/main/main.js#L1029-L1111)），对归档数据结构的核心字段明确验收严格度级别。

> **结构说明**：基线 `captureIntegrity` 变量在 `archive()` 中被平铺解构至 `coverage` 对象内（如 `coverage.integrityStatus`、`coverage.nativeDurationMs`、`coverage.sampleDelta` 等），并非顶层根字段。本矩阵重点规范核心计算、信号质量判定与决策相关字段，透传字段由适配器负责组装，不假称不完整的表格已覆盖全部元数据。

| 归档字段路径 | 基线生成来源（源码位置） | 验收严格度 | 验证规则与断言标准 |
| :--- | :--- | :--- | :--- |
| `schemaVersion` | `main.js` L1057 (`RESULT_SCHEMA_VERSION`) | **严格一致** | 必须精确匹配当前结果 Schema 版本号。 |
| `algorithmVersion` | `main.js` L1058 (`ALGORITHM_VERSION`) | **严格一致** | 保持与基线一致，后续升级需显式递增。 |
| `sampleRate` | `main.js` L1062 (`CANVAS_CONFIG.FFT.SAMPLE_RATE`) | **严格一致** | 必须严格恒等于整型 `44100`。 |
| `sampleCount` | `main.js` L1063 (`totalAWeightedSampleCount`) | **严格一致** | 参与 A 滤波积分的样本总数必须**一个样本不差**。 |
| `measurementScope` | `main.js` L1064 (`valid ? 'whole-recording' : 'received-audio'`) | **严格一致** | 枚举值必须精确一致（全段有效 vs 片段）。 |
| `aWeightedEnergy` | `main.js` L1065 (`totalAWeightedEnergySum`) | **容差匹配** | 遵循独立审定的能量误差预算（见第 3 节）。 |
| `leqA` | `main.js` L1066 (`calculateLeqFromEnergy(...)`) | **容差匹配** | 遵循独立审定的 dB 容差预算；失效时必须为 `null`。 |
| `cneUnrounded` | `main.js` L1067 (`snapshotCne`) | **容差匹配** | 遵循独立审定的 CNE 浮点容差预算；失效时为 `null`。 |
| `cne` | `main.js` L1087 (`parseFloat(snapshotCne.toFixed(2))`) | **容差匹配** | 依据舍入规则与未舍入值容差判定。 |
| `parameters.weighting` | `main.js` L1069 (`'A'`) | **严格一致** | 恒等于 `'A'`。 |
| `parameters.fftSize` | `main.js` L1069 (`32768`) | **严格一致** | 恒等于 `32768`。 |
| `parameters.boundaryConvention`| `main.js` L1070 (`'zero-extended-finite-record'`) | **严格一致** | 恒等于 `'zero-extended-finite-record'`。 |
| `parameters.filterTail` | `main.js` L1070 (`filterTail`) | **容差匹配** | `paddingSamples` 严格一致；`energy` 容差匹配；声学终止时必须为 `null`。 |
| `coverage.receivedSamples` | `main.js` L1071 (`totalAWeightedSampleCount`) | **严格一致** | 必须精确等于 `sampleCount`。 |
| `coverage.integrityStatus` | `main.js` L1074 (`captureIntegrity.status`) | **严格一致** | 枚举值严格一致（`valid` / `partial` / `unverified` / `pending`）。 |
| `coverage.toleranceSamples`| `main.js` L1075 (`CAPTURE_DURATION_TOLERANCE_SAMPLES`) | **严格一致** | 恒等于整型 `46`。 |
| `coverage.sampleDelta` | `main.js` L1075 (`captureIntegrity.sampleDelta`) | **透传比对** | 由宿主时长换算比对，允许浮点舍入等价。 |
| `dataQuality` | `main.js` L1101 | **严格一致** | 枚举值严格一致（`valid` / `partial` / `unverified` / `invalid`）。 |
| `plateauSuspected` | `main.js` L1102 (`inputPlateauSuspected`) | **严格一致** | 块级平台限幅布尔标志位必须 100% 相同。 |
| `nearFullScaleObserved`| `main.js` L1103 (`inputNearFullScale`) | **严格一致** | 块级亚满幅布尔标志位必须 100% 相同。 |
| `silentSampleCount` | `main.js` L1104 (`silentSampleCount`) | **严格一致** | 数字静音样本计数必须绝对一致。 |
| `deliveryDelayed` | `main.js` L1104 (`deliveryDelayed`) | **严格一致** | 调度延迟布尔标志位必须一致。 |
| `qualityReason` | `main.js` L1108 (`qualityReason`) | **严格一致** | 失败原因文本映射规则一致。 |
| `threatClass` | `main.js` L1089 | **严格一致** | 风险分类 CSS 映射键必须严格一致。 |
| `riskSegments` | `main.js` L1092 (`getRiskSegmentSnapshot()`) | **严格一致** | 5 级风险分段门限与键值必须严格一致。 |
| `calibrationGrade` | `main.js` L1077 | **透传比对** | 由应用校准模块确定，核心不篡改。 |
| `device` / `system` / `vstamp` | `main.js` L1093–1109 | **透传比对** | 宿主采集环境元数据无损透传。 |

---

## 3. 误差预算规格 [待审核项 - 严禁私自冻结]

> **重要合规警告（父审强调）**：
> 迁移容差必须在**首次 Rust 数值比较之前**，依据信号原理与独立误差预算进行审定与冻结，绝对不能在 Phase 1/2 观察到 Rust 计算差异之后“看菜下饭”反向调整或放宽。
> 没有依据的数值建议绝不能声称已推导或已冻结。以下各项均为**待审候选提案 [待审核 (Pending Review)]**，供算法负责人与协调者在进入编码前独立签署。

### 3.1 累加与中间写回精度预算
- **基线源码事实**：
  - `DCBlocker` 内部使用 f64 状态（`pole`, `previousInput`, `previousOutput`），但写出的 `bufferZ` 是 **`Float32Array`**（`_work/baseline/utils/audio-quality.js` [第 110–123 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/utils/audio-quality.js#L110-L123)）。
  - `AWeightingFilter` 内部使用 f64 状态寄存器和 f64 历史缓冲，但其写出的 `bufferA` 也是 **`Float32Array`**（`_work/baseline/utils/audio-math.js` [第 135–160 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/utils/audio-math.js#L135-L160)）。
  - `main.js` 中逐样本累加能量时，执行 `const energyA = weightedA * weightedA; totalAWeightedEnergySum += energyA;`（L443–445），在 JS 引擎中为 IEEE-754 binary64（双精度浮点累加）。
- **待审公差方案 [待审核-TOL-01]**：
  - Rust 核心应复刻“IIR/FIR 运算保留 f64 状态，输出截断为 f32，随后在 f64 累加器中求和”的级联方式。
  - **建议累加能量相对容差**：$\frac{|\Delta E|}{E_{baseline}} \le 1.0 \times 10^{-6}$。
  - **待审前置条件**：需在 600 秒满长标准信号（26,460,000 样本）上由独立理论误差模型进行上界推导，而非观察 Rust 差异后拟合。

### 3.2 44.1 kHz A 计权双二阶节与 FIR 系数公差
- **基线源码事实**：
  - 双二阶节极点 `pole20`, `pole107`, `pole738` 在构造函数中由双线性变换生成（`audio-math.js` L68–76）。
  - 129 抽头、128 阶 FIR 系数在构造函数中通过 2048 点 `fftInPlace` 逆变换加时域窗动态生成（L110–118）。
- **待审公差方案 [待审核-TOL-02]**：
  - Rust 核心在 Phase 2 将系数冻结为二进制静态常量（避免运行时动态设计产生环境偏差）。
  - **建议系数容差**：Rust 冻结常量与 JS 生成器在 IEEE-754 binary64 字节级一致（`assert_eq!(coef.to_le_bytes(), golden_bytes)`）。

### 3.3 等效声级（Leq）数值公差
- **基线源码事实**：
  - `calculateLeqFromEnergy` 公式为：`10 * Math.log10(Math.max(meanSquare, 1e-24)) + offset`（`audio-math.js` L47）。
- **待审公差方案 [待审核-TOL-03]**：
  - **正常动态范围（30 dB SPL ~ 130 dB SPL）**：绝对误差待审建议上限 $|\Delta \text{Leq}| \le 0.01\text{ dB}$。
  - **极弱信号（底噪区 < 30 dB SPL）**：由于接近 `1e-24` 能量下限，对数运算敏感度增加，绝对误差待审建议上限 $|\Delta \text{Leq}| \le 0.05\text{ dB}$。

### 3.4 32768 点 FFT 及 1/3 倍频程功率谱公差
- **基线源码事实**：
  - 单边谱归一化因子 `meanSquareContribution = oneSidedFactor * fftPower / (N * windowEnergy)`，下限 `1e-24`（`fft.js` L146–147）。
  - 1/3 倍频程将 bins 功率线性求和后转 dB：`10 * Math.log10(Math.max(sumPower, 1e-20))`（`canvas-spectrum.js` L74–78）。
- **待审公差方案 [待审核-TOL-04]**：
  - **频段能量有效区（>-20 dBFS）**：各频段 dB 差值待审建议上限 $|\Delta L_{\text{band}}| \le 0.02\text{ dB}$。
  - **低能量/截止频段区**：允许最大 $\pm 0.1\text{ dB}$ 容差；当 `startBin > endBin` 时，必须严格复核返回 `-Infinity`，严禁产生虚假数值。

### 3.5 滤波器尾积分收敛步数与能量公差
- **基线源码事实**：
  - 零延拓单块为 256 样本，最多推进 2 秒（88200 样本），连续 8 块低于阈值则收敛退出（`audio-math.js` L169–184）。
  - 门限为 `threshold = Math.max(referenceEnergy, 1e-24) * 1e-12`。
- **待审公差方案 [待审核-TOL-05]**：
  - **收敛补零样本数 `paddingSamples`**：必须**完全等于基线步数**。通常按 256 样本推进；若跑满 2 秒上限，最后一块截断，44.1 kHz 下总数为 88200，不能要求它必为 256 的整倍数。
  - **尾部能量 `energy`**：相对容差待审建议上限 $\frac{|\Delta E_{tail}|}{E_{tail, baseline}} \le 1.0 \times 10^{-5}$。

---

## 4. 基线已知缺陷与历史行为保持 (Known Baseline Quirks)

迁移必须严格保留以下基线特征，**严禁在 Phase 0/1/2 中自行“修复”或更改算法**：

### 4.1 单点 1 kHz 校准的频响未核验局限
- **基线证据**：`_work/baseline/pages/main/main.js` [第 1099–1100 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/pages/main/main.js#L1099-L1100)
  ```javascript
  frequencyResponseVerification: 'unverified',
  broadbandInterpretation: 'single-point-offset-estimate',
  ```
- **保持原则**：小程序当前仅以 1 kHz 单频点校准偏移量对整个 20 Hz ~ 20 kHz 宽带进行刚性平移（加性 offset）。Rust 核心不得试图在此引入未经主线立项的频响补偿曲线。

### 4.2 极低信噪比与高噪声环境的语音算法局限
- **基线证据**：`MIGRATION_IMPLEMENTATION_PLAN.md` 第 1 节第 6 条。
- **保持原则**：针对高噪声环境下的基频（F0）八度跳变、低信噪比下的共振峰丢失问题，继续沿用基线标记；Phase 0 不进行任何针对性修补。

### 4.3 DCBlocker 首样本状态初始化瞬态与持续直流拒绝
- **基线证据**：
  - `_work/baseline/utils/audio-quality.js` [第 19–21 行, 第 113–116 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/utils/audio-quality.js#L19-L21)
  - `_work/baseline/pages/main/main.js` [第 405–412 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/pages/main/main.js#L405-L412)
- **保持原则**：
  1. **首样本初始化瞬态**：首样本进入时 `previousInput` 被赋值为当前样本归一化值，导致首样本输出为 0。随后 2 Hz IIR 滤波器存在指数衰减建立时间。该瞬态属于基线行为，必须在 DSP 单元测试中精确复现。
  2. **持续直流的全流程声学拒绝**：恒定直流块因 `max - min <= 2` 被判为数字静音。累计达到 2205 样本时，当前整块拒绝并终止；此前未达门限的小块可以进入 DC 滤波器。须冻结原始分块，不将独立滤波响应冒充全流程接受行为。

### 4.4 尾部零延拓在极弱信号下的收敛行为
- **基线证据**：`_work/baseline/utils/audio-math.js` [第 171 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/utils/audio-math.js#L171)
  `threshold = Math.max(referenceEnergy, 1e-24) * 1e-12;`
- **保持原则**：极小 `referenceEnergy` 时阈值最低为 `1e-36`。是否跑满 88200 样本取决于实际滤波状态和每块输出能量，不能仅凭信号幅度断言。完全零初始状态的滤波输出为零，可在 8 个静块后退出；全流程数字静音终止时则跳过 tail。冻结实际返回的能量、步数和收敛标志。

### 4.5 风险决策边界的非对称判定
- **基线证据**：`_work/baseline/pages/main/main.js` [第 746 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/pages/main/main.js#L746)
  ```javascript
  level.key === 'SAFE' ? cneValue <= level.upper : cneValue < level.upper
  ```
- **保持原则**：对于安全阈值 `safeMax = 80.0`，基线采用小于等于（`<=`，即精确 80.00 dB 为 SAFE）；而对于其后的等级（如 85.0、94.0、105.0），基线采用严格小于（`<`，即精确 85.00 dB 判定为 MEDIUM 而非 ATTENTION）。这种非对称判定逻辑必须在决策测试中完全一致，严禁私自增加“边界防护带”。

### 4.6 空帧与非法帧的非对称处理
- **基线证据**：`_work/baseline/pages/main/main.js` [第 391–396 行](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/_work/baseline/pages/main/main.js#L391-L396)
- **保持原则**：
  - 字节长度为奇数的帧：视为格式破坏，直接标记 `markMainMeasurementInvalid`；
  - 字节长度为 0 的空帧（`!buffer.length`）：基线直接静默 `return`，不抛错亦不使测量失效。

---

## 5. 测试语料库与用例矩阵 (Test Corpus & Matrices)

本节为分阶段验收设计，不能据此声称所有场景已运行。Phase 0 实际生成的场景、信号长度、原始块边界、事件与结果以 fixtures/manifest.json 和运行报告为准；未来 Rust 背压、Trap、真实设备场景仍待实现验证。

### 5.1 基础声学信号代表集 (Acoustic Representation Corpus)
所有信号均固定为 44.1 kHz 采样率、16-bit PCM 单声道。

| 语料标识 | 信号特征 | 样本长度 | 期望判定结果 | 验证侧重点 |
| :--- | :--- | :--- | :--- | :--- |
| `SIG-01` | 连续全零（数字静音） | 44100 (1.0s) | 触发连续数字静音超限（$\ge 2205$），终止为 Invalid | 质量终止、无尾滤波、分母冻结 |
| `SIG-02` | 1000 Hz 纯正弦波 (-20 dBFS) | 441000 (10.0s)| 正常结算，A 计权增益接近 0 dB | 稳态 A 滤波增益与 Leq 精度 |
| `SIG-03` | 1/3 倍频程标准频率序列 (20~8000 Hz) | 每频点 2.0s | 正常结算，各频段能量独立突出 | 双二阶节与 FIR 级联幅频响应 |
| `SIG-04` | 非整数周期正弦波 (999.3 Hz, 50.7 Hz) | 132300 (3.0s)| 正常结算，频谱窗泄漏表现一致 | Hann 窗与 FFT 旁瓣一致性 |
| `SIG-05` | 持续直流偏置信号 (DC Step = 8192) | 88200 (2.0s) | 全流程：50ms 触发静音超限终止为 Invalid | 全流程质量拒绝（区别于独立 DC 单元测试） |
| `DSP-01` | 隔离 DC 滤波响应（先零输入再施加阶跃） | 88200 (2.0s) | 阶跃产生 2 Hz 指数衰减；首次即恒值时由播种规则输出零 | DCBlocker 纯数学单元响应与初值 |
| `SIG-06` | 亚满幅大动态信号 (峰值 32150) | 44100 (1.0s) | 正常结算，标记 `nearFullScale = true` | 质量警告与正常 Q+D 事务 |
| `SIG-07` | 平台限幅伪信号 (平顶 12 样本) | 44100 (1.0s) | 正常结算，标记 `plateauSuspected = true` | 平台波形探测器灵敏度 |
| `SIG-08` | 削波过载信号 (窗口内满幅 3 样本) | 44100 (1.0s) | 触发削波，立即终止为 Invalid | Q-only 结算，DSP 拒收 |

### 5.2 决策边界语料库 (Decision Boundary Corpus)
针对应用层风险判定与报警逻辑，在关键分贝门限边界注入微小偏置。此项通过纯 domain 函数调用验证，不假称由 Int16 PCM 命中微小分贝：

| 决策测试项 | 测试输入 CNE (dB) | 基线期望等级 (`riskStatus.key`) | 报警期望 (`isAlarming`) | 源码判定依据 |
| :--- | :--- | :--- | :--- | :--- |
| `DEC-01` | 79.999 | `SAFE` | 不触发 | `main.js` L746 (`<= 80.0`) |
| `DEC-02` | 80.000 | `SAFE` | 不触发 | `main.js` L746 (`<= 80.0`) |
| `DEC-03` | 80.001 | `ATTENTION` | 不触发 | `main.js` L746 (`> 80.0`) |
| `DEC-04` | 84.999 | `ATTENTION` | 不触发 | `main.js` L746 (`< 85.0`) |
| `DEC-05` | 85.000 | `MEDIUM` | 不触发 | `main.js` L746 (`85.0` 命中 MEDIUM) |
| `DEC-06` | 93.999 | `MEDIUM` | 不触发 | `main.js` L746 (`< 94.0`) |
| `DEC-07` | 94.000 | `HIGH` | 不触发 | `main.js` L746 (`94.0` 命中 HIGH) |
| `DEC-08` | 100.000 (设预警门限=100) | `HIGH` | **触发报警** (`cne >= noiseAlarmLevel`) | `main.js` L362 |

### 5.3 故障注入与异常处置矩阵 (Fault Matrix)
| 故障编号 | 故障注入场景 | 核心与适配器期望行为 | 账本结算状态 |
| :--- | :--- | :--- | :--- |
| `FLT-01` | 奇数字节破坏帧 (byteLength=2047) | 拒绝处理，标记格式无效，安全停止原生录音 | `RejectedError(InvalidFormat)` |
| `FLT-02` | 录音中途收到麦克风系统中断 (`InterruptionBegin`)| 标记测量被系统中断，会话置为 Invalid | `Interrupted` |
| `FLT-03` | 录音停止超时 (超过 2250 ms 未收到 onStop) | 触发兜底定时器，置失效原因并跳过尾滤波，归档为 Invalid (canSave=false) | `StopTimeoutFallback` |
| `FLT-04` | 核心事件缓冲区溢出（背压阻塞） | 返回 `WouldBlock`，宿主依模式降级或挂起 | `BackpressureBlocked` |
| `FLT-05` | 已经处于 `SignalTerminated` 时再次来帧 | 核心直接拒绝，适配器结算为忽略块 | `IgnoredAfterTermination` |
| `FLT-06` | 归档完成后重复调用 `finalize` | 幂等操作，只读返回已归档快照，不重复累加 tail | `FinalizedIdempotent` |

### 5.4 变长分块语料与块级判定边界 (Chunking Invariance Matrix)
> **父审纠错约束**：任意回调分块**不保证**质量判定与应用级输出（如块内峰值、块级静音及块 RMS `lastFrameLevels`）完全相同，因为 `inspectPcm` 和 `calculateRMS` 是在单个回调块的物理边界上计算的。
> 分块一致性（Chunking Invariance）**严格仅要求**：对于已通过质量检验并接受的无故障信号流，在进入滤波与逐样本积分数学管道后，不同分块下的 `totalAWeightedSampleCount`、`totalAWeightedEnergySum` 与最终 `leqA` 必须满足一致性公差。
> 涉及块级质量事件的 fixture，其分块必须精确按基线切片位置冻结。

- 序列 A：1024 样本固定块；
- 序列 B：1600 样本固定块（对应 36.3 ms，基线常用）；
- 序列 C：4096 样本大块；
- 序列 D：动态变长块（[128, 2048] 波动）。

---

## 6. Mock 与真机验证范围划分 (Mock vs Real Device Scope)

### 6.1 Mock / 离线确定性验证范围
- **执行环境**：本地开发机、CI 流水线、纯 Rust 原生单测、Node.js VM 离线测试宿主（基于 `tests/runtime.cjs`）。
- **验证内容**：
  1. 使用合成标准 PCM 与 Mock 事件，逐块比对 Rust 与 JS 的数学输出；
  2. 模拟注入中断、奇数帧、背压饱和等纯逻辑事件；
  3. 评估算法运算的 CPU Cycle 与离线性能。
- **边界红线**：Mock 环境的测试通过**只能证明代码逻辑与基线算法设计等价**，绝对不能作为移动端兼容性或真机可用的证明！

### 6.2 真机运行验证范围 (Real Device Scope)
- **执行环境**：真实的 iPhone 与 Android 品牌真机微信小程序运行环境。
- **验证内容**：
  1. WASM 模块在真实真机宿主环境中的实际加载、编译与实例化能力；
  2. 真实麦克风硬件采样率漂移（如标称 44100 但时钟存在微小偏差导致的丢帧）；
  3. 微信小程序 Worker 线程通信开销与内存分配压力（GC Pause 影响）；
  4. 真实用户操作下的二次启动、切后台、来电中断恢复等生命周期行为；
  5. 微信小程序代码包增量影响。

---

## 7. Phase 0 与 Phase 0A 准入门槛与退出标准

### 7.1 Phase 0 退出门槛（Exit Gates）
只有满足以下全部前置条件，Phase 0 方可宣布收敛并允许启动后续阶段：
1. **五项基线产物齐备且通过交叉审阅**：
   - `MIGRATION_IMPLEMENTATION_PLAN.md`（实施方案）
   - `CURRENT_SIGNAL_STATE_MACHINE.md`（基线状态机事实，由 DSH 完成）
   - `CORE_STATE_CONTRACT.md`（核心状态契约，由 AGY 完成）
   - `NUMERIC_SEMANTICS.md`（数值语义与系数设计，由 DSH 完成）
   - `MIGRATION_ACCEPTANCE.md`（验收规范与矩阵，由 AGY 完成）
2. **基线样本与执行证据就绪**：
   - 生成确定性合成 fixture（初始估计 20–24 组，补充未校准、原生时长缺失、单块跨两秒与报警后为 26 组；含 PCM、chunks、events、expected，真实计算 FFT 的场景另含 spectra）；
   - 在隔离副本中执行基线回归测试，生成可核查的测试与性能证据报告；
   - 证明文件实施方案不能替代实际 fixture 与执行证据。
3. **源码引用绝对精确**：所有文档中引用的代码路径、函数名及行号必须直接对应基线只读代码 `_work/baseline/`，无任何臆测。
4. **打包隔离落地**：协调者已确认 `project.config.json` 中配置了 `rs-core` 打包排除项，确保迁移工程文件不进入微信发布包。
5. **已知缺陷与待审项清晰列出**：不隐瞒基线问题，不私自冻结误差预算数字。

### 7.2 Phase 0A 准入门槛与验证目标（Hello-DSP Gate）
Phase 0A 是进入正式 Rust 核心编写（Phase 1）前的**轻量级技术可行性试水阶段**：
- **前置准入**：Phase 0 退出门槛全部达成。
- **执行范围**：
  - 仅构建极简的 `hello-dsp` WASM 原型（包含极简内存传递、一个简单的增益或加法运算）。
  - **绝不接入生产录音流水线**，绝不替换原有 `main.js`。
- **真机验收考量（非正式批准阈值，供参考）**：
  1. 在 Android 和 iOS 目标真机微信环境中成功加载并执行极简 WASM 函数；
  2. 验证冷启动加载耗时可接受（供基准测量，不设假想硬门槛）；
  3. 验证构建产物体积增量可控，不影响小程序发布配额；
  4. 验证 WebAssembly 内存初始化与销毁无泄漏现象。

---

## 8. 待审项与风险跟踪清单 (Pending Review Items)

1. **[待审核-ACC-01] 误差预算正式冻结流程**：第 3 节中标记的五项公差提案，必须在观察任何 Rust 差异之前、依据独立理论模型与信号分析由协调者、算法负责人及质量代理共同审定并签署冻结。
2. **[待审核-ACC-02] 46 样本容差保持原定义**：基线 `main.js` L111 设定 `CAPTURE_DURATION_TOLERANCE_SAMPLES = Math.ceil(44100 / 1000) + 1 = 46` 样本（约 1 毫秒），代表原生时长毫秒级舍入加一个采样点量化误差。网络抖动、时钟漂移与丢帧属于不同概念。基线容差保持不变，严禁按机型放宽；任何调整必须作为独立算法/平台语义变更事项立项。
3. **[待审核-ACC-03] 决策测试判定原则**：决策测试直接对齐基线在 `main.js` L746 中的硬判定规则，纯迁移范围严禁引入任何“防护带”；对微小浮点差异的容忍度由前置数学计算的 Leq 误差预算保证。
