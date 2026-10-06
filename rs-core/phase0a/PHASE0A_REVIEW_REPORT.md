# Phase 0A 源码与桌面验证交付报告

日期：2026-10-05。P0科学基线保持 `3a0d6765147c56d2a73e1cec78f6106ae2e681ab`。

## 当前结论

Rust源码、独立WASM产物、通用宿主及独立微信测试项目已落地。桌面验收通过，状态为 `PASSED_HOST_VERIFICATION_PENDING_WECHAT_DEVICE`。Android/iOS真机及Worker仍是UNRUN，因此正式Phase0A准入门槛尚未全部完成，不能据此开始P1声学结果比较。

本轮实现4096个f32的固定输入/输出缓冲、简单增益处理、错误返回和陷阱注入，属于hello-DSP能力探针。没有DC/A滤波、Leq、FFT、噪声风险或语音算法移植，没有接入生产录音。

## Rust源码与运行入口

- [计算探针源码](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/src/lib.rs)：no_std、拥有缓冲的ProbeBuffers、先全量验证再写输出，失败无部分提交。
- [WASM导出层](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-wasm/src/lib.rs)：Rust2024导出、WASM限定的静态状态、单实例调用与panic/trap隔离。
- [原生测试](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-core/tests/probe_tests.rs)与[导出层原生测试](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/crates/noise-wasm/tests/wasm_export_tests.rs)。
- [通用host](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0a/probe-host.cjs)和[真实WASM验证](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0a/check-wasm.cjs)。
- [Python构建验证入口](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/tools/run-phase0a.py)：在rs-core目录运行 `python tools/run-phase0a.py`，锁定/离线构建并生成报告，通过Node验收后同步测试资产。
- [独立微信项目配置](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0a/wechat-probe/project.config.json)：开发者工具导入该文件所在目录，配置测试AppID后做真机预览。默认touristappid供本地导入，不使用生产项目配置。

## 实际验证

| 项目 | 实际结果 |
| --- | --- |
| Rust工具链 | rustc1.95.0 / cargo1.95.0，完整版本记录在运行报告 |
| wasm32v1-none | Codex经环境自动审批后安装成功，并确认installed target |
| 原生测试 | 10项core + 2项安全元数据/独立实例测试，12/12通过 |
| WASM编译 | release/locked/offline成功，无外部crate依赖 |
| Node实际WASM验收 | 25/25通过，0外部导入；不是JS代算 |
| 格式与lint | rustfmt检查、native all-targets和WASM release clippy -D warnings通过 |
| WX接口形态审计 | 真实Rust WASM、VM中无标准WebAssembly全局、实例化直接返回Instance；17项host检查及页面7步通过，仍属桌面模拟 |
| 资产身份 | 编译产物与微信项目副本相同，host.cjs与host.js字节相同 |
| P0隔离 | 174个基线源文件未改变、26组/138个冻结数据文件保持完整，rs-core打包排除保留 |

WASM大小1656字节，SHA-256：`3e9b7d190e3ea5b876cf50fa26a733f75079f1691d784a67a9a274a498dce7fe`。初始线性内存17页，Node实际增长到18页，旧buffer失效，新视图继续正确运算。

位级数值检查采用编码前规定的 `[-1,-0.5,0,0.25,1] * 0.5`。另验证空/满/超容量、u32边界、NaN/±Inf、f32增益转换上溢、正负乘积溢出、全4096项输出保持、两个活实例隔离、真实RuntimeError和新实例恢复。该精确乘法用例不提供完整声学迁移容差。

证据：[运行报告](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/phase0a-report.json)、[独立源码与产物审计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/phase0a-independent-audit.json)、[WX接口形态审计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/phase0a-wx-shape-audit.json)、[AGY精确命令审计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/phase0a-agent-command-audit.json)。

执行日志保留Windows增量缓存硬链接不可用、改用复制的提示；这没有导致测试失败。代理“无任何告警”的文字不作为验收事实。

## 分工与父审纠正

DSH ecnu-max完成设计边界独立复核。AGY gemini-3.8-flash-high完成主要Rust、宿主、测试项目和验证工具，随后按父审修正，并在新受限执行任务中运行四条精确授权命令。

Codex负责workspace/lock/toolchain、组件安装、交付审读及少量纠正。实跑初稿发现7个Rust2024导出属性错误，未计为通过；修正后重跑。另核查并纠正native静态Sync数据竞争、地址截断、微信缺标准WebAssembly全局、f32字面量误比较、长度wrap、错误提交及trap后读值、测试项目生产AppID和Worker UNRUN误列PASS等问题。

## 官方接口支持与未证实项

采用保守的wasm32v1-none目标；Rust官方说明其默认只启用WebAssembly Core1.0集合并支持no_std的core/alloc。[Rust目标说明](https://doc.rust-lang.org/stable/rustc/platform-support/wasm32v1-none.html)

微信官方页面本轮无法打开，另核查Tencent官方API类型：WXWebAssembly.instantiate接收包内路径，返回Promise<Instance>，并定义memory.buffer/grow；通用host同时支持Node返回包装对象。[Tencent官方类型定义](https://raw.githubusercontent.com/wechat-miniprogram/api-typings/master/types/wx/lib.wx.wasm.d.ts)

类型定义和桌面API模拟不证明任何手机、微信基础库或Worker可用。页面只报告实际运行的主线程基础检查，Worker单独显示UNRUN。开发者工具/真机尚未执行，不声明发布包已真机验证；当前独立项目资产不进入生产包。

## 下一阶段前置条件

需要目标Android/iOS真机日志，以及Worker、冷启动/销毁、失败恢复和包体的实际记录。微信测试页目前提供基础主线程检查，尚未实现完整Worker或移动端压力测试；不能把页面的“基础检查通过”当作完整0A通过。

在第一次Rust声学结果比较前，另冻结独立误差预算及生产ABI的receipt/ack、过期查询、空块结算、非有限值表示。完整FIR/FFT/tail延迟需以实际实现实测，不能从本探针吞吐推导。

小程序主线仍走JS；未校准保存、旧实验室预设和历史数值未改动。本轮未提交、推送或发布。
