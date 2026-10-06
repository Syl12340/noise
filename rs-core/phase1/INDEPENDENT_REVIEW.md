# 独立复核：数值/状态语义与验收缺口

协调者勘误（已对照真实源码，以下原审阅文字保留作审计）：ring实际为f64(f32(DC输出))*32768，不再写回f32；达到2205累计静音样本的当前整块会return并终止，只有未达到门限的短静音块进入DSP；空块max-min=-65535，其noAcSignal=false来自len>1守卫，不是溢出；BIN_COUNT=16384，endBin上限16383；29带必须保持基线的dB反演求和。这些更正优先于下文原表述，不可按原错误描述实施。

只读基线（3a0d676）与契约的复核记录。未执行命令/构建/测试，未改动 AGY 源码、系数、P0、生产。故本轮**不声称任何验收已通过**；以下为必须保留的语义与尚缺的验收。

## 必须保留的语义与缺口（5 条）

1. **32bit 写回必须是"先 f32 再放大"，而非 f64 直算。** 基线 `main.js:450` 把 `bufferZ`（f32，来自 `DCBlocker` 的 `Float32Array`）乘 32768 后存入 ring，ring 再被 `Float64Array` 承接给 Hann。即路径含一次 f32 量化，一旦 Rust 用 f64 保存 DC 输出再乘 32768，环形缓冲内容即与 JS 不同，后续 16384 bin 逐位比较必然失败。缺口：契约未明确要求 ring 元素落 f32 后往返，也没有验收项断言"ring 内容逐位等于 f32(f32(DC) * 32768)"；`query_spectrum` 与定时 FFT 是否读取同一量化后 ring 亦未规定。

2. **Q-only 拒整块必须"整块零推进"且不推进 DC/A 内部状态。** `main.js:397-404` 在 `quality.clipped` 时 `return`，发生在 `dcBlocker.process` 之前；`inspectPcm`/`PcmQualityInspector` 是有状态滑动窗（10ms，`windowSamples=441`，`railLimit=max(2,ceil(441*0.001))=2`），该块样本仍进入 inspector，但**不进入** DC/A/能量/ring/hop/秒窗。契约第 24 行说"DSP 整块不推进"未点明 inspector 已被更新。缺口：需断言拒块后 `inspector` 的 `samples/rails/railWindow/position/clippedIntervals` 与 JS 一致，且 `consecutiveSilentSampleCount` 之类计数不被拒块重置。

3. **50ms 静音与 DC 短块：累计判据依据 `buffer.length`，且静音块仍走完整 DSP。** `main.js:405-415` 用 `>= round(44100*0.05)=2205` 判终止，且不 `return`，静音块照常进入 DC/A/能量。同时 `DCBlocker` 首样本做 `previousInput=x` 初始化（`audio-quality.js:113-116`），首块"第一样本置零差分"是唯一性语义；`centeredSignal` 则对**每块**去均值、`inspectPcm` 的 `digitalSilence` 用 `peakAbs<=1 || (len>1 && max-min<=2)`，空块时 `min=32767,max=-32768` 使 `max-min` 溢出为假。缺口：需覆盖空块/单样本块、`len==1` 时 `noAcSignal` 恒假、以及静音终止阈值是"累计"而非"连续块数"（`consecutive` 在非静音块才清零）。

4. **FFT 真功率与投影必须分离，29 带不得复用 dB 域。** `fft.js:143-148` 每 bin 为 `oneSidedFactor*fftPower/(N*windowEnergy)`，k=0 用 1、其余 2，`windowEnergy=sum(Hann^2)` 每次调用重算；而 `canvas-spectrum.js:73-78` 在 dB 域做 `pow(10, dB/10)` 反演求和，再 `10*log10(max(sum,1e-20))`。两者不可合并：把 29 带改成直接累加线性功率会改变 1e-20 与 1e-24 的截断位置，且 `startBin=max(1,ceil(fLow/freqRes))`、`endBin=min(8191,floor(fHigh/freqRes))`、`startBin>endBin → -Infinity` 是精确分组语义。缺口：验收需同时逐位比 16384 bin 线性功率与 29 带（后者允许投影差），并断言 `-Infinity` 带在 JSON 中以显式标签输出、不被 `Math.max` 抬成有限值。

5. **`Math.max` 的 NaN 语义与"无时钟造样本"必须显式。** `calculateDb` 为 `20*log10(Math.max(rms,1e-12)/ref)`、`calculateLeqFromEnergy` 为 `10*log10(Math.max(meanSquare,1e-24))+offset`：JS `Math.max(NaN,x)` 返回 NaN，故 NaN 会穿透而非被钳到 1e-24；`calculateLeqFromEnergy` 另在入口对非有限/负能量或 `count<=0` 直接返回 0（**不是 NaN**）。Rust `f64::max(NaN,x)` 返回 x，语义相反，属必须显式分支的差异，不能靠 1e-10 投影容差吸收。`integrateFilterTail` 的 256 零块是**合成**样本：`paddingSamples` 只进分母外的 `samples`，tail 只加分子、不改 `totalAWeightedSampleCount`，且 `quietBlocks` 按块能量 `<= threshold` 计数、上限 `min(2*sampleRate, ...)`。缺口：需专门测试 NaN/±Inf/0 分类一致、以及 tail 不产生任何新样本计数与 ring/hop 推进。

## 容差定位

契约第 15 行的 1e-10 dB 与 `32*EPS*max(1,|ref|)` 是**工程准入**，只约束单个 libm 投影函数，不是全域 ULP 证明，也不覆盖第 5 项的负数/NULL 分支、第 1 项的 f32 量化与第 28 行的状态/计数精确性。不得据此放宽能量、事件、窗边界的逐位要求。
