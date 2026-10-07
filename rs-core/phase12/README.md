# 数字声强和帧级周期变化率

Rust核心与独立WASM新增两个描述性指标，复现固定旧voice-metrics.js。
本轮为新提交批次第1轮，保留工作区。原PCM→HNR/Worker的v1输出和小程序
主线没有扩展新字段；后续流水线组装还需质量屏蔽、选区/分段支持和新版本契约。

| 宿主入口 | 输出 |
| --- | --- |
| `host.intensityTrack(signal, options)` | track、实际fs/frameSize/hop，unit='dBFS'、method='rectangular-rms'、referenceRms=1、rmsFloor=1e-12、calibrationApplied=false |
| `host.pitchPeriodVariability(f0, options)` | value、pairCount、不可用reason，unit='ratio'、definition和cycleJitter=false |

声强输入为去直流、未经预加重的归一化Float32Array；调用者可以先使用
centerPcm。options支持fs(default12000)、frameSize、hop/hopSize。
未指定帧/帧移时由Rust按旧Math.round(fs*.025)/Math.round(fs*.01)计算。
RMS为未加窗样本平方的顺序均值再开方，结果20*log10(max(rms,1e-12))。
参照RMS明确为1：当前定义下满幅正弦的RMS约0.707，因此结果约-3.01dB。
不应用校准偏移，也不把正db强制压为0；去均值信号可能超过数字满幅。
该数值不能直接当作物理声压级或设备实验室校准结果。

周期变化率输入为按分析帧顺序给出的Float64Array F0。对相邻正F0计算
period=1/f0，将abs(period-previous)顺序相加并除以成对平均周期的顺序总和。
非正F0中断邻接，没有可用相邻有声对时value:null。它不是逐声门周期Jitter，
也不能套用其临床判据。options支持hasCaptureGaps/clippedInput；任一为真
返回null和明确原因，沿用原记录级抑制规则，不影响录音/保存。
时间戳不会被插值，调用者须保证输入帧顺序及记录的连续性信息。

关于量纲，Praat的 [Intensity定义](https://praat.org/manual/Intensity.html)
采用相对于20微帕的物理声压级；本接口保持旧数字幅值定义。
Praat的 [Jitter说明](https://uvafon.hum.uva.nl/praat/manual/Voice_2__Jitter.html)
基于从波形取得的周期，本接口是帧级F0统计。这里只用这些资料界定差异，
没有把Praat算法替换进迁移基线。

输入最大262144样本，声强帧最大4096、输出行最大4096；周期变化率最大4096
个F0。共享speech待取结果/复制/确认保护；错误不发布部分统计、不改变其它
会话。非有限输入、无法表示的帧时间、周期倒数或累积溢出明确拒绝，
不把Inf/NaN归为零变化率。基础统计为有界同步调用，未承诺手机延迟。
默认参数和帧移必须在u32范围内，防止极端fs的整数饱和在原生/WASM间产生
不同元数据；该路径已构造反例并加入入口拒绝检查。
FFI的声强size/hop=0表示自动选择；宿主的显式0配置拒绝。范围外/静音/空输入
的有效结果与开发参数错误有明确区别。

14组实际旧JS声强参考覆盖七种率、静音、空/短、奇数帧、数值底限、正db和
默认5.25秒。11组周期参考覆盖常量、两值、暂停、非正标记和极端有限数值。
初始原生/WASM1232项精确字段、1186项声级检查通过，声级最大差约3.6e-15dB，
低于沿用1e-10预算；周期变化率逐位一致。检查间断/削波标记、溢出拒绝、
待取结果、原始容量/标志、内存增长和另一YIN会话保持可用。新增Rust测试
覆盖这些入口与空/静音/默认帧规则。
参考SHA256：`888c5b87fdd545349b600a0dd0cdfaebff869c32676c0b4ab5083a172d30aa07`。

全量入口`python tools/run-phase12.py`，包含phase11和之前所有回归。
精确工作区副本：`python tools/verify_working_checkout.py --phase12`。
报告见reports/voice-metrics-checks.json、phase12-verification.json及
working-checkout-verification.json。旧数值参考、系数和误差预算不修改。
微信/Android真机、原生libm、LPC/共振峰、语谱图及逐周期指标仍待后续。
