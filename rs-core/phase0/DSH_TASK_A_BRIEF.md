# DSH ecnu-max：Phase 0 基线事实文档

用户明确授权 DSH ecnu-max 分配 Phase 0，并授权处理源码。健康检查模型为 chatecnu/ecnu-max，不更改配置或供应商。

早先委派被自动审批以“同文档任务已经运行”拒绝。协调者在重派前完成只读进程核查：未发现 DSH CLI/编辑进程，候选进程无读取失败；两份目标文件尚不存在。原委派没有收到执行或交付结果。本次是一次新启动，不与其它 DSH 写任务并发。

只读基线位于 _work/baseline/，来源提交 3a0d6765147c56d2a73e1cec78f6106ae2e681ab。

唯一可写：phase0/CURRENT_SIGNAL_STATE_MACHINE.md 与 phase0/NUMERIC_SEMANTICS.md。不要修改其它文件，不构建测试、不写Rust、不修bug、不推送、不读取凭证或环境私密数据。允许源码文件读取与这两份文档写入；使用文件工具即可，不执行终端命令。

STATE_MACHINE：核对 main/audio-quality/audio-math/fft/canvas-spectrum/recorder-session/data-model/risk-config。还原原始块检查、质量提交、跨块rails与chunk-local silence、50ms整块拒绝、终止后忽略、DC/A/f32写回、块RMS、逐样本秒级A累计前缀/Z区间、ring/hop、按需FFT/视图查询、onStop计数/容差/tail及archive。注明源码行号。future Rust协议只可列为映射，不能称当前已经实现。

NUMERIC：列出单位/输入精度、f32边界/f64状态、初值/运算顺序、32768 Hann/8192 hop/N/2 output/省略Nyquist/功率贡献归一化/29band、下限与特殊返回、tail阈值/256块/8静块/2s上限、分母不加tail。129tap是128阶，不称129阶。持续DC应用可能在滤波前终止，不能将滤波单元行为冒充完整应用。

对exact80：main分类使用SAFE<=upper，risk-config的其它调用者是否采用<，需直接核对，不凭方案先假定。保存已知失败与不确定点，不改变46样本容差，不捏造迁移epsilon。AGY正在写契约/验收/工具，不能改它的任何文件。

交付两份真实文件、准确代码引用、修改路径及未确定项。不把Mock声学输出当真机或临床验证。
