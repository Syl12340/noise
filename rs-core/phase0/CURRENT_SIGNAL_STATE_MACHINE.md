# Phase 0 当前信号状态机事实还原 (CURRENT_SIGNAL_STATE_MACHINE)

**基线提交**：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`  
**只读来源**：`_work/baseline/`（`phase0/BASELINE_SOURCE_MANIFEST.json` 所列已提交 blob，无私有配置）  
**责任**：Phase 0 信号状态机核心事实基线文档  
**性质**：**基线既有事实**的记录。文中每个论断均标注 `_work/baseline/` 中的真实源码行号。凡涉及未来 Rust 协议者，一律置于独立映射规划节，且明确标注为**映射规划**，不代表当前已经实现；当前阶段不存在任何 Rust 源码。

**行号约定**：`main.js` 指 `_work/baseline/pages/main/main.js`（共 1318 行）；`audio-quality.js` 指 `_work/baseline/utils/audio-quality.js`（共 128 行）；`audio-math.js` 指 `_work/baseline/utils/audio-math.js`（共 195 行）；`result-manager.js` 指 `_work/baseline/utils/result-manager.js`（共 59 行）；其余模块同理，均在 `_work/baseline/utils/` 下。

---

## 1. 结论摘要

1. 音频帧处理是一条**单线程、逐样本、就地累加**的流水线，入口唯一为 `handleRecordedFrame`（`main.js` L386）。
2. **拒绝与终止的多维语义**：终止不仅包含声学门限拒绝（「削波过载」与「连续数字静音超限」），也包含结构性数据格式无效（奇数字节长度）、系统中断、硬件错误与停止超时兜底。不能概括为只有两种硬拒绝（详见第 3、6 节）。削波与 50ms 静音超限为 **Q-only 终止**（提交质量证据，不提交 DSP）。
3. **恒定 DC 块的进流与拒绝**：常数 DC 块在未达 50ms 连续静音门限前仍进入 `DCBlocker`。自会话首样本即恒值时输出为零；若此前信号不同则可产生瞬态。累计静音达到 2205 样本时，当前整块拒绝并终止（第 3 节）。
4. **块 RMS 与秒级 Leq 是两个不同口径**，不可混用（第 4 节）。
5. **终止后的帧被静默忽略**（`main.js` L396），这不是空操作判定，而是会话栅栏（第 6 节）。
6. **停止时可选执行尾滤波，且分母不加 tail**（第 7 节）；会话一旦无效则禁止 tail（`main.js` L1210）。
7. **分类器数值逻辑与展示层文案存在边界不一致**：`main.js` L746 是唯一的数值分类逻辑，SAFE 段使用 `<=`；但在历史详情展示层 `result.js` L67–72 中，SAFE 被格式化为 `<80 dB(A)`、ATTENTION 为 `80-85 dB(A)`，存在边界文本歧义（第 8 节）。
8. **未校准用户依然可正常测量并保存**：`main.js` L961–967 在无有效校准时将状态自动降级转换为 `valid: true, grade: 'estimated', riskEligible: false`，满足 `hasUsableMainSamples`，允许保存估算记录，仅不认证为参考测量且不作风险分级（第 7 节）。

---

## 2. 会话生命周期与状态变量

| 变量 | 初始/重置语义 | 行号 |
| :--- | :--- | :--- |
| `isMainMonitoringActive` | 唯一权威「本会话是否接纳帧」标志；`false` 时 `handleRecordedFrame` 立即返回 | `main.js` L142, L387–389, L1013, L1156 |
| `monitorSessionId` | 每次 reset 自增，用于作废跨会话的异步回调（位置、看门狗） | L183, L258–260, L1249–1257 |
| `currentMainPage` | 当前页实例引用，防止跨页回调串写 | L141, L997, L1158 |
| `_mainStopRequested` | 用户已请求停止；为 `true` 时 `Stop` 走正常收尾而非「意外停止」 | L1168, L1183, L537–546 |
| `_awaitingRecorderRecovery` | 系统占用等待恢复期间，暂停断流看门狗 | L211, L261, L519–522 |
| `measurementInvalidReason` | 非空即会话声学/流程失效；一旦置位不再被覆盖 | L101, L229–233 |
| `inputOverloaded` | 削波过载闩锁；置位后所有后续帧静默丢弃 | L98, L396, L401 |
| `captureIntegrity` | `{status: pending\|valid\|partial\|unverified}`，停止时依原生时长核验 | L112, L176, L1208–1209 |
| `filterTail` | 尾滤波结果，兼作幂等闩锁（`!filterTail` 才执行） | L116, L180, L1210–1214 |

**启动序列**（`startMainMonitoring`，L996–1022）：
`currentMainPage = this` → `isMainMonitoringActive = false` → 取消待启动定时器 → `initMonitor()`（L951–989，重建 `AWeightingFilter`、`DCBlocker`、读配置、算 `timeTerm`、`resetMonitorSessionState`）→ 绑定帧回调（L1006）→ 绑定生命周期监听（L1012）→ `isMainMonitoringActive = true`（L1013）→ `safeStartRecorder(..., 50)`（L1014）→ 启动看门狗（L1020）。

**关键顺序事实**：`isMainMonitoringActive = true` 在 `safeStartRecorder` **之前**（L1013 vs L1014），因此启动请求期间的迟到帧只要通过 recorder-session 的 guardedListener 就能进入处理。

**重置的完整性**：`resetMonitorSessionState`（L167–227）重置全部累加器（L191–194）、清空环形缓冲（L200–203）、**重建 `DCBlocker`**（L182），但**不重建 `aWeightingFilter`**——后者在 `initMonitor` 中重建（L955）。二者共同保证跨会话无状态残留。

---

## 3. 原始块检查的精确顺序与拒绝分类

`handleRecordedFrame(page, res)` 的守卫链（L386–424），**顺序即语义**：

| 序 | 条件 | 处置 | 行号 |
| :-- | :--- | :--- | :--- |
| 1 | `!isMainMonitoringActive \|\| !page` | 静默返回 | L387–389 |
| 2 | `frameBuffer` 缺失 / `byteLength` 非有限 / **奇数** | `markMainMeasurementInvalid('音频数据格式无效，请重新测量')`，会话结构性终止 | L391–394 |
| 3 | `!buffer.length \|\| inputOverloaded \|\| measurementInvalidReason` | 静默返回 | L396 |
| 4 | `inspectPcm(buffer, inputQualityInspector)` | 质量证据更新（恒执行） | L397 |
| 5 | `quality.clipped` | `inputOverloaded = true` + 失效 + **整块声学拒绝** | L400–404 |
| 6 | `quality.digitalSilence` | 累计静音计数；达 50 ms 门限则失效 + **整块声学拒绝** | L405–415 |
| 7 | 否则 | 正常 DSP 提交 | L417–493 |

**第 2 步的结构性数据格式无效**：`frameBuffer.byteLength % 2 !== 0` 直接判定非法（L392）。这是 16-bit 线性 PCM 对齐要求。它属于**硬性结构拒绝并终止会话**，不能称只有声学门限拒绝。

**第 3 步的静默丢弃语义**：`inputOverloaded` 或 `measurementInvalidReason` 已置位时，后续帧**既不进入质量检查也不进入 DSP**，直接返回（L396）。这是「终止后忽略」在基线中的实现方式：**由标志位在入口处丢弃，而不是由硬件底层停止投递**。

**质量分派（`inspectPcm`，audio-quality.js L2–32）**：
- 逐样本统计 `clippedSamples`（`>=32767 || <=-32768`，L9）、`nearFullScaleSamples`（`abs>=32112`，L11）、`peakAbs`、`min`、`max`（L12–14）。
- 委托 `PcmQualityInspector.process` 提供滑动窗口证据（L17）。
- `nearFullScale = nearFullScaleSamples > 0`（L18）——**警告，不拒绝**。
- `noAcSignal = pcm.length > 1 && max - min <= 2`（L19）——**极差判据**。
- `digitalSilence = pcm.length > 0 && (peakAbs <= 1 || noAcSignal)`（L20）——**峰值或极差任一成立即判静音**。

> **持续常数 DC 的真实进流与终止过程**：
> 1. 常数直流块因 `max - min = 0 <= 2`，在 `inspectPcm` 中被判为 `noAcSignal` 与 `digitalSilence`（audio-quality.js L19–20）；
> 2. 但在 `handleRecordedFrame` L408–413 中，只要连续静音计数尚未达到 50 ms 门限（2205 样本），**前序较小的 DC 块并不会被立即拒绝，而是继续流入 `dcBlocker.process(buffer)`（L426）**；
> 3. 在 `DCBlocker` 内部，首样本被赋给 `previousInput`（L114），导致首样本及后续无变化的差分项恒为 0，因此稳态 DC 输出全零；
> 4. 只有当连续静音计数累计满 2205 样本时，在当前块触发 `markMainMeasurementInvalid('录音连续输出数字静音，本次结果无效')`（L410），此时**当前超限块才被整块拒绝**并终止会话。

**质量提交（跨块 rails）**：`PcmQualityInspector` 以 10 ms 滑动窗口累计满幅样本数（L39–40, L55–72）。`railLimit = max(2, ceil(windowSamples * .001))`，在 44.1 kHz 下 `windowSamples = 441`、`railLimit = 2`。窗口与运行游标 `position`、`rails`、`samples` **跨块保留**（L41–48），因此削波证据不受回调块边界影响。削波区间按 `start <= last.end` 合并（L69–71）。

**chunk-local silence（与 rails 相反）**：静音判定**不是**滑动窗口。`consecutiveSilentSampleCount` 是单纯的连续样本计数（L408, L414），任何非静音块将其清零（L414），门限为 `Math.round(44100 * 0.05) = 2205` 样本（L409）。它虽跨块累加，但语义是「连续」而非「局部滑动窗口」，且**由 main 层而非 inspector 维护**。`silentSampleCount` 另行累计全部静音样本（L407），仅入档（L1104），不参与判定。

**50 ms 整块拒绝的确切含义**：门限比较在**块级**发生（L409），一旦越限，**当前整个块**被拒绝且会话终止——而不是仅丢弃越限的那部分样本。该块样本从未进入 `dcBlocker.process`。

**平台检测**（L73–82）：仅在 `run >= 8`、`|previous| > 1024`、且满足「先接近后离开」的乘积判据时置 `plateauSuspected`（L76–77），注释明示排除常数 DC（L75）。该标志只入档（L1102），不中止处理。

**近满幅与平台均为警告**：`inputNearFullScale`/`inputPlateauSuspected` 在 L398–399 以 `||` 累积，处理继续。

---

## 4. DC / A 计权 / f32 写回与块 RMS

正常块的 DSP 提交（L426–493）：

1. `bufferZ = dcBlocker.process(buffer)`（L426）——输入 `Int16Array`，内部分别 `/32768`（audio-quality.js L112），输出 **`Float32Array`**（L110, L119）。跨块状态 `previousInput`/`previousOutput`（L105–107, L120–121）；首样本用 `initialized` 一次性播种（L113–116），避免起始阶跃。
2. `energyZ = calculateRMS(bufferZ)`（L427）——**块 RMS**，在去直流后的整块上计算（audio-math.js L11–18）。
3. `dbfsZ = calculateDb(energyZ, 1)`（L428）——参考值**显式传 1**，因为 `bufferZ` 已归一化到 ±1 量纲。
4. `dbsplZ = dbfsZ + offset`（L429）——偏移在 dB 域相加。
5. `lastFrameLevels = {dbfs, dbspl}`（L430）——仅作 UI 与归档末值，**不参与积分**。
6. `bufferA = aWeightingFilter.process(bufferZ, false)`（L431）——`normalize = false`，因为输入已是归一化浮点，**避免二次除以 32768**。输出 **`Float32Array`**（audio-math.js L135）。
7. 逐样本循环（L440–482）。

> **f32 边界**：`DCBlocker` 与 `AWeightingFilter` 的输出缓冲均为 `Float32Array`（audio-quality.js L110；audio-math.js L135）。因此**每个样本一旦离开滤波链就被量化为 f32**，而累加器 `totalAWeightedEnergySum`、`intervalZWeightedEnergySum` 是 JS `number`（f64）。`energyA = weightedA * weightedA`（L443）在 f64 中计算，但**操作数是已量化的 f32 值**。

> **环形缓冲回写**：`pcmRingBuffer[pcmWriteIndex] = normalizedZ * 32768`（L450）——把去直流后的浮点**乘回 32768** 存入 `Float64Array`（L56）。这是为了给 `applyHannWindow` 的 `/32768` 做逆运算（fft.js L108）。**取整并未发生**（`Float64Array` + 未取整乘法），注释明示「保留小数以免量化/溢出」（L56）。

> **口径区分（不可混淆）**：块 RMS 用的是**去直流后的 Z 计权**信号且仅覆盖单块（L427）；秒级区间用 `intervalZWeightedEnergySum`（Z 计权，逐样本平方，L447）；累计 `leqA` 用 `totalAWeightedEnergySum`（**A 计权**，L445）。三者计权不同、时间跨度不同。

---

## 5. 逐样本累计、秒级结算与 ring/hop

**逐样本累加（L440–482）**：

| 操作 | 表达式 | 行号 |
| :--- | :--- | :--- |
| A 计权能量（f64 累加） | `totalAWeightedEnergySum += energyA` | L445 |
| A 计权样本计数 | `totalAWeightedSampleCount++` | L446 |
| Z 计权区间能量 | `intervalZWeightedEnergySum += normalizedZ * normalizedZ` | L447 |
| Z 计权区间计数 | `intervalZWeightedSampleCount++` | L448 |
| 环形缓冲写入 | `pcmRingBuffer[pcmWriteIndex] = normalizedZ * 32768` | L450 |
| ring 游标推进 | `pcmWriteIndex = (pcmWriteIndex + 1) % fftSize`（`fftSize = 32768`） | L451 |

**A 累计前缀 / Z 区间语义**：`totalAWeighted*` 是**自会话首样本起永不重置的累计前缀**（仅在 L191–192 重置）；`intervalZWeighted*` 是**每秒清零的区间量**（L333–334）。二者分母不同，得到的 Leq 语义不同：前者是整段累计 LAeq（L299–303），后者是该秒的 Z 计权 Leq（L328–332）。

**秒级边界（L472–481）**：`intervalSampleCounter` 逐样本递增（L472），`>= sampleRate` 时**减去** `sampleRate`（L478–479，非清零，可容纳单块 >= 2s 跨越多个秒级边界）并调用 `finalizeMeasurementSecond(page, dbfsZ, dbsplZ)`（L480）。

`finalizeMeasurementSecond`（L326–375）：
1. `time++`（L327）。
2. `intervalDbsplZ = calculateLeqFromEnergy(intervalZWeightedEnergySum, intervalZWeightedSampleCount, offset)`（L328–332）。
3. 区间累加器清零（L333–334）。
4. 仅当 `calibrationStatus.valid && Number.isFinite(intervalDbsplZ)` 时 `recordArray(time, intervalDbsplZ)`（L336–338）。
5. 波形视图下重绘（L339–341）。
6. `cne = calculateCurrentCne()`（L343），随后风险/告警判定（L344–374）。

> **注意**：`dbfsZ`/`dbsplZ` 作为**块级**参数传入秒级结算（L480），用于 UI 展示（L355–356），**不参与** `intervalDbsplZ` 的积分。

**ring / hop 定时相位与视图查询的区别**：
- **定时 FFT 的 hop 相位完全由样本计数固定**：`fftSampleCount` 逐样本自增（L462），达到 `fftHopSize`（8192）时递减 `fftHopSize`（L463–464）。即使在波形视图下不需要频谱（`spectrumNeeded = false`），**hop 游标与相位依然严格推进**（L462–464），仅跳过 `updateSpectrumFromRingBuffer()`。
- **视图切换的主动查询是独立事件**：当用户切入 spectrum/spectrogram 模式时，若环形缓冲已满 32768 点（L831, L841），系统在切换时刻立即主动调用一次 `updateSpectrumFromRingBuffer()` 刷新画面。**这次额外查询依用户点击的样本时间点而定，绝不重置或修改定时 hop 的累计计数器 `fftSampleCount`**。两者不可混为一谈。
- `updateSpectrumFromRingBuffer`（L307–324）：未校准则直接置 `spectrumBandLevels = null` 并返回（L308–311）；否则从 `pcmWriteIndex` 起**按环序**复制 32768 点到 `fftInput`（L313–317），调用 `computeSpectrum`（L319）与 `computeThirdOctaveBands`（L320）。该查询只产生显示副作用，**不消耗音频样本、不移动 `pcmWriteIndex`、不推进 hop 计数**。

---

## 6. 终止后的忽略与栅栏

终止的所有触发入口：

| 入口 | 置位与原因 | 行号 |
| :--- | :--- | :--- |
| 削波过载 | `inputOverloaded = true` + `markMainMeasurementInvalid('输入过载，请降低电平后重新测量')` | L400–404 |
| 连续静音 50 ms | `markMainMeasurementInvalid('录音连续输出数字静音，本次结果无效')` | L409–412 |
| 格式非法 | `markMainMeasurementInvalid('音频数据格式无效，请重新测量')` | L393 |
| 原生意外停止 | `markMainMeasurementInvalid('录音意外停止，本次结果无效')` | L547 |
| 系统来电中断 | `markMainMeasurementInvalid('录音被系统中断，本次结果无效')` | L559 |
| 录音被暂停 | `markMainMeasurementInvalid('录音被暂停，本次结果无效')` | L565 |
| 录音器底层错误 | `markMainMeasurementInvalid('录音发生错误，本次结果无效')` | L571 |
| 停止兜底超时 (2250ms) | `measurementInvalidReason = '录音停止未确认，本次结果无效'` | L1190 |

`markMainMeasurementInvalid(reason)`（L229–249）：
- 仅在 `measurementInvalidReason` 为空时写入，**首个原因不可被覆盖**（L230–232）。
- 清看门狗、`cne = NaN`（L233–234）。
- `isMainMonitoringActive = false`（L246）——**这是让后续帧被忽略的真正开关**。
- `cancelRecorderStart` + `safeStopRecorder`（L247–248）。

**终止后帧的行为**：由 L387–389（`!isMainMonitoringActive`）与 L396（`measurementInvalidReason`）两级守卫丢弃。**这些帧不进入质量检查、不进入 DSP、不推进任何计数**。

**「录音意外停止」的区分**（L531–548）：`Stop` 事件到达时，若 `isRecorderTransitioning` 为真则让位给 recorder-session 的交接（L536）；若 `_mainStopRequested` 为真则走正常收尾（L537–540）；若原生 `duration >= limit - 2` 视为达到 600 s 上限的正常停止（L541–546，`limit = mainRecordParams.duration = 600000`，L806）；否则判为意外停止并失效（L547）。

**停止路径（L1181–1231）**：`stopNoiseMonitoring` 置 `_mainStopRequested = true`、清除看门狗、取消待启动、置 `stopping`、启动 **2250 ms 兜底定时器**（L1187–1192）、`safeStopRecorder`。若兜底超时先到，则置 `measurementInvalidReason = '录音停止未确认，本次结果无效'` 并强制 `completeRequestedMainStop()`（L1190–1191）。**该分支因 `measurementInvalidReason` 非空而跳过尾滤波**（L1210）。

**看门狗（L256–276）**：250 ms 周期。`referenceTime` 取 `lastValidFrameAt || mainCaptureStartedAt || startDate`（L263）；超时门限按阶段三选一：录音中 **2000 ms**、首帧 **10000 ms**、启动 **15000 ms**（L264–265, L106–108）。**已收到过有效帧时的超时只置 `deliveryDelayed = true` 并改标签，不失效**（L267–271）；从未收到有效帧才失效（L272–273）。

---

## 7. 停止结算、容差与 tail、可保存性与校准降级

**`onStop` 计数与容差（`completeRequestedMainStop`，L1196–1231）**：

```javascript
const nativeDurationMs = res && res.duration;                                   // L1203
const durationAvailable = Number.isFinite(nativeDurationMs) && nativeDurationMs > 0;  // L1204
const sampleDelta = durationAvailable
  ? totalAWeightedSampleCount - nativeDurationMs * CANVAS_CONFIG.FFT.SAMPLE_RATE / 1000  // L1205-1206
  : null;
const complete = durationAvailable && Math.abs(sampleDelta) <= CAPTURE_DURATION_TOLERANCE_SAMPLES;  // L1207
captureIntegrity = { status: complete ? 'valid' : durationAvailable ? 'partial' : 'unverified', ... };  // L1208-1209
```

- **容差常量**：`CAPTURE_DURATION_TOLERANCE_SAMPLES = Math.ceil(44100 / 1000) + 1 = 45 + 1 = 46`（L111）。**46 样本**，注释明确其只用于容纳原生毫秒时长的量化误差与一个样本的舍入，**不允许按比例丢帧**（L109–110）。
- **三态**：`valid`（时长可用且 `|delta| <= 46`）、`partial`（时长可用但超差）、`unverified`（时长不可用）。
- **比较符**：`<=`（L1207），**恰好 46 判为 valid**。

**tail 触发条件与收敛动力学（L1210–1214）**：

```javascript
if (!filterTail && totalAWeightedSampleCount > 0 && !measurementInvalidReason) {
  filterTail = require('../../utils/audio-math').integrateFilterTail(
    aWeightingFilter, totalAWeightedEnergySum, CANVAS_CONFIG.FFT.SAMPLE_RATE);
  totalAWeightedEnergySum += filterTail.energy;
}
```

- **三条件**：幂等（`!filterTail`）、有样本（`totalAWeightedSampleCount > 0`）、会话未失效（`!measurementInvalidReason`）。
- **分母不加 tail**：尾部能量只加到分子 `totalAWeightedEnergySum`（L1213），**分母 `totalAWeightedSampleCount` 保持不变**。
- **动力学细节（audio-math.js L168–185）**：
  1. 阈值：`threshold = Math.max(referenceEnergy, 1e-24) * 1e-12`（L171）；
  2. 每块 256 个零样本（L169）；
  3. 最大时长 2 秒（88200 样本）：由于 88200 不是 256 的整倍数（$344 \times 256 + 136 = 88200$），末块按 `Math.min(256, 2 * sampleRate - samples)` 截短为 136 样本（L173）；
  4. 提前收敛：连续 8 块能量 $\le \text{threshold}$ 立即退出（L172, L184）。完全零初始状态可在 8 块后退出；非零弱信号的残余状态需实际计算，不能断言固定步数。数字静音终止时不执行 tail。

**可保存性与未校准状态降级（L278–293, L961–967）**：
- `hasUsableMainSamples`（L278–285）：要求 active、`calibrationStatus.valid`、未过载、无失效原因、`totalAWeightedSampleCount > 0`、能量有效且未超时。
- `isMainMeasurementValid = captureIntegrity.status === 'valid' && hasUsableMainSamples()`（L288）。
- `isMainMeasurementSaveable` 额外接受 `unverified` 与 `partial`（L292）。
- **未校准用户的可用性事实**：虽然 L278 检查 `calibrationStatus.valid`，但在 `initMonitor` L961–967 中：
  ```javascript
  if (!calibrationStatus.valid) {
    calibrationStatus = { ...calibrationStatus, valid: true, grade: 'estimated',
      riskEligible: false, calibrationVerified: false,
      calibrationNote: calibrationStatus.reason, reason: '',
      label: calibrationStatus.meta && calibrationStatus.meta.source ? '历史参数估算' : '未校准估算' };
  }
  ```
  **未校准状态被自动转换为 `valid: true`、`grade: 'estimated'`、`riskEligible: false`**。因此未校准用户依然能通过 `hasUsableMainSamples`，测量完成后 `canSave = true`，结果可正常保存入库。系统仅将展示文案设为“未校准估算”，将风险等级设为“估算结果，不作风险分级”，**并不强制要求实验室校准才能使用或保存**。

---

### 归档与停止释放的顺序补充

main.js L1215 先用 `archive()` 冻结 `_completedSnapshot`，再在 L1216 释放会话资源，因此保存依据冻结快照。`archive()` L1030 若已有快照则直接返回；L1032 的时长仅按积分样本数除以 44100，L1065–1075 保存含 tail 的 A 能量、未舍入 CNE、FFT/边界约定及 captureIntegrity 信息。结构或声学终止路径可能没有 `_completedSnapshot`，验证工具须保留实际终止证据而不能重新调用 archive 冒充停止完成。基线 coverage.receivedSamples 等于积分数；未来 adapter 实际接纳数须另列，不能混淆。

## 8. exact80：数值分类器与展示层边界差异

**基线唯一的分类实现**（`getRiskStatusByCNE`，`main.js` L735–753）：

```javascript
for (let i = 0; i < levels.length; i++) {
  const level = levels[i];
  if (level.key === 'SAFE' ? cneValue <= level.upper : cneValue < level.upper) {   // L746
    return { key: level.key, text: level.text, bgClass: level.bgClass };
  }
}
const lastLevel = levels[levels.length - 1];   // L751-752
return { key: lastLevel.key, text: lastLevel.text, bgClass: lastLevel.bgClass };
```

- **SAFE 使用 `<=`**（L746）：`cne === 80.0` 命中 SAFE。
- **ATTENTION/MEDIUM/HIGH 使用 `<`**（L746 的三元另一支）：`cne === 85.0` 跃迁为 MEDIUM，`94.0` 跃迁为 HIGH。
- **EXTREME 与 Infinity 的命中语义**：默认配置下有限高值在循环内满足 `cneValue < Infinity` 而返回 EXTREME。所有非有限输入由 main.js L736–738 直接返回 INVALID，不进入循环；末段兜底不是它们的处理路径。

**展示层边界文本歧义（`result.js` L60–79）**：
- 在历史详情页面 `result.js:formatRiskRange` 中：
  - SAFE 段（`lower: null, upper: 80`）被格式化为文本 **`<80 dB(A)`**（L71）；
  - ATTENTION 段（`lower: 80, upper: 85`）被格式化为文本 **`80-85 dB(A)`**（L67）。
- **事实记录**：虽然底层分类器只有 `main.js` L746 一处（80.0 归入 SAFE），但前端历史展示文本中 SAFE 写作 `<80`、ATTENTION 写作 `80-85`，导致用户端界面在 80 dB(A) 这一分界点上存在数值归属与文本描述的直观不一致。

---

## 9. 未确定项与已知事实勘误

1. **去重保护已在 result-manager 中实现（勘误）**：`_work/baseline/utils/result-manager.js` L23 明确包含 `if (record.recordId && records.some(item => item && item.recordId === record.recordId)) return records;`。原稿中“未在源码中发现去重保护”的论断与源码事实不符，在此正式更正：基线在落盘层对相同 `recordId` 具有防御性幂等去重保护。
2. **Mock 声学输出不等于真机或临床验证**：基线自身即声明 `frequencyResponseVerification: 'unverified'`（`main.js` L1099）、`captureChainVerification: 'unverified'`（L1105）、`broadbandInterpretation: 'single-point-offset-estimate'`（L1100）。有限长 FIR 为数值工程近似，未在真机环境认证，未做医疗器械效度认证。
3. **46 样本容差为既有工程常量**（`main.js` L111, L1207）：本规范仅如实陈述既有代码取值，未引入迁移 epsilon，未对科学效度作超出基线的延伸陈述。
4. **`captureIntegrity.status === 'unverified'` 的触发面**：任何未提供可用 `duration` 的平台都会落此档，并由 `isMainMeasurementSaveable` 允许保存（范围标为 received-audio）。
5. **未来 Rust 协议仅为映射规划，当前并未实现**：第 2–8 节描述的是 `_work/baseline/` 中的 JavaScript 既有行为；`phase0/CORE_STATE_CONTRACT.md` 第 8 节中的 `AudioCoreEngine`、`ChunkReceipt`、`FinalizeDisposition`、`query_spectrum` 等均为规划蓝图，当前阶段不存在任何 Rust 源码。

---

## 10. 交付与边界声明

- **本次修改交付物（严格限制双文件）**：
  - [`rs-core/phase0/CURRENT_SIGNAL_STATE_MACHINE.md`](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/CURRENT_SIGNAL_STATE_MACHINE.md)（本文件）
  - [`rs-core/phase0/NUMERIC_SEMANTICS.md`](file:///C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/NUMERIC_SEMANTICS.md)
- **只读基线与生产代码未被改动**：`_work/baseline/` 保持完全只读；小程序生产源码及工具未被修改；
- **执行约束**：无终端命令、无编译构建、无凭证暴露。
