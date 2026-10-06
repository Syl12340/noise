# 独立噪声声学算法移植：实现与验收契约

日期：2026-10-06。用户明确授权直接移植声学算法、原始主线不动；该授权允许独立移植先于微信真机0A门槛，不能据此自动接入生产或宣称手机验证通过。

## 首批范围

移植固定3a0d676基线的噪声监测计算链：audio-quality的inspectPcm/PcmQualityInspector/centeredSignal/DCBlocker，audio-math的RMS/dB/Leq/CNE/AWeightingFilter/尾滤波，fft的32768 Hann与原位蝶形，以及canvas-spectrum的29带精确频率分组。main只读取以还原原始块拒绝、逐样本能量/秒窗、ring/hop、两类FFT和结束行为。语音resample/YIN/HNR/LPC/formant属后续独立范围，本轮不改变其科学定义或生产实现。

所有新增/修改只在rs-core。生产app/pages/utils/workers、项目根配置、本轮开始时已存在的dirty/untracked文件、P0 frozen fixtures和baseline全部不改。保留0A探针默认构建；声学feature新增独立测试/接口，不接主小程序，不推送。

## 比较前冻结数值规则（v1）

1. 只支持44.1kHz/Int16。归一化除32768；DC和A写出f32、内部状态和能量顺序累加f64；不得FMA、fast-math、Kahan或重关联。
2. JS生成的A系数字节直接复用P0；DC极点、Hann、FFT每stage旋转因子、精确频带bin ranges从锁定JS导出为新独立系数包。这样代数管道使用相同输入、常数和运算顺序，预期f32输出和累计能量逐位一致，不用容差掩盖滤波器差异。
3. native的sqrt/log10/pow10可用Rust std；它们的跨运行时全域ULP保证本轮没有证明，故单独设工程准入检查，不假称理论认证：有限投影dB绝对差<=1e-10，有限RMS差<=32*EPS*max(1,abs(reference))。dB上限相当于功率相对差约ln(10)/10*1e-10=2.303e-11，单独限制数学函数差异，不能放宽能量/事件精确规则。NaN/±Inf/0返回分支按类别一致。
4. 计数/状态/拒绝/质量/窗边界/tail步数与converged严格一致。FFT核的f64线性功率逐位比较（用同JS冻结Hann/旋转因子）；DB及29bands仅允许第3项投影差。若发现不符，修实现或标不通过，不观察结果后加宽本v1规则。
5. 600秒顺序累计理论舍入界gamma_N=N*u/(1-N*u)，u=2^-53,N=26460000，约2.94e-9：这是各后端共同的算法舍入界，不是许可Rust与JS不同求和。代数运算相同仍要求逐位等价。基线频响误差不是迁移容差。
6. 结果不继承设备/实验室/临床验证；仅desktop compatibility。若WASM数学函数引入差异，同规则验证并标具体numeric profile；不静默JS代算DSP。

## 同步核心接口契约

此轮采用同步处理，不承诺cooperative/Pending/取消的生产ABI。NoiseEngine拥有会话state、DC/A、质量inspect、能量、ring与有界事件队列，实例不共享可变global。

- process_chunk(seq:u32, pcm:&[i16], spectrum_needed:bool)：seq从1起。接口/序号/容量错误不提交；WouldBlock不提交，允许drain后同seq重试；成功Q+D同时提交；削波或累计50ms静音Q-only提交并终止，DSP整块不推进。
- empty input返回IgnoredEmpty，不消耗core seq或计数。adapter原始块序号另计，不将计算切片当原始块。
- 终止后输入IgnoredAfterTermination，Q/D/seq不动。明确hard_invalid(reason)保持已提交数据并终止，用于格式损坏/系统中断/停止超时，不虚构输入样本。
- query_spectrum不足32768返回None；完整时纯查询，样本/hop/事件时钟不变，UI列追加由原应用层负责。
- finish(Normal/Invalid)幂等：正常且有样本、非hard-invalid才冲刷A（不冲刷DC）；256零块，threshold=max(E,1e-24)*1e-12，8静块或88200上限，tail只加分子。SignalTerminated即使被要求Normal也不能tail或恢复有效。
- 定时FFT首次32768及hop8192；不需要频谱时仍推进ring/hop。每个秒窗含exclusive-end、Z能量/计数、边界累计A能量/计数、来源seq和整块RMS，不能用块末快照替代。
- 队列默认128条有界事件（窗口/频谱），处理前保守预检所需容量；调用后drain。单语义块上限262144样本，覆盖P0最大88200单块；超限返回明确Capacity且不改变状态，不偷偷重分块。
- 原生时长完整性、校准资格、风险分级、告警、显示/历史/保存不移入core。offset只是数学投影参数，不作为接受输入条件。

## 文件所有权与工程实现

Codex：Cargo manifest/lock/module注册、coefficients/noise-44100-v1/、本契约/汇总、独立输入与验收工具最终核查。

AGY独占新增crates/noise-core/src/acoustics.rs（或acoustics/模块子目录）、crates/noise-core/tests/acoustics*.rs、crates/noise-core/examples/acoustics_driver.rs、phase1/compare-acoustics.cjs、tools/run-acoustics-port.py、phase1/README.md。不得改lib.rs/Cargo文件/P0/0A。实现主要原生共享core，编译到wasm32-unknown-unknown的构建检查；完整声学WASM测量ABI留后续独立任务，禁止把0A增益ABI冒充声学接口。

noise-core新增acoustics feature启用std（默认feature仍no_std probe）。无外部crate依赖；不安装、不联网、不改配置。Cargo与module注册由Codex完成。

DSH独占phase1/INDEPENDENT_REVIEW.md，只读基线/契约，复核数值与状态口径。不冻结新epsilon，不碰AGY源码，不执行命令/外部状态。

## 原生驱动与对照

Rust example读取文件路径参数：自定义二进制协议NAC1（4字节magic, offset f64LE，后续opcode流）。P=1：seq u32LE,len u32LE,needSpectrum u8，随后len个i16LE；Q=2主动query；F=3结束disposition u8(0正常/1无效)；I=4 hard_invalid；D=5 drain。禁止未判界就分配或读；错误最终非0。

stdout NDJSON真实core收据/window/spectrum/final；可用固定key的安全手工JSON输出（无serde依赖），非有限数用显式NaN/+Infinity/-Infinity标签。频谱输出每次完整16384bins以及29bands和at-sample/source。接口错误给结构化error并退出非0；不复制JS算法在驱动中计算。

Node工具从P0 PCM/chunks/events和expected生成隔离_work输入，仅调用Rust驱动，比较全部core字段。P0不重写。奇数损坏/中断通过I，Stop timeout通过Invalid finish；partial/unverified正常tail。校准/保存状态只注明app-owned，不伪称移入Rust。质量拒绝前后、尾、秒窗和每次实际FFT均需覆盖；新单元signal/跨块rails/分块不变/重复结束/错误seq/队列背压亦验证。额外JS单元参考只从baseline真实模块导出，不重写数学流水线当独立真值。

Python工具只调用已审阅argv，使用--locked --offline，有限timeout，写rs-core/reports/_work/target；缺组件不伪通过、不自动安装。先交源码无终端命令，父代理审阅后授权实际build/test/compare。
