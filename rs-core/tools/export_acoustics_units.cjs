'use strict';
// JS-only unit references. Observe actual baseline implementations, never a copied DSP pipeline.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline');
const output=path.join(root,'phase1/reference_units');
assert.ok(!fs.existsSync(output),'Unit references already frozen; refuse overwrite.');
const math=require(path.join(base,'utils/audio-math.js'));
const bands=require(path.join(base,'utils/canvas-spectrum.js'));
const filename=path.join(base,'utils/fft.js');
const source=fs.readFileSync(filename,'utf8');
const marker='spectrumDB[k] = 10 * Math.log10(Math.max(meanSquareContribution, 1e-24)) + offset;';
assert.equal(source.split(marker).length,2);
let observed=[];
const moduleObject=new Module(filename,module);
moduleObject.filename=filename;
moduleObject.paths=Module._nodeModulePaths(path.dirname(filename));
globalThis.__portObservePower=(k,value)=>{observed[k]=value;};
moduleObject._compile(source.replace(marker,'globalThis.__portObservePower(k, meanSquareContribution);\n    '+marker),filename);
const fft=moduleObject.exports;
const encode=v=>typeof v==='number'&&!Number.isFinite(v)?(Number.isNaN(v)?'NaN':v>0?'+Infinity':'-Infinity'):v;
const json=v=>JSON.stringify(v,(_k,val)=>encode(val),2)+'\n';
const cases=[];
for(const input of [[],[0],[3,4],[-32768,32767],[NaN],[Infinity]]) {
 const array=Float32Array.from(input);cases.push({kind:'rms',input:Array.from(array),expected:math.calculateRMS(array)});
}
for(const [rms,reference] of [[0,1],[-1,1],[NaN,1],[Infinity,1],[Infinity,Infinity],[1,NaN],[1,0],[1,-Infinity]])
 cases.push({kind:'db',args:[rms,reference],expected:math.calculateDb(rms,reference)});
for(const args of [[0,1,100],[1,0,100],[-1,10,100],[NaN,10,100],[Infinity,10,100],[1,3,100],[1,1,NaN]])
 cases.push({kind:'leq',args,expected:math.calculateLeqFromEnergy(...args)});
for(const args of [[80,-6.020599913279624],[NaN,0],[Infinity,-Infinity]])
 cases.push({kind:'cne',args,expected:math.calculateCNEFromLeq(...args)});
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'scalars.json'),json(cases));
const manifest={baselineCommit:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',scalarCases:cases.length,
 sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),powerObservation:'actual meanSquareContribution before floor/log, memory hook only',files:{}};
for(const name of ['zero','tone','dc_step','nyquist']) {
 const pcm=new Float64Array(32768);
 for(let i=0;i<pcm.length;i++) pcm[i]=name==='zero'?0:name==='tone'?Math.round(8000*Math.sin(2*Math.PI*999.3*i/44100)):name==='dc_step'?(i<1000?0:8192):(i%2?16000:-16000);
 observed=[];
 const db=fft.computeSpectrum(pcm,100);assert.equal(observed.length,16384);
 const packet=Buffer.alloc(pcm.length*8);pcm.forEach((v,i)=>packet.writeDoubleLE(v,i*8));
 fs.writeFileSync(path.join(output,name+'.f64le'),packet);
 fs.writeFileSync(path.join(output,name+'.json'),json({linear_bins:observed,spectrum_db:Array.from(db),bands_db:Array.from(bands.computeThirdOctaveBands(db)),offset:100}));
}
delete globalThis.__portObservePower;
for(const name of fs.readdirSync(output)) {const bytes=fs.readFileSync(path.join(output,name));manifest.files[name]={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
fs.writeFileSync(path.join(output,'manifest.json'),json(manifest));
console.log(JSON.stringify({scalarCases:cases.length,spectrumCases:4,files:Object.keys(manifest.files).length}));
