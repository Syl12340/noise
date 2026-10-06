# AGY 后续任务：文档纠错与基线冻结工具

用户已授权处理源码，并要求 AGY 多承担工作。基线只读目录 `_work/baseline`，提交 `3a0d6765147c56d2a73e1cec78f6106ae2e681ab`。

唯一写入路径：自己的 CORE_STATE_CONTRACT.md/MIGRATION_ACCEPTANCE.md 纠错，以及 tools/freeze-vectors.cjs、tools/run-phase0.py、phase0/fixtures/README.md。其它文件包括 DSH 文档、生产代码、配置、prepare_baseline.py/check_isolation.py 和根 docs 不得修改。

仅文件工具读写，allowed_commands 为空，不执行命令/测试/构建/安装/推送。父代理会审查工具后再精确授权执行。若权限受限，交付部分成果和阻塞，不绕过。

## 父审必须纠正的内容

1. 迁移容差必须在首次 Rust 数值比较之前依据独立误差预算审定，不能在 Phase 1/2 得到 Rust 差异以后确定。没有依据的数值建议不能称已推导或已冻结。
2. 46 样本容差保持原定义，不按机型放宽；改变必须另立算法/平台语义变更事项。抖动、时钟差、时长量化与丢帧不是同一概念。
3. FIR 是 129 抽头、128 阶。纯 core 频谱查询只读 DSP 状态；legacy helper 会改变显示缓存并可能 append 谱图，不能说其完全无副作用。
4. archive 实际字段超过矩阵列举项；captureIntegrity 不是直接的 archive 字段，应引用 coverage.integrityStatus 等实际路径。不要称不完整的矩阵已覆盖每个字段。
5. 持续 DC 块属于 noAcSignal/digitalSilence，足够长时在进入 DC filter 之前已被拒绝；不能把它写成正常 accepted 然后验证滤波衰减。DC 滤波单元测试与整段应用行为分开。
6. 停止超时没有原生确认时不得强制“归档完整结果”；根据实际 baseline 返回 pending/invalid/未完成证据，核对代码，不发明兜底冻结。
7. 任意 callback 分块不保证质量/应用输出相同；只要求已接受数学流的滤波分块一致性，基线 chunk-local quiet 判定必须分别冻结结果。
8. 冷启动100ms、包体200KB没有本项目依据，不得设为已批准准入阈值。实际引擎映射也未经核查，不写 iOS/Android 必然采用某 JS 引擎。
9. 验收清单必须包含 fixtures 与实际基线执行证据，不能把已有实施方案算作替代第五项 fixtures。边界“防护带”不能夹入纯迁移。

## 工具任务

实现 tools/freeze-vectors.cjs：通过基线 tests/runtime.cjs 加载真实 main.js。若使用 runtime transform，只在内存加入观测 hook，替换数量必须断言；磁盘基线永远不改。不要独立重写生产流水线冒充端到端 golden。

生成20–24个合成 fixture：PCM i16le、原始 chunks、按序 Mock events、metadata、expected（块质量/计数、秒边界前缀、尾、结束与快照）。频谱可存 f64le。覆盖多频、非整频、quiet/short/DC/near-full/clipping、50ms整块拒绝、终止后忽略、两级能量、多窗口 chunk、按需 FFT/主动视图查询、partial/unverified、结束事件。

若 UI方法 mock 困难，可以明确模拟控制边界，但不可声称真实UI或真实设备验收。应用精确阈值另做 domain corpus，调用内存观测导出的原函数，比较 main 与 risk-config；不伪称 Int16 PCM 任意微dB命中边界。

实现 tools/run-phase0.py，CLI 为 freeze/verify。只写 rs-core/_work 临时副本、phase0/fixtures、reports。校验 BASELINE_SOURCE_MANIFEST，生成两次比对所有 payload SHA；时间等不污染确定性。verify 不改 golden。回归只在额外副本运行，不写只读 baseline 或根 docs。跑原138工程、targeted14、包检查、algorithm-evaluation；1/83既有失败保留。可跑两个 formant 集保留门槛失败。无依赖安装，Praat可明确未跑。

路径白名单、无shell拼接、不递归删除主工程、不输出凭证、UTF8、简洁运行摘要。脚本尚未运行时必须如实标明，不能声称 fixture 或回归已完成。

交付五个真实文件、待审项、预计运行命令及依赖。AGY旧任务已完成，本任务不与其它 AGY 写任务并发。
