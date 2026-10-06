'use strict';
// Supplementary profile frozen before its Rust comparison; primary profile stays immutable.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ref=path.join(root,'phase2/pitch-reference');
const {yinPitchFrame}=require(path.join(root,'_work/baseline/utils/phonetic/yin-pitch.js'));
const original=JSON.parse(fs.readFileSync(path.join(ref,'manifest.json')));
const input=fs.readFileSync(path.join(ref,'tone-200.bin'));
const frame=Float64Array.from({length:1024},(_,i)=>input.readDoubleLE(i*8));
const raw=yinPitchFrame(frame,12000,.1,40,1200).rawF0;
const configs=[{name:'upper-adjusted',fs:12000,threshold:.1,fmin:40,fmax:raw-5e-7},
  {name:'lower-adjusted',fs:12000,threshold:.1,fmin:raw+5e-7,fmax:1200}];
const cases=configs.map(({name,...config})=>({name,op:'frame',input:'tone-200.bin',count:1024,config,
  expected:yinPitchFrame(frame,config.fs,config.threshold,config.fmin,config.fmax),sha256:crypto.createHash('sha256').update(input).digest('hex')}));
if(!cases.every(c=>c.expected.rangeBoundaryAdjusted===true))throw new Error('Boundary evidence did not trigger expected branch');
const manifest={profile:'legacy-pitch-boundary-bits-v1',sources:original.sources,cases};
const dest=path.join(ref,'edge-manifest.json');
fs.writeFileSync(dest,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')}));
