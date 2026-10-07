'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'coefficients/full-speech-v1');
if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('Tables already frozen');fs.mkdirSync(dir,{recursive:true});const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),files={};
function save(name,values){const b=Buffer.alloc(values.length*8);values.forEach((v,i)=>b.writeDoubleLE(v,i*8));fs.writeFileSync(path.join(dir,name),b);files[name]=sha(b);}
const rates=[12000,16000,22050,24000,32000,44100,48000],ceilings=[4000,4500,5000,5500,6000,7000,8000],outputs=ceilings.map(c=>2*(c+1000));
const hamming=require(path.join(base,'utils/phonetic/frame-segment.js')).hammingWindow;
const windows=[...new Set(outputs.flatMap(r=>[25,40].map(ms=>Math.round(r*ms/1000))))].sort((a,b)=>a-b);for(const n of windows)save('hamming-'+n+'.bin',Array.from(hamming(n)));
for(const rate of rates){
 const arrays=[];class CaptureF64 extends Float64Array{constructor(n){super(n);arrays.push(this);}}
 const source=fs.readFileSync(path.join(base,'utils/phonetic/spectrogram-gen.js'),'utf8');
 const context={module:{exports:{}},require:p=>require(path.join(base,'utils/phonetic',p)),Float64Array:CaptureF64,Float32Array,Math};vm.createContext(context);vm.runInContext(source,context);
 context.module.exports.generateSpectrogram(new Float32Array(Math.round(rate*.005)),rate);
 if(arrays[0].length!==Math.round(rate*.005))throw new Error('Wrong window capture');save('hann-'+rate+'.bin',Array.from(arrays[0]));
}
const rootSource=fs.readFileSync(path.join(base,'utils/phonetic/poly-roots.js'),'utf8'),seeds=[];
for(let degree=2;degree<=32;degree++){
 const math=Object.create(Math),cos=[],sin=[];math.cos=x=>{const v=Math.cos(x);cos.push(v);return v;};math.sin=x=>{const v=Math.sin(x);sin.push(v);return v;};
 const stop={};const ctx={module:{exports:{}},Float64Array,Math:math,stop:()=>{throw stop;}};vm.createContext(ctx);vm.runInContext(rootSource.replace('const maxIterations = 2000;','stop(); const maxIterations = 2000;'),ctx);
 try{ctx.module.exports.findRoots(Float64Array.from({length:degree+1},(_,i)=>i===0?1:0));}catch(e){if(e!==stop)throw e;}
 if(cos.length!==degree||sin.length!==degree)throw new Error('Bad seed capture');for(let i=0;i<degree;i++)seeds.push(cos[i],sin[i]);
}save('root-seeds.bin',seeds);
const preFreq=-Math.log(.97)*12000/(2*Math.PI);save('emphasis.bin',[preFreq,...outputs.map(r=>Math.exp(-2*Math.PI*preFreq/r))]);
const rsSource=fs.readFileSync(path.join(base,'utils/phonetic/resample.js'),'utf8'),profiles=[];
for(const input of rates)for(let index=0;index<outputs.length;index++){
 const output=outputs[index],cutoff=ceilings[index]+500;if(output>input)continue;if(output===12000)continue;
 const captured=[];class CaptureMap extends Map{set(k,v){captured.push([Math.round(k*1e6),Array.from(v)]);return super.set(k,v);}}
 const context={module:{exports:{}},require:p=>require(path.join(base,'utils/phonetic',p)),Float32Array,Float64Array,Map:CaptureMap,Math};vm.createContext(context);
 // Skip only convolution after the actual phase/kernel cache is constructed.
 vm.runInContext(rsSource.replace('    let value = 0;','    continue;\n    let value = 0;'),context);context.module.exports.resampleLowPass(new Float32Array(262144),input,output,cutoff);
 const b=Buffer.alloc(24+captured.length*(4+257*8));b.write('RSK1',0);b.writeUInt32LE(input,4);b.writeUInt32LE(output,8);b.writeDoubleLE(cutoff,12);b.writeUInt32LE(captured.length,20);let at=24;
 for(const [key,kernel]of captured){b.writeUInt32LE(key,at);at+=4;for(const v of kernel){b.writeDoubleLE(v,at);at+=8;}}
 const file='resample-'+input+'-'+output+'.bin';fs.writeFileSync(path.join(dir,file),b);files[file]=sha(b);profiles.push({input,output,cutoff,file,phases:captured.length});
}
const manifest={baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',rates,ceilings,outputs,windows,profiles,files};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const arms=profiles.map(p=>`(${p.input},${p.output}) => include_bytes!("${p.file}"),`).join('\n');
const generated=`// Actual JS-captured table files; no runtime kernel construction.\npub fn profile_bytes(input:u32,output:u32)->Option<&'static [u8]>{Some(match(input,output){\n${arms}\n_=>return None,\n})}\n`;
fs.writeFileSync(path.join(dir,'profiles.rs'),generated);console.log(JSON.stringify({profiles:profiles.length,windows:windows.length,bytes:Object.keys(files).reduce((n,f)=>n+fs.statSync(path.join(dir,f)).size,0),manifestSha256:sha(fs.readFileSync(path.join(dir,'manifest.json')))}));
