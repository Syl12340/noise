# 样本工具父审：必须先修复，再申请执行

只允许改 tools/freeze-vectors.cjs、tools/run-phase0.py、fixtures/README.md。生产、baseline及其它代理文档禁止改。此任务不执行命令，父代理随后运行审查。

1. context.globalThis 在 runtime 创建的上下文外部并不存在；应把回调直接放入 env.context 属性，在 VM 内 globalThis可访问。hookCount 在load main前为0，现在executeFixture立即assert必失败；需在load后断言。
2. page.onShow()可能需要runtime未提供的wx/Canvas方法；优先按原测试调用startMainMonitoring，并使必要UI操作有明确Mock。page.switchView未必是真正函数，核对名称或通过明确模拟控制观测接口。避免未核查假名。
3. 每块tick独立Math.round会累积时长误差，应按累计sample边界算时间增量。default recorder.stop同步先emit Stop，随后forge Stop是重复被忽略；partial/unverified/timeout必须在stop前覆写Mock停止行为，按声明事件控制首次原生停止。不伪造baseline结果。结束后读取真实_completedSnapshot；不存在时明确未完成，不能page.archive重新计算冒充冻结结果。
4. def.events被写_emitted/_injected污染两次运行，必须复制或外置去重状态。metadata/expected所有决定性字段不得取真实时钟/随机安装ID；使用固定FakeClock/固定随机或明确规范化非语义字段，实际处理事件序列要保存，不只写模板。
5. accepted-only帧hook无法捕获拒绝和忽略。通过内存导出getState在每次emit前后读取真实quality inspector.samples/clipped/rails/intervals、integrated count、guard，再记录actual dispositions，不重写生产判定。秒窗口要在reset前采集intervalZ能量/样本数与A累计前缀、边界index；不能只保留最后receipt而丢完整window/receipt列表。
6. FFT用真实baseline computeSpectrum观测并保存f64le、29bands/时间位置/按需与主动query区别；若没实际算FFT不能声称已验证。可内存导出closure的mode/query/helpers但要明确模拟控制、非真实GUI。不足窗也保存不可用。修正sine amplitude0.1是峰值-20、RMS约-23.01 dBFS，不称RMS-20。
7. domain corpus必须内存导出并调用真实getRiskStatusByCNE，不复制其for逻辑。risk-config真正公开函数只有getEnabledRiskLevels等，若没有独立classifier则明确不存在，别伪造。报警必须通过实际条件/fixture，或标为未覆盖而不把val>=100自写结果当真实报警。包含no-calibration使用案例、unverified duration、一个>=2s且单chunk跨两个秒边界的案例。20–24个总数可调整，不凑名义覆盖。
8. freeze-vectors支持--output参数，仅允许rs-core/_work内候选目录或显式冻结目标。Python先两临时候选生成比全payload(不排除有语义manifest)，再冻结一次。已有golden拒绝覆写；verify重算候选并比全部文件(PCM/chunks/events/metadata/expected/spectra/domain)。verify不建fixture或写golden，只可报告。现有两次直接重写最终dir不接受。
9. regression复制images（协调者已经从Git增加baseline images，现174files）；缺必需脚本必须fail。不能所有nonzero都叫baseline_failure：5工程+14必须0且计数138+14正确，package必须0；algorithm-evaluation必须83/82/1/0且失败名吻合；两个formant必须与committed原reports基准aggregate匹配（源码readonly报告在baseline/docs/scientific-repairs-2026-10-05）。Syntax/crash/其它退出须FAIL，最终非0。保留日志/报告来源。
10. 所有递归清理先验证stage.resolve位于RS_CORE_DIR/_work/temp_stage且非父目录，不忽略异常，不递归删baseline/fixtures/root。修复timeout/pathguard/manifest路径穿越。维护README诚实范围，并不执行任何命令。

完成后交付3文件，父代理会运行preflight并再给精确freeze/verify/regression授权。
