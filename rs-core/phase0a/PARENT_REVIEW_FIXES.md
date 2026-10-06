# 0A 初稿父审待纠正项

此清单由Codex只读审查形成；不要把初稿交付声明当验收。初始AGY任务完成后接续处理，仍只写原AGY独占源码/工具/测试/README路径，无生产/P0向量/manifest/lock修改，无终端命令；父代理再编译预检。

1. Cargo edition2024要求导出用#[unsafe(no_mangle)]；当前#[no_mangle]会编译失败。
2. noise-wasm的UnsafeCell/Cell+unsafe Sync静态实例现在在native也存在。单线程WASM理由不适用于native，native平行调用有数据竞争/UB。仅在wasm且无atomics配置下编译实际静态FFI；native只测拥有缓冲的安全ProbeBuffers与纯metadata函数。调整wasm_export_tests，不在native并发使用全局buffer或从extern C panic。若包含atomics/共享内存，应compile_error拒绝。原生单线程Mutex包装也不符合无需native全局的设计。
3. noise-core input_ptr/output_ptr在native截成u32丢高位。返回原生指针或usize，仅WASM导出层转u32；native测试用完整地址。len与capacity先判界再切片；supported32/64转换要明确。
4. 通用host中的exp.memory instanceof WebAssembly.Memory会在仅有WXWebAssembly的微信中ReferenceError。通过注入runtime或结构验证buffer/grow接口，不依赖标准WebAssembly全局。读取指针检查finite/integer/u32/对齐/范围，fresh views时重新核对；不要对undefined调用toString制造次生错误。
5. runProbeSuite用123.456/77.7/88.8等JS双精度literal比较f32写入值必失败。改用精确可表示sentinel或比较写入后的bits；所有失败验证输出全4096项逐位不变，不能只检查第0项。每个invalid用例重置inputs以独立检验NaN/+Inf/-Inf，不让之前NaN遮蔽后续Inf。gain也要覆盖±Inf、f32转换后上溢，以及product±溢出。len=u32::MAX、4097、空及4096边界；检查有效len之后的output未写。
6. process宿主len必须Number.isInteger且0<=len<=0xffffffff，负数/小数/2^32不能通过WASM自动wrap静默变成其它请求。接口参数错误先在宿主拒绝，不把它误当WASMtrap；整块无写。正常valid len但超过capacity仍传给真实WASM检查-1。
7. forceTrap函数若意外返回也须作废实例并报告契约错误，不让forceTrap以后还继续读输出；Node验收确认捕获真实WebAssembly.RuntimeError而非任意JS错误。异常/不认识的WASM返回码须明确失败，不伪PASS。
8. check-wasm实际artifact与Node报告：检查所有casepassed、memory.grow后新view、偏移/对齐/非重叠；两个活实例互不影响而不仅销毁后再建；reset完整4096。native测试也避免高位截断/只验一个元素造成假通过。
9. 微信官方页面打不开，但父代理已读Tencent官方api-typings：https://raw.githubusercontent.com/wechat-miniprogram/api-typings/master/types/wx/lib.wx.wasm.d.ts，instantiate(path,imports?)类型Promise<Instance>，memory.buffer/grow有定义。host需支持直接Instance与Node{instance,module}，不得套用NodeglobalMemory instanceof。不能据类型声明宣称真机已跑；Worker可选项缺证据标UNRUN。
10. Python工具只在rs-core内操作，先绝对路径范围检查；禁止默认递归清理/安装/联网。缺target明确UNRUN且非0。build与测试分开记录：probe通过不等于正式0A真机通过。standalone项目生成host.js必须与通用host.cjs字节一致或由构建工具显式同步并记hash，不能手写两套逻辑漂移。

固定ABI0A v1不是生产测量ABI。冻结的dyadic向量不允许放宽容差，也不允许实现DC/A/FFT/Leq来绕开P1前置门槛。
