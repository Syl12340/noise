# Phase 0 数值语义基准规范 (NUMERIC_SEMANTICS)

**基线提交**：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`  
**只读来源**：`_work/baseline/`（`phase0/BASELINE_SOURCE_MANIFEST.json` 所列清单，无私有或未跟踪文件）  
**责任**：Phase 0 核心数值语义基线文档  
**性质**：**基线既有事实**的详细数值与数学规范记录。所有公式、参数、系数、量化边界均标注 `_work/baseline/` 中的准确源码文件与行号。不假称已有 Rust 实现，不凭空发明未经基线复核的误差容限。

**行号约定**：
- `main.js` 指 `_work/baseline/pages/main/main.js`（1318 行）
- `audio-math.js` 指 `_work/baseline/utils/audio-math.js`（195 行）
- `audio-quality.js` 指 `_work/baseline/utils/audio-quality.js`（128 行）
- `fft.js` 指 `_work/baseline/utils/fft.js`（170 行）
- `canvas-spectrum.js` 指 `_work/baseline/utils/canvas-spectrum.js`（223 行）
- `constants.js` 指 `_work/baseline/utils/constants.js`；以实际文件行号为准，不以目录中其它版本的总行数定位。
- `risk-config.js` 指 `_work/baseline/utils/risk-config.js`（192 行）
- `result.js` 指 `_work/baseline/pages/result/result.js`（356 行）

---

## 1. PCM 归一化与定点/浮点转换边界

### 1.1 输入整数定点量纲
- 底层硬件通过微信小程序 `wx.getRecorderManager()` 回调投递原始音频数据，帧缓冲区封装在 `res.frameBuffer`（ArrayBuffer）；
- 采样格式为 **44.1 kHz, 单声道 (Mono), 16 位有符号整型 (Int16 Little-Endian)**；
- 满幅范围为 $[-32768, 32767]$，对应内部构造 `const buffer = new Int16Array(frameBuffer)`（`main.js` L395）。

### 1.2 归一化因子与参考常数
- **归一化除数**：基线统一采用 **`32768.0`**（$2^{15}$），将整数样本映射至 $[-1.0, 32767/32768]$（`audio-quality.js` L112，`audio-math.js` L139）；
- **声学参考量**：`calculateDb(rms, reference)` 默认基准为 `32768.0`（`audio-math.js` L29）；
- **浮点归一化下的参考值**：当计算已归一化缓冲区的 RMS 分贝时，`dbfsZ = calculateDb(energyZ, 1)`（`main.js` L428），显式传参 `reference = 1`，避免二次缩放；
- **声学偏移相加**：$dbsplZ = dbfsZ + \text{offset}$（`main.js` L429），在对数分贝域直接加上校准偏移量。

### 1.3 环形缓冲逆向缩放与无取整保持
- 在 `handleRecordedFrame` 逐样本循环中，去直流后的浮点样本被写入 FFT 环形缓冲：
  ```javascript
  pcmRingBuffer[pcmWriteIndex] = normalizedZ * 32768; // main.js L450
  ```
- **关键语义**：
  1. `pcmRingBuffer` 为 `Float64Array(32768)`（`main.js` L56）；
  2. 乘以 32768 后**不执行 Math.round() 或 Int16 截断**，注释明确说明“保留小数以免量化/溢出”（L56）；
  3. 此设计为了与 `applyHannWindow` 中的 `(pcm[i] / 32768.0)`（`fft.js` L108）构成精确对称的数值逆变换，确保 FFT 输入完整保留 64 位浮点精度。

---

## 2. DCBlocker 直流阻断器数值动力学

`DCBlocker`（`audio-quality.js` L102–125）实现一阶数字高通滤波器，截止频率为 2 Hz。

### 2.1 极点参数与差分方程
- **数字极点**：
  $$p = \exp\left(-\frac{2\pi \times 2.0}{f_s}\right) = \exp\left(-\frac{4\pi}{44100}\right) \quad (\text{audio-quality.js L104})$$
- **差分方程**（单极点零点高通）：
  $$y[n] = \frac{1 + p}{2} \cdot \big(x[n] - x[n-1]\big) + p \cdot y[n-1] \quad (\text{audio-quality.js L117–118})$$
  其中输入 $x[n] = \text{pcm}[n] / 32768.0$。

### 2.2 首样本播种 (Initial Seeding) 与恒定 DC 响应
- 状态寄存器初始值：`previousInput = 0`, `previousOutput = 0`, `initialized = false`（L105–107）；
- **首样本播种机制**（L113–116）：
  ```javascript
  if (!this.initialized) {
    this.previousInput = x;
    this.initialized = true;
  }
  ```
- **数值响应推论**：
  1. **首样本即为恒定 DC**：由于 $x[0] = \text{previousInput}$，分子差分项 $(x[0] - x[-1]) = (x - x) = 0$。加之初始输出 $y[-1] = 0$，首样本输出 $y[0] = 0$；若后续输入样本幅值保持不变，差分项恒为 0，输出序列 $y[n]$ 恒等于 0（稳态输出全零，不产生瞬态阶跃）；
  2. **非零阶跃（先零后 DC）**：若在已初始化（`previousInput = 0`）后突然跳变至非零 DC 阶跃值 $X$，则在跳变点产生幅度约为 $X \cdot (1+p)/2$ 的初始脉冲，随后按极点 $p^n$ 呈指数衰减（时间常数 $\tau = -1/\ln(p) \approx 3509$ 样本，约 79.6 ms）。

### 2.3 短 DC 块进流与 50ms 拒绝门限
- 常数 DC 块（$\max - \min \le 2$）在 `inspectPcm` 中被标记为 `digitalSilence`（`audio-quality.js` L20）；
- 但在 `handleRecordedFrame` 中，**只有连续静音计数累计满 50 ms（2205 样本）时才会拒绝并终止**（`main.js` L409）；
- **低于 50 ms 门限的前序 DC 小块正常进入 `dcBlocker.process(buffer)`**。从会话首样本即恒值时输出全零；若此前信号不同，则保留相应瞬态。累计计数达 2205 时当前整块拒绝。

---

## 3. A 计权数字滤波管道详细参数

`AWeightingFilter`（`audio-math.js` L66–164）由两级级联双二阶节（IIR Biquads）和一段 129 抽头（128 阶）FIR 滤波器串联构成。

### 3.1 模拟转折极点与双线性变换
IEC 61672-1 模拟 A 计权原型包含四个转折角频率，经双线性变换 $z = \frac{2f_s + s}{2f_s - s}$（其中 $s = -2\pi f$）映射为数字域极点（`audio-math.js` L68–71）：
- $f_{20} = 20.598997 \text{ Hz} \implies p_{20} = \frac{88200 - 2\pi \times 20.598997}{88200 + 2\pi \times 20.598997}$
- $f_{107} = 107.65265 \text{ Hz} \implies p_{107} = \frac{88200 - 2\pi \times 107.65265}{88200 + 2\pi \times 107.65265}$
- $f_{738} = 737.86223 \text{ Hz} \implies p_{738} = \frac{88200 - 2\pi \times 737.86223}{88200 + 2\pi \times 737.86223}$

### 3.2 级联 Biquad 节（直接 II 型转置结构）
两级 Biquad 均采用**直接 II 型转置（Direct Form II Transposed）**结构，状态寄存器初值均为全零。下列第一级公式的 $x[n]$ 指归一化输入先乘 `this.gain` 后的值（L139–140），不能将 gain 移到输出处改变浮点运算路径。

#### Biquad 1 (两个 $20.6\text{ Hz}$ 极点与两个 $z=1$ 零点，L79–82)
- 分子系数：$b_1 = [1.0, -2.0, 1.0]$
- 分母系数：$a_1 = [1.0, -2 \cdot p_{20}, p_{20}^2]$；实际冻结值为 `[1, -1.9941388812663283, 0.9941474694445309]`。
- 状态寄存器：$z_1 = [0.0, 0.0]$
- 递归关系（L143–145）：
  $$\begin{aligned}
  y_1[n] &= b_1[0] \cdot x[n] + z_1[0] \\
  z_1[0] &= b_1[1] \cdot x[n] - a_1[1] \cdot y_1[n] + z_1[1] \\
  z_1[1] &= b_1[2] \cdot x[n] - a_1[2] \cdot y_1[n]
  \end{aligned}$$

#### Biquad 2 (107.7 Hz、737.9 Hz 极点与两个 $z=1$ 零点，L84–86)
- 分子系数：$b_2 = [1.0, -2.0, 1.0]$
- 分母系数：$a_2 = [1.0, -(p_{107} + p_{738}), p_{107} \cdot p_{738}]$；实际冻结值为 `[1, -1.884901217428792, 0.8864214718161674]`。
- 状态寄存器：$z_2 = [0.0, 0.0]$
- 递归关系（L148–150）：
  $$\begin{aligned}
  y_2[n] &= b_2[0] \cdot y_1[n] + z_2[0] \\
  z_2[0] &= b_2[1] \cdot y_1[n] - a_2[1] \cdot y_2[n] + z_2[1] \\
  z_2[1] &= b_2[2] \cdot y_1[n] - a_2[2] \cdot y_2[n]
  \end{aligned}$$

### 3.3 129-tap FIR 高频修正节
为了消除标准模拟 A 计权在 12.2 kHz 极点直接双线性变换至奈奎斯特频率（22.05 kHz）处人为压死为零的畸变，基线设计了线性相位 FIR 滤波器补偿高频（L62–64, L88–121）：
- **设计规模**：基于 2048 点频域反变换设计（$N_{\text{design}} = 2048$），截取中心 $\pm 64$ 点，总抽头数 $M = 2 \times 64 + 1 = 129$（128 阶）；
- **加窗**：采用精确系数 Blackman 窗（L115）：
  $$w_{\text{fir}}(\text{lag}) = 0.42 + 0.5 \cos\left(\frac{\pi \cdot \text{lag}}{64}\right) + 0.08 \cos\left(\frac{2\pi \cdot \text{lag}}{64}\right), \quad \text{lag} \in [-64, 64]$$
- **环形卷积缓冲区**：`history = new Float64Array(129)`，`historyIndex` 从 0 开始递增（L120–121, L152–158）；
- **增益归一化**（L119）：
  $$\text{gain} = \frac{1}{\text{lowMagnitude}(1000) \cdot |\text{firAtOneKhz}|}$$
  强制整个滤波链路在 1000 Hz 处的稳态正弦增益精确对齐为 1.0 (0.00 dB)。

---

## 4. 浮点精度边界与累加器量化

### 4.1 滤波输出的 Float32 强制量化边界
- `DCBlocker.process` 输出明确声明为 `new Float32Array(len)`（`audio-quality.js` L110）；
- `AWeightingFilter.process` 输出明确声明为 `new Float32Array(len)`（`audio-math.js` L135）；
- **量化影响**：虽然在滤波迭代过程中状态变量（`z1`, `z2`, `history`, `fir`, `gain`）全部使用 IEEE-754 64 位双精度浮点（Float64）计算，但**样本每通过一级处理模块（DCBlocker、AWeightingFilter），输出必须经历一次 IEEE-754 32 位单精度浮点（Float32，24 位尾数）量化舍入**。

### 4.2 能量累加器的 64 位累加
在 `main.js` L440–448 的主循环中：
```javascript
const normalizedZ = bufferZ[i];      // Float32 值
const weightedA = bufferA[i];        // Float32 值
const energyA = weightedA * weightedA; // 双精度浮点相乘

totalAWeightedEnergySum += energyA;       // Float64 累加
totalAWeightedSampleCount++;              // 整数累加
intervalZWeightedEnergySum += normalizedZ * normalizedZ; // Float64 累加
intervalZWeightedSampleCount++;           // 整数累加
```
- **关键语义**：平方项的操作数是经过 Float32 量化的样本值，相乘与按原顺序累加使用 JS `number` 的binary64语义。f64不意味着无舍入误差；跨引擎数学函数和完整600秒累加误差仍须独立预算与比较。

---

## 5. 声学物理量与分贝声级推导口径

| 物理量名称 | 公式与计算路径 | 参考常数与底数保护 | 源码位置 |
| :--- | :--- | :--- | :--- |
| **单块 RMS** (`energyZ`) | $\sqrt{\frac{1}{N}\sum_{i=0}^{N-1} x_i^2}$ | 在去直流后的 `bufferZ` 上计算 | `audio-math.js` L11–18 |
| **单块分贝** (`dbfsZ`) | $20 \log_{10}\left(\frac{\max(\text{energyZ}, 10^{-12})}{\text{ref}}\right)$ | $\text{ref} = 1.0$, 下限 $10^{-12}$ ($-240\text{ dBFS}$) | `audio-math.js` L28–31 |
| **单秒区间 Z 声级** (`intervalDbsplZ`) | $10 \log_{10}\left(\max\left(\frac{\sum z_i^2}{N_{\text{sec}}}, 10^{-24}\right)\right) + \text{offset}$ | $N_{\text{sec}}$ 为该秒内实际样本数，下限 $10^{-24}$ | `audio-math.js` L41–48 |
| **累计等效声级** (`leqA`) | $10 \log_{10}\left(\max\left(\frac{\sum E_A}{N_{\text{total}}}, 10^{-24}\right)\right) + \text{offset}$ | $\sum E_A$ 含 tail，分母 $N_{\text{total}}$ 不含 tail | `main.js` L1066 |
| **累计噪声暴露量** (`cne`) | $\text{leqA} + 10 \log_{10}\left(\frac{T}{T_0}\right)$ | $T$ 为预期暴露时长，$T_0 = 28800\text{ s}$ (8 小时) | `audio-math.js` L56–59 |

- **有效性门限**：若 $N_{\text{total}} \le 0$ 或能量无效，`calculateLeqFromEnergy` 显式返回 `0`（`audio-math.js` L43）；
- **会话失效返回值**：若 `!hasUsableMainSamples()`，`calculateCurrentCne` 显式返回 `NaN`（`main.js` L297）。

---

## 6. FFT 谱分析与 1/3 倍频程功率分段

### 6.1 变换参数与 Hann 窗
- 变换尺寸：$N_{\text{fft}} = 32768$（$2^{15}$），采样率 $f_s = 44100\text{ Hz}$；
- 频率分辨率：$\Delta f = \frac{44100}{32768} \approx 1.3458251953125\text{ Hz}$；
- Hann 窗定义（`fft.js` L29–31）：
  $$w(n) = 0.5 \cdot \left[1 - \cos\left(\frac{2\pi n}{32767}\right)\right], \quad n \in [0, 32767]$$

### 6.2 单边功率谱能量归一化
- 窗能量增益和：$E_{\text{window}} = \sum_{n=0}^{N-1} w(n)^2 \approx 0.375 \times 32768 = 12288$（`fft.js` L139–141）；
- **单边系数因子**（`fft.js` L145）：
  $$\text{oneSidedFactor} = \begin{cases} 1, & k = 0 \text{ (直流分量)} \\ 2, & k > 0 \text{ (交流分量)} \end{cases}$$
- **均方功率贡献度与分贝转换**（L146–147）：
  $$P_k = \frac{\text{oneSidedFactor} \cdot \big(\text{Re}[k]^2 + \text{Im}[k]^2\big)}{N_{\text{fft}} \cdot E_{\text{window}}}$$
  $$\text{spectrumDB}[k] = 10 \log_{10}\big(\max(P_k, 10^{-24})\big) + \text{offset}$$
- **Nyquist 频点剔除**：频带总数 `halfN` 严格取 $N/2 = 16384$（$k = 0 \dots 16383$）。位于 $k=16384$（22050 Hz）的奈奎斯特频点**明确省略**，未计入 `spectrumDB`。

### 6.3 1/3 倍频程 29 频带划分与能量积分
- 覆盖 $25\text{ Hz} \sim 16000\text{ Hz}$ 共 29 个标准中心频率（`canvas-spectrum.js` L12–16）；
- 频带边界因子：$\text{BAND\_FACTOR} = 2^{1/6} \approx 1.122462048309373$；
- 频带 bin 映射（L43–44）：
  $$\text{startBin} = \max\left(1, \left\lceil \frac{f_{\text{low}}}{\Delta f} \right\rceil\right), \quad \text{endBin} = \min\left(16383, \left\lfloor \frac{f_{\text{high}}}{\Delta f} \right\rfloor\right)$$
  **直流 bin 0 明确从 1/3 倍频程中排除**（$\text{startBin} \ge 1$）；
- **能量域求和与无借用策略**（L65–78）：
  $$P_{\text{band}} = \sum_{k=\text{startBin}}^{\text{endBin}} 10^{\text{spectrumDB}[k] / 10}$$
  若 $\text{startBin} > \text{endBin}$，则**直接置为 $-\infty$**，坚决不借用相邻 bin 能量；否则转换为：
  $$\text{bandLevels}[\text{band}] = 10 \log_{10}\big(\max(P_{\text{band}}, 10^{-20})\big)$$

### 6.4 定时 Hop 推进与按需切换查询
- **定时推进**：`fftHopSize = 8192` 样本（`constants.js` L77）。`fftSampleCount` 严格由处理的音频样本计数驱动，当 `fftSampleCount >= 8192` 时减去 8192。**即使在非频谱模式下，hop 相位也持续按样本推进**，切入时无相位撕裂；
- **视图切换主动查询**：`switchView`（`main.js` L831, L841）在样本缓冲满 32768 点时立即主动触发一次 `updateSpectrumFromRingBuffer()`，依用户交互时刻发生，**不修改任何 hop 计数器与相位**。

---

## 7. 尾滤波 (integrateFilterTail) 数值衰减与截短

尾滤波（`audio-math.js` L168–185）用于收集停止瞬间滤波器状态寄存器（$z_1, z_2, \text{history}$）中未释放的冲激响应能量。

### 7.1 分块冲刷与截短步长
- **输入序列**：每次向 `AWeightingFilter.process(zeros, false)` 喂入 256 个零样本（`Float32Array(256)`）；
- **总时限约束**：最长冲刷 2 秒（$2 \times 44100 = 88200$ 样本）；
- **末块非整除截短**：
  $$\frac{88200}{256} = 344.53125 \implies 344 \times 256 = 88064$$
  因此若达到 2 秒上限，第 345 块会被 `Math.min(256, 88200 - 88064) = 136` 样本**精确截短**（L173）。

### 7.2 动态提前收敛门限
- 能量阈值：
  $$\text{threshold} = \max(\text{referenceEnergy}, 10^{-24}) \times 10^{-12} \quad (\text{audio-math.js L171})$$
- **静音退出**：当连续 8 块（$8 \times 256 = 2048$ 样本，约 46.4 ms）的块能量均小于等于 `threshold` 时，循环立即终止并返回 `converged: true`；
- **零状态与极弱输入必须区分**：完全零初始滤波状态可在 8 个零能量块后退出；极弱但非零输入仍可能留下状态，退出步数须以实际块能量比较为准。全流程静音终止则跳过 tail，不计算这 8 块。

### 7.3 不扩展分母的能量归集
- 冲刷得到的能量累加至分子：`totalAWeightedEnergySum += filterTail.energy`（`main.js` L1213）；
- **分母严格保持不变**：`totalAWeightedSampleCount` 仅记录硬件真实采集的有效样本数，尾部零样本绝不计入有效样本总数（L166 注释）。

---

## 8. 风险分级决策边界与数值判定

### 8.1 边界判定逻辑 (`main.js` L735–753)
基线唯一的数值分级器依据传入的 `cneValue` 执行判断：

```javascript
for (let i = 0; i < levels.length; i++) {
  const level = levels[i];
  if (level.key === 'SAFE' ? cneValue <= level.upper : cneValue < level.upper) {
    return { key: level.key, text: level.text, bgClass: level.bgClass };
  }
}
const lastLevel = levels[levels.length - 1];
return { key: lastLevel.key, text: lastLevel.text, bgClass: lastLevel.bgClass };
```

- **SAFE 边界（`cneValue <= 80.0`）**：只有 SAFE 分段使用 `<=`，即 $80.000\text{ dB}$ 严格判定为 SAFE；
- **其余分段（`< level.upper`）**：
  - ATTENTION: $(80.0, 85.0)$
  - MEDIUM: $[85.0, 94.0)$
  - HIGH: $[94.0, 105.0)$
- **EXTREME 与 Infinity 的循环命中**：
  `risk-config.js` L180 将 EXTREME 的 `upper` 设为 `Infinity`。默认配置下有限 $cne \ge 105.0$ 在循环内命中末段。`NaN`、`Infinity`、`-Infinity` 在 L736–738 的入口守卫直接返回 `INVALID`，不会进入该循环或末段兜底。

### 8.2 展示层文案与数值判定的边界歧义
在历史记录页面 `result.js:formatRiskRange`（L60–79）中：
- SAFE（`upper: 80`）被格式化为字符串 **`<80 dB(A)`**（L71）；
- ATTENTION（`lower: 80, upper: 85`）被格式化为字符串 **`80-85 dB(A)`**（L67）。
- **事实记录**：虽然底层分类数值严格以 $cne \le 80$ 为 SAFE，但前端展示层采用 `<80` 与 `80-85`，在 80 dB(A) 节点上存在数值属于 SAFE 但文本形似 ATTENTION 的展示歧义。

### 8.3 报警触发门限
- 完整条件：`allowAlarm && calibrationStatus.riskEligible && Number.isFinite(cne) && cne >= noiseAlarmLevel && !isAlarming && !hasAlerted`（`main.js` L362）；
- 默认报警阈值：`noiseAlarmLevel = 100.0`（`constants.js` L28）；
- 触发动作：`isAlarming = true; hasAlerted = true; wx.showModal(...)`（弹窗阻断）与 `page.doVibrate(5, 500)`（长震动）。

---

## 9. 校准状态转换与可保存性数值判定

### 9.1 未校准状态的自动降级转换
基线 `hasUsableMainSamples`（`main.js` L278）虽然要求 `calibrationStatus.valid`，但在会话启动时 `initMonitor`（L961–967）执行如下转换：

```javascript
if (!calibrationStatus.valid) {
  calibrationStatus = {
    ...calibrationStatus,
    valid: true,
    grade: 'estimated',
    riskEligible: false,
    calibrationVerified: false,
    calibrationNote: calibrationStatus.reason,
    reason: '',
    label: calibrationStatus.meta && calibrationStatus.meta.source ? '历史参数估算' : '未校准估算'
  };
}
```

### 9.2 数值推论
1. **未校准可正常保存**：无校准数据的普通用户在启动后，`calibrationStatus.valid` 被自动置为 `true`，从而能够顺利通过 `hasUsableMainSamples()` 与 `isMainMeasurementSaveable()`（L291–293），停止后 `canSave = true`，**允许保存估算记录**；
2. **风险资格禁用**：`riskEligible: false` 会导致 `archive()` 中 `threat = '估算结果，不作风险分级'`，`riskEstimate = null`，并且禁止触发超标报警（L362）；
3. **不可伪称实验室必需**：基线数值模型允许未校准估算，不能将有效校准武断表述为录音和保存的前置阻断条件。

---

## 10. Phase 0 科学效度与迁移边界

1. **数值等价性 $\ne$ 声学认证**：本规范所列全部数值公式、定点转换及滤波常数均为基线既有实现的记录，用于保证后续 Rust 核心与当前基线完全一致。数值一致不代表该算法已取得医疗器械级声学效度认证。
2. **暂不设定硬性迁移容差 epsilon**：基线除 46 样本时长容差（`CAPTURE_DURATION_TOLERANCE_SAMPLES = 46`）和 0.01 dB 滤波测试公差外，未冻结全系统单双精度迁移误差数值。在 Phase 0 严禁主观编造未经父审确认的数值容差。
3. **冻结顺序**：独立迁移误差预算必须在首次 Rust 结果比较前审定；既有单项测试公差不是全系统迁移许可，不能观察 Rust 偏差后反向放宽门槛。

### 精确频带中心与窗能量补充

44.1 kHz 系数的权威字节来自 fixtures/filter_coefficients.bin，142 个 f64LE，SHA-256 为 `0a134c19fd02b45da4b979d2f92720644bc8bc159a04242ec58b1c5dade0c7ae`，增益为 `1.000600574276718`。不得根据本文展示公式的近似值重新拟合生产系数。

`THIRD_OCTAVE_CENTERS` 的 29 个名义中心只用于显示。实际 bin 边界用 `1000 * 2^((index - 16)/3)` 的精确中心（canvas-spectrum.js L25–27, L37），不能直接使用名义 25/31.5/40 等数值生成边界。32768 点对称 Hann 的理论平方和为 `3*(32768-1)/8 = 12287.625`；源码逐点以 f64 求和，冻结时保留其实际求和结果，不能以近似 12288 替代。
