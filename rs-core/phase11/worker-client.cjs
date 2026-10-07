'use strict';
const P=require('./protocol.cjs');let epochs=0;
function createAnalysisClient({transport,wasmBytes,readyTimeoutMs=10000,jobTimeoutMs=120000,cancelTimeoutMs=2000}){
 if(!transport||['postMessage','onMessage','onError','onExit','terminate'].some(k=>typeof transport[k]!=='function'))throw new TypeError('Invalid Worker transport');
 for(const n of [readyTimeoutMs,jobTimeoutMs,cancelTimeoutMs])if(!Number.isInteger(n)||n<1||n>3600000)throw new TypeError('Invalid Worker deadline');
 if(!(wasmBytes instanceof Uint8Array)||!P.buffer(wasmBytes.buffer)||wasmBytes.byteLength===0||wasmBytes.byteLength>P.MAX_WASM||epochs>=0xffffffff)throw new TypeError('Invalid WASM bytes/epoch');
 const epoch=++epochs,wasm=Uint8Array.from(wasmBytes);let state='initializing',nextId=1,job=null,readyTimer,termination=null;
 let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 const subscriptions=[];
 function stop(){for(const off of subscriptions.splice(0))if(typeof off==='function'){try{off();}catch{}}try{termination=Promise.resolve(transport.terminate());}catch(e){termination=Promise.reject(e);}termination.catch(()=>{});}
 function settle(current,e,value){clearTimeout(current.timer);clearTimeout(current.cancelTimer);if(job===current)job=null;if(e)current.reject(e);else current.resolve(value);}
 function fail(e){if(state==='faulted'||state==='closed')return;state='faulted';clearTimeout(readyTimer);rejectReady(e);if(job)settle(job,e);stop();}
 function send(type,extra={},transfers=[]){try{transport.postMessage({protocol:P.PROTOCOL,epoch,type,...extra},transfers);}catch(e){fail(e);}}
 function cancel(current,reason=P.error('AbortError','Worker analysis canceled')){
  if(job!==current||current.canceling)return;current.canceling=true;current.reason=reason;clearTimeout(current.timer);
  current.cancelTimer=setTimeout(()=>fail(P.error('WorkerError','Worker cancellation timed out')),cancelTimeoutMs);
  send('cancel',{id:current.id});
 }
 function receive(m){
  if(state==='faulted'||state==='closed')return;
  try{
   if(m&&P.u32(m.epoch)&&m.epoch!==epoch)return;
   if(!m||m.protocol!==P.PROTOCOL||!P.u32(m.epoch))throw P.error('ProtocolError','Invalid Worker response');if(m.epoch!==epoch)return;
   if(m.type==='fatal'){fail(P.unpackError(m.error));return;}
   if(m.type==='ready'){if(state!=='initializing')throw P.error('ProtocolError','Duplicate ready');clearTimeout(readyTimer);state='ready';resolveReady();return;}
   if(!P.u32(m.id))throw P.error('ProtocolError','Invalid response id');if(!job||m.id!==job.id)return;
   const current=job;
   if(m.type==='started'){if(current.started)throw P.error('ProtocolError','Duplicate start');current.started=true;return;}
   if(m.type==='progress'){
    if(current.canceling)return;
    if(!current.started||!P.u32(m.seq)||m.seq!==current.seq+1||current.waiting!==null)throw P.error('ProtocolError','Progress order/queue violation');
    P.validateProgress(m.payload);current.seq=m.seq;current.waiting=m.seq;
    Promise.resolve().then(()=>current.onProgress(m.payload)).then(()=>{if(job!==current||current.canceling)return;current.waiting=null;send('progress-ack',{id:current.id,seq:m.seq});},e=>cancel(current,e));return;
   }
   if(m.type==='canceled'){settle(current,current.reason||P.error('AbortError','Worker analysis canceled'));return;}
   if(current.canceling)return; // A result raced with cancellation; await explicit cancellation ack.
   if(m.type==='error'){settle(current,P.unpackError(m.error));return;}
   if(m.type==='result'){if(!current.started||current.waiting!==null)throw P.error('ProtocolError','Result before acknowledged progress');P.validateResult(m.payload,current.source);settle(current,null,m.payload);return;}
   throw P.error('ProtocolError','Unknown Worker response');
  }catch(e){fail(e);}
 }
 try{subscriptions.push(transport.onMessage(receive),transport.onError(e=>fail(P.error('WorkerError',String(e&&e.message||e)))),transport.onExit(code=>fail(P.error('WorkerError','Worker exited '+String(code)))));
  if(subscriptions.some(f=>typeof f!=='function'))throw new TypeError('Transport must return unsubscribe functions');
  readyTimer=setTimeout(()=>fail(P.error('TimeoutError','Worker ready timeout')),readyTimeoutMs);send('init',{wasm:wasm.buffer},[wasm.buffer]);
 }catch(e){fail(e);}
 function start(pcm,options={},hooks={}){
  if(state!=='ready')throw P.error('WorkerError','Worker client not ready');if(job)throw P.error('BusyError','Worker busy');if(nextId>0xffffffff)throw P.error('CapacityError','Worker job ids exhausted');
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['onProgress','timeoutMs'].includes(k)))throw new TypeError('Invalid Worker hooks');
  const {onProgress=()=>{},timeoutMs=jobTimeoutMs}=hooks;if(typeof onProgress!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new TypeError('Invalid Worker hooks');
  const owned=P.capture(pcm,options),id=nextId++;let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});
  const current={id,resolve,reject,onProgress,source:{samples:owned.pcm.length,rate:owned.options.sampleRate},seq:0,waiting:null,started:false,canceling:false,reason:null,timer:null,cancelTimer:null};job=current;
  current.timer=setTimeout(()=>cancel(current,P.error('TimeoutError','Worker analysis timeout')),timeoutMs);
  send('analyze',{id,pcm:owned.pcm,options:owned.options},[owned.pcm.buffer,owned.options.discontinuityBoundariesSeconds.buffer]);
  return {id,promise,cancel:()=>cancel(current)};
 }
 function close(){if(state!=='closed'&&state!=='faulted'){state='closed';clearTimeout(readyTimer);const e=P.error('AbortError','Worker client closed');rejectReady(e);if(job)settle(job,e);stop();}return termination||Promise.resolve();}
 return {ready,start,close,get state(){return state;},get busy(){return job!==null;},get epoch(){return epoch;}};
}
module.exports={createAnalysisClient};
