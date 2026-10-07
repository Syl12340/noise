'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'reference'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mb=fs.readFileSync(path.join(dir,'manifest.json'));assert.equal(sha(mb),'ca5fe21b490389830d5b4231439d0947ab1b79f066693ced2599132b230223a3');
const manifest=JSON.parse(mb),wasm=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const stats={exactFields:0,dbFields:0,maxDbError:0,centeredSamples:0};
function compare(a,b,key=''){
 if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),key);for(const k of Object.keys(b))compare(a[k],b[k],k);}
 else if(typeof b==='number'&&['db','avgHNR','partialMeanHNR'].includes(key)){const d=Math.abs(a-b);assert.ok(Number.isFinite(a)&&d<=1e-10,key+': '+a+' vs '+b);stats.dbFields++;stats.maxDbError=Math.max(stats.maxDbError,d);}
 else{assert.ok(Object.is(a,b),key+': '+a+' vs '+b);stats.exactFields++;}
}
function input(c){const b=fs.readFileSync(path.join(dir,c.input.file));assert.equal(sha(b),c.input.sha256);return {bytes:b,pcm:Int16Array.from({length:b.length/2},(_,i)=>b.readInt16LE(i*2))};}
function native(op,rate,bytes){const header=Buffer.alloc(9);header[0]=op;header.writeUInt32LE(rate,1);header.writeUInt32LE(bytes.length/2,5);
 const run=cp.spawnSync(path.join(root,'target/release/examples/pcm_driver'+(process.platform==='win32'?'.exe':'')),[],{input:Buffer.concat([header,bytes]),maxBuffer:4*1024*1024});assert.equal(run.status,0,String(run.stderr));return run.stdout;}
function f32bytes(values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;}
const options=c=>({sampleRate:c.rate,discontinuityBoundariesSeconds:Float64Array.from(c.boundaries)});
const hooks={yieldFn:async()=>{}};
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:wasm}),checks=[];
 for(const c of manifest.primitives){const {bytes,pcm}=input(c),centered=fs.readFileSync(path.join(dir,c.centered.file));assert.equal(sha(centered),c.centered.sha256);
  compare(JSON.parse(native(1,c.rate,bytes)),c.expected);compare(host.inspectPcm(pcm,c.rate),c.expected);
  assert.deepEqual(native(2,c.rate,bytes),centered);assert.deepEqual(f32bytes(host.centerPcm(pcm)),centered);stats.centeredSamples+=pcm.length*2;
 }
 for(const c of manifest.pipelines){compare(await host.analyzePcmHnr(input(c).pcm,options(c),hooks),c.expected);}
 checks.push('13 native/WASM primitive fixtures; 8 actual WASM PCM-to-HNR pipelines');
 const c=manifest.pipelines.find(c=>c.name==='discontinuous-dc'),owned=input(c).pcm,opts=options(c);let modified=false;
 const other=host.hnrBegin(new Float32Array(1024),{requirePitch:true}).handle;
 compare(await host.analyzePcmHnr(owned,opts,{yieldFn:async()=>{},onProgress:()=>{if(!modified){modified=true;owned.fill(0);opts.discontinuityBoundariesSeconds.fill(0);}}}),c.expected);
 host.hnrNext(other);host.hnrFinish(other);host.hnrCancel(other);checks.push('PCM and boundary ownership across awaits; unrelated HNR remains usable');
 for(const stage of ['centered','hnr']){let flag=false;
  await assert.rejects(host.analyzePcmHnr(input(c).pcm,options(c),{yieldFn:async()=>{},onProgress:r=>{if(r.stage===stage)flag=true;},isCanceled:()=>flag}),e=>e.name==='AbortError');
  compare(await host.analyzePcmHnr(input(c).pcm,options(c),hooks),c.expected);
 }
 for(const stage of ['pitch','hnr']){
  await assert.rejects(host.analyzePcmHnr(input(c).pcm,options(c),{yieldFn:async()=>{},onProgress:async r=>{if(r.stage===stage)throw new Error('hook error');}}),/hook error/);
  compare(await host.analyzePcmHnr(input(c).pcm,options(c),hooks),c.expected);
 }
 checks.push('cancellation, async callback failure and restart in preprocessing/HNR');
 assert.throws(()=>host.inspectPcm(new Int16Array(2),0),TypeError);
 await assert.rejects(host.analyzePcmHnr(new Int16Array(),{sampleRate:12000}),TypeError);
 await assert.rejects(host.analyzePcmHnr(new Int16Array(63001),{sampleRate:12000}),TypeError);
 await assert.rejects(host.analyzePcmHnr(new Int16Array(1024),{sampleRate:12000,unexpected:1}),TypeError);
 const quiet=await host.analyzePcmHnr(new Int16Array(6000),{sampleRate:12000},hooks);assert.equal(quiet.avgHNR,null);assert.equal(quiet.segmentQuality[0].quality.digitalSilence,true);checks.push('input profile limits and successful quiet recording');
 const loaded=await WebAssembly.instantiate(wasm,{env:{hnr_sin:Math.sin}}),e=loaded.instance.exports,raw=attachSpeechInstance(loaded.instance);
 e.speech_pcm_emphasis(0,.97);assert.equal(e.speech_inspect_pcm(0,12000),-3);assert.equal(e.speech_center_pcm(0),-3);e.speech_ack();
 assert.equal(e.speech_inspect_pcm(262145,12000),-5);assert.equal(e.speech_center_pcm(262145),-5);assert.equal(e.speech_inspect_pcm(0,0),-2);
 e.memory.grow(1);compare(raw.inspectPcm(new Int16Array([32767,-32768]),12000),host.inspectPcm(new Int16Array([32767,-32768]),12000));
 const fault=attachSpeechInstance({exports:{...e,speech_center_pcm:()=>e.probe_force_trap()}});
 await assert.rejects(fault.analyzePcmHnr(new Int16Array(1024),{sampleRate:12000},hooks));assert.equal(fault.discarded,true);
 await assert.rejects(fault.analyzePcmHnr(new Int16Array(1024),{sampleRate:12000},hooks),/discarded/);checks.push('pending/capacity/memory growth and trapped-instance discard');
 const report={status:'PASS',primitiveCases:manifest.primitives.length,pipelineCases:manifest.pipelines.length,stats,checks,manifestSha256:sha(mb),artifactSha256:sha(wasm),limits:['Native primitives and desktop WASM pipeline only','YIN/resampling synchronous; phone/Worker latency unqualified','No LPC/formants/intensity/spectrogram/jitter or production integration']};
 fs.writeFileSync(path.join(root,'reports/pcm-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
