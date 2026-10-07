# 原始PCM质量、去直流与独立HNR流水线

本阶段复用Rust噪声核心已有的PcmQualityInspector、inspect_pcm及
centered_signal，并增加语音WASM接口。所有质量检查和声学计算在Rust中。
小程序主线保持独立，录音、校准、保存及历史记录规则继续由主线处理。

| 入口 | 输出/作用 |
| --- | --- |
| `host.inspectPcm(pcm, sampleRate=44100)` | 与旧JS一致的数字静音、无交流信号、满幅/近满幅、平台及滑动窗口削波证据 |
| `host.centerPcm(pcm)` | 按完整连续片段去均值，返回拥有独立副本的Float32Array |
| `host.analyzePcmHnr(pcm, options, hooks)` | 按采集间断分割，再逐段检查、去均值、重采样、YIN、质量屏蔽、HNR及统一汇总 |

pcm为Int16Array。基础入口最大262144样本，inspect支持固定七种采样率，
center/inspect允许空输入。每次离线inspect创建全新的检查器；其结果不携带
前一片段的削波窗口。平台失真仍是警示；近满幅/单个孤立满幅样本不自动
等于已达到削波门槛。连续流的状态性DCBlocker仍由已有噪声核心负责，
centerPcm用于离线完整片段，不应逐录音回调去均值。

analyzePcmHnr需要启用harmonicity的WASM构建。options只接受sampleRate
及Float64Array discontinuityBoundariesSeconds；沿用原录音最长5.25秒、
七种输入采样率及12000Hz固定分析配置。PCM和间断列表在首个await前取得
副本。主机负责协调、复制及调度，分段位置、质量、滤波、YIN和HNR均由Rust计算。
hooks为yieldFn/onProgress/isCanceled，进度对象包含stage和segmentIndex。
YIN/重采样仍是同步计算调用；只在各准备阶段之间和HNR帧间让出执行。

返回已有分段HNR汇总，加segmentQuality（源样本位置和该段完整质量报告）、
profile='pcm-hnr-v1'。单段也有显式segmentIndex0与汇总元数据，数值与旧JS
单段流水线对照。时间轴为接收样本，不补齐未知缺失时长，jitter为null。
源PCM为空/超出原配置等开发接口错误明确报错；静音PCM正常完成并返回
avgHNR:null。取消、异步钩子失败和ABI错误没有成功的部分最终结果。
HNR/汇总资源由phase7释放；其它会话可继续使用。出现WASM陷阱弃用该实例。

```javascript
const result = await host.analyzePcmHnr(pcm, {
  sampleRate: 44100,
  discontinuityBoundariesSeconds: new Float64Array([.5])
}, {isCanceled: () => canceled, onProgress: progress => report(progress)});
```

首次冻结13组PCM基础样例及8组流水线参考，包括七种质量采样率、
空/DC/数字静音、平台警示、孤立满幅、削波、不同段均值、44.1kHz偏移、
短片段及默认5.25秒/48000Hz。基础样例原生和实际WASM逐项比较；
去直流21888个原生/WASM样本逐位比较。流水线从实际旧analyzePcm的HNR
前半段和analyzeSegments取得数值参考，单段仅补充显式汇总元数据。
初始定向检查9463项字段、947项声级，声级最大差0。
另外检查输入/边界所有权、独立会话、准备/HNR阶段取消及钩子失败/重启、
容量、待取结果、内存增长与实例陷阱。新增Rust测试覆盖待取结果、容量、
检查器独立性、空输入和常量DC。DSH在只读范围内未发现协调入口的确切问题。

参考清单SHA256：`ca5fe21b490389830d5b4231439d0947ab1b79f066693ced2599132b230223a3`。
旧数据、系数、误差预算不变。全量入口`python tools/run-phase8.py`，
干净暂存副本使用`python tools/verify_staged_checkout.py --phase8`。
报告见reports/pcm-checks.json、phase8-verification.json及
staged-checkout-verification.json。

当前完整入口覆盖PCM到HNR这一条路径。LPC/共振峰、声强、语谱图、扰动指标
仍需移植；原生libm、Worker、WX/Android真机、手机性能和临床/实验室有效性
仍未资格验证。默认5.25秒桌面对照通过不代表手机延迟已达标。
