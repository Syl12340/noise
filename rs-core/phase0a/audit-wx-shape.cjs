// Desktop API-shape check with REAL Rust WASM. This is not WeChat device evidence.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const bytes = fs.readFileSync(path.join(root, 'target/wasm32v1-none/release/noise_wasm.wasm'));
const instantiate = async (_source, imports) => (await WebAssembly.instantiate(bytes, imports)).instance;

async function main() {
  const moduleValue = { exports: {} };
  const context = vm.createContext({ module:moduleValue, exports:moduleValue.exports,
    WebAssembly:undefined, ArrayBuffer, Float32Array, Uint32Array, console:{log(){},warn(){},error(){}},
    WXWebAssembly:{instantiate, RuntimeError:WebAssembly.RuntimeError} });
  vm.runInContext('(function(module,exports){'+fs.readFileSync(path.join(__dirname,'probe-host.cjs'),'utf8')+'\n})', context)(moduleValue,moduleValue.exports);
  const host = moduleValue.exports;
  const probe = await host.createProbeHost({instantiateFn:instantiate, source:'assets/noise_wasm.wasm'});
  const suite = host.runProbeSuite(probe);
  assert.equal(suite.passed, true, JSON.stringify(suite.details.filter(t=>!t.passed)));
  let page;
  context.require = spec => {assert.equal(spec,'../../probe-host.js');return host;};
  context.Page = definition => {page={...definition,data:{...definition.data},
    setData(update){Object.assign(this.data,update);}};};
  context.wx = {getSystemInfoSync:()=>({platform:'node-api-shape-simulation',SDKVersion:'simulated',version:'simulated'})};
  vm.runInContext('(function(require){'+fs.readFileSync(path.join(__dirname,'wechat-probe/pages/index/index.js'),'utf8')+'\n})',context)(context.require);
  page.onLoad();
  await page.runProbeTest();
  assert.equal(page.data.testStatus,'PASSED');
  assert.equal(page.data.workerStatus,'UNRUN');
  assert.ok(page.data.steps.every(step=>step.passed));
  assert.ok(!page.data.steps.some(step=>/Worker/.test(step.name)));
  const result = {status:'PASS',artifactSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    standardWebAssemblyGlobal:'absent_in_VM',instantiateReturn:'direct Instance',
    hostChecks:suite.details.length,pageMainThreadSteps:page.data.steps.length,workerStatus:'UNRUN',
    realDeviceStatus:'UNRUN',scope:'Desktop Node API-shape simulation with actual Rust WASM; not mobile compatibility.'};
  fs.writeFileSync(path.join(root,'reports/phase0a-wx-shape-audit.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
