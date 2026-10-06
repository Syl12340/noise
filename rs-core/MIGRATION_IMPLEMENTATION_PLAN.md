# 共享 Rust 核心迁移实施方案

日期：2026-10-05。用途：供 Codex、DSH、AGY 等代理分阶段实施及复核。

基线提交：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`。

当前状态（2026-10-06）：用户授权独立声学移植先于0A真机门槛。噪声计算链已移植，24项声学测试、26组P0核心字段回放及完整数学/FFT单位对照通过，详见phase1/PORT_REVIEW_REPORT.md；生产主线不改动。声学WASM导出ABI、生产适配器、真机/Worker及语音模块仍未完成，不代表完整迁移或设备科学性验证通过。

## 1. 目标与不可改变的约束

建立共享、确定性的 Rust 声学计算核心，保留微信小程序的采集、生命周期、交互、存储及校准证据管理。Rust 开发与小程序主线开发可以并行，但必须隔离文件、分支、运行产物和发布开关。

硬性要求：

1. 所有核心迁移源码、验证脚本、样本和文档放在独立 `rs-core/` 子目录；不移动当前小程序目录。
2. Phase 0 不写生产 Rust，不修复基线算法，不修改生产 JS 或历史记录。
3. 保留 legacy JS；首次接入时 JS 为权威结果，Rust 只作影子比较。
4. 无校准用户仍能录音和保存；旧实验室预设、历史数值及现有使用路径不得因迁移新增拦截。
5. 不改变现有科学定义、原始块拒绝规则、Float32 写回位置、分母、滤波尾约定和频谱口径。
6. 当前共振峰准确性/覆盖率、低信噪比 F0 周期歧义等已知问题继续标记；语言迁移不能提升验证等级。
7. 迁移与算法修复分别提交。发现基线问题时记录证据和独立修复事项，禁止混入移植改动。
8. 本方案不授权自动推送、发布、强制合并、清理主线文件或修改账号/代理/权限设置。

“无缝替换”在本方案中指用户入口、录音管理、记录格式和历史读取保持兼容，并具有可验证的回退路径；不能据此承诺 Rust 单轨发生故障后仍能凭空恢复整段结果。

## 2. 目录与主线隔离

目标目录如下；Phase 0已落地产物以监督报告为准，其余仍为后续实施规划。

```text
noise/
├─ app.js / app.json / pages/ / utils/ / workers/   # 现有小程序
└─ rs-core/
   ├─ MIGRATION_IMPLEMENTATION_PLAN.md
   ├─ phase0/
   │  ├─ CURRENT_SIGNAL_STATE_MACHINE.md
   │  ├─ CORE_STATE_CONTRACT.md
   │  ├─ NUMERIC_SEMANTICS.md
   │  ├─ MIGRATION_ACCEPTANCE.md
   │  └─ fixtures/
   ├─ tools/                                     # 隔离验证入口
   ├─ reports/                                   # 新报告，不覆盖原 docs 报告
   ├─ coefficients/                              # Phase 2
   ├─ crates/
   │  ├─ noise-core/                             # Phase 1 起
   │  └─ noise-wasm/                             # 能力验证/边界层
   ├─ Cargo.toml / Cargo.lock / rust-toolchain.toml # 后续阶段
   └─ .gitignore                                 # 排除 target 和临时产物
```

第一轮不创建 speech 或 native C ABI crate。Rust workspace 的 Cargo 根、锁文件和 target 均应属于 `rs-core/`，不在小程序根目录增加 Cargo 构建状态。

**打包隔离是执行前置条件。** 协调者已在P0加入 `project.config.json` 的 `rs-core` 排除项，隔离检查已确认该项是唯一新增的主项目配置。主线再次打包仍需验证内容；其它代理不得修改该配置。后续集成只复制必要WASM发布产物，不将整个Rust workspace加入小程序包。

首选在独立分支 `codex/rust-core-phase0` 和独立 worktree 中实施。工作树放在允许写入的临时目录，不能作为嵌套仓库提交到主工程。由协调者独占 Git 操作。若使用同一工作树，禁止切换主线分支，严格按以下文件所有权并行。

## 3. 并行任务与文件所有权

| 任务 | 可修改路径 | 主要产出 | 不得修改 |
| --- | --- | --- | --- |
| A：基线状态还原 | `rs-core/phase0/CURRENT_SIGNAL_STATE_MACHINE.md` | 当前实际状态、调用顺序、计数、停止和忽略路径，附源码位置 | 其它代理文档、生产源码 |
| B：状态契约 | `rs-core/phase0/CORE_STATE_CONTRACT.md` | 事务、终止、关闭、序号、receipt、事件、背压与错误映射 | fixtures、数值规则、生产源码 |
| C：数值与验收设计 | `rs-core/phase0/NUMERIC_SEMANTICS.md`、`rs-core/phase0/MIGRATION_ACCEPTANCE.md` | 精度、运算顺序、误差预算和验收矩阵 | 契约文档、fixtures、生产源码 |
| D：基线工具与样本 | `rs-core/tools/`、`rs-core/phase0/fixtures/`、`rs-core/reports/` | 冻结样本、原始块/事件、golden outputs、复现入口 | A/B/C 的文件、生产源码 |
| 协调者 | 本方案、汇总清单、集成记录 | 分工、交叉审阅、阶段验收、限定打包配置 | 不替代理静默重写未核对的科学结论 |

按并发资源分批调度：A/B/C 可同时进行；D 可由协调者执行，也可在空闲槽位启动。A 的事实核对完成后，B/C/D 再收敛字段含义，不能各自猜测不同接口。

禁止多代理同时修改 Cargo 锁文件、根 manifest、同一 fixture、同一汇总报告。未来 Rust 模块可分文件并行，crate 根、依赖配置和 ABI 注册表仍由一个负责人管理。

小程序主线可继续在独立工作树开发，但 Rust 基线始终固定。主线产生新算法修复时，另做基线升级记录，保留旧样本和旧结果后重新验证；禁止自动追随 `master` 或静默更新 golden outputs。

## 4. 运行层边界

| 层 | 责任 |
| --- | --- |
| `noise-core` | 确定性信号处理、原始块质量证据、接受/拒绝、计数、窗口、频谱及尾处理 |
| `noise-wasm` | 句柄、ABI、内存与结果搬运、错误码；不重新定义 DSP |
| WeChat adapter | 原始回调块边界、会话代次、队列、调用后端、关闭栅栏及故障策略 |
| application/domain | 平台采集完整性、校准证据、风险标签、报警、显示、保存和历史兼容 |
| validation | 数值、协议、应用决策、故障及性能验证；测试工具不进入生产调用路径 |

core 不调用 wx、设备/录音 API、网络、文件系统、当前时间或产品存储。校准资格和风险阈值不成为 DSP 接受输入的条件。应用保存原始 DSP 证据，允许有明确来源的校准投影和显示格式化，不静默重写原始量或历史数值。

## 5. Phase 0 必须还原的基线事实

以锁定提交为事实依据，不能只凭本方案或粘贴讨论生成结论。至少核查：

1. `main.js`：原始块格式检查、质量检查、终止标志、DC、整块 RMS、A 滤波、逐样本积分、环形缓冲、秒边界、视图请求、停止和 archive。
2. `audio-quality.js`：跨块削波/平台证据、块内 min/max/peak、连续静音计数、DC 初值及 Float32 输出。
3. `audio-math.js`：A 系数设计、处理精度、能量下限及有限记录尾处理。
4. `fft.js`、`canvas-spectrum.js`：32768 点 Hann、8192 hop、N/2 bins、Nyquist 省略、单边均方贡献及 29 带分组。
5. `recorder-session.js`、`data-model.js`、结果和风险模块：只读取以确定边界和应用映射，不迁移其平台职责。

关键基线语义：

- 削波及连续数字静音达到现有门限时，拒绝整个原始块进入 DSP；质量证据已经推进。
- 终止无效后的帧按原路径忽略，不继续检查或积分。
- hard invalid 时跳过 A 尾；partial/unverified 在未触发 hard invalid 时仍按基线处理尾。
- tail 增加能量分子，真实积分样本分母不增加。
- 秒级事件保存边界时刻的累计 A 能量；整块 RMS 与秒级区间量分开。
- ring/hop 持续推进，FFT 按显示需求计算；切换视图还可查询当前完整缓冲的频谱。

空块、非法格式、重复停止、迟到帧、尾未收敛等实际行为均需源码核对。包括“exact-80 不一致”在内的候选问题，必须记录实际复现结果，不能未经核实写成已确认事实。

## 6. 事务、序号与停止契约

### 6.1 输入结算

| 情况 | 质量状态 | DSP 状态 | 软件序号 |
| --- | --- | --- | --- |
| 结构/句柄/序号错误、WouldBlock | 不提交 | 不提交 | 不推进 |
| 正常接受及 near-full/plateau warning | 与 DSP 一起提交 | 提交 | 推进 |
| clipping/连续静音门限拒绝 | 提交证据 | 不提交 | 推进，生成 terminal-rejected receipt |
| 正常块取消或可恢复失败 | 两者均不提交 | 不提交 | 不推进 |
| trap/panic | 状态不承诺，实例 Poisoned | 不承诺 | 不承诺 |

`consumed_input_samples`、`integrated_samples`、`tail_zero_samples` 分开；待提交计算不进入已提交计数。应用接收量和原生时长属于独立证据。历史字段与这些量的映射必须明确，不能迁移时直接替换旧完整性判断的分母。

声学拒绝不是接口错误，不得盲目重放。对正常块采用 Q+D 事务，对声学终止采用 Q-only 结算。计算子步不得成为新的语义块边界。

### 6.2 会话状态

逻辑状态为 `Active / Pending / Closing / SignalTerminated / TailPending / Finalized / Poisoned`。它们是 DSP 输入和结果状态，不是 RecorderManager 状态。

- `Pending` 的快照只读上次已提交状态；暂存窗口不得提前可见。
- `SignalTerminated` 不再推进质量或 DSP，禁止 tail；只冻结证据和无效结果。
- 应用 hard invalid 通过显式结束 disposition 映射，保持现有处理路径。
- `Finalized` 结果只读；重复结束不再次累计 tail。
- `Poisoned` 不继续产生测量值。

### 6.3 关闭栅栏

原生停止确认后，adapter 关闭原生输入接纳并记录截止序号。所有已接纳输入必须明确结算为 accepted、terminal-rejected、ignored-after-termination 或有原因的故障处置；未结算输入不能凭空消失。

需要区分 adapter 原生接纳栅栏与 core 提交栅栏。若声学终止后已有排队块，按基线忽略并记入 adapter 账本；这些块不再推进 core，不能继续要求 core 对它们积分才能满足 `last_settled_seq == K`。非终止路径则排空全部需要提交 core 的输入后才能处理尾。

结束请求遇到 Pending 时保存 Closing 条件，完成当前事务后不得重新开放新输入。只有输入账本结算、无待提交事务、结束 disposition 确定后，才处理 tail 或直接冻结无效证据。

### 6.4 receipt 与事件

每会话使用 generation/handle 和 `u32 chunk_seq`。序号只证明软件提交协议，不证明硬件没有丢帧。

commit 返回不确定时先查询状态，不盲目重放 PCM。详情使用有界 receipt/event 队列，明确 ack、保留范围、重复读取和过期查询语义。事件有稳定 ID，application 去重后应用风险、报警和显示。

窗口包含起止积分样本位置（结束为 exclusive）、窗口 Z 能量/样本数、边界累计 A 能量/样本数和来源块序号。当前块级 RMS 独立保存，不能用块末累计快照冒充较早窗口。

### 6.5 背压与频谱查询

core 事件容量不足时，输入不得提交，可先 drain/ack 后重试。adapter 还须限制输入队列容量和驻留时间，因为麦克风不会等待 core。

- shadow 拥塞：JS 权威路径继续，比较标记 incomplete；不得将跳过输入后的 Rust 状态继续当完整对照。
- Rust-primary 拥塞：明确故障/停止并保留最后可证明摘要；不能静默丢 PCM 后保存完整测量。

`query_current_spectrum` 基于已提交完整缓冲，不推进样本、hop、窗口或事件时钟；不足完整窗返回不可用。读取输出的内存有效期和复制/ack 顺序归 ABI 契约管理。

## 7. 数值、系数和版本

`NUMERIC_SEMANTICS.md` 必须逐项说明输入单位、Float32 写回、f64 状态和累积、求和次序、初值、舍入、下限、NaN/Inf、窗口和 tail 终止条件。不得用全 f64、Kahan 求和或另一套滤波设计替代基线后宣称纯迁移。

A 计权首先冻结当前 JS generator 在 44.1 kHz 的系数，包括 gain、二阶节和 FIR；记录生成器来源和环境。数值身份哈希按固定字段顺序的 IEEE-754 binary64 little-endian 字节计算，文件哈希另存。DC、窗口等生成量也需说明是否冻结以及跨运行时误差预算。

FFT 库仅替换 DFT kernel，应用自有的窗、归一化、floor、输出长度和频带口径保持。第一轮不扩展整个应用的 48 kHz 支持，不删除其它模块仍引用的 JS 工具。

结果记录：scientific_algorithm_version、core_implementation_version、abi_version、coefficient_value_sha256、backend_type、build_artifact_hash、numeric_compatibility_profile。科学结论必须关联实际配置和数值 profile；新 profile 不自动继承旧验证结论。

## 8. fixtures 与验收

每个信号 fixture 至少保存：

```text
pcm.i16le
metadata.json       # 来源/采样率/单位/种子/哈希/基线提交/执行环境
chunks.json         # 原始块长度及切片位置
events.json         # 按序控制事件、视图请求、原生停止及模拟证据
expected.json       # 块结算、质量、窗口、快照和最终结果
spectra/            # 如需保存完整频谱，明确二进制布局与索引
```

区分合成信号、Mock 平台事件和真实设备采集。生成样本的 golden outputs 是 JS 行为参考，不是独立声学真值。禁止将临时目录、真实用户录音或凭证无选择地打包。

初始代表集覆盖：静音、空输入、1 kHz、20/31.5/63/125/500/4000/8000 Hz、非整频点、DC、near-full、削波、亚满幅平台、不同块划分、短记录、两级能量序列、多窗口块、频谱切换、partial/unverified、终止无效和停止排队。

decision-boundary corpus 单独标明为应用决策测试，覆盖阈值下/上/等于、风险标签、报警、canSave、dataQuality 和 measurementScope。不要宣称 Int16 声学样本能任意精确命中微小 dB 边界；必要时在明确的 domain 输入接口验证判级，并另保留端到端 PCM 测试。

验收分类：计数/序号/事件顺序/窗口边界/质量/拒绝判定要求一致；能量按绝对加相对容差，Leq 按 dB 容差，FFT 按功率域和低功率/floor 单独规则。尾补零数及收敛行为单列核查。应用决策不因 DSP 差异落在容差内就自动放行。

容差应依据运算误差预算、Float32 写回、目标运行时和 FFT 误差，在观察最终 Rust 差异之前由协调者冻结。现有频响探针的约 0.0084 dB 观测误差不是迁移容差。未确定的数值必须标为待审，禁止代理自行放宽。

故障矩阵至少包含：错误句柄/格式/序号、声学拒绝、Pending 取消、队列满、commit 后读失败、重复 ack、memory.grow、trap、旧会话响应、停止时 Pending/多块排队、终止后的排队块、重复 finish、tail 故障和原生停止超时。

## 9. 阶段及完成门槛

| 阶段 | 产物和门槛 |
| --- | --- |
| Phase 0 | 五项基线产物、隔离复现入口、样本哈希、已知失败清单；完成交叉审阅 |
| 0A | 独立 hello-DSP 能力验证：目标 Android/iOS、加载/调用/内存/Worker/故障/包体/冷启动；不接管生产 |
| 1 | 建立 noise-core，归一化/DC/能量/Leq；native 与 WASM 分别对基线验证 |
| 2 | 固定 A 系数、质量结算、块拒绝和 tail；验证分块及结束约定 |
| 3 | 窗口、FFT、频带和主动查询；冻结原始控制事件对应关系 |
| 4 | 薄适配器 shadow 接入，JS 权威，记录比较覆盖和差异 |
| 5 | 完整数值、状态、决策、故障、延迟与内存验收后按会话灰度；保留回退版本 |
| 6 | 独立 speech RFC 和验证；resample→YIN→HNR→LPC→formant，保留实验性质 |

0A 的 hello-DSP 只能证明运行能力，不能证明完整 FIR/FFT/tail 的延迟。同步 `process_chunk` 或 cooperative step 的最终选择，应依据 Phase 2/3 实际核心在真机上的 p95/max、取消和调度测量。先冻结事务语义，不提前强制具体 step ABI。

每阶段交付修改文件清单、接口/契约、测试及命令、数值差异、已知失败、未迁移内容和源码/产物身份。阶段验收不以全部科学性测试转绿为要求；已有失败必须持续保留，不能删除或放宽条件。

## 10. 无缝集成和回退

`legacy / shadow / rust-primary` 在会话启动时选定并记录。WASM 未就绪或加载失败时，新会话走 legacy，不让录音依赖加载成功或实验室校准。

shadow 中 JS 从首样本权威运行，Rust 失败只影响比较。Rust-primary 的中途失败不能重新初始化 JS 再拼接剩余音频；若产品要求当前会话也能连续回退，必须额外维持从首样本同步的 JS 状态，并验证双算开销及整份结果选择语义。

首个生产适配入口限定为噪声监测。RecorderManager、权限、中断、Storage、校准表单、历史读取和其它语音调用者保持原模块。记录 schema 保持兼容，新增身份字段为可选项，缺失旧元数据不导致历史被强制作废。

生产入口配置和资产复制由协调者独占。每次接入检查主线差异白名单、打包内容、源/Worker 一致性、录音二次启动、跨页、权限恢复、保存回读和现有页面样式。仅核心单元测试通过不足以启用 Rust-primary。

## 11. 可直接委派的任务模板

### 共同前置说明

> 以提交 3a0d6765147c56d2a73e1cec78f6106ae2e681ab 为基线。当前任务只完成 Phase 0。生产代码只读，所有输出写入指定 rs-core 子路径。保持原算法、原始块边界和已知失败，不修基线问题、不创建生产 Rust、不接入页面、不推送。核对每项声明的源码位置；发现冲突报告协调者，不修改其它任务的文件。交付实际修改路径、完成项、未完成项和验证证据，不把模拟数据称为真机验证。

任务 A：还原基线 signal-state machine，独占 CURRENT_SIGNAL_STATE_MACHINE.md，特别核对质量提交、整块拒绝、秒级前缀、FFT 两类触发、停止尾处理和终止忽略。

任务 B：依据已核对基线和本方案整理 CORE_STATE_CONTRACT.md，独占该文件。明确正常 Q+D、拒绝 Q-only、Closing/SignalTerminated、两个栅栏、receipt/ack、背压和快照可见性；未定项显式列出，不自行扩大 ABI。

任务 C：整理 NUMERIC_SEMANTICS.md 与 MIGRATION_ACCEPTANCE.md，独占两文件。列出原始类型及运算路径，建立误差预算、字段级验收和应用阈值/故障矩阵，保留未通过的科学性条件。

任务 D：在 tools、fixtures、reports 内建立隔离基线复现。只运行审阅后的明确脚本，保存原始块与控制事件，重复运行检查确定性；原 docs 报告不覆盖。先交付脚本检查再运行，不使用未经授权用户录音。

### DSH/AGY 执行规则

只读文档审阅任务明确禁止文件和外部状态修改；写入任务仅在当前委派已授权范围内启用 mutation，并提供上述独占路径。

AGY 多步骤工作使用持久任务，保留 task_id 并收集最终结果；构建/测试授权使用经过审阅的精确 allowed_commands。空命令列表表示无终端命令权限。不得以通用 python、node、shell 或任意 Cargo 命令替代精确授权。命令入口须先实现和审核，本方案没有声称这些未来工具现已存在。

DSH/AGY 报告为待核查交付，协调者检查文件差异、命令记录、退出码和事实。failed、interrupted、权限拒绝或部分答案不算完成。禁止发送凭证或无关私密资料；禁止自动提权、绕过沙箱、扩大命令授权或修改供应商配置掩盖失败。

## 12. 当前方案落盘后的下一步

先由协调者落实执行隔离与主线打包排除，再派发 A/B/C/D。五项 Phase 0 产物交叉审阅完成后进入 0A；在此之前不替换小程序计算入口。主线修复和 Rust 核心可独立推进，所有算法基线升级与生产接入都经过明确的版本和验收记录。
