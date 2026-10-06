# Phase 0A：独立 Rust/WASM 运行探针

用户“请继续”授权从P0推进下一阶段，延续AGY多承担工作、DSH独立复核、Codex监督及少量编写的分工。全部产物在rs-core；不改生产app/pages/utils/workers，不更新P0 frozen资产、不接生产录音、不推送。Cargo根、锁文件、两crate manifest、rust-toolchain由Codex独占，其余授权路径按以下分工。

## 本轮范围与门槛

仅实现hello-DSP探针，不移植DC/A/Leq/FFT或任何语音算法，不宣称科学迁移等价。正式P1仍要求0A目标真机能力与独立误差预算/ABI冻结。本轮原生/WASM探针的数值验证只用预先规定的精确二进制数，因此不借此冻结完整声学迁移公差。

Rust工具链已安装stable/rustc1.95.0，仅x86_64-pc-windows-msvc target可用。优先无外部crate依赖，noise-core no_std；noise-wasm wasm构建no_std+panic abort。目标先选wasm32v1-none，以Rust官方说明的WebAssembly Core1.0 feature集合做保守能力探测（https://doc.rust-lang.org/stable/rustc/platform-support/wasm32v1-none.html），不声称微信一定支持。原生测试可使用std test harness。不要代理安装组件、联网、更改权限或Cargo配置。

## 0A专用ABI v1（不是生产测量ABI）

- input/output为两个独立、固定4096个f32缓冲，WASM实例内持有，无malloc/free和宿主任意指针参数。
- probe_abi_version()->u32 返回1；probe_capacity()->u32 返回4096。
- probe_input_ptr()/probe_output_ptr()->u32（仅wasm导出，字节偏移，4字节对齐）。
- probe_process(len:u32,gain:f32)->i32：0成功；-1长度超过capacity；-2gain非有限；-3输入存在非有限；-4乘积非有限。先全量验证后才改output；失败不部分提交。len=0合法、不改output。
- probe_reset()清空两缓冲；probe_force_trap()仅wasm导出故障注入，使用wasm unreachable。探针trap后宿主必须作废实例，后续新建实例复验，不能继续读测量值。
- 同一实例不得并发/reentrant调用；无shared memory/线程；禁用生产数据使用。unsafe只限wasm固定缓冲边界层，注明安全依据，避免static mut共享引用或原生测试并发全局状态。
- 原生安全逻辑采用拥有缓冲的ProbeBuffers实例，可单测独立实例；外层wasm固定实例按相同规则调用。

## 预先冻结的简单验证输入

input=[-1,-0.5,0,0.25,1]，gain=0.5，expected=[-0.5,-0.25,0,0.125,0.5]，f32位级精确相等。另测capacity边界、空输入、len>capacity、NaN/±Inf输入/gain、乘积溢出且output不变、重复reset、实例隔离、trap与新实例恢复。memory.grow后宿主必须重新获取memory.buffer与view，不保留旧TypedArray。

## 分工

AGY独占：crates/noise-core/src/、crates/noise-wasm/src/、必要crate tests/，phase0a/probe-host.cjs、phase0a/check-wasm.cjs、phase0a/wechat-probe/、phase0a/README.md、tools/run-phase0a.py。禁止其它文件。仅文件读写，无终端命令；父审后再给精确命令授权。

DSH独占phase0a/INDEPENDENT_REVIEW.md；只读P0文档、baseline有关段落和本brief，给0A语义边界、WASM/raw-memory风险及P1误差预算冻结的独立意见；不改其它文件，无终端/构建/外部状态。不要编造0A/P1通过结果。

Codex：manifest/lock/toolchain、安装目标的必要受控步骤、预检/最终验收报告。其它模型输出均待核验。

## AGY交付要求

1. Rust源码实现上述probe，清晰标实验探针；不写生产声学placeholder算法冒充迁移。
2. 通用host模块可注入instantiate实现：Node读bytes；微信WXWebAssembly读包内路径。握手、内存范围/对齐校验、fresh视图、简单验证、失败实例作废。不要eval或动态下载代码。不能静默以JS代算冒充WASM成功。
3. check-wasm.cjs读取本地真实.wasm：imports/exports/bytes/hash、握手、精确输入、越界/无效参数、memory.grow旧view失效、trap/新实例；实际机器信息、耗时与内存观察。报错最终非0，无真实wasm就明确UNRUN。
4. 独立微信测试项目放phase0a/wechat-probe，只有能力验证页及可选独立worker，测试资产assets/noise_wasm.wasm由工具复制。无麦克风权限/录音代码、不修改主项目路由。将wx/WXWebAssembly真实API与尚未实测假设区别，记录微信版本、基础库、系统、实例化/调用错误。按钮触发测试，进度/error/完成结果清楚、样式简洁，不把技术参数混进生产UI。
5. run-phase0a.py仅写rs-core内reports、target、phase0a/wechat-probe/assets，manifest/lock预期。使用subprocess argv无shell，offline/locked构建，工具链与target检查，缺target不得伪通过或自行装组件。原生cargo test、wasm32v1-none build和Node实际artifact验证分阶段，真机结果一律UNRUN直到用户提供。
6. README写实际文件/命令/限制/未跑项目，性能仅probe，不推导完整DSP p95。若微信官方页面读取失败，标核查限制而不编造调用承诺。

仅简明汇报修改文件和未确定点，父代理审读后执行；无安装、推送、Rust主线接入、外部依赖或权限绕过。
