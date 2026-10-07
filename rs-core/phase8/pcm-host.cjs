'use strict';
function attachPcm({host,e,call,input,result}){
 const rateValid=r=>Number.isInteger(r)&&[12000,16000,22050,24000,32000,44100,48000].includes(r);
 function support(){if(typeof e.speech_pcm_quality_abi_version!=='function'||call('speech_pcm_quality_abi_version',[])!==1||typeof e.speech_inspect_pcm!=='function'||typeof e.speech_center_pcm!=='function')throw new Error('Unsupported PCM quality ABI');}
 function inspect(pcm,rate=44100){support();if(!rateValid(rate))throw new TypeError('Invalid PCM rate');input(pcm,Int16Array,262144,'speech_pcm_ptr');return result('speech_inspect_pcm',[pcm.length,rate],1);}
 function center(pcm){support();input(pcm,Int16Array,262144,'speech_pcm_ptr');return result('speech_center_pcm',[pcm.length],2);}
 async function analyze(pcm,options={},hooks={}){
  support();
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['sampleRate','discontinuityBoundariesSeconds'].includes(k)))throw new TypeError('Invalid PCM analysis options');
  const {sampleRate=44100,discontinuityBoundariesSeconds=new Float64Array()}=options;
  if(!rateValid(sampleRate)||!(pcm instanceof Int16Array)||pcm.length===0||pcm.length>262144||pcm.length>sampleRate*5.25||!(discontinuityBoundariesSeconds instanceof Float64Array)||discontinuityBoundariesSeconds.length>4096)throw new TypeError('Invalid PCM capture');
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||Object.keys(hooks).some(k=>!['yieldFn','onProgress','isCanceled'].includes(k)))throw new TypeError('Invalid PCM scheduling hooks');
  const {yieldFn=()=>new Promise(resolve=>setTimeout(resolve,0)),onProgress=()=>{},isCanceled=()=>false}=hooks;
  if(![yieldFn,onProgress,isCanceled].every(f=>typeof f==='function'))throw new TypeError('Invalid PCM scheduling hooks');
  const check=()=>{if(isCanceled()){const error=new Error('PCM HNR analysis canceled');error.name='AbortError';throw error;}};
  check();const owned=pcm.slice(),boundaries=discontinuityBoundariesSeconds.slice();
  const spans=host.planSegments(owned.length,sampleRate,boundaries),pieces=[],segmentQuality=[];
  for(let index=0;index<spans.length;index++){
   check();const span=spans[index],chunk=owned.subarray(span.startSample,span.endSample);
   const quality=inspect(chunk,sampleRate),centered=center(chunk);
   segmentQuality.push({startSample:span.startSample,endSample:span.endSample,quality});
   await onProgress({stage:'centered',segmentIndex:index,segments:spans.length});check();await yieldFn();check();
   const signal=host.resample(centered,sampleRate);
   await onProgress({stage:'resampled',segmentIndex:index,segments:spans.length});check();await yieldFn();check();
   const pitchTrack=host.track(signal); // Fixed recording YIN profile; all DSP stays Rust.
   pieces.push({startSample:span.startSample,endSample:span.endSample,signal,pitchTrack,intervals:quality.clippingEvidence.intervals});
   await onProgress({stage:'pitch',segmentIndex:index,segments:spans.length});check();await yieldFn();check();
  }
  const assembled=await host.harmonicitySegments(pieces,{sampleCount:owned.length,sampleRate},{yieldFn,isCanceled,onProgress:r=>onProgress({...r,stage:'hnr'})});
  check();return {...assembled,segmentQuality,profile:'pcm-hnr-v1'};
 }
 return {inspectPcm:inspect,centerPcm:center,analyzePcmHnr:analyze};
}
module.exports={attachPcm};
