'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'phase13/reference');if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('References already frozen');fs.mkdirSync(dir,{recursive:true});const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const originals={hypot:Math.hypot,atan2:Math.atan2,log:Math.log,log10:Math.log10,sin:Math.sin};let oracle=new Map();const codes={hypot:1,atan2:2,log:3,log10:4,sin:5};
function bits(v){const b=Buffer.alloc(8);b.writeDoubleLE(Number.isNaN(v)?NaN:v);return b.toString('hex');}
for(const [name,fn]of Object.entries(originals))Math[name]=(...args)=>{const output=fn(...args),a=args[0],b=args.length>1?args[1]:0,key=codes[name]+':'+bits(a)+':'+bits(b);oracle.set(key,{code:codes[name],a,b,output});return output;};
function frozen(name,bytes){fs.writeFileSync(path.join(dir,name),bytes);return {file:name,sha256:sha(bytes)};}
function f64(values){const b=Buffer.alloc(values.length*8);values.forEach((v,i)=>b.writeDoubleLE(v,i*8));return b;}
function f32(values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;}
function trace(name){const b=Buffer.alloc(4+oracle.size*25);b.writeUInt32LE(oracle.size);let at=4;for(const v of oracle.values()){b[at++]=v.code;b.writeDoubleLE(v.a,at);at+=8;b.writeDoubleLE(v.b,at);at+=8;b.writeDoubleLE(v.output,at);at+=8;}return frozen(name+'.math.bin',b);}
const req=p=>require(path.join(base,'utils/phonetic',p));const linear=req('burg-lpc.js'),roots=req('poly-roots.js'),formants=req('formant-extract.js'),sgram=req('spectrogram-gen.js');
const cases=[];
function record(c,run){oracle=new Map();try{c.expected=run();}catch(e){c.error=true;c.errorMessage=e.message;}c.oracle=trace(c.name);cases.push(c);}
for(const order of [0,1,4,12,20]){const signal=Float64Array.from({length:300},(_,i)=>.2*Math.cos(2*Math.PI*200*i/12000)+.1*Math.cos(2*Math.PI*800*i/12000));record({name:'burg-'+order,kind:'burg',order,input:frozen('burg-'+order+'.f64le',f64(signal))},()=>{const r=linear.burgLPC(signal,order);return {a:Array.from(r.a),error:r.error};});}
for(const [name,c]of [['quadratic',[1,-.8,.25]],['degree-one',[1,-.5]],['repeated',[1,-2,1]],['invalid-leading',[0,1,1]]])record({name:'roots-'+name,kind:'roots',coefficients:c},()=>roots.findRoots(Float64Array.from(c)));
for(const rate of [12000,44100,48000]){const signal=Float32Array.from({length:Math.round(rate*.04)},(_,i)=>.2*originals.sin(2*Math.PI*200*i/rate));record({name:'spectrogram-'+rate,kind:'spectrogram',rate,input:frozen('spectrogram-'+rate+'.f32le',f32(signal))},()=>{const r=sgram.generateSpectrogram(signal,rate);return {times:Array.from(r.times),data:r.data.map(v=>Array.from(v)),width:r.width,height:r.height};});}
for(const rate of [12000,16000]){const signal=Float32Array.from({length:Math.round(rate*.1)},(_,i)=>.2*originals.sin(2*Math.PI*200*i/rate)+.1*originals.sin(2*Math.PI*1200*i/rate));const pitch=Array.from({length:10},(_,i)=>({time:i*.01+.0125,f0:200,aperiodicity:.05}));
 record({name:'formants-'+rate,kind:'formants',rate,pitch,order:12,input:frozen('formants-'+rate+'.f32le',f32(signal))},()=>formants.formantTrack(signal,rate,{pitchTrack:pitch,lpcOrder:12}));
}
const full=[];const analyze=req('analysis.js').analyzePcm;
async function main(){
 for(const [name,rate,n,params,cuts]of [['full-default',44100,6615,{},[]],['full-segmented',12000,3600,{maxFormant:4000},[.15]],['full-high-ceiling',48000,7200,{maxFormant:8000,lpcOrder:14,windowMs:40},[]],['full-silent',16000,2400,{maxFormant:6000},[]]]){
  const pcm=Int16Array.from({length:n},(_,i)=>name==='full-silent'?0:Math.round(6000*originals.sin(2*Math.PI*200*i/rate)+1500*originals.sin(2*Math.PI*1200*i/rate)+600));
  const raw=Buffer.alloc(n*2);pcm.forEach((v,i)=>raw.writeInt16LE(v,i*2));oracle=new Map();const result=await analyze(pcm,rate,{parameters:params,discontinuityBoundariesSeconds:cuts});
  const projected={parameters:result.parameters,duration:result.duration,sampleRate:result.sampleRate,signal:Array.from(result.signal),pitchTrack:result.pitchTrack,formantTracks:result.formantTracks,intensityTrack:result.intensityTrack,harmonicity:result.harmonicity,avgHNR:result.avgHNR,jitter:result.jitter,inputQuality:result.inputQuality,invalidIntervals:result.invalidIntervals,coverage:result.coverage,formantStatus:result.formantStatus,spectrogram:{...result.spectrogram,data:result.spectrogram.data.map(v=>Array.from(v)),times:Array.from(result.spectrogram.times)},...(result.analysisSegments?{analysisSegments:result.analysisSegments}:{})};
  full.push({name,kind:'full',rate,params,cuts,input:frozen(name+'.i16le',raw),oracle:trace(name),expected:projected});
 }
 const manifest={baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',cases,full};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({cases:cases.length,full:full.length,manifestSha256:sha(fs.readFileSync(path.join(dir,'manifest.json')))}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{for(const [n,f]of Object.entries(originals))Math[n]=f;});
