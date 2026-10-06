'use strict';
// Actual baseline module execution; only observe its math calls and window.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'phase4/reference'),tables=path.join(root,'coefficients/hnr-v1');
if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('HNR references already frozen');
fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(tables,{recursive:true});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),read=p=>fs.readFileSync(path.join(base,p),'utf8');
const bits=x=>{const b=Buffer.alloc(8);b.writeDoubleLE(x);return b.readBigUInt64LE();};
let calls=new Map();
const math=Object.create(Math);math.sin=x=>{const y=Math.sin(x);calls.set(bits(x),y);return y;};
const fctx={module:{exports:{}},Math:math,Float64Array};
vm.runInNewContext(read('utils/phonetic/fractional-correlation.js')+'\nmodule.exports.observedWindow = window;',fctx);
const f=fctx.module.exports;
const hctx={module:{exports:{}},Math,Float64Array,Number,require:name=>{
  if(name==='./fractional-correlation')return f;
  if(name==='../fft')return require(path.join(base,'utils/fft.js'));
  if(name==='./voice-metrics')return require(path.join(base,'utils/phonetic/voice-metrics.js'));
  if(name==='./iteration')return require(path.join(base,'utils/phonetic/iteration.js'));
  throw new Error(name);
}};
vm.runInNewContext(read('utils/phonetic/harmonicity.js'),hctx);
const h=hctx.module.exports,{consume}=require(path.join(base,'utils/phonetic/iteration.js'));
const {calculateHNR}=require(path.join(base,'utils/phonetic/voice-metrics.js'));
const window=Buffer.from(f.observedWindow.buffer);fs.writeFileSync(path.join(tables,'fractional-window.f64le'),window);
const cases=[];
const encode=v=>JSON.stringify(v,(_k,x)=>typeof x==='number'?(Object.is(x,-0)?'-0':!Number.isFinite(x)?Number.isNaN(x)?'NaN':x>0?'+Infinity':'-Infinity':x):x);
function record(name,op,input,config,run) {
  calls=new Map();const output=run(input),ib=input?Buffer.from(input.buffer):Buffer.alloc(0);
  const oracle=Buffer.alloc(calls.size*16);let i=0;for(const [key,value] of calls){oracle.writeBigUInt64LE(key,i*16);oracle.writeDoubleLE(value,i*16+8);i++;}
  const inp=name+'.input.bin',tr=name+'.sin.bin';fs.writeFileSync(path.join(dir,inp),ib);fs.writeFileSync(path.join(dir,tr),oracle);
  cases.push({name,op,input:inp,oracle:tr,inputSha256:sha(ib),oracleSha256:sha(oracle),sinArguments:calls.size,config,expected:JSON.parse(encode(output))});
}
const tone=(n,freq,amp=.25,dc=0)=>Float32Array.from({length:n},(_,i)=>dc+amp*Math.sin(2*Math.PI*freq*i/12000));
const cfg={fs:12000,frameSize:1024,hopSize:120,fmin:40,fmax:1200,requirePitch:true,minPeakCorrelation:.2,maxPitchDeviation:.15};
function hnr(name,signal,extra={},pitchF0=200) {
  const c={...cfg,...extra};
  if(c.pitchTrack===undefined)c.pitchTrack=Array.from({length:Math.max(0,Math.floor((signal.length-c.frameSize)/c.hopSize)+1)},(_,i)=>({time:(i*c.hopSize+c.frameSize/2)/c.fs,f0:pitchF0,aperiodicity:.1}));
  record(name,'hnr',signal,c,s=>h.estimateHarmonicity(s,c.fs,c));
}
for(const freq of [100,200,203.7,400,1200])hnr('tone-'+freq,tone(1024,freq),{},freq);
hnr('independent',tone(1024,203.7),{requirePitch:false,pitchTrack:[]});
hnr('dc-tone',tone(1024,203.7,.25,.3),{},203.7);
hnr('silence',new Float32Array(1264));
hnr('constant',new Float32Array(1024).fill(.3));
hnr('short',tone(100,200));
hnr('empty',new Float32Array());
hnr('no-pitch',tone(1024,200),{pitchTrack:[]});
hnr('uncertain',tone(1024,200),{pitchTrack:[{time:512/12000,f0:200,aperiodicity:.300001}]});
hnr('stale',tone(1024,200),{pitchTrack:[{time:0,f0:200,aperiodicity:.1}]});
hnr('wrong-pitch',tone(1024,200),{},120);
hnr('narrow-range',tone(1024,203.7),{fmin:203,fmax:204},203.7);
hnr('odd-frame',tone(641,203.7),{frameSize:521,hopSize:120},203.7);
hnr('large-frame',tone(2048,203.7),{frameSize:2048},203.7);
hnr('minimum-frame',tone(256,600),{frameSize:256},600);
hnr('duration-10frames',tone(2104,203.7),{},203.7);
hnr('nearest-pitch',tone(1264,203.7),{pitchTrack:[{time:512/12000,f0:203.7,aperiodicity:.1},{time:632/12000,f0:203.7,aperiodicity:.1},{time:752/12000,f0:0,aperiodicity:1}]},203.7);
hnr('high-threshold',tone(1024,203.7),{minPeakCorrelation:1},203.7);
hnr('multi-harmonic',Float32Array.from({length:1024},(_,i)=>.2*Math.sin(2*Math.PI*203.7*i/12000)+.1*Math.sin(4*Math.PI*203.7*i/12000)+.07*Math.sin(10*Math.PI*203.7*i/12000)),{},203.7);
let rng=12345;const noise=Float32Array.from({length:1024},()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return (rng/2**32-.5)*.4;});
hnr('noise',noise,{requirePitch:false,pitchTrack:[]});
hnr('tone-noise',Float32Array.from(tone(1024,203.7),(x,i)=>x+noise[i]*.3),{},203.7);
const fracFrame=Float64Array.from(tone(1024,203.7));
for(const [name,initial,lower,upper] of [['fractional',12000/203.7,58,60],['integer',60,59,61],['endpoint',59,59,59.3],['bad-bracket',60,60,60]]) {
  record(name,'fractional',fracFrame,{initial,lower,upper},s=>consume(f.refineCorrelationPeak(s,initial,lower,upper)));
}
record('fractional-short','fractional',new Float64Array(128),{initial:10,lower:9,upper:11},s=>consume(f.refineCorrelationPeak(s,10,9,11)));
for(const [name,r] of [['negative',-.1],['zero',0],['small',1e-12],['half',.5],['cap',1],['over',1.01],['nan',NaN],['inf',Infinity]])record('scalar-'+name,'scalar',null,{correlation:JSON.parse(encode(r))},()=>calculateHNR(r));
for(const [name,track,hop,min] of [
  ['summary-empty',[],.01,.1],
  ['summary-duration',Array.from({length:10},(_,i)=>({time:i*.01,db:20})),.01,.1],
  ['summary-short',Array.from({length:9},(_,i)=>({time:i*.01,db:20})),.01,.1],
  ['summary-coverage',[{db:20},{db:null,reason:'low-periodicity'},{db:null,reason:'low-energy'},{db:null,reason:'unvoiced-or-uncertain'},{db:50,reason:'capture-gap-boundary'}],.1,.1],
  ['summary-below-coverage',[{db:20},{db:null},{db:null}],.1,.1],
  ['summary-partial',[{db:20},{db:30}],.01,0],
])record(name,'summary',null,{track,hop,min},()=>h.summarizeHarmonicity(track,hop,{minDurationSeconds:min}));
const sources=['utils/phonetic/harmonicity.js','utils/phonetic/fractional-correlation.js','utils/phonetic/voice-metrics.js','utils/fft.js'].map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(base,p)))}));
const manifest={profile:'legacy-hnr-js-sin-v1',sources,windowSha256:sha(window),cases};
const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(dir,'manifest.json'),raw);
console.log(JSON.stringify({cases:cases.length,oracleBytes:cases.reduce((n,c)=>n+c.sinArguments*16,0),manifestSha256:sha(raw),windowSha256:sha(window)}));
