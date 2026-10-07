'use strict';
const PROTOCOL=1,MAX_RESULT=2*1024*1024,MAX_WASM=4*1024*1024;
const u32=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff;
const buffer=b=>Object.prototype.toString.call(b)==='[object ArrayBuffer]';
const rates=[12000,16000,22050,24000,32000,44100,48000];
function error(name,message,code){const e=new Error(message);e.name=name;if(code!==undefined)e.code=code;return e;}
function capture(pcm,opts={}){
 if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!['sampleRate','discontinuityBoundariesSeconds'].includes(k)))throw error('TypeError','Invalid capture options');
 const {sampleRate=44100,discontinuityBoundariesSeconds=new Float64Array()}=opts;
 if(!(pcm instanceof Int16Array)||!buffer(pcm.buffer)||!rates.includes(sampleRate)||pcm.length===0||pcm.length>262144||pcm.length>sampleRate*5.25||!(discontinuityBoundariesSeconds instanceof Float64Array)||!buffer(discontinuityBoundariesSeconds.buffer)||discontinuityBoundariesSeconds.length>4096)throw error('TypeError','Invalid PCM capture');
 return {pcm:pcm.slice(),options:{sampleRate,discontinuityBoundariesSeconds:discontinuityBoundariesSeconds.slice()}};
}
const progressKeys=['stage','segmentIndex','segments','state','index','start','completed','total','done'];
function compactProgress(value){
 const p={};for(const k of progressKeys)if(Object.prototype.hasOwnProperty.call(value,k))p[k]=value[k];validateProgress(p);return p;
}
function validateProgress(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!progressKeys.includes(k))||!['centered','resample-batch','resampled','pitch-frame','pitch','hnr'].includes(p.stage))throw error('ProtocolError','Invalid progress');
 for(const [k,v] of Object.entries(p)){
  if(k==='stage')continue;
  if(k==='state'){if(!['frame','complete'].includes(v))throw error('ProtocolError','Invalid progress state');}
  else if(k==='done'){if(typeof v!=='boolean')throw error('ProtocolError','Invalid progress completion');}
  else if(!Number.isInteger(v)||v<0||v>262144)throw error('ProtocolError','Invalid progress counter');
 }
}
function validateResult(value,source){
 const keys=['analysisSegments','invalidIntervals','harmonicity','avgHNR','jitter','timeAxis','discontinuityPolicy','segmentQuality','profile'];
 if(!value||Object.keys(value).sort().join('|')!==keys.sort().join('|')||value.profile!=='pcm-hnr-v1'||value.timeAxis!=='received-samples'||value.discontinuityPolicy!=='segment-before-dsp'||value.jitter!==null||!Array.isArray(value.analysisSegments)||value.analysisSegments.length>128||!Array.isArray(value.segmentQuality)||value.segmentQuality.length>128||!Array.isArray(value.invalidIntervals)||value.invalidIntervals.length>4096||!value.harmonicity||!Array.isArray(value.harmonicity.track)||value.harmonicity.track.length>4096||!Object.is(value.avgHNR,value.harmonicity.avgHNR))throw error('ProtocolError','Invalid analysis result');
 const finite=v=>typeof v==='number'&&Number.isFinite(v),nullable=v=>v===null||finite(v),count=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max;
 const h=value.harmonicity;
 for(const k of ['signalFrames','cappedFrames','activeFrames','validFrames'])if(!count(h[k],h.track.length))throw error('ProtocolError','Invalid HNR counter');
 if(h.cappedFrames>h.signalFrames||h.validFrames>h.activeFrames||!finite(h.coverage)||h.coverage<0||h.coverage>1||!finite(h.validDurationSeconds)||h.validDurationSeconds<0||!finite(h.minDurationSeconds)||h.minDurationSeconds<0||!nullable(h.partialMeanHNR)||!nullable(h.avgHNR))throw error('ProtocolError','Invalid HNR summary');
 for(const r of h.track){
  if(!r||!finite(r.time)||!nullable(r.db)||!count(r.segmentIndex,127)||!r.support||!finite(r.support.start)||!finite(r.support.end)||r.support.start>=r.support.end)throw error('ProtocolError','Invalid HNR row');
  if(r.reason!==undefined&&!['low-energy','unvoiced-or-uncertain','low-periodicity','no-periodic-peak','clipped-input','capture-gap-boundary'].includes(r.reason))throw error('ProtocolError','Invalid HNR reason');
  if(r.peakCorrelation!==undefined&&(!finite(r.peakCorrelation)||r.peakCorrelation<0||r.peakCorrelation>1))throw error('ProtocolError','Invalid HNR correlation');
  if(r.lagSamples!==undefined&&(!finite(r.lagSamples)||r.lagSamples<=0))throw error('ProtocolError','Invalid HNR lag');
  if(r.comparisonSamples!==undefined&&(!count(r.comparisonSamples,4096)||r.comparisonSamples<2))throw error('ProtocolError','Invalid HNR comparison');
  if(r.refinementConverged!==undefined&&r.refinementConverged!==true)throw error('ProtocolError','Invalid HNR convergence');
  if(r.correlationMethod!==undefined&&r.correlationMethod!=='normalized-fractional-delay-sinc-129')throw error('ProtocolError','Invalid HNR method');
 }
 if(source){
  let end=0;if(value.analysisSegments.length===0||value.segmentQuality.length!==value.analysisSegments.length)throw error('ProtocolError','Missing source segments');
  for(let i=0;i<value.analysisSegments.length;i++){
   const s=value.analysisSegments[i],q=value.segmentQuality[i];
   if(!s||!q||s.startSample!==end||!Number.isInteger(s.endSample)||s.endSample<=end||s.endSample>source.samples||s.start!==s.startSample/source.rate||s.end!==s.endSample/source.rate||s.status!=='analyzed'||q.startSample!==s.startSample||q.endSample!==s.endSample)throw error('ProtocolError','Result source mismatch');end=s.endSample;
   const quality=q.quality,n=s.endSample-s.startSample;if(!quality)throw error('ProtocolError','Missing PCM quality');
   for(const k of ['clippedSamples','nearFullScaleSamples'])if(!count(quality[k],n))throw error('ProtocolError','Invalid PCM count');
   if(!count(quality.peakAbs,32768))throw error('ProtocolError','Invalid PCM peak');
   for(const k of ['nearFullScale','digitalSilence','noAcSignal','plateauSuspected','clipped'])if(typeof quality[k]!=='boolean')throw error('ProtocolError','Invalid PCM flag');
   const e=quality.clippingEvidence;
   if(!e||!finite(e.windowSeconds)||e.windowSeconds<=0||!count(e.railLimit,262144)||e.railLimit<1||!count(e.maxRails,n)||!count(e.maxConsecutiveRailSamples,n)||!Array.isArray(e.intervals)||e.intervals.length>4096)throw error('ProtocolError','Invalid clipping evidence');
   for(const interval of e.intervals)if(!finite(interval.start)||!finite(interval.end)||interval.start<0||interval.end<=interval.start||interval.end>n/source.rate)throw error('ProtocolError','Invalid clipping interval');
  }
  if(end!==source.samples)throw error('ProtocolError','Incomplete source result');
  for(const r of value.harmonicity.track){const s=value.analysisSegments[r.segmentIndex];if(!Number.isInteger(r.segmentIndex)||!s||!Number.isFinite(r.time)||r.time<s.start||r.time>s.end)throw error('ProtocolError','Result row outside source segment');}
 }
 let nodes=0;
 function visit(v,depth){
  if(++nodes>100000||depth>32)throw error('ProtocolError','Result capacity exceeded');
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='number'){if(!Number.isFinite(v))throw error('ProtocolError','Nonfinite result');return;}
  if(typeof v==='string'){if(v.length>512||/[^\x00-\x7f]/.test(v))throw error('ProtocolError','Invalid result string');return;}
  if(!v||typeof v!=='object'||(!Array.isArray(v)&&Object.prototype.toString.call(v)!=='[object Object]'))throw error('ProtocolError','Invalid result value');
  if(Array.isArray(v)&&v.length>4096)throw error('ProtocolError','Result array too large');
  for(const k of Object.keys(v)){if(k.length>64||/[^\x00-\x7f]/.test(k))throw error('ProtocolError','Invalid result key');visit(v[k],depth+1);}
 }
 visit(value,0);if(JSON.stringify(value).length>MAX_RESULT)throw error('ProtocolError','Result too large');
}
function packError(e){return {name:typeof e.name==='string'?e.name.slice(0,128):'WorkerError',message:typeof e.message==='string'?e.message.slice(0,1024):'Worker analysis failed',...(typeof e.code==='number'&&Number.isFinite(e.code)?{code:e.code}:{})};}
function unpackError(e){if(!e||typeof e.name!=='string'||e.name.length>128||typeof e.message!=='string'||e.message.length>1024||(e.code!==undefined&&!Number.isFinite(e.code)))throw error('ProtocolError','Invalid error');return error(e.name,e.message,e.code);}
module.exports={PROTOCOL,MAX_WASM,u32,buffer,error,capture,compactProgress,validateProgress,validateResult,packError,unpackError};
