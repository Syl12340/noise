'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'phase12/reference'),out=path.join(dir,'manifest.json');
if(fs.existsSync(out))throw new Error('Reference already frozen');fs.mkdirSync(dir,{recursive:true});
const base=path.join(root,'_work/baseline'),source=path.join(base,'utils/phonetic/voice-metrics.js'),m=require(source),quality=require(path.join(base,'utils/audio-quality.js'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function write(name,signal){const b=Buffer.alloc(signal.length*4);signal.forEach((v,i)=>b.writeFloatLE(v,i*4));fs.writeFileSync(path.join(dir,name),b);return {file:name,sha256:sha(b)};}
const intensity=[];
for(const rate of [12000,16000,22050,24000,32000,44100,48000]){
 const s=Float32Array.from({length:Math.round(rate*.1)},(_,i)=>.2*Math.sin(2*Math.PI*200*i/rate));
 intensity.push({name:'rate-'+rate,fs:rate,frameSize:Math.round(rate*.025),hop:Math.round(rate*.01),auto:true,signal:s});
}
intensity.push({name:'silence',fs:12000,frameSize:300,hop:120,signal:new Float32Array(600)},
 {name:'above-full-scale',fs:12000,frameSize:300,hop:120,signal:Float32Array.from({length:600},(_,i)=>i%2?2:-2)},
 {name:'odd-grid',fs:12000,frameSize:301,hop:119,signal:Float32Array.from({length:1000},(_,i)=>i===500?1:0)},
 {name:'empty',fs:12000,frameSize:300,hop:120,signal:new Float32Array()},
 {name:'short',fs:12000,frameSize:300,hop:120,signal:new Float32Array(299)},
 {name:'floor-boundary',fs:12000,frameSize:8,hop:8,signal:Float32Array.from([1e-12,-1e-12,0,0,1e-13,0,0,0,1e-11,-1e-11,0,0,0,0,0,0])});
const raw=fs.readFileSync(path.join(root,'phase8/reference/default-5_25s.i16le')),pcm=Int16Array.from({length:raw.length/2},(_,i)=>raw.readInt16LE(i*2));
intensity.push({name:'default-5_25s',fs:48000,frameSize:1200,hop:480,auto:true,signal:quality.centeredSignal(pcm)});
for(const c of intensity){c.input=write(c.name+'.f32le',c.signal);c.expected=m.calculateIntensity(c.signal,c.fs,c.frameSize,c.hop);delete c.signal;}
const sequences=[[],[200],[200,200,200],[100,200],[100,0,200],[100,200,0,300,400],[100,-1,200,300],[200,201,199,200],[1e100,1e100,2e100],[1e-100,2e-100,1e-100],[-0,0,-1]];
const variability=sequences.map((f0,i)=>({name:'sequence-'+i,f0,expected:m.calculatePitchPeriodVariability(f0.map(value=>({f0:value})))}));
fs.writeFileSync(out,JSON.stringify({baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sourceSha256:sha(fs.readFileSync(source)),intensity,variability},null,2)+'\n');console.log(sha(fs.readFileSync(out)));
