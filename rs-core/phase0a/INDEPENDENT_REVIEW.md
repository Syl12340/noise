# Phase 0A 独立复核意见（DSH）

协调者注：下文“截至复核”是AGY源码交付前的设计审查快照。最终实现/运行状态以PHASE0A_REVIEW_REPORT.md为准。DSH关于排除项未执行的描述来自过时方案段落；实际P0已添加并验证rs-core打包排除，本轮仍保留该隔离。设计审查不替代实际代码验收。

范围：只读 `phase0a/IMPLEMENTATION_BRIEF.md`、`phase0/CORE_STATE_CONTRACT.md`、`phase0/NUMERIC_SEMANTICS.md`、`phase0/PHASE0_REVIEW_REPORT.md`、`phase0/MIGRATION_ACCEPTANCE.md` 与 `_work/baseline/` 相关段落，及 workspace 内实际文件清单。本文件是 0A 的语义/风险复核，不是 0A 或 P1 的通过结论。

## 1. 实际状态（不得拔高）

截至复核，workspace 内与 0A 相关的实际文件只有 `phase0a/IMPLEMENTATION_BRIEF.md`、`crates/noise-core/Cargo.toml`、`crates/noise-wasm/Cargo.toml`、根 `Cargo.toml`。不存在 `crates/*/src/`、`phase0a/probe-host.cjs`、`phase0a/check-wasm.cjs`、`phase0a/wechat-probe/`、`phase0a/README.md`、`tools/run-phase0a.py`，也未见任何 0A wasm artifact 或 `reports/` 下的 0A 运行报告。因此本轮不存在可复核的 Rust 结果：**0A 一律标 UNRUN，真机（Android/iOS 微信）能力一律标 UNRUN**；P1 误差预算、ABI 冻结均未达成。本复核不代替编译/测试/真机证据，也不构成 0A 通过。

## 2. ABI、固定缓冲与长度/非有限值全量验证

1. **只有一条 ABI，不是生产 ABI**：`probe_abi_version()->1`、`probe_capacity()->4096` 与两枚 4096 f32 缓冲属于 0A 探针专用；`phase0/CORE_STATE_CONTRACT.md` 第 8 节明确其 `ChunkReceipt`/句柄/`process_chunk(&[i16])` 仍是“未来蓝图、当前不存在”。0A 任何结果不得被引用来宣称核心契约已实现或 ABI 已冻结。收据保留/ack、过期查询（契约 §6.1）、空块序号归属（§9 待审核-01）在 0A 中仍属未决。
2. **长度语义**：`len:u32` 与 `capacity=4096` 为边界真值。`len>4096` 必须返回 -1 且不改 output；`len==0` 合法且不改 output（属 brief 冻结语义，但契约 §9 待审核-01 尚未决定生产通道上零长块的序号与收据归属，两者不可混用）。需注意 Rust 侧若做 `len as usize` 后再比较、或先切片后判长，在 32 位/64 位宿主上的行为须一致；必须先用 `len` 判界再建切片，避免以算术溢出替代显式分支。
3. **非有限值全量验证的顺序**：brief 的 -2/-3/-4 隐含严格优先级——先验 `gain` 有限，再全量扫描 input 有限，再全量验算乘积有限，全部通过后才写 output。这个顺序本身是正确的“先验证后提交”设计，但复核要盯三点：(a) `f32::is_finite` 必须覆盖 NaN、+Inf、-Inf 三类，不能用 `!= x` 或比较运算近似；(b) 扫描与写回必须分成两趟，任何“边算边写”的优化都会破坏失败不部分提交；(c) -4 的“乘积非有限”不能用事后检查 output 代替：合法输入 × 合法 gain 仍可上溢为 ±Inf，必须用 f32 语义逐样本判定并整块拒绝。同时应验证失败路径后 output 与调用前逐字节相同（含 `len` 之后未触及区域）。
4. **位级精确而非近似相等**：brief 冻结的 `input=[-1,-0.5,0,0.25,1]`、`gain=0.5`、`expected=[-0.5,-0.25,0,0.125,0.5]` 在二进制下均可精确表示，故要求 f32 位级相等是合理的，且**不得由此推导任何声学 epsilon**；它与 `phase0/MIGRATION_ACCEPTANCE.md` §3 的 f32 写回/f64 累加级联、[待审-TOL-01..03] 完全是两个层次。0A 的“通过”只能说明该固定输入在该工具链下逐位一致。
5. **不得用 JS 代算**：`probe_process` 的返回值与 output 内容必须来自真实 wasm 实例；若 wasm 缺失，`check-wasm.cjs` 必须报 UNRUN 并非 0 退出，README/报告不得写成“已通过”。探针输出也不得混入任何 DC/A/Leq/FFT 结果——`NUMERIC_SEMANTICS.md` 的全部系数与公式在 0A 中不应出现，否则会诱导把探针数字误读为迁移等价证据。

## 3. memory.grow、trap 与实例生命周期边界

1. **memory.grow 后视图失效**：宿主必须重新读取 `instance.exports.memory.buffer` 并重建 TypedArray；旧视图在 grow 后为 detached，任何缓存复用都会读到错误数据或直接抛错。复核要求：grow 前记录的 `ptr`（字节偏移）可继续用，但视图必须 fresh；且需实测 grow 后 `probe_input_ptr()`/`probe_output_ptr()` 的偏移是否仍然 4 字节对齐、是否落在新 memory 范围内——若实现把缓冲放在 `.data`/静态段，增长可能复制内存，偏移约定必须由测试而不是假设来确认。
2. **trap 即实例作废**：`probe_force_trap()` 走 `unreachable` 后，实例进入不可用状态；契约 §3 `Poisoned` 的语义（拒绝一切后续计算与取值）与此一致。复核要求：宿主在 trap 后不得再读 output 作为测量值，必须丢弃实例并新建实例复验（`probe_abi_version`/`probe_capacity`/精确输入重跑）；若 report 里出现“trap 后仍读到上一次 output”，应判为失败而不是部分通过。
3. **生命周期与并发**：同一实例禁止并发/可重入调用，无 shared memory/线程。Rust 侧 `unsafe` 只应限在固定缓冲边界层，禁止 `static mut` 造成共享可变引用；原生测试用拥有缓冲的 `ProbeBuffers` 实例，避免测试并行共享全局状态。任何“靠全局单例方便测试”的做法都会同时破坏实例隔离与 trap 后作废语义。
4. **矩阵完整性**：capacity 边界、空输入、越界 len、NaN/±Inf 输入、非有限 gain、乘积溢出且 output 不变、重复 reset、实例隔离、trap 与新实例恢复，这项清单缺任何一项，0A 都只能记“未完成”。其中“失败后 output 不变”与“新实例恢复”是判定“失败不部分提交 + 实例可作废重建”的关键证据。

## 4. 独立微信测试项目与生产录音隔离

`phase0a/wechat-probe` 必须是独立、可删除的测试项目：只放能力验证页与可选独立 worker，`.wasm` 由工具复制到 `assets/noise_wasm.wasm`，不申请麦克风权限、不含录音代码、不修改主项目路由与包配置。这样做的理由是 `phase0/PHASE0_REVIEW_REPORT.md` 与 `MIGRATION_ACCEPTANCE.md` §7.2 的硬约束：0A “绝不接入生产录音流水线，绝不替换 main.js”。据此：

- 生产录音入口 `wx.getRecorderManager()`/`handleRecordedFrame`（`_work/baseline/pages/main/main.js` L386–396、L1181–1194）在本轮不得被引用、hook 或替换；0A 页面的按钮测试只驱动探针自身缓冲。
- 探针只做能力探测，不产生任何 dB/Leq/CNE 数值，因此即使真机测试出错，也不可能污染用户录音、页面状态、归档或保存判定。
- 微信 API 面必须区分“官方文档既有”与“未实测假设”：`wx`/`WXWebAssembly` 的实例化方式、基础库版本、Android/iOS 差异、包内路径加载、Worker 可用性都应记录为待实测；宿主模块须支持注入 instantiate 实现（Node 读字节 / 微信读包内路径），不得 `eval`、不得动态下载，也不得静默以 JS 结果冒充 WASM 成功。真机结果在用户提供前一律 UNRUN，这也覆盖契约 §9 待审核-02 的 Worker 背压水线（不得用 0A 探针数据推断生产队列尺寸）。
- 打包隔离前置条件仍然成立：`MIGRATION_IMPLEMENTATION_PLAN.md` 已说明 `project.config.json` 的 `rs-core` 排除项尚未由本轮执行；0A 工具与测试资产若进入发布包即为回归。此项属协调者责任，不属于本复核可自行处置的范围。

## 5. P1 误差预算前置门槛与本轮不冻结 epsilon

`MIGRATION_ACCEPTANCE.md` §3 的五项公差（能量相对 1e-6、系数二进制一致、Leq 0.01/0.05 dB 等）现在全部是 **[待审核]** 提案，§8 [待审核-ACC-01] 要求“在观察任何 Rust 差异之前”由协调者、算法负责人、质量代理共同签署冻结；[待审核-ACC-03] 另禁止引入“防护带”。`NUMERIC_SEMANTICS.md` §10 同样声明 Phase 0 未冻结全系统 epsilon，且 `CAPTURE_DURATION_TOLERANCE_SAMPLES=46` 与 0.01 dB 单项测试公差都不是全系统许可。因此：

1. 0A 只使用预先规定的精确二进制数，**不产生也不校准任何声学 epsilon**；本轮明确不冻结完整声学迁移容差，这是刻意的，不是遗漏。
2. P1 前置门槛应为：误差预算文档（600 秒满长样本上的独立理论上界推导）、ABI 细节（收据保留/ack、过期查询、空块结算、非有限值序列化表示——契约 §9 的 `-Infinity`/`1e-20` 分支需明确表示方式）、以及 0A 真机能力证据三者在**首次 Rust 数值比较之前**齐备。任一缺失即不得进入比对，更不得在看到偏差后反向放宽门槛。
3. 冻结顺序不可倒置：先冻结预算与 ABI，再做比较；0A 的位级探针结果不构成对 P1 任何公差的默认许可，也不得以探针“通过”推导 600 秒累加误差或完整 DSP 性能。

## 6. 结论与未定项

本轮未产生任何 Rust/真机证据，故结论仅为：0A 设计中的 ABI、缓冲、长度与非有限值验证、grow/trap/生命周期、测试项目隔离五处要求自洽且与 Phase 0 契约及验收文档一致，但**全部待实际实现与实机执行核验**。未定项：待审核-01（零长块归属）、待审核-02（Worker 背压水线）、待审核-ACC-01/03（预算冻结与决策判定）、探针 trap 后宿主作废是否被宿主脚本实际强制执行、以及内存增长后指针对齐与偏移稳定性的实测结论。这些都不应在本轮被写作已完成。
