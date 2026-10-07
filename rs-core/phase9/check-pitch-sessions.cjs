'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mb=fs.readFileSync(path.join(__dirname,'reference/manifest.json'));assert.equal(sha(mb),'92bc4bc8fe75290d048dc03460ddb924a7be71619e59d110fb5115d6d35954bb');
const manifest=JSON.parse(mb),bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const stats={exactFields:0,frames:0};
function compare(a,b){if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const k of Object.keys(b))compare(a[k],b[k]);}else{assert.ok(Object.is(a,b),String(a)+' vs '+String(b));stats.exactFields++;}}
function signal(c){const raw=fs.readFileSync(path.join(root,c.input));assert.equal(sha(raw),c.inputSha256);return Float32Array.from({length:raw.length/4},(_,i)=>raw.readFloatLE(i*4));}
function native(c,s){const header=Buffer.alloc(44);header.writeDoubleLE(c.config.fs,0);header.writeUInt32LE(c.config.frameSize,8);header.writeUInt32LE(c.config.hopSize,12);header.writeDoubleLE(c.config.threshold,16);header.writeDoubleLE(c.config.fmin,24);header.writeDoubleLE(c.config.fmax,32);header.writeUInt32LE(s.length,40);
 const raw=Buffer.alloc(s.length*4);s.forEach((v,i)=>raw.writeFloatLE(v,i*4));
 const run=cp.spawnSync(path.join(root,'target/release/examples/pitch_session_driver'+(process.platform==='win32'?'.exe':'')),[],{input:Buffer.concat([header,raw]),maxBuffer:4*1024*1024});assert.equal(run.status,0,String(run.stderr));return JSON.parse(run.stdout);}
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:bytes}),checks=[];
 for(const c of manifest.cases){const s=signal(c);compare(native(c,s),c.expected);let n=0,yields=0;
  compare(await host.trackAsync(s,c.config,{yieldFn:async()=>{yields++;},onProgress:r=>{if(r.state==='frame'){assert.equal(r.index,n);compare(r.row,c.expected[n]);n++;assert.equal(r.completed,n);}}}),c.expected);
  assert.equal(n,c.expected.length);assert.equal(yields,Math.max(0,n-1));stats.frames+=n;
 }
 checks.push('8 actual-JS native/WASM session tracks, optional fields and exact global times');
 const c=manifest.cases[0],s=signal(c),opts={...c.config},owned=host.pitchBegin(s,opts).handle;
 s.fill(0);opts.fs=1;host.preEmphasis(new Int16Array([1,2]));let r;do{r=host.pitchNext(owned);}while(!r.done);compare(host.pitchFinish(owned),c.expected);compare(host.pitchFinish(owned),c.expected);assert.equal(host.pitchNext(owned).state,'complete');host.pitchCancel(owned);assert.throws(()=>host.pitchNext(owned),e=>e.code===-1);checks.push('owned input/options, staging reuse, idempotence and stale handle');
 const pair=manifest.cases.filter(c=>['detuned','odd-grid'].includes(c.name)).map(c=>({c,h:host.pitchBegin(signal(c),c.config).handle,done:false}));
 assert.throws(()=>host.pitchBegin(new Float32Array()),e=>e.code===-6);
 while(pair.some(p=>!p.done))for(const p of pair)if(!p.done)p.done=host.pitchNext(p.h).done;
 for(const p of pair){compare(host.pitchFinish(p.h),p.c.expected);host.pitchCancel(p.h);}checks.push('two sessions with different frame and hop; bounded registry');
 const other=host.pitchBegin(new Float32Array(1024)).handle;let cancel=false;
 await assert.rejects(host.trackAsync(signal(c),c.config,{yieldFn:async()=>{},onProgress:()=>{cancel=true;},isCanceled:()=>cancel}),e=>e.name==='AbortError');
 host.pitchNext(other);host.pitchFinish(other);host.pitchCancel(other);
 await assert.rejects(host.trackAsync(signal(c),c.config,{yieldFn:async()=>{},onProgress:async()=>{throw new Error('callback failure');}}),/callback failure/);
 compare(await host.trackAsync(signal(c),c.config,{yieldFn:async()=>{}}),c.expected);checks.push('cancel/callback cleanup, unrelated session and restart');
 assert.throws(()=>host.pitchBegin(new Float32Array(65000),{frameSize:4096}),e=>e.code===-5);
 assert.throws(()=>host.pitchBegin(new Float32Array([NaN])),e=>e.code===-2);
 assert.throws(()=>host.pitchBegin(new Float32Array(),{hop:120,hopSize:119}),TypeError);checks.push('whole-session work budget and admission');
 const loaded=await WebAssembly.instantiate(bytes,{env:{hnr_sin:Math.sin}}),e=loaded.instance.exports,raw=attachSpeechInstance(loaded.instance);
 const h=raw.pitchBegin(new Float32Array(1024)).handle;assert.throws(()=>raw.pitchFinish(h),err=>err.code===-8);
 e.speech_pcm_emphasis(0,.97);assert.equal(e.speech_pitch_next(h),-3);assert.equal(e.speech_pitch_finish(h),-3);assert.equal(e.speech_pitch_cancel(h),-3);e.speech_ack();e.memory.grow(1);assert.equal(raw.pitchNext(h).index,0);raw.pitchFinish(h);raw.pitchCancel(h);
 const fault=attachSpeechInstance({exports:{...e,speech_pitch_next:()=>e.probe_force_trap()}});await assert.rejects(fault.trackAsync(new Float32Array(1024)));assert.equal(fault.discarded,true);checks.push('pending gate, incomplete finish, memory growth and trapped-instance discard');
 const pcmManifest=JSON.parse(fs.readFileSync(path.join(root,'phase8/reference/manifest.json'))),pcmCase=pcmManifest.pipelines[0],pcmBytes=fs.readFileSync(path.join(root,'phase8/reference',pcmCase.input.file));assert.equal(sha(pcmBytes),pcmCase.input.sha256);
 const pcm=Int16Array.from({length:pcmBytes.length/2},(_,i)=>pcmBytes.readInt16LE(i*2));let canceled=false,count=0;
 await assert.rejects(host.analyzePcmHnr(pcm,{sampleRate:pcmCase.rate},{yieldFn:async()=>{},onProgress:r=>{if(r.stage==='pitch-frame'){count++;canceled=true;}},isCanceled:()=>canceled}),err=>err.name==='AbortError');assert.equal(count,1);
 // Existing phase8 checker verifies exact final HNR after this scheduling replacement.
 const resumed=await host.analyzePcmHnr(pcm,{sampleRate:pcmCase.rate},{yieldFn:async()=>{}});assert.equal(resumed.harmonicity.track.length,pcmCase.expected.harmonicity.track.length);checks.push('PCM pipeline cancels during YIN frame scheduling and restarts');
 const report={status:'PASS',cases:manifest.cases.length,stats,checks,manifestSha256:sha(mb),artifactSha256:sha(bytes),limits:['Yields between frames only; resampling remains synchronous; no device/Worker latency qualification']};
 fs.writeFileSync(path.join(root,'reports/pitch-session-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
