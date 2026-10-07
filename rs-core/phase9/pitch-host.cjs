'use strict';
function attachPitch({e,call,input,result,discarded}){
 const u32=x=>Number.isInteger(x)&&x>0&&x<=0xffffffff;
 function support(){if(typeof e.speech_pitch_session_abi_version!=='function'||call('speech_pitch_session_abi_version',[])!==1||['speech_pitch_begin','speech_pitch_next','speech_pitch_finish','speech_pitch_cancel'].some(k=>typeof e[k]!=='function'))throw new Error('Unsupported pitch session ABI');}
 function handle(h){if(!u32(h))throw new TypeError('Invalid pitch handle');}
 function begin(signal,opts={}){
  support();if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!['fs','frameSize','hop','hopSize','threshold','fmin','fmax'].includes(k)))throw new TypeError('Invalid pitch session options');
  const {fs=12000,frameSize=1024,hop,hopSize,threshold=.1,fmin=40,fmax=1200}=opts;
  if(hop!==undefined&&hopSize!==undefined&&hop!==hopSize)throw new TypeError('Conflicting pitch hops');
  const step=hop===undefined?(hopSize===undefined?120:hopSize):hop;
  if(!u32(frameSize)||!u32(step)||![fs,threshold,fmin,fmax].every(Number.isFinite))throw new TypeError('Invalid pitch configuration');
  input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_pitch_begin',[signal.length,fs,frameSize,step,threshold,fmin,fmax],1);
 }
 function next(h){handle(h);return result('speech_pitch_next',[h],1);}
 function finish(h){handle(h);return result('speech_pitch_finish',[h],1);}
 function cancel(h){handle(h);const code=call('speech_pitch_cancel',[h]);if(code!==0){const error=new Error('Pitch cancel '+code);error.code=code;throw error;}}
 async function full(signal,opts={},hooks={}){
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['yieldFn','onProgress','isCanceled'].includes(k)))throw new TypeError('Invalid pitch hooks');
  const {yieldFn=()=>new Promise(r=>setTimeout(r,0)),onProgress=()=>{},isCanceled=()=>false}=hooks;
  if(![yieldFn,onProgress,isCanceled].every(f=>typeof f==='function'))throw new TypeError('Invalid pitch hooks');
  const check=()=>{if(isCanceled()){const error=new Error('Pitch canceled');error.name='AbortError';throw error;}};
  check();const h=begin(signal,opts).handle;
  try{let done=false;while(!done){check();const r=next(h);done=r.done;await onProgress(r);if(!done)await yieldFn();}check();return finish(h);}
  finally{if(!discarded())cancel(h);}
 }
 return {pitchBegin:begin,pitchNext:next,pitchFinish:finish,pitchCancel:cancel,trackAsync:full};
}
module.exports={attachPitch};
