// pages/index/index.js
const {
  createProbeHost,
  compareFloat32Bits,
  verifyAllOutputEquals,
  PROBE_ABI_VERSION,
  PROBE_CAPACITY,
  FROZEN_VECTOR,
  ERR_OK,
  ERR_LEN_OVERFLOW,
  ERR_NON_FINITE_GAIN,
  ERR_NON_FINITE_INPUT,
  ERR_NON_FINITE_PRODUCT,
} = require('../../probe-host.js');

const WASM_ASSET_PATH = 'assets/noise_wasm.wasm';

Page({
  data: {
    systemInfo: {},
    hasWXWebAssembly: false,
    testStatus: 'UNRUN', // UNRUN | RUNNING | PASSED | FAILED
    statusLabel: '未运行 (UNRUN)',
    statusMessage: '点击下方按钮开始在当前微信环境中执行 Phase 0A 探针测试。',
    durationMs: 0,
    isRunning: false,
    workerStatus: 'UNRUN',
    steps: [],
  },

  onLoad() {
    let sys = {};
    try {
      if (typeof wx.getSystemInfoSync === 'function') {
        sys = wx.getSystemInfoSync();
      }
    } catch (e) {
      console.warn('[Probe] wx.getSystemInfoSync failed:', e);
    }

    const hasWXWebAssembly = typeof WXWebAssembly !== 'undefined';

    this.setData({
      systemInfo: sys,
      hasWXWebAssembly,
      testStatus: 'UNRUN',
      statusLabel: '未运行 (UNRUN)',
      statusMessage: '环境信息已就绪。点击下方按钮开始验证。',
      steps: [],
    });
  },

  async runProbeTest() {
    if (this.data.isRunning) return;

    this.setData({
      isRunning: true,
      testStatus: 'RUNNING',
      statusLabel: '运行中 (RUNNING)',
      statusMessage: '正在逐步执行探针握手与验证...',
      steps: [],
      durationMs: 0,
    });

    const steps = [];
    const recordStep = (name, passed, detail) => {
      steps.push({ name, passed, detail });
      this.setData({ steps: [...steps] });
    };

    const startTime = Date.now();
    let allPassed = true;

    try {
      // 1. API 存在性检查
      const hasWasmApi = typeof WXWebAssembly !== 'undefined';
      recordStep(
        '1. WXWebAssembly API 检查',
        hasWasmApi,
        hasWasmApi
          ? 'WXWebAssembly 全局对象存在且可用'
          : '当前运行环境未检测到 WXWebAssembly (基础库可能过低或平台不支持)'
      );

      if (!hasWasmApi) {
        throw new Error('WXWebAssembly 不可用，无法继续');
      }

      // 2. 实例化包内 WASM 资产
      let probe;
      try {
        const instantiateFn = (path, imports) => WXWebAssembly.instantiate(path, imports);
        probe = await createProbeHost({
          instantiateFn,
          source: WASM_ASSET_PATH,
        });
        recordStep(
          '2. WASM 模块实例化与加载',
          true,
          `成功加载 ${WASM_ASSET_PATH}，未发现缺少导入`
        );
      } catch (loadErr) {
        recordStep(
          '2. WASM 模块实例化与加载',
          false,
          `实例化失败: ${loadErr.message}。若文件不存在，请先通过 tools/run-phase0a.py 构建并复制资产。`
        );
        throw loadErr;
      }

      // 3. ABI 握手与指针 4 字节对齐
      const abiValid = probe.abiVersion === PROBE_ABI_VERSION;
      const capValid = probe.capacity === PROBE_CAPACITY;
      const inAlign = probe.inputPtr % 4 === 0;
      const outAlign = probe.outputPtr % 4 === 0;
      const handshakeOk = abiValid && capValid && inAlign && outAlign;

      recordStep(
        '3. ABI 握手与内存对齐',
        handshakeOk,
        `ABI版本=${probe.abiVersion}, 容量=${probe.capacity}, inPtr=0x${probe.inputPtr.toString(16)}, outPtr=0x${probe.outputPtr.toString(16)} (4字节对齐)`
      );
      if (!handshakeOk) {
        throw new Error('ABI 握手或对齐校验失败');
      }

      // 4. 冻结向量 IEEE-754 位级精确计算验证
      probe.reset();
      let views = probe.getFreshViews();
      views.output.fill(64.0); // Exact dyadic sentinel
      for (let i = 0; i < FROZEN_VECTOR.input.length; i++) {
        views.input[i] = FROZEN_VECTOR.input[i];
      }
      const procRet = probe.process(FROZEN_VECTOR.input.length, FROZEN_VECTOR.gain);

      let bitExact = procRet === ERR_OK;
      let bitDetail = '';
      if (bitExact) {
        views = probe.getFreshViews();
        for (let i = 0; i < FROZEN_VECTOR.expected.length; i++) {
          const cmp = compareFloat32Bits(views.output[i], FROZEN_VECTOR.expected[i]);
          if (!cmp.match) {
            bitExact = false;
            bitDetail = `第 ${i} 项位不匹配: 得到 ${cmp.actualBits}, 期望 ${cmp.expectedBits}`;
            break;
          }
        }
        // Verify remaining samples 5..4095 are untouched
        for (let i = FROZEN_VECTOR.input.length; i < PROBE_CAPACITY; i++) {
          if (views.output[i] !== 64.0) {
            bitExact = false;
            bitDetail = `索引 ${i} 处未执行区域被污染`;
            break;
          }
        }
      } else {
        bitDetail = `probe_process 返回错误代码: ${procRet}`;
      }

      if (bitExact) {
        bitDetail = '所有 5 项测试值 IEEE-754 32位表示完全一致，未触及区域保持不变';
      }
      recordStep('4. 冻结向量位级精度验证', bitExact, bitDetail);
      if (!bitExact) {
        throw new Error('冻结向量精度验证失败');
      }

      // 5. 参数与边界校验 (len=0, 4096, 4097, NaN, Inf, 溢出)
      let paramPassed = true;
      let paramDetail = '';

      // len = 0 保持全 4096 项 output 不变
      views = probe.getFreshViews();
      views.output.fill(128.5); // Exact dyadic sentinel
      const ret0 = probe.process(0, 0.5);
      views = probe.getFreshViews();
      if (ret0 !== ERR_OK || !verifyAllOutputEquals(views.output, 128.5)) {
        paramPassed = false;
        paramDetail = 'len=0 未保持全量 output 或返回非 0';
      }

      // len = 4096 正常 pass
      if (paramPassed) {
        views.input.fill(0.5);
        const ret4096 = probe.process(4096, 2.0);
        views = probe.getFreshViews();
        if (ret4096 !== ERR_OK || !verifyAllOutputEquals(views.output, 1.0)) {
          paramPassed = false;
          paramDetail = `len=4096 返回错误: ${ret4096}`;
        }
      }

      // len = 4097 超界拒绝，全 4096 项不变
      if (paramPassed) {
        views.output.fill(32.0);
        const ret4097 = probe.process(4097, 2.0);
        views = probe.getFreshViews();
        if (ret4097 !== ERR_LEN_OVERFLOW || !verifyAllOutputEquals(views.output, 32.0)) {
          paramPassed = false;
          paramDetail = `len=4097 未返回 ERR_LEN_OVERFLOW(-1) 或输出被污染: ${ret4097}`;
        }
      }

      // gain = NaN 独立测试
      if (paramPassed) {
        views.input.fill(1.0);
        views.output.fill(16.0);
        const retNanGain = probe.process(5, NaN);
        views = probe.getFreshViews();
        if (retNanGain !== ERR_NON_FINITE_GAIN || !verifyAllOutputEquals(views.output, 16.0)) {
          paramPassed = false;
          paramDetail = `gain=NaN 未返回 ERR_NON_FINITE_GAIN(-2) 或输出被污染`;
        }
      }

      // input = NaN 独立测试 (先重置 input)
      if (paramPassed) {
        views.input.fill(1.0);
        views.input[2] = NaN;
        views.output.fill(8.0);
        const retNanIn = probe.process(5, 1.0);
        views = probe.getFreshViews();
        if (retNanIn !== ERR_NON_FINITE_INPUT || !verifyAllOutputEquals(views.output, 8.0)) {
          paramPassed = false;
          paramDetail = `input=NaN 未返回 ERR_NON_FINITE_INPUT(-3) 或输出被污染`;
        }
      }

      // product 溢出独立测试 (先重置 input)
      if (paramPassed) {
        views.input.fill(1.0);
        views.input[0] = 1e38;
        views.output.fill(4.0);
        const retOver = probe.process(5, 10.0);
        views = probe.getFreshViews();
        if (retOver !== ERR_NON_FINITE_PRODUCT || !verifyAllOutputEquals(views.output, 4.0)) {
          paramPassed = false;
          paramDetail = `溢出未返回 ERR_NON_FINITE_PRODUCT(-4) 或输出被污染`;
        }
      }

      if (paramPassed) {
        paramDetail = 'len=0, 4096, 4097, NaN, 溢出全量校验正确通过且全量4096项无脏写';
      }
      recordStep('5. 边界与非法参数校验', paramPassed, paramDetail);
      if (!paramPassed) {
        throw new Error('参数与边界校验失败');
      }

      // 6. 故障注入与陷阱捕获 (probe_force_trap)
      let trapOk = false;
      let trapDetail = '';
      try {
        probe.forceTrap();
        trapDetail = 'probe_force_trap 未触发异常';
      } catch (trapErr) {
        if (probe.disposed && (trapErr.name === 'RuntimeError'
          || (typeof WXWebAssembly.RuntimeError === 'function' && trapErr instanceof WXWebAssembly.RuntimeError))) {
          trapOk = true;
          trapDetail = `成功捕获陷阱，实例被标记作废 (${trapErr.message})`;
        } else {
          trapDetail = '未确认真实WASM陷阱或实例未作废';
        }
      }
      recordStep('6. 故障注入与作废隔离', trapOk, trapDetail);
      if (!trapOk) {
        throw new Error('故障注入隔离失败');
      }

      // 7. 新实例恢复验证
      let recoverOk = false;
      let recoverDetail = '';
      try {
        const instantiateFn = (path, imports) => WXWebAssembly.instantiate(path, imports);
        const freshProbe = await createProbeHost({
          instantiateFn,
          source: WASM_ASSET_PATH,
        });
        const freshViews = freshProbe.getFreshViews();
        freshViews.input[0] = 3.0;
        freshProbe.process(1, 4.0);
        const freshOut = freshProbe.getFreshViews().output[0];
        if (freshOut === 12.0) {
          recoverOk = true;
          recoverDetail = '新建实例成功恢复正常计算 (3.0 * 4.0 = 12.0)';
        } else {
          recoverDetail = `新实例计算异常: 输出 ${freshOut}`;
        }
      } catch (recErr) {
        recoverDetail = `新实例初始化失败: ${recErr.message}`;
      }
      recordStep('7. 新实例重建与恢复', recoverOk, recoverDetail);
      if (!recoverOk) {
        throw new Error('新实例恢复验证失败');
      }

      // 8. 独立 Worker 探针选项状态
      // Worker is not exercised by this main-thread page; never count UNRUN as a pass.

    } catch (e) {
      allPassed = false;
    }

    const elapsed = Date.now() - startTime;
    this.setData({
      isRunning: false,
      durationMs: elapsed,
      testStatus: allPassed ? 'PASSED' : 'FAILED',
      statusLabel: allPassed ? '主线程基础检查通过' : '验证未通过 (FAILED)',
      statusMessage: allPassed
        ? `当前环境的主线程基础检查通过。Worker及完整真机能力验收仍待完成。耗时 ${elapsed} ms。`
        : `测试过程中发现异常或环境不兼容，请查看分步检验记录。总耗时 ${elapsed} ms。`,
    });

    console.log('[Phase 0A Probe Result]', {
      status: allPassed ? 'PASSED' : 'FAILED',
      durationMs: elapsed,
      steps,
      environment: this.data.systemInfo,
      workerStatus: 'UNRUN',
    });
  },
});
