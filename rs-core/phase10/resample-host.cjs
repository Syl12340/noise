'use strict';
function attachResample({e,call,input,result,discarded}){
 const u32=x=>Number.isInteger(x)&&x>0&&x<=0xffffffff;
 function support(){if(typeof e.speech_resample_session_abi_version!=='function'||call('speech_resample_session_abi_version',[])!==1||['speech_resample_begin','speech_resample_next','speech_resample_progress','speech_resample_finish','speech_resample_cancel'].some(k=>typeof e[k]!=='function'))throw new Error('Unsupported resample session ABI');}
 function handle(h){if(!u32(h))throw new TypeError('Invalid resample handle');}
 function batchSize(n){if(!Number.isInteger(n)||n<1||n>4096)throw new TypeError('Invalid resample batch');}
 function begin(signal,inputRate,outputRate=12000,cutoffHz=5500){support();if(!u32(inputRate)||!u32(outputRate)||!Number.isFinite(cutoffHz))throw new TypeError('Invalid resample profile');input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_resample_begin',[signal.length,inputRate,outputRate,cutoffHz],1);}
 function next(h,limit=256){handle(h);batchSize(limit);const values=result('speech_resample_next',[h,limit],2),progress=result('speech_resample_progress',[h],1);return {...progress,values};}
 function finish(h){handle(h);return result('speech_resample_finish',[h],2);}
 function cancel(h){handle(h);const code=call('speech_resample_cancel',[h]);if(code!==0){const error=new Error('Resample cancel '+code);error.code=code;throw error;}}
 async function full(signal,inputRate,outputRate=12000,cutoffHz=5500,hooks={}){
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['batchSize','yieldFn','onProgress','isCanceled'].includes(k)))throw new TypeError('Invalid resample hooks');
  const {batchSize:limit=256,yieldFn=()=>new Promise(r=>setTimeout(r,0)),onProgress=()=>{},isCanceled=()=>false}=hooks;batchSize(limit);
  if(![yieldFn,onProgress,isCanceled].every(f=>typeof f==='function'))throw new TypeError('Invalid resample hooks');
  const check=()=>{if(isCanceled()){const error=new Error('Resampling canceled');error.name='AbortError';throw error;}};
  check();const h=begin(signal,inputRate,outputRate,cutoffHz).handle;
  try{let done=false;while(!done){check();const receipt=next(h,limit);done=receipt.done;await onProgress(receipt);if(!done)await yieldFn();}check();return finish(h);}
  finally{if(!discarded())cancel(h);}
 }
 return {resampleBegin:begin,resampleNext:next,resampleFinish:finish,resampleCancel:cancel,resampleAsync:full};
}
module.exports={attachResample};
