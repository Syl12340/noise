# 独立噪声声学算法移植验收报告

日期：2026-10-06。科学基线：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`。数值配置：`legacy-noise-44100-native-v1`。

## 结论

首批噪声声学算法已直接移植到独立Rust计算库，原生兼容性验收通过。此次不改变原始小程序主线、不替换录音入口、不发布或推送。用户明确要求直接移植，因此独立开发不再等待0A真机门槛；该授权不代表生产接入或真机结果已获验证。

声学feature编译到wasm32-unknown-unknown成功，本轮产物是rlib构建检查。完整声学测量WASM导出ABI、微信适配器与真机验证尚未实现；现有0A WASM仍是增益探针，不能用于声压测量。

## 实际实现

入口：[acoustics.rs](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/src/acoustics.rs)。`noise-core`的`acoustics` feature启用std；默认feature仍保留原no_std探针。

| 模块 | 保留行为 |
| --- | --- |
| quality.rs | 441样本滑动削波窗、railLimit=2、近满幅/平台证据、chunk-local静音、逐块去均值工具 |
| dc_blocker.rs | 2Hz高通、首样本播种、f64反馈及f32写回 |
| a_weighting.rs | 两节biquad、129tap/128阶FIR、固定gain、f64内部状态及f32输出、有限记录尾处理 |
| math.rs | RMS/dB/Leq/CNE数学助手、空RMS NaN、无有效能量/样本的Leq返回分支 |
| fft.rs/spectrum.rs | 32768对称Hann、原顺序蝶形、N/2输出省略Nyquist、raw/floored功率、29带原dB反演求和与floor |
| engine.rs | 原始块Q+D/Q-only结算、2205样本静音门限、整数序号、精确事件容量预检、秒窗前缀、ring/hop8192、纯query、结束幂等 |

平台原生时长核验、校准资格/实验室标记、风险与报警、显示、存储和历史兼容没有移入core。offset仅是数学投影参数，不作为DSP接受输入的校准拦截条件。语音resample/YIN/HNR/LPC/formant尚未移植，本轮仅首批噪声链。

## 比较前冻结与身份

[PORT_CONTRACT.md](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase1/PORT_CONTRACT.md)和[NUMERIC_PROFILE_V1.json](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase1/NUMERIC_PROFILE_V1.json)在Rust数值比较前冻结。A/DC/Hann/FFT旋转因子及精确bin ranges读取JS实际生成的LE字节；不改系数设计，不用Rust的sin/exp另造常数。

有限dB投影上限1e-10、RMS上限32*EPS*max(1,abs(ref))只是预定工程准入门槛，不是全域libm误差证明。能量、计数、窗口边界、tail步数/收敛与FFT线性功率不以该投影容差放行；NaN/Inf类别单独验证。没有观察差异后放宽门槛。

## 实际验证结果

| 检查 | 结果 |
| --- | --- |
| 声学Rust测试 | 24/24通过，含极值整数/平台溢出、静音与clipping优先级、分块、窗口、序号/容量、tail、重复finish、只读snapshot |
| 默认构建兼容 | 原有workspace探针测试通过；新增声学测试只在对应feature启用 |
| P0真实冻结会话 | 26/26通过，逐块/窗口/最终能量及tail的952个f64值逐位一致，10402个状态/计数字段一致 |
| 完整频谱读数 | P0每次实际观测的16384bins及29bands、样本位置与query/scheduled来源均比对；264176个dB字段最大差5.684341886080802e-14 |
| 独立数学单位参考 | 24个真实JS函数边界案例通过；RMS观测差0，NaN/Inf/空值分支匹配所测合法输入域 |
| 独立FFT单位参考 | 零信号、非整周期正弦、DC阶跃、Nyquist交替信号4组；131072个raw/floored功率值逐位一致，全bins/bands投影通过 |
| 构建与检查 | 原生release驱动、WASM target rlib、rustfmt、native Clippy -D warnings通过 |
| 主线与基准保护 | 本轮开始时233个已跟踪工作文件均未变，138个P0 frozen数据文件与系数包未变 |

P0的奇数字节/系统中断通过明确host invalid指令映射；停止timeout以invalid finish映射。partial/unverified保持正常tail。P0的canSave、calibrationGrade、risk/modal并未在Rust中重新实现，不能从同名fixture通过推断它们已移植。

参考不是复制的JS流水线：会话来自P0冻结文件；单位FFT raw power以真实baseline函数的只读内存hook捕获；数学助手直接调用真实baseline模块。对照说明兼容性，不是独立物理真值或临床认证。未逐一对照所有内部滤波状态及每个f32输出样本，不作比现有验证覆盖更广的证明。

## 实施中的实际修正

AGY承担主要Rust模块、驱动与测试初稿；DSH提供独立复核。Codex监督、补充固定表/数值profile、独立参考与审计工具，核对并纠正：

- i16最小值abs溢出、平台乘积i32溢出、空RMS错误返回、tail NaN阈值处理。
- clipping之前更新silence计数、正常结束重复变invalid、终止后守卫顺序、序号溢出。
- cap1预估导致错误阻塞、单块大于事件队列的永久重试（现为明确容量错误，不部分提交）。
- 验收初稿的自写JS流水线、宽松功率/能量比较、缺字段/NaN伪通过、仅前500bins比较。
- 原生驱动的歧义自动识别协议、异常字符串JSON转义、缺累计近满幅标记、测试长DC误认为有效音频、默认feature测试注册。

初始AGY任务失败且只部分交付；Rust修正任务完成并经实跑核查。工具重写委派最终失败为空答案，没有计为完成，未继续盲重试；最终执行入口采用Codex已实际通过的独立验证器。未发生提权绕过或账号/供应商配置修改。Rust官方WASM std组件由Codex经自动审批后补齐。

Windows增量缓存硬链接不可用时Cargo退回复制，有日志提示，未造成测试失败。不能把“Clippy通过”扩大为所有构建日志零提示。

## 可复跑入口与证据

在rs-core目录执行 `python tools/run-acoustics-port.py`，入口依次运行隔离guard、声学测试、release驱动、冻结P0/单位对照、WASM rlib、默认workspace测试、格式/lint及最终隔离guard。使用locked/offline、有界timeout，不写主线或golden，不安装组件。

- [总执行报告](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/acoustics-port-report.json)
- [P0独立对照](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/acoustics-p0-native-comparison.json)
- [完整单位对照](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/acoustics-unit-comparison.json)
- [核心引擎](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/src/acoustics/engine.rs)
- [原生测试驱动](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/examples/acoustics_driver.rs)

## 保留的边界

本轮只支持44.1kHz；FFT公开移植核限定32768，不替代原JS通用任意N工具。RMS助手取f32切片，Leq计数取u64，JS任意类型/NaN计数不属于该typed API域。全量600秒时长压力、实际FIR/FFT延迟、移动端数学函数差异、事件生产WASM ABI与cooperative/Pending接口仍需后续实测/冻结，不能从probe或短向量推断。

基线的频响/采集链未核验、共振峰和低信噪比F0局限以及exact80显示歧义继续保留。本轮不改变历史数值、实验室预设可用性或未校准保存路径。
