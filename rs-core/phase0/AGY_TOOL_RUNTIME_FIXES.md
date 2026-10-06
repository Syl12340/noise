# 第二轮工具父审：运行事实与剩余缺口

先完成数值文档任务，之后独占修改 tools/freeze-vectors.cjs、tools/run-phase0.py、phase0/fixtures/README.md。父代理已实际运行 review_tools.py，结果在 reports/tool-preflight.json；不能沿用“全面静态通过”的自述。

1. 未校准用例 clearOffset 不存在。新的runtime本来没有offsetMeta，直接不设置即可，核对实际storage初始化。
2. 正常用例全部partial：runtime原生duration包括启动后的50ms。按实际recorder Start时刻与sample累计明确控制正常Stop duration=Math.round(total真实输入样本/44100*1000)，而非额外50ms；特殊partial/unverified/timeout仍控制首次事件。不要把Mock偏差冻成基线科学缺陷。
3. 声学终止后基线没有_completedSnapshot，这是事实；但expected不能把有效已积分计数/能量/质量证据全写0。在stop释放前后捕获真实state，用terminalEvidence明确字段；completedSnapshot仍null，dataQuality区分invalid终止与未完成，不调用archive冒充已冻结。保存全部receipts而非finalReceipt，并保存真实clippedIntervals坐标。
4. __getSpectrumData目前主动计算新FFT，根本不是观测已算FFT！波形用例也伪称available。需在真实updateSpectrumFromRingBuffer计算处加只读hook，记录每一次bins/bands/积分样本位置、hop或view-query来源，捕获真实基线已算结果。不足窗/未请求要unavailable；若独立DSP query另列，不混为页面观测。二进制明确LE写入，不依赖native字节序。HOP_SIZE常量1600错误：baseline8192。别另写流水线。
5. fix26实际modal=false，检查dataModel.setAlarmEnabled/setNoiseAlarmLevel以及校准riskEligible来源。用固定laboratory-preset(可过期但不拦截)或真实可用证据；确保真实条件触发并assert，不能只看名字。不要编造仪器通过；元数据标synthetic-test-only。同理plateau需要检查是否实际warning。
6. events.json仅switch/system/corrupt，没有start/Stop/timeout/empty/repeatedstop等实际控制事件，无法重播。保存完整声明+实际执行位置/参数；metadata记录固定校准配置、alarm参数、viewmode与时钟模型；非有限值用明确标记保留NaN/±Infinity，不JSON null混淆。
7. run-phase0 freeze把README当已有golden导致首次必须force；verify把README算进golden导致必失败。只排除README(非payload说明)，其余文件全量比较。已存在manifest/golden必须拒绝覆写，不提供--force绕过；更新必须独立版本/显式审查。Node命令自身也应拒绝覆盖golden。只允许_work/temp_stage候选与显式freeze目标，排除_work/baseline，resolve/reparse路径检查。--verify不得创建目录或漏比较chunks/events/metadata/domain/manifest。
8. regression formant只比较aggregate长度与通过flag，未比数值！必须比较完整aggregate。算法失败只许 Vowel pipeline F0=400 Hz，不能额外放行F0=200名称。汇总需实际total/failed/errors字段，保存来源和耗时。父代理回归结果随后提供，按真实脚本JSON结构修正解析，timeout保存失败日志，最终非零，不谎称均pass。
9. 冻结系数：从真实44.1k AWeightingFilter对象导出2节参数/FIR129/gain的f64LE字节与JSON清单/sha；明确仅当前44.1k，不扩48k，不自己算近似系数。冻结进候选/manifest并全部比对。

无生产/baseline修改，无Rust，不推送。此轮仅修正这3文件，无终端命令。父代理预检后才给exact freeze/verify/regression授权。简明报告。
