'use strict';
const {parentPort}=require('node:worker_threads');
const {attachSpeechInstance}=require('../phase3/speech-host.cjs');
const {createWorkerService}=require('./worker-service.cjs');
if(!parentPort)throw new Error('Run this entry in a Worker');
async function createHost(source){
 const module=await WebAssembly.compile(source),imports=WebAssembly.Module.imports(module);
 if(imports.length!==1||imports.some(i=>i.module!=='env'||i.name!=='hnr_sin'||i.kind!=='function'))throw new Error('Worker requires the harmonicity build');
 const instance=await WebAssembly.instantiate(module,{env:{hnr_sin:Math.sin}});
 for(const name of ['speech_pcm_quality_abi_version','speech_segments_abi_version','speech_pitch_session_abi_version','speech_resample_session_abi_version'])if(typeof instance.exports[name]!=='function'||instance.exports[name]()!==1)throw new Error('Unsupported Worker pipeline ABI');
 return attachSpeechInstance(instance);
}
const service=createWorkerService({post:m=>parentPort.postMessage(m),createHost});
parentPort.on('message',service.receive);
parentPort.on('messageerror',service.transportFailure);
