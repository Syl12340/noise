'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {instantiateSpeech}=require('../phase3/speech-host.cjs');const root=path.resolve(__dirname,'..'),dir=path.join(__dirname,'reference'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mb=fs.readFileSync(path.join(dir,'manifest.json'));assert.equal(sha(mb),'442a65cc32b6fc50cebac1fcd57660940deb9a589f6c3319c54e516c2aa5679a');const m=JSON.parse(mb),wasm=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));let fields=0,db=0,maxDb=0;
function compare(a,e,key='',trail=''){
 if(ArrayBuffer.isView(a))a=Array.from(a);
 if(e!==null&&typeof e==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(e).sort(),trail);for(const k of Object.keys(e))compare(a[k],e[k],k,trail+'.'+k);}
 else if(typeof e==='number'&&['db','avgHNR','partialMeanHNR'].includes(key)){const d=Math.abs(a-e);assert.ok(Number.isFinite(a)&&d<=1e-10,trail+': '+a+' vs '+e);db++;maxDb=Math.max(maxDb,d);}
 else{assert.ok(Object.is(a,e),trail+': '+a+' vs '+e);fields++;}
}
class Wire{constructor(){this.b=[];}byte(v){this.b.push(Buffer.from([v]));return this;}u(v){const b=Buffer.alloc(4);b.writeUInt32LE(v);this.b.push(b);return this;}f(v){const b=Buffer.alloc(8);b.writeDoubleLE(v);this.b.push(b);return this;}d(v){this.u(v.length);v.forEach(n=>this.f(n));return this;}raw(v,size){this.u(v.length/size);this.b.push(v);return this;}oracle(c){const b=fs.readFileSync(path.join(dir,c.oracle.file));assert.equal(sha(b),c.oracle.sha256);this.b.push(b);return this;}run(){const p=cp.spawnSync(path.join(root,'target/release/examples/full_speech_driver.exe'),[],{input:Buffer.concat(this.b),maxBuffer:64*1024*1024});assert.equal(p.status,0,String(p.stderr));return JSON.parse(p.stdout);}}
function input(c){const b=fs.readFileSync(path.join(dir,c.input.file));assert.equal(sha(b),c.input.sha256);return b;}
function project(v){assert.equal(v.profile,'pcm-speech-v2');assert.equal(v.RESULT_SCHEMA_VERSION,2);assert.equal(v.ALGORITHM_VERSION,'acoustics-2026-10-05.1');delete v.profile;delete v.RESULT_SCHEMA_VERSION;delete v.ALGORITHM_VERSION;return v;}
async function main(){const host=await instantiateSpeech({api:WebAssembly,source:wasm});const completed=[];
 for(const c of m.cases){let w=new Wire();if(c.kind==='burg'){const b=input(c),v=Float64Array.from({length:b.length/8},(_,i)=>b.readDoubleLE(i*8));w.byte(1).u(c.order).d(Array.from(v));compare(host.burgLpc(v,c.order),c.expected,c.kind,c.name);}
  else if(c.kind==='roots'){w.byte(2).d(c.coefficients);if(c.error)assert.throws(()=>host.findPolynomialRoots(Float64Array.from(c.coefficients)),e=>e.code===-2);else compare(host.findPolynomialRoots(Float64Array.from(c.coefficients)),c.expected,c.kind,c.name);}
  else if(c.kind==='formants'){w.byte(3).u(c.rate).u(c.order).raw(input(c),4).u(c.pitch.length);c.pitch.forEach(p=>w.f(p.time).f(p.f0).f(p.aperiodicity));}
  else{w.byte(4).u(c.rate).raw(input(c),4);}
  const actual=w.oracle(c).run();if(c.error)assert.equal(actual.error,true);else compare(actual,c.expected,c.kind,c.name);completed.push(c.name);
 }
 for(const c of m.full){const p=c.params||{},b=input(c),w=new Wire().byte(5).u(c.rate).u(p.lpcOrder||12).u(p.maxFormant||5000).u(p.windowMs||25).byte(p.task==='connected'?1:0).d(c.cuts).raw(b,2).oracle(c);compare(project(w.run()),c.expected,'full','native-'+c.name);
  const pcm=Int16Array.from({length:b.length/2},(_,i)=>b.readInt16LE(i*2));const actual=await host.analyzePcmSpeech(pcm,{sampleRate:c.rate,parameters:p,discontinuityBoundariesSeconds:Float64Array.from(c.cuts)},{yieldFn:async()=>{}});compare(project(actual),c.expected,'full','wasm-'+c.name);completed.push(c.name);
 }
 const report={status:'PASS',completed,fields,db,maxDb,artifactBytes:wasm.length,artifactSha256:sha(wasm),manifestSha256:sha(mb),limits:['Compatibility with experimental baseline, not quantitative clinical validation','Native dynamic math uses actual-JS oracle; WX/package/runtime qualification remains open']};fs.writeFileSync(path.join(root,'reports/full-speech-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={compare,project};
