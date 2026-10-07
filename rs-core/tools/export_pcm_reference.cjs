'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'phase8/reference');
if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('Reference already frozen');
fs.mkdirSync(dir,{recursive:true});const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),load=p=>require(path.join(base,p));
const quality=load('utils/audio-quality.js'),support=load('utils/phonetic/time-support.js'),hnr=load('utils/phonetic/harmonicity.js');
const src=fs.readFileSync(path.join(base,'utils/phonetic/analysis.js'),'utf8');
const prefix=src.slice(src.indexOf('async function analyzePcm'),src.indexOf("  stage('比较共振峰模型'"));
const validation=src.slice(src.indexOf('function validateParameters'),src.indexOf('async function analyzePcm'));
const invalidate=src.slice(src.indexOf('function invalidateIntervals'),src.indexOf('function validateParameters'));
const cutsCode=src.slice(src.indexOf('  const cuts ='),src.indexOf('  if (cuts.length)'));
const context={Int16Array,Float32Array,Float64Array,Number,Math,Array,Set,Error,
 C:load('utils/phonetic/phonetic-config.js').PHONETIC_CONFIG,...quality,
 resampleLowPassAsync:load('utils/phonetic/resample.js').resampleLowPassAsync,
 yinPitchTrackAsync:load('utils/phonetic/yin-pitch.js').yinPitchTrackAsync,
 estimateHarmonicityAsync:hnr.estimateHarmonicityAsync,summarizeHarmonicity:hnr.summarizeHarmonicity,addSupport:support.addSupport,summarizeCoverage:()=>({})};
vm.createContext(context);
vm.runInContext(invalidate+validation+prefix+`
  addSupport(harmonicity.track,C.PITCH_FRAME_SIZE/rate,128/sampleRate);
  invalidateIntervals(harmonicity.track,invalidIntervals);
  Object.assign(harmonicity,summarizeHarmonicity(harmonicity.track,C.ANALYSIS_HOP_SIZE/rate));
  return {signal,pitchTrack,formantTracks:[],intensityTrack:[],harmonicity,
    inputQuality,invalidIntervals,parameters:{},spectrogram:{times:new Float64Array(),data:[]}};
}
`+src.slice(src.indexOf('async function analyzeSegments'),src.indexOf('module.exports ='))+`
function captureCuts(pcm,sampleRate,options){${cutsCode}return cuts;}
`,context);
function pcmBytes(pcm){const b=Buffer.alloc(pcm.length*2);pcm.forEach((v,i)=>b.writeInt16LE(v,i*2));return b;}
function floatBytes(values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;}
function write(name,bytes){fs.writeFileSync(path.join(dir,name),bytes);return {file:name,sha256:sha(bytes)};}
function tone(n,rate,bias=800){return Int16Array.from({length:n},(_,i)=>Math.round(6000*Math.sin(2*Math.PI*200*i/rate)+bias));}
const primitives=[];
for(const rate of [12000,16000,22050,24000,32000,44100,48000]){
 const n=Math.ceil(rate*.04),pcm=tone(n,rate);pcm[Math.floor(n/3)]=32767;pcm[Math.floor(n/3)+1]=-32768;
 primitives.push({name:'rails-'+rate,rate,pcm});
}
primitives.push({name:'empty',rate:44100,pcm:new Int16Array()},
 {name:'dc',rate:12000,pcm:new Int16Array(1200).fill(2500)},
 {name:'digital-silence',rate:12000,pcm:Int16Array.from({length:1200},(_,i)=>i%2)},
 {name:'plateau-warning',rate:12000,pcm:Int16Array.from([0,1200,...new Array(10).fill(2400),1200,0])},
 {name:'isolated-rails',rate:12000,pcm:Int16Array.from({length:600},(_,i)=>i%240===0?32767:100)},
 {name:'near-full-scale',rate:12000,pcm:Int16Array.from([32111,32112,-32112,-32111])});
const pipelines=[
 {name:'continuous-12000',rate:12000,pcm:tone(6000,12000),boundaries:[]},
 {name:'continuous-44100',rate:44100,pcm:tone(22050,44100),boundaries:[]},
 {name:'clipped-48000',rate:48000,pcm:tone(24000,48000),boundaries:[]},
 {name:'discontinuous-dc',rate:12000,pcm:Int16Array.from([...tone(3072,12000,4000),...tone(3072,12000,-4000)]),boundaries:[3072/12000]},
 {name:'three-clock-spans',rate:44100,pcm:tone(33076,44100),boundaries:[11025/44100,22051/44100]},
 {name:'short-first',rate:12000,pcm:tone(4095,12000),boundaries:[1023/12000]},
 {name:'plateau-unrejected',rate:12000,pcm:tone(6000,12000),boundaries:[]},
 {name:'default-5_25s',rate:48000,pcm:tone(252000,48000),boundaries:[]},
];
pipelines[2].pcm.fill(32767,10000,10008);pipelines[6].pcm.fill(12000,1500,1510);
async function main(){
 for(const p of primitives){p.input=write(p.name+'.i16le',pcmBytes(p.pcm));p.centered=write(p.name+'.f32le',floatBytes(quality.centeredSignal(p.pcm)));p.expected=quality.inspectPcm(p.pcm,new quality.PcmQualityInspector(p.rate));delete p.pcm;}
 for(const c of pipelines){
  c.input=write(c.name+'.i16le',pcmBytes(c.pcm));
  const cuts=context.captureCuts(c.pcm,c.rate,{discontinuityBoundariesSeconds:c.boundaries});
  const segments=[],endpoints=[0,...cuts,c.pcm.length];
  for(let i=0;i+1<endpoints.length;i++)segments.push({startSample:endpoints[i],endSample:endpoints[i+1],quality:quality.inspectPcm(c.pcm.subarray(endpoints[i],endpoints[i+1]),new quality.PcmQualityInspector(c.rate))});
  const actual=await context.analyzePcm(c.pcm,c.rate,{discontinuityBoundariesSeconds:c.boundaries});
  if(!cuts.length){
   actual.analysisSegments=[{start:0,end:c.pcm.length/c.rate,startSample:0,endSample:c.pcm.length,status:'analyzed'}];
   actual.harmonicity.track.forEach(r=>r.segmentIndex=0);
  }
  const h=actual.harmonicity;delete h.correlationMethod;delete h.interpolationHalfSamples;
  c.expected={analysisSegments:actual.analysisSegments,invalidIntervals:actual.invalidIntervals,harmonicity:h,avgHNR:h.avgHNR,jitter:null,timeAxis:'received-samples',discontinuityPolicy:'segment-before-dsp',segmentQuality:segments,profile:'pcm-hnr-v1'};
  c.sampleCount=c.pcm.length;delete c.pcm;
 }
 const sources={};for(const p of ['utils/audio-quality.js','utils/phonetic/analysis.js'])sources[p]=sha(fs.readFileSync(path.join(base,p)));
 const bytes=Buffer.from(JSON.stringify({baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sources,primitives,pipelines},null,2)+'\n');fs.writeFileSync(path.join(dir,'manifest.json'),bytes);console.log(sha(bytes));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
