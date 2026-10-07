# YIN逐帧会话与可取消调度

独立Rust核心新增PitchSession，持有完整连续信号和配置，每次next只计算
一个完整YIN帧。它直接调用原yin_pitch_frame；帧时间、原始差分插值、
倍频排除及可选诊断字段的数值定义继续使用已有实现。
PCM到HNR入口现等待逐帧YIN，并在帧间让出/检查取消。

| 宿主入口 | 作用 |
| --- | --- |
| `pitchBegin(signal, options)` | 复制Float32Array和配置并创建会话 |
| `pitchNext(handle)` | 返回已提交的帧、index/completed/total/done |
| `pitchFinish(handle)` | 返回完整轨迹；未完成报错，完成后可重复读取 |
| `pitchCancel(handle)` | 释放该会话；旧句柄不能访问新会话 |
| `trackAsync(signal, options, hooks)` | 逐帧计算、等待进度/调度钩子，取消或异常后清理所属会话 |

options沿用fs、frameSize、hop/hopSize、threshold、fmin、fmax，默认记录配置
12000Hz/1024/120/0.1/40–1200Hz。输入最大262144样本、帧最大4096、
完整帧最多4096，两个同时活跃的YIN会话。全会话仍限制为150million
比较对，不因为逐帧调用而重复获得预算。参数/有限值、容量和预算在创建时
检查，拒绝不会消耗句柄；保留原同步轨迹对有限非法频率范围的无基频结果。
样本上限和预算须同时满足。默认网格的预算最多允许573帧、69783样本，
所以超过该长度会先触发预算限制；原录音5.25秒/63000样本仍在范围内。
此预算是保守的计算量上限，静音和非法范围的提前返回不会增加可接受长度，
与原同步轨迹入口一致。

每个时间点按原整数样本位置加frameSize/2再除fs计算，奇数帧保留半样本
中心。短/空输入不产生部分帧。结果复制确认后才调用并等待钩子，期间可
执行其它已确认的语音操作。输入、配置与暂存区后续改写不改变会话结果。
WASM陷阱使整个实例弃用；没有重放或JS算法回退。

hooks为yieldFn/onProgress/isCanceled。更新后的analyzePcmHnr新增
stage='pitch-frame'进度，原stage='pitch'事件仍保留。取消可以在准备、
YIN帧间和HNR帧间生效；回调失败同样清理当前会话。HNR科学配置和最终
流水线输出不变，旧PCM流水线样例继续精确对照。

首次冻结8组实际旧JS轨迹，复用phase5不可变输入，包括默认5.25秒517帧、
非整数频率、静音过渡、奇数帧/帧移、空/短和旧非法范围行为。
原生和实际WASM共验证652个基准帧，初始定向14079项字段精确比较通过。
另检查双会话不同网格、输入所有权、幂等/不完整完成、旧句柄、整体预算、
取消/回调失败/重启、待取结果、内存增长、陷阱，以及PCM流水线在YIN帧间取消。
新增Rust测试覆盖入口事务、整体预算、短帧和半样本时轴。

参考清单SHA256：`92bc4bc8fe75290d048dc03460ddb924a7be71619e59d110fb5115d6d35954bb`。
全量入口`python tools/run-phase9.py`，包含phase8及所有之前回归。
干净暂存副本复验：`python tools/verify_staged_checkout.py --phase9`。
报告见reports/pitch-session-checks.json、phase9-verification.json及
staged-checkout-verification.json。旧参考数据和数值预算未修改。

本轮按新节奏只本地提交，是最近推送d0620e7后的第1轮；累计2–3轮再统一
同步微信和GitHub。小程序主线继续隔离。

仍不能在单个YIN帧内取消，重采样仍同步；这些调用没有手机延迟保证。
下一批处理重采样的可取消调度，Worker/真机、真实原生libm及其余声学模块
仍待验收或移植。桌面对照通过不构成临床科学有效性证明。
