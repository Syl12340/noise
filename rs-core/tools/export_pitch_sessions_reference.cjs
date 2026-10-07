'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'phase9/reference/manifest.json');
if(fs.existsSync(out))throw new Error('Reference already frozen');
const base=path.join(root,'_work/baseline'),source=path.join(base,'utils/phonetic/yin-pitch.js');
const {yinPitchTrack}=require(source),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const cases=['default-5_25s','detuned','silence-voiced','odd-grid','empty','short'].map(name=>({name,input:'phase5/reference/'+name+'.f32le',config:{fs:12000,frameSize:name==='odd-grid'?521:1024,hopSize:name==='odd-grid'?119:120,threshold:.1,fmin:40,fmax:1200}}));
cases.push({name:'legacy-inverted-range',input:'phase5/reference/detuned.f32le',config:{fs:12000,frameSize:1024,hopSize:120,threshold:.1,fmin:500,fmax:100}},
 {name:'legacy-nonpositive-range',input:'phase5/reference/detuned.f32le',config:{fs:12000,frameSize:1024,hopSize:120,threshold:.1,fmin:0,fmax:1200}});
for(const c of cases){const raw=fs.readFileSync(path.join(root,c.input));c.inputSha256=sha(raw);const signal=Float32Array.from({length:raw.length/4},(_,i)=>raw.readFloatLE(i*4));c.expected=yinPitchTrack(signal,c.config.fs,c.config);}
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sourceSha256:sha(fs.readFileSync(source)),cases},null,2)+'\n');console.log(sha(fs.readFileSync(out)));
