'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const reference=fs.readFileSync(path.join(__dirname,'reference/manifest.json'));
assert.equal(sha(reference),'4667d4cc7a3df53c0a0df28311fc2db83e587feab7b759bbfa41a457704d5cba');
const manifest=JSON.parse(reference),bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
let compared=0;
function compare(a,b){
 if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a),Object.keys(b));for(const k of Object.keys(b))compare(a[k],b[k]);}
 else{assert.ok(Object.is(a,b),String(a)+' differs from '+String(b));compared++;}
}
async function main(){
 const host=await instantiateSpeech({api:WebAssembly,source:bytes});
 for(const c of manifest.cases){
  const values=[c.times.length,c.intervals.length,c.window,c.margin,c.duration,...c.times,...c.intervals.flatMap(i=>[i.start,i.end])];
  const input=Buffer.alloc(values.length*8);values.forEach((v,i)=>input.writeDoubleLE(v,i*8));
  const run=cp.spawnSync(path.join(root,'target/release/examples/support_driver'+(process.platform==='win32'?'.exe':'')),[],{input,maxBuffer:4*1024*1024});
  assert.equal(run.status,0,String(run.stderr));compare(JSON.parse(run.stdout),c.expected);
  compare(host.supportEvidence(Float64Array.from(c.times),{windowSeconds:c.window,filterMarginSeconds:c.margin,duration:c.duration,intervals:c.intervals}),c.expected);
 }
 const quiet=new Float32Array(1024),live=host.hnrBegin(quiet).handle;
 const invalid=[{signal:quiet,opts:{hop:12000}}, {signal:quiet,opts:{fmin:200,fmax:200}},
  {signal:quiet,opts:{pitchTrack:[{time:0,f0:200,aperiodicity:.1},{time:0,f0:200,aperiodicity:.1}]}}];
 for(const bad of [NaN,Infinity,-Infinity]){const signal=quiet.slice();signal[1023]=bad;invalid.push({signal,opts:{requirePitch:true}});}
 for(const c of invalid)for(const method of ['hnrBegin','harmonicity'])assert.throws(()=>host[method](c.signal,c.opts),e=>e.code===-2);
 host.hnrNext(live);host.hnrFinish(live);host.hnrCancel(live);
 const second=host.hnrBegin(quiet).handle;assert.equal(second,live+1);host.hnrCancel(second);
 const signal=Float32Array.from({length:1024},(_,i)=>i%2?.2:-.2),opts={fmin:1,fmax:2,minPeakCorrelation:0};
 const full=await host.harmonicityFull(signal,opts);assert.equal(full.track[0].reason,'no-periodic-peak');assert.equal(full.avgHNR,null);compare(host.harmonicity(signal,opts),full);
 const supportOpts={windowSeconds:.1,duration:1};
 for(const times of [[NaN],[.1,.1],[-.1],[2]])assert.throws(()=>host.supportEvidence(Float64Array.from(times),supportOpts),e=>e.code===-2);
 assert.throws(()=>host.supportEvidence(new Float64Array([.1]),{...supportOpts,intervals:[{start:.3,end:.2}]}),e=>e.code===-2);
 assert.throws(()=>host.supportEvidence(new Float64Array([1e308]),{windowSeconds:1e308,filterMarginSeconds:1e308,duration:1e308}),e=>e.code===-2);
 assert.throws(()=>host.supportEvidence(new Float64Array([.1]),{...supportOpts,typo:1}),TypeError);
 const inst=await WebAssembly.instantiate(bytes,{env:{hnr_sin:Math.sin}}),e=inst.instance.exports,raw=attachSpeechInstance(inst.instance);
 assert.equal(e.speech_pcm_emphasis(0,.97),0);assert.equal(e.speech_support_evidence(0,.1,0,0,0),-3);e.speech_ack();
 assert.equal(e.speech_support_evidence(4097,.1,0,0,0),-5);assert.equal(e.speech_support_evidence(0,.1,0,0,4097),-5);
 e.memory.grow(1);compare(raw.supportEvidence(new Float64Array([.1]),supportOpts),host.supportEvidence(new Float64Array([.1]),supportOpts));
 const report={status:'PASS',referenceSha256:sha(reference),artifactSha256:sha(bytes),supportCases:manifest.cases.length,comparedFields:compared,
 checks:['five HNR boundary repairs via short and full WASM','rejection preserves handle and live session','native and WASM exact baseline support evidence','invalid support and overflow rejection','pending gate, capacity and memory growth'],limits:['metadata primitive only; no segmentation/masking pipeline or real-device validation']};
 fs.writeFileSync(path.join(root,'reports/phase6-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
