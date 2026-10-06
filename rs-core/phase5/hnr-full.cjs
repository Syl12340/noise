'use strict';
// All framing, clock, nearest evidence and summary stay in Rust session state.
function attachHnrFull({e,call,input,range,result,discarded}) {
  const u32=x=>Number.isInteger(x)&&x>0&&x<=0xffffffff;
  function support() {
    for(const key of ['speech_hnr_session_abi_version','speech_session_pitch_capacity','speech_session_pitch_ptr','speech_hnr_begin','speech_hnr_next','speech_hnr_finish','speech_hnr_cancel'])if(typeof e[key]!=='function')throw new Error('Build does not include HNR sessions');
    if(call('speech_hnr_session_abi_version',[])!==1||call('speech_session_pitch_capacity',[])!==4096)throw new Error('Unsupported HNR session identity');
  }
  function handle(h){if(!u32(h))throw new TypeError('Invalid HNR session handle');}
  function begin(signal,opts={}) {
    support();if(!opts||typeof opts!=='object'||Array.isArray(opts))throw new TypeError('Invalid HNR options');
    const allowed=['fs','frameSize','hop','hopSize','fmin','fmax','pitchTrack','requirePitch','minPeakCorrelation','maxPitchDeviation'];
    if(Object.keys(opts).some(k=>!allowed.includes(k)))throw new TypeError('Unknown HNR option');
    const {fs=12000,frameSize=1024,hop,hopSize,fmin=40,fmax=1200,pitchTrack=[],requirePitch=false,minPeakCorrelation=.2,maxPitchDeviation=.15}=opts;
    if(hop!==undefined&&hopSize!==undefined&&hop!==hopSize)throw new TypeError('Conflicting hop/hopSize');
    const step=hop===undefined?(hopSize===undefined?120:hopSize):hop;
    if(!u32(frameSize)||!u32(step)||![fs,fmin,fmax,minPeakCorrelation,maxPitchDeviation].every(Number.isFinite)||typeof requirePitch!=='boolean'||!Array.isArray(pitchTrack)||pitchTrack.length>4096)throw new TypeError('Invalid HNR session configuration');
    const evidence=new Float64Array(pitchTrack.length*3);
    for(let i=0;i<pitchTrack.length;i++){const p=pitchTrack[i];if(!p||![p.time,p.f0,p.aperiodicity].every(Number.isFinite))throw new TypeError('Invalid pitch evidence');evidence.set([p.time,p.f0,p.aperiodicity],i*3);}
    input(signal,Float32Array,262144,'speech_signal_ptr');
    // Range failure is fatal: input() already checked ownership, and result() will
    // poison the host on traps/decoding. A staging range failure must do the same.
    try{const ptr=call('speech_session_pitch_ptr',[]);new Float64Array(range(ptr,evidence.byteLength,8),ptr,evidence.length).set(evidence);}catch(error){discarded(true);throw error;}
    return result('speech_hnr_begin',[signal.length,fs,frameSize,step,fmin,fmax,requirePitch?1:0,minPeakCorrelation,maxPitchDeviation,pitchTrack.length],1);
  }
  function next(h){handle(h);return result('speech_hnr_next',[h],1);}
  function finish(h){handle(h);return result('speech_hnr_finish',[h],1);}
  function cancel(h){handle(h);const code=call('speech_hnr_cancel',[h]);if(code!==0){const error=new Error('HNR cancel status '+code);error.code=code;throw error;}}
  const canceled=()=>{const error=new Error('HNR calculation canceled');error.name='AbortError';return error;};
  async function full(signal,opts={},hooks={}) {
    if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['yieldFn','onProgress','isCanceled'].includes(k)))throw new TypeError('Invalid HNR scheduling hooks');
    const {yieldFn=()=>new Promise(resolve=>setTimeout(resolve,0)),onProgress=()=>{},isCanceled=()=>false}=hooks;
    if(![yieldFn,onProgress,isCanceled].every(f=>typeof f==='function'))throw new TypeError('HNR hooks must be functions');
    if(isCanceled())throw canceled();
    const {handle:h}=begin(signal,opts);
    try {
      let done=false;
      while(!done) {
        if(isCanceled())throw canceled();
        const receipt=next(h);done=receipt.done;
        await onProgress(receipt); // Copied/acked; async callback errors also release ownership.
        if(!done)await yieldFn();
      }
      if(isCanceled())throw canceled();
      return finish(h);
    } finally {
      // If the instance faulted, its entire memory is invalid. Otherwise release
      // precisely this session; the other acknowledged session may keep running.
      if(!discarded())cancel(h);
    }
  }
  return {hnrBegin:begin,hnrNext:next,hnrFinish:finish,hnrCancel:cancel,harmonicityFull:full};
}
module.exports={attachHnrFull};
