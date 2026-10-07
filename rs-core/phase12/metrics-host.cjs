'use strict';
function attachVoiceMetrics({e,call,input,result}){
 const u32=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff;
 function support(){if(typeof e.speech_voice_metrics_abi_version!=='function'||call('speech_voice_metrics_abi_version',[])!==1||typeof e.speech_intensity_track!=='function'||typeof e.speech_period_variability!=='function')throw new Error('Unsupported voice metrics ABI');}
 function intensity(signal,opts={}){
  support();if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!['fs','frameSize','hop','hopSize'].includes(k)))throw new TypeError('Invalid intensity options');
  const {fs=12000,frameSize,hop,hopSize}=opts;if(!Number.isFinite(fs)||(frameSize!==undefined&&!u32(frameSize))||(hop!==undefined&&!u32(hop))||(hopSize!==undefined&&!u32(hopSize))||(hop!==undefined&&hopSize!==undefined&&hop!==hopSize))throw new TypeError('Invalid intensity configuration');
  const step=hop===undefined?hopSize:hop;input(signal,Float32Array,262144,'speech_signal_ptr');return result('speech_intensity_track',[signal.length,fs,frameSize===undefined?0:frameSize,step===undefined?0:step],1);
 }
 function variability(f0,opts={}){
  support();if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!['hasCaptureGaps','clippedInput'].includes(k)))throw new TypeError('Invalid variability options');
  const {hasCaptureGaps=false,clippedInput=false}=opts;if(typeof hasCaptureGaps!=='boolean'||typeof clippedInput!=='boolean')throw new TypeError('Invalid variability flags');
  input(f0,Float64Array,4096,'speech_frame_ptr');return result('speech_period_variability',[f0.length,hasCaptureGaps?1:0,clippedInput?1:0],1);
 }
 return {intensityTrack:intensity,pitchPeriodVariability:variability};
}
module.exports={attachVoiceMetrics};
