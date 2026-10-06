'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),vm=require('node:vm');
const {attachSpeechInstance,instantiateSpeech}=require('./speech-host.cjs');
const root=path.resolve(__dirname,'..'),artifact=path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm');
const bytes=fs.readFileSync(artifact),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const tests=[],check=(name,fn)=>{fn();tests.push({name,status:'PASS'});};
const hnrMode=process.argv.includes('--harmonicity');
const raw=()=>new WebAssembly.Instance(new WebAssembly.Module(bytes),hnrMode?{env:{hnr_sin:Math.sin}}:{});
const load=(p,hash)=>{const b=fs.readFileSync(p);assert.equal(sha(b),hash);return JSON.parse(b);};
const decode=(b,Type,read,width)=>Type.from({length:b.length/width},(_,i)=>b[read](i*width));
async function main() {
  const module=await WebAssembly.compile(bytes);assert.deepEqual(WebAssembly.Module.imports(module),hnrMode?[{module:'env',name:'hnr_sin',kind:'function'}]:[]);
  const instance=raw(),e=instance.exports,host=attachSpeechInstance(instance);
  const pitchRef=path.join(root,'phase2/pitch-reference');
  const primary=load(path.join(pitchRef,'manifest.json'),'046930004d0524718f76f383271b8d006d85b42b3d224104f39b21f4fe3c9383');
  const edge=load(path.join(pitchRef,'edge-manifest.json'),'5ddbeb6fcd9676b844f9220e67de5dd3c9467b2b12a63a0f55f3f10cef5e581e');
  let pitchCases=0;
  for(const c of [...primary.cases,...edge.cases]) {
    const b=fs.readFileSync(path.join(pitchRef,c.input));assert.equal(sha(b),c.sha256);
    const cfg=c.config;let out;
    if(c.op==='frame')out=host.pitchFrame(decode(b,Float64Array,'readDoubleLE',8),cfg);
    else if(c.op==='track')out=host.track(decode(b,Float32Array,'readFloatLE',4),cfg);
    else if(c.op==='pcm')out=Array.from(host.preEmphasis(decode(b,Int16Array,'readInt16LE',2),cfg.coef));
    else out=Array.from(host.emphasizeFloat(decode(b,Float32Array,'readFloatLE',4),cfg.coef));
    assert.deepEqual(out,c.expected,c.name);pitchCases++;
  }
  const resRef=path.join(root,'phase3/resample-reference');
  const manifest=load(path.join(resRef,'manifest.json'),'4af3fe3d906a17f257bfd82f4a35be60cfa08df188ce8bad3c8d6a4ede2bce21');
  let samples=0;
  for(const c of manifest.cases) {
    const input=fs.readFileSync(path.join(resRef,c.input)),expected=fs.readFileSync(path.join(resRef,c.output));
    assert.equal(sha(input),c.inputSha256);assert.equal(sha(expected),c.outputSha256);
    const out=host.resample(decode(input,Float32Array,'readFloatLE',4),c.inputRate,c.outputRate,c.cutoffHz);
    assert.equal(out.length,c.outputSamples);
    assert.deepEqual(Buffer.from(out.buffer,out.byteOffset,out.byteLength),expected,c.name);samples+=out.length;
  }
  check('pending result cannot be overwritten across operations',()=> {
    assert.equal(e.speech_pcm_emphasis(0,.97),0);assert.equal(e.speech_result_kind(),2);
    assert.equal(e.speech_pitch_frame(0,12000,.1,40,1200),-3);assert.equal(e.speech_resample(0,44100,12000,5500),-3);
    assert.equal(e.speech_result_kind(),2);assert.equal(e.speech_ack(),0);
  });
  check('binary output is owned after acknowledgment and later operation',()=> {
    const first=host.preEmphasis(new Int16Array([32767,0,-32768]));const copy=Array.from(first);
    host.preEmphasis(new Int16Array([1,2,3]));assert.deepEqual(Array.from(first),copy);
  });
  check('memory growth recreates typed views',()=> {
    const before=e.memory.buffer;e.memory.grow(1);assert.equal(before.byteLength,0);
    assert.deepEqual(Array.from(host.emphasizeFloat(new Float32Array([.5]),1)),[0]);
  });
  check('oversized and wrapped configurations do not call DSP',()=> {
    assert.throws(()=>host.track(new Float32Array(10),{hop:2**32}),TypeError);
    assert.throws(()=>host.pitchFrame(new Float64Array(4097)),TypeError);
    assert.equal(e.speech_pcm_emphasis(262145,.97),-5);assert.equal(e.speech_result_kind(),0);
  });
  check('pair budget rejects excessive synchronous YIN work',()=> {
    assert.throws(()=>host.track(new Float32Array(16384),{frameSize:4096,hop:1}),error=>error.code===-5);
    assert.equal(e.speech_result_kind(),0);
  });
  check('unsupported profile returns no approximate data',()=> {
    assert.throws(()=>host.resample(new Float32Array(10),44100,16000),error=>error.code===-7);
    assert.equal(e.speech_result_kind(),0);
  });
  check('legacy hopSize is honored and conflicting or unknown options reject',()=> {
    const signal=new Float32Array(900);
    assert.deepEqual(host.track(signal,{frameSize:301,hopSize:119}),host.track(signal,{frameSize:301,hop:119}));
    assert.equal(host.track(signal,{frameSize:301,hopSize:119})[1].time,(119+150.5)/12000);
    assert.throws(()=>host.track(signal,{hop:120,hopSize:119}),/Conflicting/);
    assert.throws(()=>host.track(signal,{hopSzie:119}),/Unknown/);
    assert.throws(()=>host.pitchFrame(new Float64Array(),{sampleRate:44100}),/Unknown/);
  });
  check('nonfinite input rejection leaves result empty',()=> {
    assert.throws(()=>host.track(new Float32Array([NaN])),error=>error.code===-2);
    assert.equal(e.speech_result_kind(),0);
  });
  check('trap discards instance without subsequent retry',()=> {
    const inst=raw(),bad=attachSpeechInstance({exports:{...inst.exports,speech_track:()=>inst.exports.probe_force_trap()}});
    assert.throws(()=>bad.track(new Float32Array(10)),WebAssembly.RuntimeError);assert.equal(bad.discarded,true);
    assert.throws(()=>bad.track(new Float32Array(10)),/discarded/);
  });
  check('decode failure discards already published output',()=> {
    const inst=raw(),bad=attachSpeechInstance({exports:{...inst.exports,speech_result_kind:()=>0}});
    assert.throws(()=>bad.preEmphasis(new Int16Array([1])),/result kind/);assert.equal(bad.discarded,true);
    assert.equal(inst.exports.speech_result_kind(),2);
  });
  const ctx={module:{exports:{}},ArrayBuffer,Float64Array,Float32Array,Int16Array,Uint8Array};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'speech-host.cjs'),'utf8'),ctx);
  const wx=await ctx.module.exports.instantiateSpeech({api:{instantiate:async()=>raw()},source:'speech.wasm'});
  check('WX-shaped loader needs neither global WebAssembly nor TextDecoder',()=> {
    assert.equal(ctx.WebAssembly,undefined);assert.equal(ctx.TextDecoder,undefined);
    const out=wx.pitchFrame(new Float64Array());assert.equal(out.f0,0);assert.equal(out.aperiodicity,1);assert.equal(Object.keys(out).sort().join(','),'aperiodicity,f0');
  });
  const loaded=await instantiateSpeech({api:WebAssembly,source:bytes});
  check('Node injected loader identity',()=>assert.deepEqual(loaded.track(new Float32Array(0)),[]));
  const report={status:'PASS',pitchCases,resampleCases:manifest.cases.length,resampleFloat32Bits:samples,tests,artifact:{bytes:bytes.length,sha256:sha(bytes),imports:WebAssembly.Module.imports(module)},scope:'Actual Rust WASM on Node, WX loader shape simulation only; no device or whole speech pipeline validation.'};
  fs.writeFileSync(path.join(root,'reports/speech-wasm.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
