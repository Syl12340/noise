# HNR边界修复与连续片段支持证据

本轮仅修改独立rs-core。小程序仍使用原JS，录音、校准、保存和历史记录规则不变。

五项修复：非有限信号在计算入口拒绝；基频证据时间必须严格递增；
HNR帧移不能超过帧长；频率上限必须严格大于下限；零相关阈值下无有效峰
正常返回no-periodic-peak，而不使整个会话失败。前四项是开发接口参数检查，
不会转换为用户的录音或保存门槛。普通已支持参数的数值定义不变。

下一阶段第一批实现Rust `speech::time_support::assess_support` 与独立WASM
`host.supportEvidence(times, {windowSeconds, filterMarginSeconds, duration, intervals})`。
times为Float64Array，时间与削波区间均以当前连续片段起点为0。
返回time、support边界、incompleteFilterSupport和clipped两个独立标志。
最多4096行/4096区间，计算后复制结果并确认；不修改输入数组或HNR会话。

```javascript
const evidence = host.supportEvidence(new Float64Array([512 / 12000, .1]), {
  windowSeconds: 1024 / 12000,
  filterMarginSeconds: 128 / 44100,
  duration: 1,
  intervals: [{start: .2, end: .21}]
});
```

这是元数据计算基础，尚未自动检测PCM削波、分割采集间断、组装段间时间、
屏蔽HNR轨迹或重新汇总。接入这些步骤前不能把它当作完整语音流水线。
不要将跨间断PCM直接拼接后传入完整HNR会话。

定向检查覆盖五项修复、旧会话继续可用、拒绝请求不消耗句柄、
原生/WASM与7组实际旧JS支持证据精确对照、非法支持区间、端点溢出、
待确认结果、容量和内存增长。固定清单SHA256：
`4667d4cc7a3df53c0a0df28311fc2db83e587feab7b759bbfa41a457704d5cba`。
新正确性要求独立于旧JS兼容样例，旧参考数据与容差不重写。

全量入口：`python tools/run-phase6.py`，包含既有phase5及之前全部回归。
结果见`reports/phase6-verification.json`与`reports/phase6-checks.json`，
干净暂存副本验收见`reports/staged-checkout-verification.json`。
桌面通过不代表微信/Android真机、Worker性能、真实原生libm或临床有效性验收。
