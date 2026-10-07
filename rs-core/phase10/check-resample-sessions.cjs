'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'phase3/resample-reference'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mb=fs.readFileSync(path.join(dir,'manifest.json'));assert.equal(sha(mb),'4af3fe3d906a17f257bfd82f4a35be60cfa08df188ce8bad3c8d6a4ede2bce21');
const manifest=JSON.parse(mb),wasm=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
function fixture(c){const input=fs.readFileSync(path.join(dir,c.input)),expected=fs.readFileSync(path.join(dir,c.output));assert.equal(sha(input),c.inputSha256);assert.equal(sha(expected),c.outputSha256);return {input,expected,signal:Float32Array.from({length:input.length/4},(_,i)=>input.readFloatLE(i*4))};}
function bytes(values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;}
function native(c,raw,batch){const header=Buffer.alloc(24);header.writeUInt32LE(c.inputRate,0);header.writeUInt32LE(c.outputRate,4);header.writeDoubleLE(c.cutoffHz,8);header.writeUInt32LE(batch,16);header.writeUInt32LE(c.inputSamples,20);
 const run=cp.spawnSync(path.join(root,'target/release/examples/resample_session_driver'+(process.platform==='win32'?'.exe':'')),[],{input:Buffer.concat([header,raw]),maxBuffer:4*1024*1024});assert.equal(run.status,0,String(run.stderr));return run.stdout;}
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:wasm}),stats={cases:0,exactSamples:0,batches:0},checks=[];
 for(let index=0;index<manifest.cases.length;index++){
  const c=manifest.cases[index],f=fixture(c),batch=[1,7,256,4096][index%4];assert.deepEqual(native(c,f.input,batch),f.expected);
  let completed=0,yields=0;
  const output=await host.resampleAsync(f.signal,c.inputRate,c.outputRate,c.cutoffHz,{batchSize:batch,yieldFn:async()=>{yields++;},onProgress:r=>{
   assert.equal(r.start,completed);assert.equal(r.values.length,r.completed-r.start);assert.equal(r.total,c.outputSamples);assert.equal(r.done,r.completed===r.total);
   assert.deepEqual(bytes(r.values),f.expected.subarray(r.start*4,r.completed*4));completed=r.completed;stats.batches++;r.values.fill(0);
  }});
  assert.equal(yields,Math.max(0,Math.ceil(c.outputSamples/batch)-1));assert.equal(completed,c.outputSamples);assert.deepEqual(bytes(output),f.expected);stats.cases++;stats.exactSamples+=c.outputSamples*2;
 }
 checks.push('70 frozen native/WASM outputs; global phases/edges; batch sizes1/7/256/4096; copied callback batches');
 const c=manifest.cases.find(c=>c.inputRate===44100&&c.inputSamples>500),f=fixture(c),h=host.resampleBegin(f.signal,c.inputRate).handle;
 f.signal.fill(0);host.centerPcm(new Int16Array([1,2,3]));let r;do{r=host.resampleNext(h,7);}while(!r.done);assert.deepEqual(bytes(host.resampleFinish(h)),f.expected);assert.deepEqual(bytes(host.resampleFinish(h)),f.expected);assert.equal(host.resampleNext(h).values.length,0);host.resampleCancel(h);assert.throws(()=>host.resampleNext(h),e=>e.code===-1);checks.push('owned input, staging reuse, idempotence and stale handle');
 const pair=[44100,22050].map(rate=>{const c=manifest.cases.find(c=>c.inputRate===rate&&c.inputSamples>500),f=fixture(c);return {c,f,h:host.resampleBegin(f.signal,c.inputRate).handle,done:false};});
 assert.throws(()=>host.resampleBegin(new Float32Array(),12000),e=>e.code===-6);
 while(pair.some(p=>!p.done))for(const p of pair)if(!p.done)p.done=host.resampleNext(p.h,p.c.inputRate===44100?7:256).done;
 for(const p of pair){assert.deepEqual(bytes(host.resampleFinish(p.h)),p.f.expected);host.resampleCancel(p.h);}checks.push('interleaved distinct source-rate sessions');
 const other=host.resampleBegin(new Float32Array(1024),12000).handle;let flag=false;
 await assert.rejects(host.resampleAsync(fixture(c).signal,c.inputRate,12000,5500,{batchSize:7,yieldFn:async()=>{},onProgress:()=>{flag=true;},isCanceled:()=>flag}),e=>e.name==='AbortError');
 while(!host.resampleNext(other).done){}host.resampleFinish(other);host.resampleCancel(other);
 await assert.rejects(host.resampleAsync(fixture(c).signal,c.inputRate,12000,5500,{onProgress:async()=>{throw new Error('callback failure');}}),/callback failure/);
 assert.deepEqual(bytes(await host.resampleAsync(fixture(c).signal,c.inputRate,12000,5500,{yieldFn:async()=>{}})),f.expected);checks.push('cancel/callback cleanup, other session and restart');
 const loaded=await WebAssembly.instantiate(wasm,{env:{hnr_sin:Math.sin}}),e=loaded.instance.exports,raw=attachSpeechInstance(loaded.instance);
 const owned=raw.resampleBegin(new Float32Array(1024),12000).handle;assert.throws(()=>raw.resampleFinish(owned),err=>err.code===-8);
 e.speech_pcm_emphasis(0,.97);assert.equal(e.speech_resample_next(owned,256),-3);assert.equal(e.speech_resample_progress(owned),-3);assert.equal(e.speech_resample_finish(owned),-3);assert.equal(e.speech_resample_cancel(owned),-3);e.speech_ack();
 assert.equal(e.speech_resample_next(owned,0),-2);assert.equal(e.speech_resample_next(owned,4097),-2);e.memory.grow(1);assert.equal(raw.resampleNext(owned,1).start,0);raw.resampleCancel(owned);
 assert.throws(()=>raw.resampleBegin(new Float32Array([NaN]),12000),err=>err.code===-2);assert.throws(()=>raw.resampleBegin(new Float32Array(),96000),err=>err.code===-7);
 const fault=attachSpeechInstance({exports:{...e,speech_resample_next:()=>e.probe_force_trap()}});await assert.rejects(fault.resampleAsync(new Float32Array(1024),12000));assert.equal(fault.discarded,true);checks.push('pending/incomplete, invalid batch, memory growth, admission and trap discard');
 const pcmManifest=JSON.parse(fs.readFileSync(path.join(root,'phase8/reference/manifest.json'))),p=pcmManifest.pipelines[0],b=fs.readFileSync(path.join(root,'phase8/reference',p.input.file));assert.equal(sha(b),p.input.sha256);
 const pcm=Int16Array.from({length:b.length/2},(_,i)=>b.readInt16LE(i*2));let canceled=false,n=0;
 await assert.rejects(host.analyzePcmHnr(pcm,{sampleRate:p.rate},{yieldFn:async()=>{},onProgress:r=>{if(r.stage==='resample-batch'){n++;canceled=true;}},isCanceled:()=>canceled}),err=>err.name==='AbortError');assert.equal(n,1);
 const resumed=await host.analyzePcmHnr(pcm,{sampleRate:p.rate},{yieldFn:async()=>{}});assert.equal(resumed.harmonicity.track.length,p.expected.harmonicity.track.length);checks.push('PCM pipeline cancellation during resampling and restart; final exact comparison remains in phase8');
 const report={status:'PASS',stats,checks,manifestSha256:sha(mb),artifactSha256:sha(wasm),limits:['Batch yields only; no actual Worker/device latency qualification','Working tree round; no local commit or push']};fs.writeFileSync(path.join(root,'reports/resample-session-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
