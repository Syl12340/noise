'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),ref=path.join(__dirname,'reference'),artifact=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifestBytes=fs.readFileSync(path.join(ref,'manifest.json'));assert.equal(sha(manifestBytes),'57f98723dab3807de382e06cfe715d378b114a57629fb30adf7de260e51c6263');
const manifest=JSON.parse(manifestBytes);const tests=[];const check=(name,fn)=>{fn();tests.push({name,status:'PASS'});};
const stats={cases:0,exactNumbers:0,dbNumbers:0,maxDbError:0};
const number=v=>v==='NaN'?NaN:v==='+Infinity'?Infinity:v==='-Infinity'?-Infinity:v==='-0'?-0:v;
function compare(a,e,label,key='') {
  if(Array.isArray(e)){assert.ok(Array.isArray(a));assert.equal(a.length,e.length,label);for(let i=0;i<e.length;i++)compare(a[i],e[i],label+'['+i+']',key);}
  else if(e!==null&&typeof e==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(e).sort(),label);for(const k of Object.keys(e))compare(a[k],e[k],label+'.'+k,k);}
  else if(typeof e==='number'||['NaN','+Infinity','-Infinity','-0'].includes(e)){
    a=number(a);e=number(e);
    if(['db','avgHNR','partialMeanHNR'].includes(key)&&Number.isFinite(e)) {const error=Math.abs(a-e);assert.ok(Number.isFinite(a)&&error<=1e-10,label+': '+a+' vs '+e);stats.dbNumbers++;stats.maxDbError=Math.max(stats.maxDbError,error);}
    else{assert.ok(Object.is(a,e),label+': '+a+' vs '+e);stats.exactNumbers++;}
  }else assert.equal(a,e,label);
}
async function main() {
  const module=await WebAssembly.compile(artifact);assert.deepEqual(WebAssembly.Module.imports(module),[{module:'env',name:'hnr_sin',kind:'function'}]);
  const instance=new WebAssembly.Instance(module,{env:{hnr_sin:Math.sin}}),e=instance.exports,host=attachSpeechInstance(instance);
  for(const c of manifest.cases.filter(c=>c.op==='hnr')){
    const input=fs.readFileSync(path.join(ref,c.input));assert.equal(sha(input),c.inputSha256);
    const signal=Float32Array.from({length:input.length/4},(_,i)=>input.readFloatLE(i*4));
    const actual=host.harmonicity(signal,c.config);compare(actual,c.expected,c.name);stats.cases++;
  }
  check('HNR shares the pending speech result gate',()=>{
    assert.equal(e.speech_pcm_emphasis(0,.97),0);
    assert.equal(e.speech_harmonicity(0,12000,1024,120,40,1200,0,.2,.15,0),-3);assert.equal(e.speech_result_kind(),2);e.speech_ack();
  });
  check('oversize HNR input does not publish partial output',()=>{
    assert.equal(e.speech_harmonicity(8193,12000,1024,120,40,1200,0,.2,.15,0),-5);assert.equal(e.speech_result_kind(),0);
  });
  check('invalid and nonchronological pitch evidence rejects',()=>{
    assert.throws(()=>host.harmonicity(new Float32Array(1024),{pitchTrack:[{time:.2,f0:200,aperiodicity:.1},{time:.1,f0:200,aperiodicity:.1}]}),error=>error.code===-2);
    assert.equal(e.speech_result_kind(),0);
  });
  check('HNR frame count budget rejects before refinement',()=>{
    assert.throws(()=>host.harmonicity(new Float32Array(8192),{frameSize:256,hop:1}),error=>error.code===-5);assert.equal(e.speech_result_kind(),0);
  });
  check('memory growth and copied metadata remain valid',()=>{
    const before=e.memory.buffer;e.memory.grow(1);assert.equal(before.byteLength,0);
    const result=host.harmonicity(new Float32Array(1024));assert.equal(result.track[0].reason,'low-energy');
    host.preEmphasis(new Int16Array([100,200]));assert.equal(result.track[0].reason,'low-energy');
  });
  check('throwing scalar import invalidates the whole host instance',()=>{
    const inst=new WebAssembly.Instance(module,{env:{hnr_sin:()=>{throw new Error('math dependency failed');}}});
    const broken=attachSpeechInstance(inst),signal=Float32Array.from({length:1024},(_,i)=>.2*Math.sin(2*Math.PI*203.7*i/12000));
    assert.throws(()=>broken.harmonicity(signal,{requirePitch:true,pitchTrack:[{time:512/12000,f0:203.7,aperiodicity:.1}]}),/math dependency failed/);
    assert.equal(broken.discarded,true);assert.throws(()=>broken.preEmphasis(new Int16Array()),/discarded/);
  });
  let denied=false;
  try {await instantiateSpeech({api:{compile:async()=>({}),Module:{imports:()=>[{module:'env',name:'unexpected',kind:'function'}]},instantiate:async()=>{throw new Error('Must not instantiate');}},source:new Uint8Array()});}catch(error){denied=/unauthorized/.test(error.message);}
  check('loader rejects any other import before instantiation',()=>assert.equal(denied,true));
  const injected=await instantiateSpeech({api:WebAssembly,source:artifact});
  check('loader accepts only the declared scalar math import',()=>assert.equal(injected.harmonicity(new Float32Array(1024)).validFrames,0));
  const report={status:'PASS',profile:manifest.profile,stats,tests,artifact:{bytes:artifact.length,sha256:sha(artifact),imports:WebAssembly.Module.imports(module)},scope:'Actual Rust DSP with runtime scalar Math.sin; no JS DSP fallback. WX/device/whole-recording scheduling unverified.'};
  fs.writeFileSync(path.join(root,'reports/hnr-wasm.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
