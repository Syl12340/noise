'use strict';
// Observe actual baseline preparation and FFT intermediate states; no copied DSP.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'phase4/states');
if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('HNR states already frozen');fs.mkdirSync(dir,{recursive:true});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fft=require(path.join(base,'utils/fft.js')).fftInPlace;
let state,fftCalls;
const src=fs.readFileSync(path.join(base,'utils/phonetic/harmonicity.js'),'utf8');
const marker='const time = (start + frameSize / 2) / sampleRate;';
if(!src.includes(marker))throw new Error('Baseline marker changed');
const ctx={module:{exports:{}},Float64Array,Math,Number,observe:(mean,centered,energies,fftSize)=>{state={mean,centered:Array.from(centered),energies:Array.from(energies),fftSize,stage1Re:null,stage1Im:null,autocorrelationRe:null};},
require:name=>name==='../fft'?{fftInPlace:(re,im,n)=>{fft(re,im,n);fftCalls++;if(fftCalls===1){state.stage1Re=Array.from(re);state.stage1Im=Array.from(im);}else state.autocorrelationRe=Array.from(re);}}:require(path.join(base,'utils/phonetic',name+'.js'))};
vm.runInNewContext(src.replace(marker,'observe(mean, centered, energies, fftSize);\n'+marker),ctx);
const cases=[];
for(const n of [256,521,1024,2048,4096,0]) {
    const size=n||1024;const signal=Float32Array.from({length:size},(_,i)=>n?.2*Math.sin(2*Math.PI*203.7*i/12000)+.03*Math.cos(2*Math.PI*997.3*i/12000)+.1:0);
    fftCalls=0;state=null;ctx.module.exports.estimateHarmonicity(signal,12000,{frameSize:size,hopSize:120,requirePitch:true,pitchTrack:[]});
    const name=n?'frame-'+n:'low-energy',input=name+'.f32le',bytes=Buffer.from(signal.buffer);fs.writeFileSync(path.join(dir,input),bytes);
    cases.push({name,input,inputSha256:sha(bytes),expected:state});
}
const json=JSON.stringify({sourceSha256:sha(Buffer.from(src)),cases},(_k,v)=>typeof v==='number'&&Object.is(v,-0)?'-0':v,2)+'\n';
fs.writeFileSync(path.join(dir,'manifest.json'),json);console.log(JSON.stringify({cases:cases.length,manifestSha256:sha(Buffer.from(json))}));
