'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'phase7/reference/signals.json');
if(fs.existsSync(out))throw new Error('Signal inputs already frozen');
const bytes=fs.readFileSync(path.join(root,'phase7/reference/manifest.json'));
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),'378c7c702d76afe81fceb632daa1ca53da444eeaee3f38f7a1919c5fc15554db');
const hnr=require(path.join(root,'_work/baseline/utils/phonetic/harmonicity.js'));
const identities={};
for(const c of JSON.parse(bytes).cases)for(let index=0;index<c.pieces.length;index++){
 const p=c.pieces[index],signal=Float32Array.from({length:p.analysisLength},(_,i)=>.2*Math.sin(2*Math.PI*(i%60)/60));
 assert.deepEqual(hnr.estimateHarmonicity(signal,12000,{pitchTrack:p.expectedPitch,requirePitch:true}),p.rawHnr);
 const raw=Buffer.alloc(signal.length*4);signal.forEach((v,i)=>raw.writeFloatLE(v,i*4));
 const name=c.name+'-'+index+'.f32le';fs.writeFileSync(path.join(root,'phase7/reference',name),raw);identities[name]=crypto.createHash('sha256').update(raw).digest('hex');
}
fs.writeFileSync(out,JSON.stringify(identities,null,2)+'\n');console.log(crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
