'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {instantiateSpeech}=require('../phase3/speech-host.cjs');
const {compare,project}=require('./check-full.cjs');
const root=path.resolve(__dirname,'..'),baseline=path.join(root,'_work/baseline');
const original=require(path.join(baseline,'utils/phonetic/analysis.js')).analyzePcm;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function projected(v){return JSON.parse(JSON.stringify({...v,signal:Array.from(v.signal),spectrogram:{...v.spectrogram,times:Array.from(v.spectrogram.times),data:v.spectrogram.data.map(c=>Array.from(c))}}));}
async function main(){
  const wasm=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
  const host=await instantiateSpeech({api:WebAssembly,source:wasm});const records=[];
  async function check(name,rate,n,p={},cuts=[],silent=false,rails=false){
    const pcm=Int16Array.from({length:n},(_,i)=>silent?0:rails&&i>n*.6?32767:Math.round(5000*Math.sin(2*Math.PI*200*i/rate)+1800*Math.sin(2*Math.PI*1300*i/rate)+300));
    // Materialize and hash the actual JS result BEFORE invoking the port. The
    // primary immutable fixtures remain separate; these extend domain coverage.
    const expected=projected(await original(pcm,rate,{parameters:p,discontinuityBoundariesSeconds:cuts}));
    const expectedSha256=hash(JSON.stringify(expected));
    const actual=projected(project(await host.analyzePcmSpeech(pcm,{sampleRate:rate,parameters:p,discontinuityBoundariesSeconds:Float64Array.from(cuts)},{yieldFn:async()=>{}})));
    delete expected.RESULT_SCHEMA_VERSION;delete expected.ALGORITHM_VERSION;
    compare(actual,expected,'full',name);
    records.push({name,rate,samples:n,parameters:p,cuts,expectedSha256,columns:actual.spectrogram.width,pitchRows:actual.pitchTrack.length});
  }
  for(const rate of [12000,16000,22050,24000,32000,44100,48000])
    for(const maxFormant of [4000,4500,5000,5500,6000,7000,8000])if(maxFormant+1000<=rate/2)
      await check('profile-'+rate+'-'+maxFormant,rate,Math.round(rate*.18),{maxFormant,lpcOrder:14,windowMs:40});
  await check('nominal-longest',48000,252000,{maxFormant:8000,lpcOrder:14,windowMs:40},[],true);
  await check('nominal-longest-tonal',48000,252000,{maxFormant:8000,lpcOrder:14,windowMs:40});
  await check('one-sample',12000,1,{maxFormant:4000});
  await check('short-pieces',22050,3308,{},[1/22050,.03,.09]);
  await check('clipped-and-segmented',44100,8820,{task:'connected'},[.1],false,true);
  const pcm=new Int16Array(1200),opts={sampleRate:12000,parameters:{maxFormant:4000}};
  for(const bad of [[],false,1,'a',{parameters:[]},{parameters:{unknown:true}},{sampleRate:0},{sampleRate:16000,parameters:{maxFormant:8000}}])assert.throws(()=>host.fullBegin(pcm,bad),TypeError);
  assert.throws(()=>host.fullBegin(new Int16Array(),opts),TypeError);
  if(typeof SharedArrayBuffer==='function')assert.throws(()=>host.fullBegin(new Int16Array(new SharedArrayBuffer(2400)),opts),TypeError);
  let h=host.fullBegin(pcm,opts).handle;assert.throws(()=>host.fullFinish(h),e=>e.code===-8);assert.throws(()=>host.fullBegin(pcm,opts),e=>e.code===-6);host.fullCancel(h);
  assert.throws(()=>host.fullNext(h),e=>e.code===-1);const second=host.fullBegin(pcm,opts).handle;assert.ok(second>h);host.fullCancel(second);
  for(const stage of ['centered','pitch-resample','pitch','hnr','formant-resample','formants','spectrogram','intensity']){
    let canceled=false;await assert.rejects(host.analyzePcmSpeech(pcm,opts,{yieldFn:async()=>{},onProgress:p=>{if(p.stage===stage)canceled=true;},isCanceled:()=>canceled}),e=>e.name==='AbortError');
    h=host.fullBegin(pcm,opts).handle;host.fullCancel(h);
  }
  let done=false,canceled=false;
  await assert.rejects(host.analyzePcmSpeech(new Int16Array(12000),opts,{onProgress:p=>{done=p.done;},yieldFn:async()=>{if(done)canceled=true;},isCanceled:()=>canceled}),e=>e.name==='AbortError');
  h=host.fullBegin(pcm,opts).handle;host.fullCancel(h);
  await assert.rejects(host.analyzePcmSpeech(pcm,opts,{onProgress:async()=>{throw new Error('callback failed');}}),/callback failed/);
  h=host.fullBegin(pcm,opts).handle;host.fullCancel(h);
  // Ownership, cached finish and copied arrays survive staging reuse/memory growth.
  const source=new Int16Array([100,200,300]);h=host.fullBegin(source,opts).handle;source.fill(0);
  while(!host.fullNext(h).done){}const first=host.fullFinish(h),again=host.fullFinish(h);compare(first,again,'ownership');host.fullCancel(h);
  assert.ok(first.signal.some(v=>v!==0));const saved=first.signal.slice();host.preEmphasis(new Int16Array([1,2,3]));assert.deepEqual(first.signal,saved);
  fs.writeFileSync(path.join(root,'reports/full-domain-checks.json'),JSON.stringify({status:'PASS',cases:records,lifecycle:['bad options/shared memory','busy/stale/early-finish','cancel at every stage','cancel during result copying','rejected progress callback releases session','owned input/cached copied output'],artifactBytes:wasm.length,artifactSha256:hash(wasm),limits:['Additional live pinned-JS observations, not a replacement for immutable primary references','Desktop engine only; no WX/Android package/runtime or clinical qualification']},null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',domainCases:records.length,lifecycle:true}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
