# 独立Worker执行、取消与恢复

新增独立消息协议、Worker服务、客户端和真实Node Worker适配。
Worker内创建单独的Rust WASM实例，运行既有PCM→HNR入口。算法和校准/保存/
历史记录规则没有改动，小程序原workers目录也没有改动。

```javascript
const {createNodeAnalysisClient} = require('./node-client.cjs');
const client = await createNodeAnalysisClient({wasmBytes});
const job = client.start(pcm, {sampleRate: 44100}, {
  onProgress: async metadata => updateProgress(metadata)
});
// 需要取消时调用 job.cancel()；等待取消确认后才能开始新任务。
try { const result = await job.promise; } finally { await client.close(); }
```

客户端就绪后可连续分析多个任务，每个Worker一次只接受一个任务。
PCM、边界及WASM字节先取副本，再转移副本；原输入不会被分离或后续改写。
协议epoch和递增任务id隔离旧消息，取消中到达的结果不会作为成功结果接收。
Ready握手检查完整HNR构建和会话ABI；失败不会自动切换到旧JS计算。

进度只有stage/帧或批游标等元数据，不发送浮点批次或完整诊断行。
Worker最多一个待确认进度，等待用户异步回调完成后确认；取消可解除该等待，
由已有finally清理会话。回调异常取消任务并返回原错误。最终结果验证有限
数值类型、容量、源样本分区/采样率和行所属片段，防止错任务或损坏数据被接受。
该检查核对协议与数据归属，不重新计算声学结果。

默认就绪超时10秒、任务期限120秒、取消确认期限2秒，均可配置。
期限到达先请求取消；确认缺失则终止Worker并弃用客户端。Worker异常/退出/消息反序列化失败、
WASM弃用、匹配epoch的损坏消息同样拒绝请求并清理计时器/订阅。
恢复必须显式创建新Worker和客户端，旧请求不会自动重放。close拒绝活动任务并
终止Worker，旧epoch和旧回调不能推进新任务。

真实Node Worker对全部8组冻结PCM流水线结果通过对照，初始9197项字段、
965项声级检查最大差0；进度共2037次。验证副本所有权、一次一任务、
异步进度确认、取消/回调失败后同Worker重启、默认5.25秒分析时主事件循环
仍活动。另用真实无响应Worker检查期限终止，用真实Worker退出检查错误及
新Worker恢复，检查非法WASM初始化清理。注入回调传输验证迟到epoch、损坏/
错源结果、数值字段被字符串替代及挂起回调取消。测试替身不执行替代DSP。

Node适配使用官方 [Worker API](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)，
数据使用结构化克隆/ArrayBuffer传输；采用复用Worker，避免每帧创建线程。
设置的Node JavaScript堆资源限制不能视为整个WASM/进程内存的上限。
其它平台可注入消息传输和Host工厂，必须保留类型、取消和生命周期语义。

目前真实执行证据仅来自Node，回调传输测试不代表wx Worker支持WXWebAssembly。
尚需微信平台能力核查和Android/iOS真机证据；不声称手机延迟或临床科学有效性
已资格验证。LPC/共振峰、声强/语谱图/扰动指标及真实原生libm仍待推进。

全量入口`python tools/run-phase11.py`，包含phase10及所有之前回归。
发布前使用`python tools/verify_staged_checkout.py --phase11`精确暂存副本复验。
报告见reports/worker-checks.json、phase11-verification.json及staged-checkout-verification.json。
本次将phase10+11合为一个本地提交，与phase9一起构成3轮发布批次；
之后恢复2–3轮一次的提交摘要、提交和推送节奏。
