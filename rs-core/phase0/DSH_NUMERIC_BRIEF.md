# DSH ecnu-max：补齐数值语义，校正状态机事实

上一任务实际失败，仅交付 CURRENT_SIGNAL_STATE_MACHINE.md；NUMERIC_SEMANTICS.md 不存在。协调者已说明部分交付，不将它计为完成。现在是范围缩小的新任务，不能重跑全部任务或更改供应商配置。

只允许写 phase0/NUMERIC_SEMANTICS.md，以及校正 phase0/CURRENT_SIGNAL_STATE_MACHINE.md 的下列事实。AGY 正在独占工具和 README，禁止改其它文件。读取 _work/baseline 固定提交源码，用户已授权处理源码；不读凭证，不执行终端/测试/构建，不改生产代码。文件工具读取写入即可。请尽量压缩交付文字，避免再次超时。

数值语义必须覆盖：Int16/32768、DC首次初始化、Float32中间写入与Float64滤波状态/能量累加、两biquad+129tap FIR（128阶）、系数44.1k生成路径和归一化、顺序与初值、FFT32768 Hann/hop8192/N/2 bins省略Nyquist/功率归一化/29bands、零值下限和特殊返回、tail256块/8静块/2s/阈值/分母不加tail。源码行号必须真实；不捏造迁移误差门槛，数值相容不等于科学效度。

状态机文档校正：
1. 声学门限终止为clipping/silence，格式无效也是结构性终止，不能称只有两种硬拒绝。
2. 恒DC块达到累计50ms的当前整块拒绝；此前低于门限的小块可以进入DCBlocker，不能写永远到不了。
3. 数值classifier虽只有main一处，exact80 SAFE<=80与result.js展示<80、80–85仍有展示边界不一致，应如实记录。
4. 有限值小于EXTREME的Infinity会命中末段，不能说Infinity永不提前命中。
5. 有无校准/保存要求请以hasUsableMainSamples实际源码准确陈述，未校准用户仍可使用，不能将valid校准擅改成实验室必需。
6. 定时FFT的hop相位由样本计数固定；切换额外查询的时间依切换点，不能混为定时相位变化。
7. result-manager有recordId重复保护，检查后改掉“未发现去重”。
8. 交付列表只在两个真实文件存在时声明两份完成。

交付须列真实修改文件及未完成点，不把任务失败或部分文件当完成。不要写Rust、不推送。
