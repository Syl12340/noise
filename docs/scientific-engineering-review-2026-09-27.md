# 科学性与工程设计验证报告（只读审查，2026-09-27）

审查基线：`7546804648ef993d6242377f01b3ccfc66e15e7e`。本轮不修改程序、测试或既有结果文件，不提交或推送；仅新增本报告。工作区原有个人页面、本地配置和辅助文件保留。

结论：现有声级能量积分与 A 计权已有一定数值支持，但不能据此认定整条测量链稳定可靠。本轮复现了 YIN 对非周期瞬态输出高可信伪基频、停止声级测量丢失尾帧、采样严重不足仍判有效三类高优先级问题。共振峰仍未达到原有定量门限；HNR 在低信噪比下的误差也超出现有测试覆盖。当前更适合受控条件下的研究探索，不能据本次证据宣布临床或职业卫生定量有效性。

**方法与证据边界**

- 源码审查、内存合成信号、现有模拟录音器的事件序列实验、固定版本 NoiseCapture 公开夹具对照。
- 运行环境：Windows，Node.js v24.21.0；Python 用于读取公开参考数据并通过 stdin 交给 Node，参考数据未写入工作区。
- 既有行为回归在进程内拦截报告写入后重跑，23/23 通过。包检查通过：48 个 JS、14 个页面、41 个事件绑定；Worker 生成物与 16 个源模块一致。
- 既有算法、行为回归、冻结共振峰结果中的 sourceSha256 全部与本轮被审查文件匹配。78/80 以及共振峰表格引用这些既有结果；本轮未将旧结果覆盖为新的时间戳。
- 本机未安装 praat-parselmouth；Praat 对照属于官方方法与参数语义核查，未执行 Praat 二进制对跑。未运行完整 NoiseCapture Android 应用，只比较其公开测试夹具与参考数值。
- 未执行微信开发者工具编译、Android/iOS 真机连续性、参考声级计、人工标注临床语料验证。模拟录音器证明代码分支行为，不证明某款设备已经发生丢帧。
- 审查代理输出经过独立复核；没有把未经证实的建议直接纳入缺陷结论。

**一、已复现的关键问题与建议**

1. **P1：YIN 会把非周期瞬态或静音比较区间识别成高可信基频。**

位置：[yin-pitch.js:21](../utils/phonetic/yin-pitch.js#L21)、[yin-pitch.js:34](../utils/phonetic/yin-pitch.js#L34)、[yin-pitch.js:72](../utils/phonetic/yin-pitch.js#L72)、[yin-pitch.js:82](../utils/phonetic/yin-pitch.js#L82)。

整帧能量通过检查后，差分函数按延迟改变比较区间；代码没有验证该延迟下两个区间的有效能量。瞬态进入比较区间时会产生非平滑突变，平坦区边缘也被当成局部谷，随后对不适合抛物线插值的点作插值并将负值截为 0。

已定位一个具体根因：1024 样本帧中仅第 840 个样本为 0.5，tau=144/145 的差分均为 0、CMNDF 均为 1；tau=146 的差分为 0.25、CMNDF 突变到 146。tau=145 候选的插值非周期性得到 -17.125，再被截成 0；原始差分插值周期为 144.5 样本，于是最终返回 83.04498 Hz。原本 CMNDF=1 的无周期证据被插值转换为最高可信度，这比一般的倍频误差更应优先处理。

复现 A：12 kHz、1 秒全零信号，仅第 6000 个样本为 0.5，帧长 1024、帧移 120、F0 范围 40–1200 Hz。单脉冲没有周期基频，程序却输出 5 个有声候选，其中 83.045、406.780、44.527 Hz 的 aperiodicity 均为 0。30 ms 随机噪声段也产生 83.045、380.952、44.199 Hz 三个 aperiodicity=0 的候选。

复现 B：44.1 kHz 完整 analyzePcm 流程，一秒信号仅 0.400–0.430 秒含 200 Hz、幅值 10000 PCM 的纯音。输出含 155.844 和 59.406 Hz 伪候选；对全段已接受 F0 求均值为 176.855 Hz，较 200 Hz 低约 11.57%。部分候选中心在真实发声区间之外，宽窗的时间扩散与错误周期判定同时存在。

影响：爆破音、录音点击、发声起止、静音拼接附近可能污染 F0 统计；共振峰门控也使用该轨迹，但本实验没有证明伪 F0 必然生成错误共振峰。

建议：检查延迟两端的能量和有效重叠，拒绝静音对静音造成的伪低差分；验证差分窗口随延迟变化的数学性质与插值置信值；增加单脉冲、短噪声、渐入渐出元音、短停顿的反例。连续言语应验证局部有声判定与时域支持，不能仅把全段白噪声拒绝测试当成非周期鲁棒性证明。

2. **P1：停止声级测量先冻结摘要，再停止采集，最后一块音频被排除。**

位置：[main.js:1037](../pages/main/main.js#L1037)、[main.js:1023](../pages/main/main.js#L1023)、[main.js:338](../pages/main/main.js#L338)。

stopNoiseMonitoring 先 archive，stopMainMonitoring 随后立即关闭活动标志和帧监听。即便 recorder.stop 期间交付 isLastFrame=true 的尾块，handleRecordedFrame 也会忽略它。语音页已有等待 onStop 再清理的处理，声级页没有对应闭环。

复现：先输入 10 个 8192 样本、1 kHz、幅值 327.68 PCM 的块；尾部再有 4096 样本、幅值增加 10 倍的同频音。对照组先交付尾块再停止；问题组在 stop 调用中交付尾块。

| 结果 | 丢失尾块 | 收齐尾块 |
| --- | ---: | ---: |
| 纳入样本数 | 81920 | 86016 |
| LAeq，offset=100 dB | 56.9873 dB | 64.4939 dB |

该受控例中低估 7.5066 dB；丢失尾块的摘要仍为 dataQuality=valid。此数值是该合成序列的结果，不代表所有录音的固定误差。

建议：区分“正在停止”和“已经完成”，保持原会话尾帧接收，收到原生停止确认后再冻结摘要；对尾帧、停止超时和错误分别验收。验收应检查样本数与能量均守恒，而不只是停止后的摘要可以保存。

3. **P1：回调新鲜度被当成连续采样证明；语音录音缺少同等完整性判定。**

位置：[main.js:229](../pages/main/main.js#L229)、[main.js:239](../pages/main/main.js#L239)、[main.js:365](../pages/main/main.js#L365)、[main.js:957](../pages/main/main.js#L957)；[phonetic.js:176](../pages/phonetic/phonetic.js#L176)、[phonetic.js:224](../pages/phonetic/phonetic.js#L224)、[phonetic.js:245](../pages/phonetic/phonetic.js#L245)。

声级页只要求相邻有效回调不超过 2 秒，没有用样本时长与会话时长核验覆盖。语音页直接拼接收到的 PCM，完成时只检查总样本数非零，不验证停流时长或原生录音时长。丢失的区间可能被无缝拼接。

复现 A：模拟 5 次回调，每次间隔 1 秒、每块 8192 样本。归档记录 elapsedSeconds=5.05、receivedSeconds=0.928798，覆盖约 18.39%，仍为 valid；在参考校准状态与该低电平信号下仍显示“安全”。

复现 B：语音页开始后只收到 8192 样本，再等待 3 秒，页面仍处于 recording、recordTime=3，recordingInterrupted=false，实际只收到约 0.186 秒 PCM。

影响：收到的数据子集无法证明代表整个观察区间；遗漏高能量片段可严重低估 LAeq。语音丢帧可压缩时间轴并引入拼接瞬态，从而影响时长、F0 和音质估计。

建议：联合核验实际样本时长、原生启动/停止时间、原生 duration、块到达间隔和合理缓冲余量；有文件回读能力时与最终 PCM 核对。不要机械要求每块回调时间精确等于采样时长，因为合法批量交付也会产生时间抖动。确认缺口后应明确拒绝全段统计或保留不连续时间轴。

4. **P2：HNR 在低信噪比时存在明显向上偏差，当前没有相应可靠性状态。**

位置：[harmonicity.js:42](../utils/phonetic/harmonicity.js#L42)、[harmonicity.js:57](../utils/phonetic/harmonicity.js#L57)、[harmonicity.js:67](../utils/phonetic/harmonicity.js#L67)；[algorithm-evaluation.cjs:165](../tests/algorithm-evaluation.cjs#L165)。

算法从允许延迟内挑选最大的正相关峰，再换算 HNR。低周期能量条件下，对多个噪声相关峰取最大值会引入选择偏差。现有已知 SNR 测试仅覆盖 0、10、20 dB，未覆盖本轮暴露的问题区间。

本轮输入为 12 kHz、1 秒、200 Hz 正弦加高斯白噪声；信号幅值 0.1，噪声标准差为 0.1/sqrt(2)×10^(-SNR/20)，四个固定随机种子，直接调用 harmonicity 模块以隔离滤波带宽影响。

| 设定 SNR | 四次平均 HNR | 平均偏差 |
| --- | ---: | ---: |
| -20 dB | -9.5498 dB | +10.4502 dB |
| -10 dB | -7.3842 dB | +2.6158 dB |
| -5 dB | -4.0147 dB | +0.9853 dB |
| 0 dB | 0.3787 dB | +0.3787 dB |
| 10 dB | 10.1035 dB | +0.1035 dB |
| 20 dB | 20.0778 dB | +0.0778 dB |

这是低 SNR 下的估计器偏差，不表示 HNR 的对数换算公式错误。也没有证明 Praat 在所有这些输入下都能精确恢复真值；未执行 Praat 对跑。

建议：明确经过验证的 HNR 工作范围；补充负 SNR、多基频、有色噪声、幅度调制和非平稳输入；保留低可靠性状态及缺失覆盖，不能仅靠“找到正相关峰”定义有效。比较 Praat 时固定带宽、窗支持、pitch floor、静音规则和平均方式。Praat 官方也明确分析窗口长度与动态变化/灵敏度之间有取舍。[Harmonicity 算法设置](https://www.fon.hum.uva.nl/praat/manual/Sound__To_Harmonicity__ac____.html)

5. **P2：界面的“共振峰上限”不改变模型拟合频带，无法承担 Praat 同名参数的调优作用。**

位置：[analysis.js:34](../utils/phonetic/analysis.js#L34)、[analysis.js:43](../utils/phonetic/analysis.js#L43)、[formant-extract.js:54](../utils/phonetic/formant-extract.js#L54)、[phonetic.wxml:7](../pages/phonetic/phonetic.wxml#L7)。

当前分析采样率固定 12 kHz、低通截止固定 5500 Hz；maxFormant 只在 LPC 求根后筛掉超界候选。改变该参数不会改变送进 Burg 的信号、帧长或阶数。用可观测 Burg 调用的内存夹具检查 4000/4500/5000 Hz 三种设置，输入均为 300 样本，阶数均为 12/10/14；500/1500/2500 Hz 三个低阶结果完全不变。这是结构验证，不是声学准确率试验。

Praat 的 Burg 实现会先重采样到两倍 ceiling，再拟合；用户降低 ceiling 时会改变模型所拟合的谱。其默认高斯窗的实际支持长度为所填有效窗长的两倍。因此两个软件填写相同“25 ms、5000 Hz”不意味着同一分析配置。[Praat Burg 官方说明](https://www.fon.hum.uva.nl/praat/manual/Sound__To_Formant__burg____.html)

建议：若保留现有实现，将控件明确标为“候选输出频率上限”；若需要真正的拟合频带调优，应联合设计重采样率、抗混叠滤波、预加重频率和阶数，再进行独立验证。不能只增加儿童的输出上限而继续使用 12 kHz 分析率。

**二、仍然成立的科学性限制**

共振峰：既有冻结结果每个槽位 750 个真值帧，F1/F2/F3 覆盖率分别为 47.73%/44.80%/40.80%；F1、F2 已输出帧中分别有 16.76%、8.93% 的误差超过 10%，F1 最大误差 17.5%。程序已经标为实验候选，这是正确的披露，但本轮没有新证据消除这些误差。三个邻近 LPC 阶数可能共同产生偏差，模型一致不等于真值一致。[本地冻结结果](formant-validation-results.json)

验证独立性：扩展集已参与调参；“冻结验证”也已用于发现和修正编号问题，不能再作为完全未见的最终外部验证。750 个高度重叠帧来自 25 个合成信号，不是 750 个独立说话人或独立试验；缺失值也与基频、带宽有关，不能只比较成功输出帧的均值。建议保留它们作为回归集，另冻结说话人/录音级独立数据，并按说话人、F0、元音、SNR、声道条件分层报告误差、覆盖率和错误接受率。[测试定义](../tests/formant-validation.cjs#L32)

校准与采集链：绑定对象主要是安装实例、设备型号、系统版本和配置的 audioSource，没有实际活动麦克风/路由或增益响应证据。[recorder-session.js:19](../utils/recorder-session.js#L19)、[data-model.js:58](../utils/data-model.js#L58)。如果平台在连接外部麦克风或音频路由变化后仍报告相同设备配置，旧 offset 无法被这些字段识别为失效。这是条件性的工程缺口，尚未真机证实某机型会如何路由。建议在平台能力允许时记录/监视输入路由；不可识别时要求同采集链复核，避免把 reference 等级理解为全频段和全设备状态认证。

NoiseCapture 本身也采用单一增益修正，不能用“单点校准”这一点直接断言算法错误。它的校准规程要求已知参考 Leq、匹配频带和时间，并提供应用增益后的复测步骤。本程序可借鉴参考来源、实际参考读数、频带、采集时间和复测残差的记录，而不是仅增加软件置信标签。[NoiseCapture 校准规程](https://noise-planet.org/noisecapture_calibration.html)

**三、与 NoiseCapture 的外部数值对照**

固定参考版本：`509fb083d8a26a6a38d117c22667267c0ccf9cc3`。

参考夹具：`sosfilter/src/test/resources/org/orbisgis/sos/speak_44100Hz_16bitsPCM_10s.raw`，441000 个 little-endian Int16 样本，SHA256 为 `24b2767e285a671f75e34bcb4e4a475bd4ed7ed81356f1f53ef9180e9db00bbf`。以原始字节通过 stdin 输入本程序，不经过临时音频文件或格式转码。

| 比较项 | 结果 |
| --- | ---: |
| NoiseCapture 参考测试中的 expectedBA | -33.761 dB |
| 本程序 AWeightingFilter，归一化数字输出 | -33.743561 dBFS |
| 本程序 DCBlocker + AWeightingFilter | -33.743668 dBFS |
| 完整滤波链相对参考差值 | +0.017332 dB |

这是良好的单夹具数值一致性证据，但仍超出该 NoiseCapture 单元测试自身的 0.01 dB 容差；不能报告为通过了 NoiseCapture 原测试。两者数字幅度归一化惯例及滤波器设计还需要逐项对齐，也不能将这一结果扩展成手机声压级精度或标准认证。

来源：[NoiseCapture 参考测试](https://github.com/Universite-Gustave-Eiffel/NoiseCapture/blob/509fb083d8a26a6a38d117c22667267c0ccf9cc3/sosfilter/src/test/java/org/orbisgis/sos/SpectrumChannelTest.java#L42)、[参考夹具](https://github.com/Universite-Gustave-Eiffel/NoiseCapture/blob/509fb083d8a26a6a38d117c22667267c0ccf9cc3/sosfilter/src/test/resources/org/orbisgis/sos/speak_44100Hz_16bitsPCM_10s.raw)。

工程上，NoiseCapture 的该版本直接使用 VOICE_RECOGNITION，查询活动麦克风信息并使用音频处理线程。本程序在 Android 选择 voice_recognition 与其方向一致，但微信封装后的实际处理、权限和路由不能由同名参数证明等价。[AudioProcess 源码](https://github.com/Universite-Gustave-Eiffel/NoiseCapture/blob/509fb083d8a26a6a38d117c22667267c0ccf9cc3/app/src/main/java/org/noise_planet/noisecapture/AudioProcess.java)

**四、没有认定为根本错误的差异**

- 对称 Hann 窗使用 N-1 是正常定义；不能仅凭不是 periodic Hann 就断言 1 kHz 校准纯度判断错误。
- Z 计权频带之和与 A 计权总级不同是预期现象；同一线性采集链的校准 offset 可以用于两者。界面应明确权重，但这种差异本身不是积分错误。
- 预计暴露时长改变归一至 8 小时的结果符合该模型；现有界面已经标明“预计”。应验证代表性假设，不能把不同预计时长产生不同值列为算术 bug。
- 98% 数字满幅的拒绝规则是保守保护，可能拒绝尚未硬削顶的信号；这属于有效范围和提示语义的取舍，不足以证明声级算法错误。
- Hamming 与 Praat Gaussian 的差异不自动意味着实现错误；可比性需要对齐窗口支持及带宽。
- 当前 23/23 回归通过只说明这些既定用例通过。本轮新增反例说明此前“通过”不能推导为没有关键缺陷。

**五、建议的下一轮改进与验收顺序**

| 优先顺序 | 改进目标 | 建议验收证据 |
| --- | --- | --- |
| 1 | 修复瞬态伪 F0；尾帧闭环；采样完整性 | 单脉冲/短噪声不输出高可信 F0；停止前后样本数和能量守恒；严重欠采样不能判为有效全段 |
| 2 | 明确 HNR 工作范围、共振峰 ceiling 语义 | 负 SNR 与动态信号误差曲线；相同 PCM、匹配频带/窗支持下的 Praat 对跑 |
| 3 | 重新建立独立语音验证集 | 按说话人隔离；保留真实语音、短音节、高 F0、非周期发声；同时报告错误接受与缺失 |
| 4 | 校准与设备链验证 | 已知参考级、多个声级/频率、重复复测；记录采集路由；Android/iOS 真机丢帧与中断测试 |
| 5 | 人机交互与可追溯性 | 明确正在停止/数据不完整/低可靠性；全段与选区指标一致标识；可导出参数、版本、覆盖和拒绝原因 |

验收阈值需要对应实际用途事先确定；本报告没有把原有 10%/80% 工程门限称为临床标准，也不建议为了通过现有样本而降低门限。修正前三项后仍需重新评估定量指标，不能仅凭结构测试全部通过就批准定量用途。

**六、追加审查：校准与录音生命周期**

本节对应后续“还有吗再看看”。没有修改程序代码。使用当前代码与 tests/runtime.cjs 的内存模拟，核实异步回调、设置保存、异常输入和定时器路径；以下数值不是手机实测声压误差。前四项的代码路径已复现，第五项依赖尚未验证的原生回调行为，单独列为待验证风险。

6. **P1：过期的高级校准确认回调可以覆盖当前校准。**

位置：[calibrate.js:375](../pages/advanced-calibrate/calibrate/calibrate.js#L375)、[calibrate.js:389](../pages/advanced-calibrate/calibrate/calibrate.js#L389)。

saveOffset 在打开确认框时捕获 offsetVal，但 success 只检查 res.confirm，没有核对页面存活、校准批次或结果是否已失效；写入时又读取当前设备和采集配置。complete 内的页面存活检查不能保护已经执行的保存。

复现：启动高级校准，推进 3 秒准备时间，再送入 27 个连续的 8192 样本 PCM 块（44.1 kHz，1 kHz 正弦，幅值 3276.8）；正常计算出 newOffset=103.01 并弹出应用确认框。随后调用 onHide，将当前 offset 更新为 115，再投递旧确认框的 success({confirm:true})。最终保存值回退为 103.01，等级为 reference。相同 PCM 的声级会因这次覆盖变化 -11.99 dB。

这是模拟迟到回调的结果，未断言所有手机都必然产生这一时序；缺少失效校验是确定的。建议把结果与原校准批次、设备、采集配置绑定，在离页、重新校准和失败时作废；确认时验证结果仍可应用，不能把旧结果重新认证为当前 reference。

7. **P2：恢复默认后显示 100，但保存仍保留旧的 115 校准。**

位置：[settings.js:178](../pages/settings/settings.js#L178)、[settings.js:205](../pages/settings/settings.js#L205)。

reset 将界面 offset 设为默认值，却同时把 _offsetEdited 设为 false；save 仅在该标记为 true 时写入 offset，随后仍提示设置已保存。复现：预存 reference offset=115，进入设置后执行 reset、save；界面显示 100，底层仍为 115，reference 等级保留。后续声级相对用户按界面理解的配置高 15 dB。这里的 15 dB 是配置预期差异，不能据此判断原来的物理校准值是否正确。

建议明确选择一种行为：保留校准时继续显示实际校准值，并说明恢复默认不影响校准；或真正重置校准，并同步失效其原参考等级。界面、存储和状态必须一致。

8. **P2：告警振动未与声学采集隔离，且停止测量后振动定时器仍运行。**

位置：[main.js:314](../pages/main/main.js#L314)、[main.js:325](../pages/main/main.js#L325)、[main.js:1093](../pages/main/main.js#L1093)。

阈值告警在测量过程中触发 doVibrate(5,500)，没有为这些时间段标注采集干扰。doVibrate 的定时器只保存在局部变量，stopMainMonitoring 无法取消。复现：开始五次振动后立即停止监测，再推进 2500 ms，仍累计调用五次 vibrateLong，其中四次发生在停止之后。

停止后的振动是已复现的生命周期问题。振动通过机身/支撑面/空气耦合到麦克风，可能影响当前测量或紧接着启动的语音录制；本轮没有真机测得其 dB、F0 或 HNR 偏差，不能把理论耦合直接当作确定测量误差。

建议定量采集期间采用不会干扰输入的提示，或显式标记并妥善处理受影响区间；把振动定时器纳入页面和会话生命周期，在停止、离页、重启时取消。

9. **P2：高级校准对畸形 PCM 抛错，但没有使本次校准失效。**

位置：[calibrate.js:207](../pages/advanced-calibrate/calibrate/calibrate.js#L207)、[calibrate.js:213](../pages/advanced-calibrate/calibrate/calibrate.js#L213)。

帧监听直接访问 res.frameBuffer 并构造 Int16Array，未验证回调结构、字节对齐；遇到三字节 ArrayBuffer 会抛出 RangeError，抛错前后均没有主动撤销本次校准。复现：校准开始后注入三字节帧，夹具捕获异常以模拟宿主继续分发回调，再送入与第 6 项相同的正常音调块，仍得到 103.01 并提供应用确认。

该结论限定于异常输入；未证明微信正常 PCM 回调会产生奇数字节，也未假定所有宿主会在未捕获异常后继续运行。工程问题是异常帧既可能打断页面，又可能在继续运行时留下可被认证的部分会话。建议统一校验回调结构和 PCM 对齐，遇到无效帧明确终止本次校准并清除候选结果，而非仅抛异常或静默跳过。

10. **待真机核查：重复停止请求产生的迟到 onStop 可能覆盖新录音状态。**

位置：[recorder-session.js:67](../utils/recorder-session.js#L67)、[recorder-session.js:94](../utils/recorder-session.js#L94)、[recorder-session.js:223](../utils/recorder-session.js#L223)。

停止超时会再次调用 recorder.stop；全局 onStop 无条件写 nativeIdle=true 和 state=idle，未区分它属于哪次停止。内存注入以下时序可复现：停止 A、2 秒超时再次停止、收到第一次 onStop、启动 B 并收到帧、迟到的第二次 onStop。此后 B 的帧不再交给消费者，而 safeStop 又因 nativeIdle=true 不再调用底层 stop。

尚未证实微信 RecorderManager 会在该调用序列下发出两个可跨越新会话的 onStop，因此不能列为真机已确认故障。建议在 Android/iOS 真机记录超时、重复停止、开始和回调顺序，评估恢复期隔离与排空协议。原生事件本身没有会话 ID 时，简单增加一个 JavaScript 计数器并不能自动识别迟到事件。

追加审查的处理顺序建议：先修复过期校准提交与设置显示不一致，再收紧异常帧和振动生命周期；迟到 onStop 风险先以真机证据确定平台行为。上述工程缺陷能影响数值来源或数据有效性，但不能替代前文对 YIN、HNR、共振峰和采样覆盖的算法验证。

**最小只读复现实验**

以下代码可通过 Node 的内存执行方式运行，不写工作区文件：

```javascript
// 单脉冲不能证明存在周期基频，但当前实现输出多个 f0 > 0 候选。
const { yinPitchTrack } = require('./utils/phonetic/yin-pitch');
const x = new Float32Array(12000);
x[6000] = 0.5;
console.log(yinPitchTrack(x, 12000, {
  frameSize: 1024, hopSize: 120, fmin: 40, fmax: 1200
}).filter(row => row.f0 > 0));
```

```javascript
// 主页面欠采样仍有效；runtime 的 storage/timer/recorder 均为内存模拟。
const { runtime } = require('./tests/runtime.cjs');
const e = runtime();
const session = e.load('utils/recorder-session');
e.load('utils/data-model').setOffset(100, {
  source: 'advanced-1khz-calibration',
  captureProfile: session.getMeasurementCaptureProfile(),
  deviceId: session.getCurrentDeviceCalibrationId()
});
e.storage.set('alarm', false);
e.load('pages/main/main');
e.page.onShow();
e.clock.tick(50);
for (let k = 0; k < 5; k++) {
  e.clock.tick(1000);
  const pcm = Int16Array.from({ length: 8192 },
    (_, i) => Math.round(327.68 * Math.sin(2 * Math.PI * 1000 * i / 44100)));
  e.emit('FrameRecorded', { frameBuffer: pcm.buffer });
}
const result = e.page.archive();
console.log(result.coverage, result.dataQuality, result.threat);
e.page.stopMainMonitoring();
```

**七、5+4 项修复实施与复核**

本轮已经处理前文第 1–9 项；第 10 项仍属于依赖原生 RecorderManager 回调次序的真机核查项，不在本轮“5+4”范围内。

| 项目 | 实施结果 | 回归证据 |
| --- | --- | --- |
| YIN 瞬态伪 F0 | 延迟候选必须覆盖帧内实际能量；阈值未命中的后备谷限定为 CMNDF 不高于 0.3 | 单脉冲 92 帧中有效 F0 为 0 |
| 停止尾帧丢失 | 用户停止进入 stopping，保留帧监听，收到原生 onStop 后才归档和释放 | 注入 4096 样本尾块，归档样本数完整增加 4096 |
| 采样完整性 | 主测量和语音录音比较收到样本时长与原生录音墙钟时长；最低覆盖率 90%，另留 250 ms 启停余量 | 5.05 秒内只收 0.929 秒主测量被判无效；语音停顿缺帧不进入分析 |
| 低 SNR HNR | 生产流水线要求 YIN 有声证据，在 F0 附近搜索自相关峰，并拒绝相关度低于 0.2 的数值 | -20、-10 dB 合成输入返回缺失，10 dB 输入保留数值 |
| 共振峰 ceiling | ceiling 同时改变抗混叠带宽、LPC 采样率和按带宽缩放的有效阶数；5000 Hz 基准配置保持原行为 | 4000/4500/5000 Hz 对应 10/11/12 kHz 与 10/11/12 阶；已知 500/1500/2500 Hz 极点探针均完整输出 |
| 过期校准确认 | 校准候选绑定批次、设备和采集配置；离页、失败和新校准会使旧候选失效 | 离页后确认不能把新写入的 115 覆盖回 103.01 |
| 设置恢复默认 | reset 将 offset 明确标记为待保存修改 | 显示 100 后保存，存储也为 100 |
| 振动干扰 | 定量监测活动期间禁止触发机身振动；定时器归页面所有并在停止/离页时清除 | 活动采集期振动调用数为 0；停止后无残留定时器调用 |
| 畸形校准 PCM | 校验回调结构和 Int16 字节对齐；异常帧立即使本次校准失败并清除候选 | 三字节帧不抛异常，后续正常帧不能生成应用确认 |

设计依据：YIN 保留原论文的差分函数、CMNDF 与绝对阈值结构，但增加了对有限帧能量支持的必要条件；这不会把“未比较到瞬态”误写成完美周期。[YIN 原论文](https://iro.umontreal.ca/~pift6080/H09/documents/papers/yin_pitch_tracker.pdf)

HNR 仍采用归一化自相关与 10log10(r/(1-r)) 的定义，但不再从低周期性帧的大量延迟中强行挑出一个最大值。Praat 同样把周期性分析与有声/静音判定、pitch floor 和窗口周期数关联；本实现的 0.2 是根据当前帧长和已复现偏差设定的工程有效范围下限，不声称等同于 Praat 默认设置或临床阈值。[Praat Harmonicity 算法说明](https://fon.hum.uva.nl/praat/manual/Sound__To_Harmonicity__ac____.html)

共振峰实现参考 Praat“maximum formant 必须进入 LPC 拟合带宽”的原则。Praat通常重采样到 maximum formant 的两倍；本程序使用目标上方 1 kHz Nyquist 保护带，为现有有限长抗混叠滤波器保留过渡区，并把实际采样率、阶数写入结果元数据。它是经过本程序回归约束的工程变体，不宣称逐样本复现 Praat。[Praat LPC/Burg 说明](https://www.fon.hum.uva.nl/praat/manual/Sound__To_LPC__burg____.html)

校准仍遵循同一频带、同一时长的参考 Leq 与测得 Leq 之差形成 correction factor 的原则；本轮状态修复保证用户确认的确实是刚完成且仍有效的那次采集。[NoiseCapture 校准规程](https://onomap-gs.noise-planet.org/noisecapture_calibration.html)

最终自动验证：revision-regression 32/32 通过，package-integrity 通过。algorithm-evaluation 仍为 78/80；两项失败均是既有共振峰覆盖门限失败（F0=100 Hz 时 F3 缺失；F0=400 Hz 时三个槽位缺失）。冻结共振峰集和扩展集仍未达到 80% 覆盖目标，因此“实验候选、不可作为临床定量结论”的限制继续有效。修复 9 项工程/算法反例不等于消除了这项独立科学限制。
