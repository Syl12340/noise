# 完整言语分析、LPC／共振峰和语谱图

本轮在独立 `rs-core` 完成标准 PCM 结果组装，主线页面、录音、校准、保存和历史记录均未接入新核心。新接口返回 `profile: 'pcm-speech-v2'`，保留冻结基线的科学版本字段；构建身份以报告中的 WASM SHA256 另行识别。旧 `pcm-hnr-v1` 和旧 Worker 协议仍保持原有输出。

Rust 负责去均值、质量检查、分段、抗混叠重采样、YIN、HNR、Burg LPC、Durand–Kerner 求根、F1–F3 跨阶模型对应与重捕获、强度、语谱图、支持区间和覆盖率。JS 只提供指定的标量数学函数、调度和复制结果，不实现声学计算或备用算法。完整录音最多 5.25 秒／262144 个 PCM 样本，接受原有七档采样率和合法共振峰参数。

```js
const { instantiateSpeech } = require('../phase3/speech-host.cjs');
const host = await instantiateSpeech({ api: WebAssembly, source: wasmBytes });
const result = await host.analyzePcmSpeech(pcmInt16, {
  sampleRate: 44100,
  parameters: { lpcOrder: 12, maxFormant: 5000, windowMs: 25, task: 'sustained' },
  discontinuityBoundariesSeconds: new Float64Array()
}, { yieldFn, onProgress, isCanceled });
```

`result` 含 `signal`、`pitchTrack`、`formantTracks`、`intensityTrack`、`harmonicity`、`avgHNR`、历史命名的 `jitter`、`spectrogram`、`inputQuality`、`invalidIntervals`、`coverage`、`parameters` 和 `formantStatus`；分段录音还含 `analysisSegments`。`jitter` 是相邻有声帧周期变化率，不能解释为脉冲周期 jitter；强度为 dBFS，未经物理 SPL 校准。`spectrogram.data` 为独立复制的 Float32Array 列，`times` 为 Float64Array，1024 点 FFT／512 个频率格点，实际 5 ms Hann 窗、约 2 ms hop；值是 −80…0 dB 范围的 0…1 显示强度，不能直接当声压级。

也提供 `burgLpc(Float64Array, order)`、`findPolynomialRoots(Float64Array)` 和手动 `fullBegin/fullNext/fullFinish/fullCancel`。手动调用必须主动取消以释放会话；异步完整分析会自动清理。计算按重采样批次和完整帧让出执行权，最终结果复制每 128 行／列让出一次。失败事务不能返回成功的部分结果；单帧共振峰数值失败仍保留基线定义的失败行。共振峰保持 `experimental-candidates`／`quantitativeUseValidated:false`，没有提升科学资格。

执行完整验证：

```text
python tools/run-phase13.py
```

干净克隆使用 `--repository-clean`，该模式只允许原有 SDK／换行兼容规则。运行顺序先验证全部旧窄功能构建和 Worker v1，再构建 `full-speech`。冻结主参考：14 个组件、4 个完整结果；补充检查覆盖 44 个采样率／共振峰上限组合、最长静音和有声录音、极短输入、短分段、削波与连接语音，以及会话生命周期。补充参考由固定原 JS 在端口运行前生成并记录结果哈希，不能替代不可改写的主参考。

完整构建新增 37 组重采样系数及捕获窗口／根初值，共 3,770,992 字节；当前桌面构建 WASM 约 4.42 MiB，已超过旧 Worker 的 4 MiB 接收上限，不能直接投给 v1 Worker。后续需专门设计 v2 Worker、包体和设备性能验证，不能靠放宽旧协议的上限宣称已兼容微信。可选模型敏感性分析和带原录音绝对偏移的选择区适配器尚未移植；该 API 只分析传入的 PCM，时间从零开始，未知选项会拒绝。

桌面匹配不等于实验室／临床准确性。原有高基频与共振峰合成／保留集验证中的失败仍未消除；Native 的动态数学仅通过原 JS 数学轨迹完成数值核对，实时 native libm、WXWebAssembly、Android／iOS 录音链、包体与性能资格仍待验证。
