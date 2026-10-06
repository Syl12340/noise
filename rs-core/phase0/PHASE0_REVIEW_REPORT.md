# Phase 0 监督审阅与交付报告

日期：2026-10-05。固定基线：`3a0d6765147c56d2a73e1cec78f6106ae2e681ab`。

## 结论

Phase 0 的基线事实、契约草案、数值语义、验收设计、合成向量与隔离复现已落地并经父代理审查。可以作为后续独立 Phase 0A 能力验证的输入。当前没有 Rust 实现、页面接入或真机 WASM 验证；本报告不授予开始生产替换或发布的权限。

数值迁移容差仍为待审提案，必须在首次 Rust 结果比较前依据独立误差预算冻结。ABI 的收据保留/ack、过期查询与空块结算也须在相关接口编码前落实，不能把草案接口当已实现协议。

## 实际交付

- [实施方案](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/MIGRATION_IMPLEMENTATION_PLAN.md)
- [当前信号状态机](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/CURRENT_SIGNAL_STATE_MACHINE.md)
- [核心状态契约](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/CORE_STATE_CONTRACT.md)
- [数值语义](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/NUMERIC_SEMANTICS.md)
- [验收设计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/MIGRATION_ACCEPTANCE.md)
- [冻结向量说明](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/phase0/fixtures/README.md)及26组PCM/原始块/事件/元数据/结果；其中4组另有实际FFT观测数据。
- 44.1 kHz A滤波器真实系数：142个f64LE，含两节参数、gain和129tap FIR。二进制SHA-256：`0a134c19fd02b45da4b979d2f92720644bc8bc159a04242ec58b1c5dade0c7ae`。
- 隔离复现入口：[run-phase0.py](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/tools/run-phase0.py)。已有向量拒绝覆写；verify在候选目录重算并比较全部数据文件，仅排除README，不修改golden。

## 并行执行与监督

DSH健康检查对应 `chatecnu/ecnu-max`。实际两次文档任务均返回失败，初次留下状态机初稿，数值文档未交付；失败未计为完成。AGY按用户要求承担较多工作，补齐数值文档、纠正状态机、撰写契约及验收、实现和修正样本工具，最后执行精确授权命令。DSH与AGY的文档/工具路径分离；同一AGY工作目录内的编辑任务按桥限制接续。

Codex负责基线导出与打包隔离、交付审查、少量文档/工具纠正和独立审计。未采信代理初稿中的错误声明：包括恒DC永不到滤波器、Infinity分类兜底、极弱输入必定固定tail步数、请求停止即关闭正常尾帧、f32块分贝、名义频率替代精确频带中心，以及错误近似滤波系数。

工具初稿经运行预检发现问题，冻结前已纠正：无效函数调用、Mock多计启动时间、终止证据丢失、另算FFT冒充页面观测、报警未触发、仅比较部分文件或formant长度等。最终向量来自真实基线函数的内存观测；宿主绘图与录音平台仍为Mock。

AGY旧文档会话追加命令权限失败且未执行；按桥提示新建受限执行会话成功，无全局权限或账户配置修改。最终执行任务：`22b7b9e4-cbb4-45c8-9370-f2e0e0a6703d`，模型 `gemini-3.8-flash-high`。

## 实际验证证据

| 检查 | 结果与边界 |
| --- | --- |
| 基线身份/隔离 | 174个导出文件SHA-256匹配；生产JS、页面和worker未修改 |
| 工具预检 | Node语法检查及26组实际运行均退出0；未校准可保存、单块跨两秒、真实报警已核对 |
| 双候选冻结 | 26组，138个数据文件，两次全部字节散列相同 |
| 重算verify | 138对138，缺失0、不匹配0 |
| 工程回归 | 138+14=152项全部通过；package-integrity通过 |
| 算法评估 | total83/passed82/failed1/errors0，保留 `Vowel pipeline F0=400 Hz` |
| formant-validation/holdout | 两个完整首行JSON及aggregate与提交报告一致，科学门槛仍失败 |
| 命令范围 | manifest、freeze、verify、regression四条Python入口，命令审计均allow；各入口退出0 |

回归入口退出0表示符合已知基线预期；三个科学门槛子脚本实际退出1，日志保留，不称为科学性全部通过。

证据：[freeze-summary](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/freeze-summary.json)、[verify-report](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/verify-report.json)、[regression-summary](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/regression-summary.json)、[独立回归审计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/regression-independent-audit.json)、[逐文件哈希及样本证据审计](C:/Users/Shaoyilei/WeChatProjects/noise-1/rs-core/reports/fixture-independent-audit.json)。

## 范围与保留问题

实际语料覆盖静音/DC拒绝、近满幅与平台警告、削波、终止后忽略、奇数/空帧、秒窗口及单块跨秒、两段电平、非整周期及多频信号、频谱/频谱图查询、超时、片段/缺失时长、重复结束、未校准保存和报警。没有覆盖白/粉噪声、扫频、Nyquist边界、各种信噪比、长期采样时钟漂移或真实平台输入处理；代理最终文字中列出的这些场景未在26组定义中实现，不予采信。

当前冻结的是JS基线相容性证据，不是独立声学真值。未执行Praat/parselmouth新对比、真机录音、WASM、600秒压力或临床验证。此前提交的桌面性能报告仅为历史证据，本轮回归耗时不能当作完整DSP真机性能门槛。

风险展示在exact80处仍有SAFE数值判定<=80而文本<80的歧义；这是基线行为，本轮只记录。共振峰精度/覆盖率、低信噪比F0歧义和单点校准的频响/采集链未核验问题继续保留；另立算法修复事项，不混入Rust迁移。

主项目本轮仅新增 `project.config.json` 的rs-core打包排除。原有 `project.private.config.json` 变更和其它未跟踪文件未处理。未提交、推送或发布。

## 后续实施顺序

1. 独立Phase0A验证Android/iOS的WASM加载、调用、内存、Worker与故障行为；保持生产录音入口。
2. 在任何Rust数值比较前冻结独立误差预算及所需ABI细节；同步/cooperative实现选择由实际核心性能证据决定。
3. 分阶段实现native/WASM并对冻结输入、原始块、事件及字段比对；基线升级使用新身份和新向量版本。
4. 首次应用接入采用JS权威shadow模式；单会话后端固定，不能中途用新JS实例拼接Rust已处理结果。

未校准保存、旧实验室预设可用性、历史记录数值和现有WXSS/录音生命周期继续作为迁移约束。
