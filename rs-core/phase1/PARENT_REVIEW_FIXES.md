# 初稿父审：修正后才能运行比较

本文件为Codex所有；AGY初始任务完成后接续处理，原独占路径不变。禁止改预算/系数/manifest/P0/原始主线。下列问题已直接核对源码，不可用epsilon吸收。

1. quality.rs在i16上sample.abs()/previous.abs()对-32768会debug panic或release负值，近满幅/peak判定错误。先转i32再abs；peak_abs用i32/u32；plateau approach*departure用i64/f64（65535^2超i32）。增加i16MIN/MAX单点、负满幅滑窗、正/负平台高动态测试，对照JS；rails/position/railWindow/intervals也须验收。
2. math.rs calculate_rms空数组返回0，但真实JS sqrt(0/0)=NaN，须保留NaN。tail reference_energy.max(1e-24)对NaN语义不同，显式传播NaN；此时quiet比较始终false且走上限。JS utility的类型域与Rustu64计数的合法域有差别，README明确限制，不能声称无差异支持NaN sampleCount。
3. f64 ring必须存(f32 DC输出 as f64)*32768，不另以f64未量化DC代入；A/DC内部反馈state保持f64，输出f32。拒绝整块前inspect消费全部样本；clipping先于silence计数，不改前已有silent计数。
4. Native comparator必须实际核对：每块已积分能量/计数、每个window的Z能量/数及A前缀、tail.energy逐位/tail.samples+converged、每次频谱at-sample/source/bin_count/bands。不能只比最后结果或计数。保存最大误差/不符合项，实际读NUMERIC_PROFILE_V1而非自设公差。
5. FFT线性power精确门槛必须有真实验证数据：SpectrumResult公开powers（明确raw还是floor）；driver额外opcode6接32768个f64LE PCM幅值并返回独立unit_spectrum(powers,bins,bands)。Node独立调用baseline真实fft.computeSpectrum观察log10入参（即floor之后的线性power），或内存hook导出raw power；不要由已有db反算功率后宣称逐位。新单位参考写phase1或_work，不改P0；冻结FFT本身无需Rustsin/cos。scalar/NaN/Inf/zero分类也须独立实际JS对照。
6. 处理前事件容量precheck不能偷推进Q/D。空块不推进seq；重复finish和invalid后finishNormal不可重复tail或恢复，seq错误/超大chunk/WouldBlock快照逐位不变。query不推进样本/hop/事件时钟；source用scheduled/query真实区分。仅同步接口，不声称Pending/cooperative已实现。
7. NativeCLI parser必须magic/长度/余字节判界，file/path操作限验证工具rs-core路径，代码非法输入明确error/非0；无blindjson parse，任何非finite数保留标签。Nativestd例子required-feature已注册，不破坏default probe构建。
8. DSH审阅已交付但有错误，协调者注已更正：lastbin16383而非8191，50ms门限当前块return，空块noAc来自len>1守卫，不是溢出。只信baseline源码和协调者勘误。

当前wasm32-unknown-unknown已由Codex安装，可用于feature acoustics的rlib编译检查；没有声学测量WASM ABI/真机证据，不作相关通过声明。

9. engine.rs实读发现：先更新silence计数再检查clipped，与main clipping优先分支不同；必须把clipped分支放在silence增量前。finish重复Normal目前NormalFinished落入Terminated分支并返回invalid，违背幂等；缓存第一次FinalSummary并返回完整同一状态。Terminated guard须先于empty/容量，所有后续输入IgnoredAfterTermination。seq checked_add越界作为不提交接口错误，不许Q推进后panic。
10. max_windows=n/fs+1/max_spectra=n/hop+2可使capacity=1且一秒输入在空队列永远WouldBlock；按当前interval/ring/hop相位精确计算所需事件数量，或明确容量最小值并拒绝不可用配置，不能有drain也无法重试成功的合法会话。测试空队列cap1一秒接受、满队列retry不提交后drain成功。
11. 必须提供只读snapshot/receipt统计以让驱动逐块验收真实total_a_samples/energy、silent counters、inspector.samples/rails/position/railWindow/clippedIntervals、warning累积、DC/A/ring/hop及窗剩余状态；不能通过finish读取块间状态而提前flush tail。P0chunks/receipts/final逐项对照；字段未覆盖要fail/未覆盖明确，不把26个final相同当全语义通过。

12. compare-acoustics.cjs初稿不可放行：require('../utils/...')路径不存在；自行runJsBaseline又把clipping放在silence更新之后，复制同样错误；linear power被擅改宽容差，energy被RMS容差替代；只比前500bins；Query在一秒触发却比两秒末ring；padding_samples用错JS字段paddingSamples；未用26个P0资产；NaN actual在finite expected时Math.abs得到NaN、diff>tol=false而伪通过。必须重写比较器：直接读P0 frozen PCM/chunks/events/expected/拼接spectra，对26case的真实原始块和控制事件作NAC1输入；coreenergy计数/window每字段/tail严格；每次全部16384bins与29bands/时点/source按profile。可通过P0真实baseline内存hooks获得补充state，不能自写pipeline当oracle；linear单元用真实fft内存只读hook。非finite分类与actual缺字段必须fail。每个driver exit/signal/error都检查，maxBuffer至少64MiB有限值，临时文件放rs-core/_work子目录，timeout明确失败报告，不写phase1/_work。

13. 父代理编译预检cargo check --features acoustics --all-targets发现tests/acoustics_tests.rs第174行round浮点类型歧义，freq_res应明确f64；这是代码问题，不算验证通过。crate入口实际是src/acoustics.rs，已保留该入口（临时重复mod.rs已删除），不可再创建第二个同名module入口。
