# Phase 0A: 独立 Rust/WebAssembly 运行探针

Phase 0A 为轻量级 Hello-DSP 运行探针工程，旨在验证 Rust 编译到 WebAssembly（`wasm32v1-none` 目标）在通用 Node.js 宿主及微信小程序环境（`WXWebAssembly`）中的基础运行能力、内存管理与 IEEE-754 浮点数值精度。

当前状态（2026-10-05）：源码和WASM已生成，12项原生测试及25项Node实际WASM检查通过，目标组件已安装。真机/Worker仍为UNRUN；完整证据与剩余门槛见 [交付报告](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0a/PHASE0A_REVIEW_REPORT.md)。

> [!IMPORTANT]
> **本轮范围与边界声明**：
> 1. 本工程**仅包含实验性验证探针**，未实现 DC 去除、A 计权滤波、FFT 频谱分析或 Leq 等效连续声级等任何生产声学算法。
> 2. 本阶段数值验证仅基于预先规定的精确二进制测试数，**不代表生产声学算法迁移完成**，亦不冻结完整声学迁移公差。
> 3. 探针测得的微基准性能数据仅反映探针缓冲区乘法吞吐，**严禁据此推导完整生产 DSP p95 延迟**。
> 4. 真机测试结果在获得真实设备运行日志前**一律保持 UNRUN 状态**，不编造真机结论。
> 5. 打包隔离确认：主项目 `project.config.json` 已配置将 `rs-core` 纳入 `packOptions.ignore`，打包隔离已实际落地。

---

## 1. 交付物路径清单

所有产物均严格限制在 `rs-core` 目录内，未修改任何生产业务代码：

| 模块 / 资产 | 绝对路径 | 职责说明 |
| :--- | :--- | :--- |
| **noise-core 源码** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\crates\noise-core\src\lib.rs` | 探针核心缓冲逻辑、ABI v1 常量、`usize` 原生地址、全量原子校验（失败无脏写） |
| **noise-core 单元测试** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\crates\noise-core\tests\probe_tests.rs` | 覆盖位级精确性、全 4096 项不变性、独立 NaN/±Inf/乘积溢出拦截与地址对齐测试 |
| **noise-wasm 源码** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\crates\noise-wasm\src\lib.rs` | `#[unsafe(no_mangle)]` (Rust 2024)，静态 FFI 仅在 `wasm32` 编译（杜绝原生数据竞争） |
| **noise-wasm 单元测试** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\crates\noise-wasm\tests\wasm_export_tests.rs` | 原生环境仅测纯元数据与独立安全 `ProbeBuffers` 实例 |
| **通用宿主模块** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\phase0a\probe-host.cjs` | CommonJS 宿主库：注入式实例化、结构化鸭子类型检验内存、严格 u32 判界、fresh 视图、作废隔离 |
| **Node.js 验收脚本** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\phase0a\check-wasm.cjs` | 真实 `.wasm` 静态反射 (0-import)、精确数值验证、双活实例隔离、grow 视图失效与 RuntimeError 捕获恢复 |
| **独立微信测试项目** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\phase0a\wechat-probe\` | 独立小程序项目：包含测试页与字节一致的宿主模块，无录音/无麦克风权限，Worker 标 UNRUN |
| **构建验证入口** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\tools\run-phase0a.py` | Python 编排脚本：绝对路径范围限制、超时保护、强制 lockfile、仅验收成功后同步资产 |
| **本说明文档** | `C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\phase0a\README.md` | Phase 0A 规范、ABI 契约、命令指南与限制说明 |

---

## 2. Phase 0A ABI v1 契约规范

ABI v1 专为 Phase 0A 运行探针设计，不作为生产测量 ABI。

### 2.1 内存与缓冲区
- 实例内部持有两个独立、固定大小的 `f32` 缓冲区：`input` 与 `output`，各容纳 **4096** 个单精度浮点数（各自占用 16,384 字节）。
- 无任何动态内存分配（零 `malloc`/`free`），不接收宿主任意指针参数。
- 缓冲区起始地址严格保证 **4 字节对齐**。
- 两缓冲区区间彼此不重叠。
- 原生环境下提供 `input_addr() -> usize` 与 `output_addr() -> usize`，保留完整原生指针宽度，仅在 WASM 导出层转为 `u32`。

### 2.2 导出接口清单
```rust
#[unsafe(no_mangle)]
pub extern "C" fn probe_abi_version() -> u32;    // 返回固定值 1
#[unsafe(no_mangle)]
pub extern "C" fn probe_capacity() -> u32;       // 返回固定值 4096
#[unsafe(no_mangle)]
pub extern "C" fn probe_input_ptr() -> u32;      // 输入缓冲在 WASM 线性内存中的字节偏移
#[unsafe(no_mangle)]
pub extern "C" fn probe_output_ptr() -> u32;     // 输出缓冲在 WASM 线性内存中的字节偏移
#[unsafe(no_mangle)]
pub extern "C" fn probe_process(len: u32, gain: f32) -> i32; // 计算处理与全量校验
#[unsafe(no_mangle)]
pub extern "C" fn probe_reset();                 // 清空 input 与 output 缓冲 (置 0.0)
#[unsafe(no_mangle)]
pub extern "C" fn probe_force_trap();            // 故障注入：执行 wasm unreachable 指令
```

### 2.3 `probe_process` 错误代码与全量校验原则
- **`0` (PROBE_ERR_OK)**: 校验通过且处理成功。
- **`-1` (PROBE_ERR_LEN_OVERFLOW)**: 请求长度超过容量 (`len > 4096`)。
- **`-2` (PROBE_ERR_NON_FINITE_GAIN)**: `gain` 为非有限数（`NaN`、`+Infinity` 或 `-Infinity`）。
- **`-3` (PROBE_ERR_NON_FINITE_INPUT)**: 输入切片 `input[0..len]` 中存在非有限数。
- **`-4` (PROBE_ERR_NON_FINITE_PRODUCT)**: 乘积 `input[i] * gain` 产生溢出（得到非有限数）。

**原子性与全量校验保证**：
- 宿主侧首先校验 `len` 为无符号 32 位整型（`Number.isInteger(len) && 0 <= len <= 0xFFFFFFFF`），拒绝负数、小数及超过 $2^{32}-1$ 的输入，杜绝跨语言静默 wrap；
- 探针核心内部显式先判界 `len > 4096`，再按 `-1` -> `-2` -> `-3` -> `-4` 进行全量两趟扫描，确认全部合法后方写入 `output[0..len]`；
- 若出现任何错误（-1 至 -4），**立即退出且 output 完整 4096 项逐位保持不变**，禁止部分提交脏数据；
- `len = 0` 为合法操作，直接返回 `0`，且 output 完整 4096 项不发生任何修改；
- 合法 `len` 执行后，`len..4096` 未触及区域保持原有内容不变。

### 2.4 实例隔离与陷阱处理
- 静态 FFI 单例仅在单线程无 atomics 的 `wasm32` 目标下编译；若开启 atomics 则触发 `compile_error!`；
- 原生环境下杜绝任何全局静态 `UnsafeCell`，原生测试一律使用拥有缓冲的局部 `ProbeBuffers` 实例，彻底消除并发数据竞争；
- 调用 `probe_force_trap()` 将触发 `wasm unreachable` 导致宿主捕获 `WebAssembly.RuntimeError`。探针发生 trap 或意外返回后，宿主**必须将该实例作废（disposed）**，禁止后续读取，必须新建实例方可恢复测试。

---

## 3. 预先冻结的测试向量

所有平台验证均采用以下位级精确测试向量：
- **输入序列**：`[-1.0, -0.5, 0.0, 0.25, 1.0]`
- **增益系数**：`0.5`
- **预期输出**：`[-0.5, -0.25, 0.0, 0.125, 0.5]`
- **比对要求**：IEEE-754 32位无符号整数表示精确一致（例如 `0.125f32` 对应十六进制 `0x3E000000`）。
- **哨兵值策略**：所有未触及区域与失败检验均采用在 f32 下二进制精确可表示的双字或二进分数哨兵（如 `42.5`、`64.0`、`128.5`），严禁使用不可精确表示的双精度字面量。

---

## 4. 宿主与验证规范

### 4.1 通用宿主模块 (`phase0a/probe-host.cjs`)
- 支持依赖注入 `instantiateFn(source, imports)`：
  - Node.js 环境传入 `(buffer, imports) => WebAssembly.instantiate(buffer, imports)`；
  - 微信环境传入 `(path, imports) => WXWebAssembly.instantiate(path, imports)`，同时兼容 Node 的 `{ instance, module }` 与微信的直接 `Instance` 返回格式。
- 内存校验采用结构化鸭子类型检验（检查 `exp.memory.buffer instanceof ArrayBuffer` 与 `typeof exp.memory.grow === 'function'`），**绝不使用 `instanceof WebAssembly.Memory`**，避免在仅有 `WXWebAssembly` 的微信环境中抛出 `ReferenceError`。
- 提供 `getFreshViews()` 方法：每次读写前重新基于当前的 `memory.buffer` 构造 `Float32Array`，防御 `memory.grow` 导致的 ArrayBuffer 游离失效（detached buffer）。
- `phase0a/wechat-probe/probe-host.js` 与 `phase0a/probe-host.cjs` 保持严格字节一致，杜绝双套逻辑漂移。

### 4.2 独立微信测试项目 (`phase0a/wechat-probe/`)
- 位于独立子目录，包含完整独立的小程序配置文件。
- **零权限侵入**：无 `scope.record` 麦克风权限请求，无任何录音 API 调用。
- **事实与假设分离**：
  - 运行时实测事实：微信基础库版本、操作系统平台、`WXWebAssembly` 全局对象是否存在。
  - 待实测假设：Worker 独立线程中的 WASM 支持情况当前明确标为 **UNRUN**，等待真机环境提供实测证据。

---

## 5. 执行与构建操作指南

以下构建验证命令已由父代理审查并授权执行；保持离线/锁定。工具不会自行安装组件。

### 5.1 原生单元测试 (锁定离线)
```bash
cargo test --locked --offline
```

### 5.2 编译 WebAssembly 探针 (需已安装 wasm32v1-none)
```bash
cargo build --target wasm32v1-none --release --locked --offline -p noise-wasm
```
构建产物生成于 `target/wasm32v1-none/release/noise_wasm.wasm`。

### 5.3 一键自动化编排 (Python)
```bash
python tools/run-phase0a.py
```
执行结果将输出到控制台并持久化保存至 `reports/phase0a-report.json`。
自动化工具在 Stage 4 (Node 验收) exit code == 0 且 status == PASSED 后，会自动同步 `.wasm` 与 `probe-host.js` 到微信测试项目并计算哈希。

### 5.4 微信开发者工具与真机测试步骤
1. 打开“微信开发者工具” -> 选择“导入项目”。
2. 项目目录选择：`C:\Users\Shaoyilei\WeChatProjects\noise-1\rs-core\phase0a\wechat-probe`。
3. 默认配置为touristappid；真机预览需在该独立项目中配置测试AppID，并记录实际基础库版本。
4. 在模拟器或真机预览中点击 **“执行 Phase 0A 探针测试”** 按钮。
5. 观察分步记录（握手、精度、边界、故障恢复），如实记录设备型号与执行结果。

---

## 6. 契约偏离与未确定点说明

1. **工具链 Target 依赖**：
   - 目标wasm32v1-none已由Codex经自动审批后安装，当前构建通过；AGY和验证工具不执行安装。
2. **真机环境待实测项**：
   - 开发者工具、桌面模拟与手机平台的运行时行为需分别实测，不能仅凭操作系统推断其具体执行引擎或兼容性；
   - 真机状态目前严格标记为 **UNRUN**，待操作员或测试人员在目标设备上实际运行后回传日志；
   - 独立 Worker 环境中的 WASM 运行能力同样标记为 **UNRUN**。
