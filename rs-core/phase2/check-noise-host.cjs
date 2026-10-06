'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const vm=require('node:vm');
const {attachNoiseInstance,instantiateNoise}=require('./noise-host.cjs');
const root=path.resolve(__dirname,'..');
const bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const tests=[];
const check=(name,fn)=>{fn();tests.push({name,status:'PASS'});};
const alternating = n => Int16Array.from({length:n},(_,i)=>i%2?1000:-1000);
const hnrMode=process.argv.includes('--harmonicity');
let noiseMathCalls=0;
const mathImports={env:{hnr_sin:x=>{noiseMathCalls++;return Math.sin(x);}}};
const raw = () => new WebAssembly.Instance(new WebAssembly.Module(bytes),hnrMode?mathImports:{});
async function main() {
  const mod=await WebAssembly.compile(bytes);
  check('declared imports',()=>assert.deepEqual(WebAssembly.Module.imports(mod),hnrMode?[{module:'env',name:'hnr_sin',kind:'function'}]:[]));
  const instance=raw(),e=instance.exports,host=attachNoiseInstance(instance),h=host.create();
  check('status checks precede integer wrapping',()=> {
    assert.throws(()=>host.process(h,2**32,alternating(10)),TypeError);
    assert.throws(()=>host.process(h,1,alternating(10),'yes'),TypeError);
    assert.throws(()=>host.create(Infinity),TypeError);
    assert.equal(host.snapshot(h).seq,1);
  });
  check('pending result blocks both sessions and no result overwrite',()=> {
    const second=host.create();
    assert.equal(e.noise_snapshot(h),0);
    const ptr=e.noise_result_ptr(),len=e.noise_result_len();
    const before=Buffer.from(new Uint8Array(e.memory.buffer,ptr,len));
    assert.equal(e.noise_process(second,1,10,0),-3);
    assert.equal(e.noise_destroy(h),-3);
    assert.equal(e.noise_create(100,128),0);
    assert.deepEqual(Buffer.from(new Uint8Array(e.memory.buffer,ptr,len)),before);
    assert.equal(e.noise_ack(),0);host.destroy(second);
  });
  check('memory.grow reacquires views and retains committed sample count',()=> {
    const buffer=e.memory.buffer;e.memory.grow(1);assert.equal(buffer.byteLength,0);
    const out=host.process(h,1,alternating(44100),true);
    assert.equal(out.receipt.status,'committed');assert.equal(out.snapshot.total_a_samples,44100);
    let event,windows=0,spectra=0;
    while((event=host.nextEvent(h))!==null) {
      if(event.type==='window')windows++;
      if(event.type==='spectrum') {spectra++;assert.equal(event.spectrum_db.length,16384);assert.equal(event.bands_db.length,29);}
    }
    assert.equal(windows,1);assert.equal(spectra,2);
  });
  check('sequence error does not consume valid next sequence',()=> {
    assert.throws(()=>host.process(h,1,alternating(10)),error=>error.code===-4);
    assert.equal(host.process(h,2,alternating(10)).snapshot.total_a_samples,44110);
  });
  check('destroyed handles never address new sessions',()=> {
    const old=host.create();host.destroy(old);const next=host.create();assert.ok(next>old);
    assert.throws(()=>host.snapshot(old),error=>error.code===-1);
    assert.equal(host.snapshot(next).total_a_samples,0);host.destroy(next);
  });
  check('event backpressure is retryable after draining without clock changes',()=> {
    const bounded=host.create(100,1),pcm=alternating(44100);
    host.process(bounded,1,pcm);
    const before=host.snapshot(bounded);
    assert.throws(()=>host.process(bounded,2,pcm),error=>error.code===-3);
    assert.deepEqual(host.snapshot(bounded),before);
    assert.equal(host.nextEvent(bounded).type,'window');assert.equal(host.nextEvent(bounded),null);
    assert.equal(host.process(bounded,2,pcm).snapshot.total_a_samples,88200);
    host.nextEvent(bounded);host.nextEvent(bounded);host.destroy(bounded);
  });
  check('finish is idempotent and does not create samples',()=> {
    const first=host.finish(h);assert.equal(first.total_samples,44110);
    assert.deepEqual(host.finish(h,true),first);
    assert.equal(host.process(h,0,new Int16Array()).receipt.status,'ignored_after_termination');
  });
  check('independent instances retain their own sessions',()=> {
    const other=attachNoiseInstance(raw()),id=other.create();assert.equal(id,1);
    assert.equal(other.snapshot(id).total_a_samples,0);other.discard();
  });
  check('trap discards instance without replay',()=> {
    const other=raw(),bad=attachNoiseInstance(other),id=bad.create();
    const exports={...other.exports,noise_snapshot:()=>other.exports.probe_force_trap()};
    const intercepted=attachNoiseInstance({exports});
    assert.throws(()=>intercepted.snapshot(id),WebAssembly.RuntimeError);
    assert.equal(intercepted.discarded,true);assert.throws(()=>intercepted.finish(id),/discarded/);
    bad.discard();
  });
  check('decode failure cannot replay committed process',()=> {
    const other=raw(),id=other.exports.noise_create(100,128);
    const broken=attachNoiseInstance({exports:{...other.exports,noise_result_len:()=>0}});
    assert.throws(()=>broken.process(id,1,alternating(10)),/result size/);
    assert.equal(broken.discarded,true);assert.equal(other.exports.noise_has_result(),1);
    assert.throws(()=>broken.process(id,1,alternating(10)),/discarded/);
  });
  // An injected loader simulates WX return shape, not a real WX runtime.
  const ctx={module:{exports:{}},ArrayBuffer,Int16Array,Uint8Array,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'noise-host.cjs'),'utf8'),ctx);
  assert.equal(ctx.WebAssembly,undefined);assert.equal(ctx.TextDecoder,undefined);
  const wxHost=await ctx.module.exports.instantiateNoise({api:{instantiate:async()=>raw()},source:'noise.wasm'});
  check('WX-shaped loader without global WebAssembly or TextDecoder',()=> {
    const id=wxHost.create();assert.equal(wxHost.process(id,1,alternating(10)).snapshot.total_a_samples,10);
    wxHost.destroy(id);
  });
  const asyncHost=hnrMode?attachNoiseInstance((await WebAssembly.instantiate(bytes,mathImports)).instance):await instantiateNoise({api:WebAssembly,source:bytes});
  check('Node asynchronous loader',()=>assert.equal(asyncHost.create(),1));
  if(hnrMode)check('noise never invokes the HNR scalar math dependency',()=>assert.equal(noiseMathCalls,0));
  const report={status:'PASS',tests,artifact:{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),imports:WebAssembly.Module.imports(mod)},scope:'Actual Rust WASM on Node plus WX-shaped loader simulation; no real device test.'};
  fs.writeFileSync(path.join(root,'reports/noise-wasm-host.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
