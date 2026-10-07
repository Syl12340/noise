'use strict';
function attachSegments({host,e,call,input,range,result,discarded}){
 const u32=x=>Number.isInteger(x)&&x>=0&&x<=0xffffffff;
 const integer=x=>{if(!u32(x))throw new TypeError('Invalid unsigned argument');};
 const handle=h=>{integer(h);if(h===0)throw new TypeError('Invalid assembly handle');};
 function support(){if(typeof e.speech_segments_abi_version!=='function'||call('speech_segments_abi_version',[])!==1)throw new Error('Unsupported segment ABI');}
 function config(opts){
  if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!['sampleCount','sampleRate','frameSize','hop'].includes(k)))throw new TypeError('Invalid segment options');
  const {sampleCount,sampleRate,frameSize=1024,hop=120}=opts;[sampleCount,sampleRate,frameSize,hop].forEach(integer);return {sampleCount,sampleRate,frameSize,hop};
 }
 function intervals(values){
  if(!Array.isArray(values)||values.length>4096)throw new TypeError('Invalid clipping intervals');
  const pairs=new Float64Array(values.length*2);
  values.forEach((p,i)=>{if(!p||![p.start,p.end].every(Number.isFinite))throw new TypeError('Invalid clipping interval');pairs.set([p.start,p.end],i*2);});
  if(call('speech_result_kind',[])!==0){const error=new Error('Pending speech result');error.code=-3;throw error;}
  try{const ptr=call('speech_support_intervals_ptr',[]);new Float64Array(range(ptr,pairs.byteLength,8),ptr,pairs.length).set(pairs);}catch(error){discarded(true);throw error;}
 }
 function plan(sampleCount,sampleRate,boundaries=new Float64Array()){
  support();integer(sampleCount);integer(sampleRate);input(boundaries,Float64Array,4096,'speech_frame_ptr');return result('speech_plan_segments',[sampleCount,sampleRate,boundaries.length],1);
 }
 function pitch(track,opts,clips=[]){
  support();const {sampleCount,sampleRate,frameSize}=config(opts);
  if(!Array.isArray(track)||track.length>4096)throw new TypeError('Invalid pitch evidence');
  const data=new Float64Array(track.length*3);track.forEach((p,i)=>{if(!p||![p.time,p.f0,p.aperiodicity].every(Number.isFinite))throw new TypeError('Invalid pitch evidence');data.set([p.time,p.f0,p.aperiodicity],i*3);});
  input(new Float64Array(),Float64Array,4096,'speech_frame_ptr');intervals(clips);
  try{const ptr=call('speech_session_pitch_ptr',[]);new Float64Array(range(ptr,data.byteLength,8),ptr,data.length).set(data);}catch(error){discarded(true);throw error;}
  return result('speech_prepare_pitch',[sampleCount,sampleRate,frameSize,track.length,clips.length],1);
 }
 function begin(opts){support();const c=config(opts);return result('speech_assembly_begin',[c.sampleCount,c.sampleRate,c.frameSize,c.hop],1);}
 function append(h,hnr,start,end,clips=[]){handle(h);integer(hnr);integer(start);integer(end);intervals(clips);return result('speech_assembly_append',[h,hnr,start,end,clips.length],1);}
 function finish(h){handle(h);return result('speech_assembly_finish',[h],1);}
 function cancel(h){handle(h);const code=call('speech_assembly_cancel',[h]);if(code!==0){const error=new Error('Assembly cancel '+code);error.code=code;throw error;}}
 async function full(pieces,opts,hooks={}){
  const c=config(opts);
  if(c.sampleCount===0||c.sampleCount>262144||![12000,16000,22050,24000,32000,44100,48000].includes(c.sampleRate))throw new TypeError('Invalid capture domain');
  if(!Array.isArray(pieces)||pieces.length<1||pieces.length>128)throw new TypeError('Invalid segment pieces');
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['yieldFn','onProgress','isCanceled'].includes(k)))throw new TypeError('Invalid scheduling hooks');
  const {yieldFn=()=>new Promise(r=>setTimeout(r,0)),onProgress=()=>{},isCanceled=()=>false}=hooks;
  if(![yieldFn,onProgress,isCanceled].every(f=>typeof f==='function'))throw new TypeError('Invalid scheduling hooks');
  const check=()=>{if(isCanceled()){const error=new Error('Segment HNR canceled');error.name='AbortError';throw error;}};
  let cursor=0,totalSignal=0,totalPitch=0,totalClips=0;
  const descriptions=pieces.map(p=>{
   if(!p||Object.keys(p).some(k=>!['startSample','endSample','signal','pitchTrack','intervals','failed'].includes(k)))throw new TypeError('Invalid segment piece');
   integer(p.startSample);integer(p.endSample);if(p.failed!==undefined&&typeof p.failed!=='boolean')throw new TypeError('Invalid failed flag');
   if(p.startSample!==cursor||p.endSample<=cursor||p.endSample>c.sampleCount)throw new TypeError('Invalid segment partition');cursor=p.endSample;
   if(!p.failed&&(!(p.signal instanceof Float32Array)||p.signal.length>262144||!Array.isArray(p.pitchTrack)||p.pitchTrack.length>4096))throw new TypeError('Invalid segment inputs');
   if(p.failed&&(p.signal!==undefined||p.pitchTrack!==undefined||(p.intervals&&p.intervals.length)))throw new TypeError('Failed piece contains analysis data');
   const clips=p.intervals===undefined?[]:p.intervals;
   if(!Array.isArray(clips)||clips.length>4096)throw new TypeError('Invalid segment intervals');
   totalSignal+=p.failed?0:p.signal.length;totalPitch+=p.failed?0:p.pitchTrack.length;totalClips+=clips.length;
   if(totalSignal>262144||totalPitch>4096||totalClips>4096)throw new TypeError('Segment input capacity exceeded');
   return {...p,signal:p.failed?undefined:p.signal.slice(),pitchTrack:p.failed?undefined:p.pitchTrack.map(r=>({...r})),intervals:clips.map(i=>({...i}))};
  });
  if(cursor!==c.sampleCount)throw new TypeError('Incomplete segment partition');
  check();const h=begin(c).handle;
  try{
   for(let index=0;index<descriptions.length;index++){
    check();const p=descriptions[index];
    if(p.failed){append(h,0,p.startSample,p.endSample,[]);continue;}
    const qualified=pitch(p.pitchTrack,{sampleCount:p.endSample-p.startSample,sampleRate:c.sampleRate,frameSize:c.frameSize},p.intervals);
    const sh=host.hnrBegin(p.signal,{frameSize:c.frameSize,hop:c.hop,pitchTrack:qualified,requirePitch:true}).handle;
    try{
     let done=false;while(!done){check();const receipt=host.hnrNext(sh);done=receipt.done;await onProgress({...receipt,segmentIndex:index});if(!done)await yieldFn();}
     check();host.hnrFinish(sh);append(h,sh,p.startSample,p.endSample,p.intervals);
    }finally{if(!discarded())host.hnrCancel(sh);}
    await yieldFn();
   }
   check();return finish(h);
  }finally{if(!discarded())cancel(h);}
 }
 return {planSegments:plan,preparePitchEvidence:pitch,assemblyBegin:begin,assemblyAppend:append,assemblyFinish:finish,assemblyCancel:cancel,harmonicitySegments:full};
}
module.exports={attachSegments};
