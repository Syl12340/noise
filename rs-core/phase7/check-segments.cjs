'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mbytes=fs.readFileSync(path.join(__dirname,'reference/manifest.json')),sbytes=fs.readFileSync(path.join(__dirname,'reference/signals.json'));
assert.equal(sha(mbytes),'378c7c702d76afe81fceb632daa1ca53da444eeaee3f38f7a1919c5fc15554db');
assert.equal(sha(sbytes),'6e08ada5ec806597191bf7de8ae2e1cc1620f88118875872ea7044b25c4e2680');
const manifest=JSON.parse(mbytes),signals=JSON.parse(sbytes),bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const stats={exact:0,db:0,maxDbError:0};
function compare(a,b,key=''){
 if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),key);for(const k of Object.keys(b))compare(a[k],b[k],k);}
 else if(typeof b==='number'&&['db','avgHNR','partialMeanHNR'].includes(key)){const diff=Math.abs(a-b);assert.ok(Number.isFinite(a)&&diff<=1e-10,key+': '+a+' vs '+b);stats.db++;stats.maxDbError=Math.max(stats.maxDbError,diff);}
 else{assert.ok(Object.is(a,b),key+': '+a+' vs '+b);stats.exact++;}
}
class Wire{
 constructor(){this.parts=[];}
 b(v){this.parts.push(Buffer.from([v]));return this;}
 u(v){const b=Buffer.alloc(4);b.writeUInt32LE(v);this.parts.push(b);return this;}
 f(v){const b=Buffer.alloc(8);b.writeDoubleLE(v);this.parts.push(b);return this;}
 optional(v){this.b(v===undefined||v===null?0:1);if(v!==undefined&&v!==null)this.f(v);return this;}
 clips(values){this.u(values.length);values.forEach(i=>this.f(i.start).f(i.end));return this;}
 hnr(h){this.u(h.signalFrames).u(h.cappedFrames).u(h.track.length);for(const r of h.track)this.f(r.time).optional(r.db).b([undefined,'low-energy','unvoiced-or-uncertain','low-periodicity','no-periodic-peak'].indexOf(r.reason)).optional(r.peakCorrelation).optional(r.lagSamples).optional(r.comparisonSamples).b(r.correlationMethod?1:0).b(r.refinementConverged===undefined?0:r.refinementConverged?2:1);return this;}
 run(){const r=cp.spawnSync(path.join(root,'target/release/examples/segments_driver'+(process.platform==='win32'?'.exe':'')),[],{input:Buffer.concat(this.parts),maxBuffer:4*1024*1024});assert.equal(r.status,0,String(r.stderr));return JSON.parse(r.stdout);}
}
function pieces(c){return c.pieces.map((p,index)=>{
 if(p.failed)return {startSample:p.startSample,endSample:p.endSample,failed:true};
 const name=c.name+'-'+index+'.f32le',data=fs.readFileSync(path.join(__dirname,'reference',name));assert.equal(sha(data),signals[name]);
 return {startSample:p.startSample,endSample:p.endSample,signal:Float32Array.from({length:data.length/4},(_,i)=>data.readFloatLE(i*4)),pitchTrack:structuredClone(p.pitch),intervals:structuredClone(p.intervals)};
 });}
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:bytes}),checks=[];
 for(const p of manifest.plans){const values=p.boundaries.map(Number),wire=new Wire().b(1).u(p.n).u(p.rate).u(values.length);values.forEach(v=>wire.f(v));compare(wire.run(),p.expected);compare(host.planSegments(p.n,p.rate,Float64Array.from(values)),p.expected);}
 for(const c of manifest.cases){
  for(const p of c.pieces){
   const wire=new Wire().b(2).u(p.endSample-p.startSample).u(c.rate).u(1024).u(p.pitch.length);p.pitch.forEach(r=>wire.f(r.time).f(r.f0).f(r.aperiodicity));wire.clips(p.intervals);
   compare(wire.run(),p.expectedPitch);compare(host.preparePitchEvidence(p.pitch,{sampleCount:p.endSample-p.startSample,sampleRate:c.rate},p.intervals),p.expectedPitch);
  }
  const wire=new Wire().b(3).u(c.sampleCount).u(c.rate).u(1024).u(120).u(c.pieces.length);
  for(const p of c.pieces){wire.u(p.startSample).u(p.endSample).b(p.failed?1:0).clips(p.failed?[]:p.intervals);if(!p.failed)wire.hnr(p.rawHnr);}
  compare(wire.run(),c.expected);
  compare(await host.harmonicitySegments(pieces(c),{sampleCount:c.sampleCount,sampleRate:c.rate},{yieldFn:async()=>{}}),c.expected);
 }
 checks.push('four cut plans; six native assemblies and six real WASM segment DSP/assemblies; pitch masks');
 const c=manifest.cases[0],input=pieces(c),other=host.hnrBegin(new Float32Array(1024),{requirePitch:true}).handle;let changed=false;
 compare(await host.harmonicitySegments(input,{sampleCount:c.sampleCount,sampleRate:c.rate},{yieldFn:async()=>{},onProgress:()=>{if(!changed){changed=true;input[1].signal.fill(0);input[1].pitchTrack.forEach(r=>r.f0=0);}}}),c.expected);
 host.hnrNext(other);host.hnrFinish(other);host.hnrCancel(other);checks.push('owned future inputs and independent HNR session');
 let canceled=false;await assert.rejects(host.harmonicitySegments(pieces(c),{sampleCount:c.sampleCount,sampleRate:c.rate},{onProgress:()=>{canceled=true;},isCanceled:()=>canceled}),e=>e.name==='AbortError');
 await assert.rejects(host.harmonicitySegments(pieces(c),{sampleCount:c.sampleCount,sampleRate:c.rate},{onProgress:async()=>{throw new Error('hook failure');}}),/hook failure/);
 compare(await host.harmonicitySegments(pieces(c),{sampleCount:c.sampleCount,sampleRate:c.rate},{yieldFn:async()=>{}}),c.expected);checks.push('cancel/callback cleanup and restart');
 const a=host.assemblyBegin({sampleCount:2048,sampleRate:12000}).handle;
 assert.throws(()=>host.assemblyFinish(a),e=>e.code===-8);
 assert.throws(()=>host.assemblyAppend(a,0,1,1024),e=>e.code===-2);
 host.assemblyAppend(a,0,0,1024);host.assemblyAppend(a,0,1024,2048);assert.throws(()=>host.assemblyFinish(a),e=>e.code===-2);host.assemblyCancel(a);
 const sh=host.hnrBegin(new Float32Array(1024),{requirePitch:true}).handle,b=host.assemblyBegin({sampleCount:1024,sampleRate:12000}).handle;
 assert.throws(()=>host.assemblyAppend(b,sh,0,1024),e=>e.code===-8);host.hnrNext(sh);host.hnrFinish(sh);
 host.assemblyAppend(b,sh,0,1024);host.hnrCancel(sh);const finished=host.assemblyFinish(b);compare(host.assemblyFinish(b),finished);host.assemblyCancel(b);assert.throws(()=>host.assemblyFinish(b),e=>e.code===-1);checks.push('atomic partition errors, incomplete/all-failed, copied results and idempotence');
 const wrong=host.hnrBegin(new Float32Array(1024),{requirePitch:false}).handle,d=host.assemblyBegin({sampleCount:1024,sampleRate:12000}).handle;
 host.hnrNext(wrong);host.hnrFinish(wrong);assert.throws(()=>host.assemblyAppend(d,wrong,0,1024),e=>e.code===-2);host.hnrCancel(wrong);host.assemblyCancel(d);checks.push('scientific profile mismatch rejects');
 const inst=await WebAssembly.instantiate(bytes,{env:{hnr_sin:Math.sin}}),e=inst.instance.exports,raw=attachSpeechInstance(inst.instance);
 const h=raw.assemblyBegin({sampleCount:1024,sampleRate:12000}).handle;
 e.speech_pcm_emphasis(0,.97);assert.equal(e.speech_assembly_append(h,0,0,1024,0),-3);assert.equal(e.speech_assembly_cancel(h),-3);assert.equal(e.speech_plan_segments(1024,12000,0),-3);e.speech_ack();
 e.memory.grow(1);raw.assemblyAppend(h,0,0,1024);raw.assemblyCancel(h);
 assert.equal(e.speech_prepare_pitch(1024,12000,1024,4097,0),-5);checks.push('pending gate, memory growth and raw capacity');
 const report={status:'PASS',cases:manifest.cases.length,plans:manifest.plans.length,stats,checks,artifactSha256:sha(bytes),manifestSha256:sha(mbytes),signalsSha256:sha(sbytes),limits:['received-sample axis; prepared per-segment signals/evidence; no full PCM pipeline or device validation']};
 fs.writeFileSync(path.join(root,'reports/segments-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
