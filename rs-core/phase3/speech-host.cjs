'use strict';
const REQUIRED=['speech_abi_version','speech_input_capacity','speech_frame_capacity','speech_pcm_ptr','speech_signal_ptr','speech_frame_ptr',
  'speech_result_kind','speech_result_ptr','speech_result_len','speech_ack','speech_pitch_frame','speech_track','speech_pcm_emphasis','speech_float_emphasis','speech_resample'];
const u32=x=>Number.isInteger(x)&&x>=0&&x<=0xffffffff;
function attachSpeechInstance(instance) {
  const e=instance&&instance.exports;
  if(!e||REQUIRED.some(k=>typeof e[k]!=='function')||!e.memory||Object.prototype.toString.call(e.memory.buffer)!=='[object ArrayBuffer]'||typeof e.memory.grow!=='function')throw new Error('Invalid speech exports or memory');
  if(e.speech_abi_version()!==1||e.speech_input_capacity()!==262144||e.speech_frame_capacity()!==4096)throw new Error('Unsupported speech identity');
  let discarded=false;
  function alive(){if(discarded)throw new Error('Speech instance discarded');}
  function call(name,args){alive();try{return e[name](...args);}catch(error){discarded=true;throw error;}}
  function range(ptr,len,alignment){const buffer=e.memory.buffer;if(!u32(ptr)||!u32(len)||ptr%alignment!==0||ptr>buffer.byteLength||len>buffer.byteLength-ptr)throw new Error('Invalid speech memory range');return buffer;}
  function input(values,Type,limit,ptrName) {
    alive();if(!(values instanceof Type)||values.length>limit)throw new TypeError('Invalid speech input');
    if(call('speech_result_kind',[])!==0){const error=new Error('Pending speech result');error.code=-3;throw error;}
    try {const ptr=call(ptrName,[]);new Type(range(ptr,values.byteLength,Type.BYTES_PER_ELEMENT),ptr,values.length).set(values);}catch(error){discarded=true;throw error;}
  }
  function result(name,args,expected) {
    const status=call(name,args);
    if(status!==0){const error=new Error('Speech status '+status);error.code=status;throw error;}
    try {
      const kind=call('speech_result_kind',[]),ptr=call('speech_result_ptr',[]),len=call('speech_result_len',[]);
      if(kind!==expected||len>2*1024*1024)throw new Error('Invalid speech result kind/size');
      let output;
      if(kind===2) {
        if(len%4!==0||len>262144*4)throw new Error('Invalid float result length');
        // Empty Vec uses an aligned dangling pointer; zero-length view is safe in-range.
        output=new Float32Array(range(ptr,len,4),ptr,len/4).slice();
      } else {
        if(len===0)throw new Error('Empty JSON result');
        const copied=new Uint8Array(range(ptr,len,1),ptr,len).slice();let text='';
        for(let i=0;i<copied.length;i+=8192){const block=copied.subarray(i,i+8192);for(const b of block)if(b>127)throw new Error('Non-ASCII speech JSON');text+=String.fromCharCode.apply(null,block);}
        output=JSON.parse(text);
      }
      if(call('speech_ack',[])!==0)throw new Error('Speech acknowledgment failed');return output;
    }catch(error){discarded=true;throw error;}
  }
  const config=(fs,threshold,min,max)=>{if(![fs,threshold,min,max].every(Number.isFinite))throw new TypeError('Invalid pitch configuration');};
  function options(value,track) {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Pitch options must be an object');
    const allowed=track?['fs','threshold','fmin','fmax','frameSize','hop','hopSize']:['fs','threshold','fmin','fmax'];
    if(Object.keys(value).some(key=>!allowed.includes(key)))throw new TypeError('Unknown pitch option');
    const {fs=12000,threshold=.1,fmin=40,fmax=1200,frameSize=1024,hop,hopSize}=value;
    if(hop!==undefined&&hopSize!==undefined&&hop!==hopSize)throw new TypeError('Conflicting hop/hopSize');
    return {fs,threshold,fmin,fmax,frameSize,hop:hop===undefined?(hopSize===undefined?120:hopSize):hop};
  }
  return {
    get discarded(){return discarded;},discard(){discarded=true;},
    pitchFrame(frame,opts={}) {const {fs,threshold,fmin,fmax}=options(opts,false);config(fs,threshold,fmin,fmax);input(frame,Float64Array,4096,'speech_frame_ptr');return result('speech_pitch_frame',[frame.length,fs,threshold,fmin,fmax],1);},
    track(signal,opts={}) {
      const {fs,frameSize,hop,threshold,fmin,fmax}=options(opts,true);
      config(fs,threshold,fmin,fmax);if(!u32(frameSize)||frameSize===0||!u32(hop)||hop===0||fs<=0)throw new TypeError('Invalid track configuration');
      input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_track',[signal.length,fs,frameSize,hop,threshold,fmin,fmax],1);
    },
    preEmphasis(pcm,coef=.97) {if(!Number.isFinite(coef))throw new TypeError('Invalid coefficient');input(pcm,Int16Array,262144,'speech_pcm_ptr');return result('speech_pcm_emphasis',[pcm.length,coef],2);},
    emphasizeFloat(signal,coef=.97) {if(!Number.isFinite(coef))throw new TypeError('Invalid coefficient');input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_float_emphasis',[signal.length,coef],2);},
    resample(signal,inputRate,outputRate=12000,cutoffHz=5500) {
      if(!u32(inputRate)||!u32(outputRate)||!Number.isFinite(cutoffHz))throw new TypeError('Invalid resample configuration');
      input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_resample',[signal.length,inputRate,outputRate,cutoffHz],2);
    },
    harmonicity(signal,opts={}) {
      if(typeof e.speech_harmonicity!=='function'||typeof e.speech_pitch_ptr!=='function'||typeof e.speech_pitch_capacity!=='function'||typeof e.speech_hnr_input_capacity!=='function')throw new Error('Build does not include harmonicity');
      if(call('speech_pitch_capacity',[])!==512||call('speech_hnr_input_capacity',[])!==8192)throw new Error('Invalid harmonicity identity');
      if(!opts||typeof opts!=='object'||Array.isArray(opts))throw new TypeError('Invalid harmonicity options');
      const allowed=['fs','frameSize','hop','hopSize','fmin','fmax','pitchTrack','requirePitch','minPeakCorrelation','maxPitchDeviation'];
      if(Object.keys(opts).some(k=>!allowed.includes(k)))throw new TypeError('Unknown harmonicity option');
      const {fs=12000,frameSize=1024,hop,hopSize,fmin=40,fmax=1200,pitchTrack=[],requirePitch=false,minPeakCorrelation=.2,maxPitchDeviation=.15}=opts;
      if(hop!==undefined&&hopSize!==undefined&&hop!==hopSize)throw new TypeError('Conflicting hop/hopSize');
      const hopValue=hop===undefined?(hopSize===undefined?120:hopSize):hop;
      if(!u32(frameSize)||!u32(hopValue)||typeof requirePitch!=='boolean'||![fs,fmin,fmax,minPeakCorrelation,maxPitchDeviation].every(Number.isFinite)||!Array.isArray(pitchTrack)||pitchTrack.length>512)throw new TypeError('Invalid harmonicity configuration');
      const evidence=new Float64Array(pitchTrack.length*3);
      for(let i=0;i<pitchTrack.length;i++) {
        const p=pitchTrack[i];if(!p||![p.time,p.f0,p.aperiodicity].every(Number.isFinite))throw new TypeError('Invalid pitch evidence');
        evidence.set([p.time,p.f0,p.aperiodicity],i*3);
      }
      input(signal,Float32Array,8192,'speech_signal_ptr');
      try {const ptr=call('speech_pitch_ptr',[]);new Float64Array(range(ptr,evidence.byteLength,8),ptr,evidence.length).set(evidence);}catch(error){discarded=true;throw error;}
      return result('speech_harmonicity',[signal.length,fs,frameSize,hopValue,fmin,fmax,requirePitch?1:0,minPeakCorrelation,maxPitchDeviation,pitchTrack.length],1);
    },
  };
}
async function instantiateSpeech({api,source}) {
  if(!api||typeof api.instantiate!=='function')throw new TypeError('Supply WASM API');
  if(typeof api.compile==='function'&&api.Module&&typeof api.Module.imports==='function'&&typeof source!=='string') {
    const module=await api.compile(source);const imports=api.Module.imports(module);
    if(imports.length>1||imports.some(i=>i.module!=='env'||i.name!=='hnr_sin'||i.kind!=='function'))throw new Error('Speech imports unauthorized');
    const loaded=await api.instantiate(module,{env:{hnr_sin:Math.sin}});return attachSpeechInstance(loaded.instance||loaded);
  }
  const loaded=await api.instantiate(source,{env:{hnr_sin:Math.sin}});return attachSpeechInstance(loaded.instance||loaded);
}
module.exports={attachSpeechInstance,instantiateSpeech};
