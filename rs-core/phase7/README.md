# 分段规划、基频质量屏蔽与跨段HNR汇总

独立rs-core增加三个Rust计算步骤：按接收样本位置规划连续片段、
根据滤波支持/削波排除不可靠的基频证据、将独立完成的HNR轨迹按原始顺序汇总。
小程序主线继续使用JS，录音、校准、保存和历史记录规则不涉及本接口。

采集间断必须在去直流、重采样和YIN之前分割。`planSegments` 按实际旧JS的
过滤、Math.round、去重、排序规则返回startSample/endSample及对应秒数。
时间轴始终是接收样本，缺失录音的真实时长未知，不能据此推算墙钟时间。

| 宿主接口 | 用途 |
| --- | --- |
| `planSegments(sampleCount, sampleRate, boundaries)` | boundaries为Float64Array，输出连续样本区间 |
| `preparePitchEvidence(track, options, intervals)` | 局部基频证据的支持范围及质量屏蔽；输出用于HNR的time/f0/aperiodicity/support/reason |
| `assemblyBegin(options)` | 创建一个拥有结果副本的汇总会话 |
| `assemblyAppend(handle, hnrHandle, startSample, endSample, intervals)` | 复制已finish的HNR结果；hnrHandle=0显式声明失败片段 |
| `assemblyFinish(handle)` / `assemblyCancel(handle)` | 完整汇总或释放；finish幂等，未完成不能导出部分结果 |
| `harmonicitySegments(pieces, options, hooks)` | 为已独立准备的片段信号/基频证据逐段计算HNR并汇总 |

options包含sampleCount、sampleRate及可选frameSize=1024、hop=120。
每个成功piece含startSample/endSample、12000Hz的Float32Array signal、局部
pitchTrack及局部intervals；失败piece仅含startSample/endSample、failed:true。
hooks沿用yieldFn/onProgress/isCanceled。输入描述、未来片段信号和证据在首次
await之前取得副本；主机输入总计最多262144样本/4096基频证据/4096削波区间。
每实例一个汇总会话、最多128片段、4096输出行，HNR仍最多两个同时活跃。
片段结果复制后即可释放HNR句柄，再处理下一段。汇总句柄不复用。

完整入口固定采用当前录音流水线的HNR参数：12000Hz、40–1200Hz、
requirePitch=true、相关阈值0.2、相对基频偏差0.15。
低层汇总接口验证源采样数、输入长度、完整参数配置及完成状态；不同配置
不能混入同一汇总。开发接口错误会清理其会话并向调用方报告，显式失败片段
按旧定义计入失效范围。无校准仍可使用主线录音/保存。

质量原因的顺序与旧JS相同：局部滤波支持不完整清除基频，削波覆盖该原因；
HNR局部削波屏蔽后先平移time/support，再按全局浮点端点判断采集片段边界，
边界原因覆盖先前原因。保留峰值诊断和原signalFrames/cappedFrames计数。
最后按全部有序屏蔽行统一计算覆盖率、有效时长和均值。失败段没有数值行；
所有段失败明确报错。jitter输出null，跨间断的扰动指标尚未迁移。

定向验收包含4组实际JS分段规划、6组实际JS跨段参考、原生汇总和实际WASM
独立片段DSP/汇总。初始定向检查6842项精确比较、426项声级检查，最大差0。
还检查输入所有权、不同会话隔离、取消/回调失败/再次启动、分区错误、
未完成/全失败、幂等完成、参数不匹配、待取结果、容量和内存增长。
DSH只读核对了契约与旧JS的原因覆盖、时轴、全行汇总及失败段语义，未发现冲突。

参考清单SHA256：`378c7c702d76afe81fceb632daa1ca53da444eeaee3f38f7a1919c5fc15554db`。
信号清单SHA256：`6e08ada5ec806597191bf7de8ae2e1cc1620f88118875872ea7044b25c4e2680`。
信号另行冻结并与原始参考HNR逐项确认，未重写旧清单/旧样例或改变误差要求。

全量入口 `python tools/run-phase7.py`，包含phase6及所有先前回归。
发布复验使用 `python tools/verify_staged_checkout.py --phase7`。
报告见reports/segments-checks.json、phase7-verification.json及
staged-checkout-verification.json。

还需移植PCM质量/削波检测及完整的片段前处理协调；此入口接受已独立准备的
信号和基频证据，未接管录音。LPC/共振峰、真实原生libm、Worker、WX/Android
真机及手机性能验收继续留待后续。桌面对照不构成临床/实验室有效性新证明。
