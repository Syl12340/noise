'use strict';
// One-time capture of the actual baseline code and normalized cached coefficients.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),baseline=path.join(root,'_work/baseline');
const source=fs.readFileSync(path.join(baseline,'utils/phonetic/resample.js'),'utf8');
const ref=path.join(root,'phase3/resample-reference'),table=path.join(root,'coefficients/speech-resample-12000-v1');
if(fs.existsSync(path.join(ref,'manifest.json'))||fs.existsSync(path.join(table,'manifest.json')))throw new Error('Resample references already frozen; refusing to overwrite');
fs.mkdirSync(ref,{recursive:true});fs.mkdirSync(table,{recursive:true});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let captures=[];
class CaptureMap extends Map { set(key,value) {captures.push([key,Array.from(value)]);return super.set(key,value);} }
const context={module:{exports:{}},Map:CaptureMap,Float32Array,Float64Array,Math,
  require:()=>require(path.join(baseline,'utils/phonetic/iteration.js'))};
vm.runInNewContext(source,context);
const {resampleLowPass}=context.module.exports;
const files={},cases=[];
for(const rate of [12000,16000,22050,24000,32000,44100,48000]) {
  captures=[];resampleLowPass(new Float32Array(262144),rate,12000,5500);
  const unique=new Map(captures.map(([phase,kernel])=>[Math.round(phase*1e6),kernel]));
  const sorted=Array.from(unique).sort((a,b)=>a[0]-b[0]);
  const raw=Buffer.alloc(24+sorted.length*(4+257*8));
  raw.write('RSK1');raw.writeUInt32LE(rate,4);raw.writeUInt32LE(12000,8);raw.writeDoubleLE(5500,12);raw.writeUInt32LE(sorted.length,20);
  let cursor=24;
  for(const [key,kernel] of sorted) {if(kernel.length!==257)throw new Error('Kernel length');raw.writeUInt32LE(key,cursor);cursor+=4;for(const value of kernel){raw.writeDoubleLE(value,cursor);cursor+=8;}}
  const file='r'+rate+'.bin';fs.writeFileSync(path.join(table,file),raw);
  files[file]={sha256:sha(raw),bytes:raw.length,inputRate:rate,phases:sorted.map(([key])=>key)};
  function add(name,signal) {
    const input=Float32Array.from(signal),output=resampleLowPass(input,rate,12000,5500);
    const ib=Buffer.from(input.buffer),ob=Buffer.from(output.buffer),prefix='r'+rate+'-'+name;
    fs.writeFileSync(path.join(ref,prefix+'.input.f32le'),ib);fs.writeFileSync(path.join(ref,prefix+'.output.f32le'),ob);
    cases.push({name:prefix,input:prefix+'.input.f32le',output:prefix+'.output.f32le',inputSamples:input.length,outputSamples:output.length,inputRate:rate,outputRate:12000,cutoffHz:5500,inputSha256:sha(ib),outputSha256:sha(ob)});
  }
  for(const n of [0,1,2,128,257]) add('edge-'+n,Array.from({length:n},(_,i)=>i%2?.2:-.1));
  add('tone',Array.from({length:4096},(_,i)=>.3*Math.sin(2*Math.PI*203.7*i/rate)));
  add('multitone',Array.from({length:4096},(_,i)=>.2*Math.sin(2*Math.PI*999.3*i/rate)+.1*Math.sin(2*Math.PI*4000*i/rate)));
  add('stopband',Array.from({length:4096},(_,i)=>.3*Math.sin(2*Math.PI*Math.min(8000,rate*.4)*i/rate)));
  add('impulse-step',Array.from({length:4096},(_,i)=>i===1024?.8:i>2048?.1:0));
  let rng=12345678;
  add('noise',Array.from({length:4096},()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return (rng/2**32-.5)*.3;}));
}
const tableManifest={format:'RSK1',rule:'Actual baseline Map.set capture, ordered Float64 normalized257tap Blackman/sinc; all phases observed across262144 input samples',sourceSha256:sha(Buffer.from(source)),outputRate:12000,cutoffHz:5500,files};
fs.writeFileSync(path.join(table,'manifest.json'),JSON.stringify(tableManifest,null,2)+'\n');
const manifest={profile:'legacy-resample-12000-f32-bits-v1',rule:'Exact output length and every Float32 bit; frozen before Rust comparison',sourceSha256:sha(Buffer.from(source)),tablesManifestSha256:sha(fs.readFileSync(path.join(table,'manifest.json'))),cases};
fs.writeFileSync(path.join(ref,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const rust=`//! Frozen coefficient loader. Generated from actual baseline cache; no runtime trig.\npub(crate) struct KernelBank { pub kernels: Vec<(u32,Vec<f64>)> }\npub(crate) fn load_bank(input_rate:u32,output_rate:u32,cutoff_hz:f64)->Option<KernelBank> {\n if output_rate!=12000 || cutoff_hz!=5500.0 {return None;}\n let bytes:&[u8]=match input_rate {\n${Object.keys(files).map(f=>` ${files[f].inputRate} => include_bytes!("../../../../coefficients/speech-resample-12000-v1/${f}"),`).join('\n')}\n _=>return None,\n };\n let count=u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;\n let mut cursor=24;let mut kernels=Vec::with_capacity(count);\n for _ in 0..count {\n  let key=u32::from_le_bytes(bytes[cursor..cursor+4].try_into().unwrap());cursor+=4;\n  let mut kernel=Vec::with_capacity(257);\n  for _ in 0..257 {kernel.push(f64::from_le_bytes(bytes[cursor..cursor+8].try_into().unwrap()));cursor+=8;}\n  kernels.push((key,kernel));\n }\n Some(KernelBank{kernels})\n}\n`;
fs.writeFileSync(path.join(root,'crates/noise-core/src/speech/resample_tables.rs'),rust);
console.log(JSON.stringify({cases:cases.length,tables:Object.values(files).map(f=>({rate:f.inputRate,phases:f.phases.length})),manifestSha256:sha(fs.readFileSync(path.join(ref,'manifest.json'))),tablesSha256:manifest.tablesManifestSha256}));
