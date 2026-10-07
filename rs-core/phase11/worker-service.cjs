'use strict';
const P=require('./protocol.cjs');
function createWorkerService({post,createHost}){
 let epoch=0,host=null,initializing=false,dead=false,active=null,lastId=0;
 const send=(type,extra={})=>{try{post({protocol:P.PROTOCOL,epoch,type,...extra});return true;}catch{dead=true;if(active){active.canceled=true;releaseWait(active);}return false;}};
 function releaseWait(job){if(job.wait){const resolve=job.wait.resolve;job.wait=null;resolve();}}
 function fatal(e){if(dead)return;dead=true;if(active){active.canceled=true;releaseWait(active);}send('fatal',{error:P.packError(e)});}
 async function run(job,owned){
  let type='result',payload;
  try{
   payload=await host.analyzePcmHnr(owned.pcm,owned.options,{isCanceled:()=>job.canceled,onProgress:value=>{
    if(job.canceled)return;
    const progress=P.compactProgress(value);job.seq++;
    return new Promise(resolve=>{job.wait={seq:job.seq,resolve};send('progress',{id:job.id,seq:job.seq,payload:progress});});
   }});
   if(job.canceled){type='canceled';payload=null;}else P.validateResult(payload,{samples:owned.pcm.length,rate:owned.options.sampleRate});
  }catch(e){if(job.canceled||e.name==='AbortError'){type='canceled';payload=null;}else{type='error';payload=P.packError(e);}}
  finally{releaseWait(job);if(active===job)active=null;}
  if(dead)return;
  if(host.discarded){fatal(P.error('WorkerError','WASM instance discarded'));return;}
  send(type,{id:job.id,...(type==='result'?{payload}:type==='error'?{error:payload}:{})});
 }
 function receive(m){
  if(dead)return;
  try{
   if(epoch&&m&&P.u32(m.epoch)&&m.epoch!==epoch)return;
   if(!m||m.protocol!==P.PROTOCOL||!P.u32(m.epoch))throw P.error('ProtocolError','Invalid Worker request');
   if(m.type==='init'){
    if(epoch||initializing)throw P.error('ProtocolError','Duplicate initialization');epoch=m.epoch;
    if(!P.buffer(m.wasm)||m.wasm.byteLength===0||m.wasm.byteLength>P.MAX_WASM)throw P.error('ProtocolError','Invalid WASM payload');
    initializing=true;Promise.resolve().then(()=>createHost(new Uint8Array(m.wasm))).then(value=>{if(dead)return;if(!value||typeof value.analyzePcmHnr!=='function'||typeof value.discarded!=='boolean')throw P.error('WorkerError','Invalid analysis host');host=value;initializing=false;send('ready');}).catch(fatal);return;
   }
   if(m.epoch!==epoch)return;
   if(!P.u32(m.id))throw P.error('ProtocolError','Invalid job id');
   if(m.type==='cancel'){if(active&&active.id===m.id){active.canceled=true;releaseWait(active);}else send('canceled',{id:m.id});return;}
   if(m.type==='progress-ack'){if(active&&active.id===m.id&&active.wait&&active.wait.seq===m.seq)releaseWait(active);return;}
   if(m.type!=='analyze')throw P.error('ProtocolError','Unknown Worker request');
   if(!host||initializing)throw P.error('ProtocolError','Worker not ready');
   if(active){send('error',{id:m.id,error:P.packError(P.error('BusyError','Worker busy'))});return;}
   if(m.id<=lastId){send('error',{id:m.id,error:P.packError(P.error('ProtocolError','Job id reused'))});return;}
   lastId=m.id;let owned;
   try{owned=P.capture(m.pcm,m.options);}catch(e){send('error',{id:m.id,error:P.packError(e)});return;}
   const job={id:m.id,canceled:false,seq:0,wait:null};active=job;send('started',{id:m.id});void run(job,owned);
  }catch(e){fatal(e);}
 }
 return {receive,transportFailure(){fatal(P.error('WorkerError','Worker request deserialization failed'));},dispose(){dead=true;if(active){active.canceled=true;releaseWait(active);}},get active(){return active!==null;}};
}
module.exports={createWorkerService};
