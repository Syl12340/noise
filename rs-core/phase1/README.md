# 独立Rust噪声声学移植

2026-10-06：首批噪声计算链原生兼容性验收通过，原始主线与P0数据不变。

源码入口：[acoustics.rs](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/src/acoustics.rs)。包含质量检查、DC、A计权与tail、RMS/dB/Leq/CNE、32768 FFT/29频带和同步NoiseEngine。

在rs-core目录复跑：

```text
python tools/run-acoustics-port.py
```

程序只写rs-core的工作目录、构建产物与报告，使用locked/offline，不改原始主线或golden。

24项声学Rust测试、26组P0核心回放、24个真实JS数学边界案例、4组全FFT单位参考通过；线性功率131072次逐位比较通过，dB最大观测差5.684341886080802e-14。详见[完整报告](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase1/PORT_REVIEW_REPORT.md)。

默认feature保留0A no_std探针；acoustics feature使用std，仅固定44.1kHz，噪声FFT为32768点。当前没有生产声学WASM调用ABI或微信接入；WASM rlib构建检查不是手机运行证据。语音模块尚未移植。校准/原生时长完整性/风险/报警/保存仍属于原应用。

NAC1验证协议：magic+offset f64LE；1=seq/n/fftflag/i16 PCM，2=query，3=finish flag，4=reasonLen/UTF8 invalid，5=drain，6=固定32768 f64LE FFT输入，7=固定u8标量操作ID及参数；9是操作ID中的RMS切片（n_u32+f64转f32）。它是测试驱动协议，不是最终WASM ABI。

数值门槛在比较前冻结于NUMERIC_PROFILE_V1.json。保持代数与状态精确，投影误差单独限制，不通过放宽公差隐藏差异。缺组件会明确报错，验证器不自行安装。
