# AGY 接续 DSH 未完成交付

用户授权处理源码，并要求 AGY 多承担工作。DSH 两次实际调用失败，目前仅有状态机初稿，NUMERIC_SEMANTICS.md 不存在。不能把 DSH 声明当作完成。此任务明确接续缺口，不更改任何桥、权限、供应商或账户配置。

允许写 phase0/NUMERIC_SEMANTICS.md、phase0/CURRENT_SIGNAL_STATE_MACHINE.md；不得改工具、其它文档、baseline或生产代码。读 phase0/DSH_NUMERIC_BRIEF.md，按其数值语义范围创建缺失文件，并校正状态机8项。无终端命令、构建、测试、Rust、推送，无凭证读取。

补充已直接核查事实：main L278要求calibrationStatus.valid，但initMonitor L961–967将未校准状态转换valid:true/grade:estimated/riskEligible:false，允许检测与保存，不等于实验室校准已验证。务必将这个上下文写清楚。

tail截止最后块可以截短，88200不是256整倍数；首样本即恒值DC播种输出零，先零后阶跃才产生衰减。零状态tail输出零，8静块退出；不能断言极弱输入一定跑满2s。

必须在真实源码上核查f32/f64写入边界、系数、FFT及频带，含准确行号。交付真实文件清单和不确定点，避免臆断。只完成Phase0文档，不提升为Rust验证或科学认证。
