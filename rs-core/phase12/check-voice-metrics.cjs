'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'reference'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mb=fs.readFileSync(path.join(dir,'manifest.json'));assert.equal(sha(mb),'888c5b87fdd545349b600a0dd0cdfaebff869c32676c0b4ab5083a172d30aa07');const manifest=JSON.parse(mb),bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const stats={intensityCases:0,variabilityCases:0,exactFields:0,dbFields:0,maxDbError:0};
function compare(a,b,key=''){
 if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const k of Object.keys(b))compare(a[k],b[k],k);}
 else if(typeof b==='number'&&key==='db'){const d=Math.abs(a-b);assert.ok(Number.isFinite(a)&&d<=1e-10,a+' vs '+b);stats.dbFields++;stats.maxDbError=Math.max(stats.maxDbError,d);}
 else{assert.ok(Object.is(a,b),String(a)+' vs '+String(b));stats.exactFields++;}
}
function native(input){const r=cp.spawnSync(path.join(root,'target/release/examples/voice_metrics_driver'+(process.platform==='win32'?'.exe':'')),[],{input,maxBuffer:4*1024*1024});assert.equal(r.status,0,String(r.stderr));return JSON.parse(r.stdout);}
function intensityWire(c,raw){const h=Buffer.alloc(21);h[0]=1;h.writeDoubleLE(c.fs,1);h.writeUInt32LE(c.auto?0:c.frameSize,9);h.writeUInt32LE(c.auto?0:c.hop,13);h.writeUInt32LE(raw.length/4,17);return Buffer.concat([h,raw]);}
function variabilityWire(f0,gaps=false,clipped=false){const h=Buffer.alloc(7),raw=Buffer.alloc(f0.length*8);h[0]=2;h.writeUInt32LE(f0.length,1);h[5]=gaps?1:0;h[6]=clipped?1:0;f0.forEach((v,i)=>raw.writeDoubleLE(v,i*8));return Buffer.concat([h,raw]);}
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:bytes}),checks=[];
 for(const c of manifest.intensity){const raw=fs.readFileSync(path.join(dir,c.input.file));assert.equal(sha(raw),c.input.sha256);const signal=Float32Array.from({length:raw.length/4},(_,i)=>raw.readFloatLE(i*4));
  const n=native(intensityWire(c,raw)),w=host.intensityTrack(signal,c.auto?{fs:c.fs}:{fs:c.fs,frameSize:c.frameSize,hop:c.hop});
  for(const r of [n,w]){compare(r.track,c.expected);assert.equal(r.fs,c.fs);assert.equal(r.frameSize,c.frameSize);assert.equal(r.hop,c.hop);assert.equal(r.unit,'dBFS');assert.equal(r.method,'rectangular-rms');assert.equal(r.referenceRms,1);assert.equal(r.rmsFloor,1e-12);assert.equal(r.calibrationApplied,false);}stats.intensityCases++;
 }
 for(const c of manifest.variability){const n=native(variabilityWire(c.f0)),w=host.pitchPeriodVariability(Float64Array.from(c.f0));
  for(const r of [n,w]){compare(r.value,c.expected);assert.equal(r.unit,'ratio');assert.equal(r.cycleJitter,false);assert.equal(r.definition,'adjacent-voiced-frame-period-variability');assert.ok(r.pairCount<=Math.max(0,c.f0.length-1));assert.equal(r.reason,c.expected===null?'no-adjacent-voiced-pairs':null);}stats.variabilityCases++;
 }
 checks.push('14 native/WASM intensity cases and11 exact variability cases; explicit unit/reference definitions');
 const data=new Float64Array([100,200]);for(const flags of [{hasCaptureGaps:true},{clippedInput:true},{hasCaptureGaps:true,clippedInput:true}]){
  const w=host.pitchPeriodVariability(data,flags),n=native(variabilityWire(Array.from(data),flags.hasCaptureGaps,flags.clippedInput));compare(n,w);assert.equal(w.value,null);assert.equal(w.pairCount,0);assert.equal(w.reason,flags.hasCaptureGaps?'capture-discontinuity':'clipped-input');
 }
 assert.equal(host.pitchPeriodVariability(new Float64Array([100,0,200])).pairCount,0);assert.equal(host.pitchPeriodVariability(new Float64Array([100,200,0,300,400])).pairCount,2);
 for(const f0 of [[NaN],[Infinity],[5e-324],[1e-308,1e-308]])assert.throws(()=>host.pitchPeriodVariability(Float64Array.from(f0)),e=>e.code===-2);
 assert.throws(()=>host.intensityTrack(new Float32Array([NaN])),e=>e.code===-2);assert.throws(()=>host.intensityTrack(new Float32Array([0]),{fs:5e-324,frameSize:1,hop:1}),e=>e.code===-2);
 assert.throws(()=>host.intensityTrack(new Float32Array([0]),{fs:1e308,frameSize:1}),e=>e.code===-2);
 assert.throws(()=>host.intensityTrack(new Float32Array(5000),{frameSize:1,hop:1}),e=>e.code===-5);assert.throws(()=>host.intensityTrack(new Float32Array(4),{frameSize:0}),TypeError);assert.throws(()=>host.intensityTrack(new Float32Array(4),{hop:1,hopSize:2}),TypeError);
 const positive=host.intensityTrack(Float32Array.from({length:300},(_,i)=>i%2?2:-2));assert.ok(positive.track[0].db>6);checks.push('pause reset; gap/clipping suppression; nonfinite reciprocal/reduction/time and capacity rejection; positive db preserved');
 const loaded=await WebAssembly.instantiate(bytes,{env:{hnr_sin:Math.sin}}),e=loaded.instance.exports,raw=attachSpeechInstance(loaded.instance);
 e.speech_pcm_emphasis(0,.97);assert.equal(e.speech_intensity_track(0,12000,0,0),-3);assert.equal(e.speech_period_variability(0,0,0),-3);e.speech_ack();assert.equal(e.speech_period_variability(0,2,0),-2);assert.equal(e.speech_period_variability(4097,0,0),-5);assert.equal(e.speech_intensity_track(262145,12000,0,0),-5);
 e.memory.grow(1);compare(raw.pitchPeriodVariability(data),host.pitchPeriodVariability(data));
 const p=host.pitchBegin(new Float32Array(1024)).handle;host.intensityTrack(new Float32Array(600));host.pitchPeriodVariability(data);host.pitchNext(p);assert.equal(host.pitchFinish(p).length,1);host.pitchCancel(p);checks.push('shared pending gate, raw flags/capacity, memory growth and unrelated pitch session');
 const report={status:'PASS',stats,checks,manifestSha256:sha(mb),artifactSha256:sha(bytes),limits:['Standalone digital intensity/voiced-frame period statistic; no physical SPL or cycle jitter','Current PCM-HNR/Worker schema and mainline unchanged; no device/clinical qualification','New batch round1; no staging/commit/push']};
 fs.writeFileSync(path.join(root,'reports/voice-metrics-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
