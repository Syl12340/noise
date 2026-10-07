'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),out=path.join(root,'phase7/reference/manifest.json');
if(fs.existsSync(out))throw new Error('Reference already frozen');
const requireBase=p=>require(path.join(base,p)),support=requireBase('utils/phonetic/time-support.js'),hnr=requireBase('utils/phonetic/harmonicity.js');
const src=fs.readFileSync(path.join(base,'utils/phonetic/analysis.js'),'utf8');
const cutsCode=src.slice(src.indexOf('  const cuts ='),src.indexOf('  if (cuts.length)'));
const maskCode=src.slice(src.indexOf('  for (const row of pitchTrack) if'),src.indexOf("  stage('计算音质'"));
const invalidCode=src.slice(src.indexOf('function invalidateIntervals'),src.indexOf('function validateParameters'));
const segmentCode=src.slice(src.indexOf('async function analyzeSegments'),src.indexOf('module.exports ='));
const context={Set,Math,Number,Array,Float32Array,Float64Array,Int16Array,
 addSupport:support.addSupport,summarizeHarmonicity:hnr.summarizeHarmonicity,
 C:{ANALYSIS_HOP_SIZE:120,ANALYSIS_SAMPLE_RATE:12000},centeredSignal:pcm=>new Float32Array(pcm.length),summarizeCoverage:()=>({})};
vm.createContext(context);
vm.runInContext(invalidCode+'\n'+segmentCode+`
function captureCuts(n,rate,boundaries){const pcm={length:n},sampleRate=rate,options={discontinuityBoundariesSeconds:boundaries};${cutsCode}return [0,...cuts,n];}
function capturePitch(pitchTrack,n,rate,invalidIntervals){const pcm={length:n},sampleRate=rate;${maskCode}return pitchTrack;}
`,context);
function tone(n){return Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*(i%60)/60));}
const plans=[{name:'round-deduplicate',n:12000,rate:12000,boundaries:[NaN,Infinity,-1,0,1,1.1,.00004166666666666666,.000125,.25,.25,.75]},
 {name:'half-neighbor',n:48000,rate:48000,boundaries:[(123.5-1e-14)/48000,123.5/48000,(123.5+1e-14)/48000,.2]},
 {name:'unsorted',n:22050,rate:22050,boundaries:[.7,.1,.5]}, {name:'no-cut',n:1200,rate:12000,boundaries:[]}];
for(const p of plans){p.expected=context.captureCuts(p.n,p.rate,p.boundaries).slice(0,-1).map((start,i,a)=>({startSample:start,endSample:context.captureCuts(p.n,p.rate,p.boundaries)[i+1],start:start/p.rate,end:context.captureCuts(p.n,p.rate,p.boundaries)[i+1]/p.rate}));p.boundaries=p.boundaries.map(v=>Number.isFinite(v)?v:String(v));}
const cases=[
 {name:'two-clean',rate:12000,spans:[3072,3072],clips:[[],[]]},
 {name:'clip-and-gap',rate:12000,spans:[3072,3072],clips:[[{start:.09,end:.1}],[{start:0,end:.01}]]},
 {name:'clock-44100',rate:44100,spans:[11025,11026,11025],clips:[[],[{start:.1,end:.105}],[]]},
 {name:'failed-middle',rate:12000,spans:[3072,1024,3072],clips:[[],[],[]],failed:[1]},
 {name:'short-piece',rate:12000,spans:[1023,3072],clips:[[],[]]},
 {name:'touch-clips',rate:12000,spans:[3072,3072],clips:[[{start:0,end:128/12000}],[]]},
];
async function main(){
 for(const c of cases){
  c.sampleCount=c.spans.reduce((a,b)=>a+b,0);let start=0;
  c.pieces=c.spans.map((n,index)=>{
   const end=start+n,analysisLength=Math.floor(n*12000/c.rate),signal=tone(analysisLength);
   const pitch=Array.from({length:Math.max(0,Math.floor((analysisLength-1024)/120)+1)},(_,i)=>({time:(i*120+512)/12000,f0:200,aperiodicity:.1}));
   const expectedPitch=context.capturePitch(support.addSupport(pitch.map(p=>({...p})),1024/12000,128/c.rate),n,c.rate,c.clips[index]);
   const rawHnr=hnr.estimateHarmonicity(signal,12000,{pitchTrack:expectedPitch,requirePitch:true});
   const local=structuredClone(rawHnr);support.addSupport(local.track,1024/12000,128/c.rate);context.invalidateIntervals(local.track,c.clips[index]);
   const piece={startSample:start,endSample:end,analysisLength,pitch,expectedPitch,rawHnr,intervals:c.clips[index],failed:(c.failed||[]).includes(index)};
   start=end;piece.local=local;return piece;
  });
  context.analyzePcm=async pcm=>{
   const p=c.pieces[context.pieceIndex++];if(p.failed)throw new Error('fixture segment failure');
   return {signal:new Float32Array(pcm.length),pitchTrack:structuredClone(p.expectedPitch),formantTracks:[],intensityTrack:[],
    harmonicity:structuredClone(p.local),spectrogram:{times:new Float64Array(),data:[]},invalidIntervals:structuredClone(p.intervals),
    inputQuality:{clipped:p.intervals.length>0,plateauSuspected:false},parameters:{}};
  };
  context.pieceIndex=0;
  const assembled=await context.analyzeSegments(new Int16Array(c.sampleCount),c.rate,{},c.pieces.slice(0,-1).map(p=>p.endSample));
  c.expected={analysisSegments:assembled.analysisSegments,invalidIntervals:assembled.invalidIntervals,harmonicity:assembled.harmonicity,avgHNR:assembled.avgHNR,
    jitter:null,timeAxis:assembled.parameters.timeAxis,discontinuityPolicy:assembled.parameters.discontinuityPolicy};
  for(const p of c.pieces)delete p.local;
 }
 const sources={};for(const p of ['utils/phonetic/analysis.js','utils/phonetic/time-support.js','utils/phonetic/harmonicity.js'])sources[p]=crypto.createHash('sha256').update(fs.readFileSync(path.join(base,p))).digest('hex');
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sources,plans,cases},null,2)+'\n');
 console.log(crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
