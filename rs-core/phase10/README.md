# 重采样分批会话与可取消协调

本轮把独立重采样加入可取消会话。核心持有整个源信号和冻结系数库，
每次计算一批全局输出样本，成功后才提交游标和结果。同步入口与会话入口
共用同一份逐样本计算函数，不新增滤波器或改变科学定义。
源信号不会按输出批次裁剪，i*inputRate/outputRate和原边缘保持规则不重置。

| 宿主接口 | 用途 |
| --- | --- |
| `resampleBegin(signal, inputRate, outputRate=12000, cutoffHz=5500)` | 复制完整Float32Array并创建会话 |
| `resampleNext(handle, batchSize=256)` | 返回独立的values及start/completed/total/done |
| `resampleFinish(handle)` | 完整输出；未完成拒绝，完成后幂等读取 |
| `resampleCancel(handle)` | 释放所属会话，句柄不复用 |
| `resampleAsync(signal, inputRate, outputRate, cutoffHz, hooks)` | 批间让出执行、等待回调并检查取消 |

沿用七种输入率到12000Hz/cutoff5500Hz，输入最大262144样本，
批大小1–4096，默认256。每实例最多两个重采样会话。参数/容量/非有限样本
在创建时拒绝；非法批大小不会推进游标。系数/计算错误使会话终止，
不能重放或导出部分最终结果。输入和系数在成功finish后释放，cancel释放
全部会话资源。一次next的f32数据和随后进度都复制确认后才进入用户回调。
回调改写values不改变Rust保存的最终输出。

hooks为batchSize/yieldFn/onProgress/isCanceled。独立analyzePcmHnr已改为
等待resampleAsync，新进度stage='resample-batch'；原'resampled'事件保留。
YIN/HNR仍按帧调度。取消或异步回调失败释放当前会话，其它会话保持可用；
WASM陷阱弃用整个实例。检查/去均值仍是有界同步调用，没有手机延迟保证。

复用phase3已冻结的全部70组实际旧JS重采样样例，没有重写参考或系数。
初始原生/实际WASM对照共154034个输出样本逐位一致，使用1/7/256/4096
不同批大小。还检查跨批全局相位/边缘、不同源率交错、输入所有权、
回调批次副本、幂等/未完成、旧句柄、取消/回调失败/重启、待取结果、
内存增长、陷阱和PCM流水线批间取消。Rust测试在内存中移除一个系数相位，
验证批次计算到一半失败不会提交；冻结系数文件没有改动。

全量入口：`python tools/run-phase10.py`，包含全部先前回归及原PCM/HNR
流水线精确对照。最新工作区验收：`python tools/verify_working_checkout.py`。
该工具只读Git索引，在独立目录覆盖当前rs-core工作文件并验证哈希，不暂存、
提交或推送；报告见reports/working-checkout-verification.json。
本轮数值与回归报告见reports/resample-session-checks.json及phase10-verification.json。
旧staged-checkout报告属于已提交phase9，不作为当前工作区的验收结果。

按最新要求，本轮保留工作区变更，不生成提交摘要/提交/推送。
phase9已是一个待推送的本地提交；下一轮完成后可将phase10+phase11作为
一个提交，累计三轮再同步远端。具体节奏见PUBLISH_STATUS.md。

小程序主线继续隔离。Worker/WX/Android真机、真实原生libm、LPC/共振峰、
声强/语谱图/扰动指标仍待推进；批间调度不意味着单个计算单位可被中断，
也不构成临床/实验室有效性证明。
