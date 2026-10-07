'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
async function main(){
 const source=fs.readFileSync(path.resolve(__dirname,'../target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
 const mod=await WebAssembly.compile(source),imports=WebAssembly.Module.imports(mod);
 assert.deepEqual(imports.map(v=>v.name).sort(),['hnr_sin','math_atan2','math_hypot','math_log','math_log10']);
 assert.ok(imports.every(v=>v.module==='env'&&v.kind==='function'));
 const loaded=await WebAssembly.instantiate(mod,{env:{hnr_sin:Math.sin,math_hypot:Math.hypot,math_atan2:Math.atan2,math_log:Math.log,math_log10:Math.log10}});
 assert.equal(Object.prototype.toString.call(loaded.exports.memory.buffer),'[object ArrayBuffer]');
 const rejectedApi={compile:async()=>mod,Module:{imports:()=>[{module:'env',name:'unknown_math',kind:'function'}]},instantiate:()=>{throw new Error('Unauthorized imports must not instantiate');}};
 await assert.rejects(instantiateSpeech({api:rejectedApi,source}),/unauthorized/);
 const host=attachSpeechInstance(loaded);let grown=false;
 await host.analyzePcmSpeech(new Int16Array(1200),{sampleRate:12000,parameters:{maxFormant:4000}},{yieldFn:async()=>{},onProgress:()=>{if(!grown){loaded.exports.memory.grow(1);grown=true;}}});
 assert.ok(grown&&!host.discarded);
 const report={status:'PASS',imports,artifactBytes:source.length,oldWorkerLimitBytes:4*1024*1024,exceedsOldWorkerLimit:source.length>4*1024*1024,unsharedMemory:true,memoryGrowthDuringSession:true};
 fs.writeFileSync(path.resolve(__dirname,'../reports/full-import-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
