'use strict';
// Capture actual baseline functions, before comparing Rust outputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const baseline = path.join(root, '_work', 'baseline');
const {yinPitchFrame, yinPitchTrack} = require(path.join(baseline, 'utils/phonetic/yin-pitch.js'));
const {preEmphasis} = require(path.join(baseline, 'utils/phonetic/pre-emphasis.js'));
const {emphasizeFloat} = require(path.join(baseline, 'utils/phonetic/resample.js'));
const dir = path.join(root, 'phase2', 'pitch-reference');
fs.mkdirSync(dir, {recursive:true});
const cases = [];
const tone = (n,f,amp=.2,dc=0,rate=12000) => Array.from({length:n},(_,i)=>dc+amp*Math.sin(2*Math.PI*f*i/rate));
function add(name,op,input,config={}) {
  let typed = op==='pcm'?Int16Array.from(input):op==='frame'?Float64Array.from(input):Float32Array.from(input);
  let out = op==='frame'?yinPitchFrame(typed,config.fs,config.threshold,config.fmin,config.fmax):
    op==='track'?yinPitchTrack(typed,config.fs,{frameSize:config.frameSize,hopSize:config.hop,threshold:config.threshold,fmin:config.fmin,fmax:config.fmax}):
    op==='pcm'?preEmphasis(typed,config.coef):emphasizeFloat(typed,config.coef);
  const file = name+'.bin';
  fs.writeFileSync(path.join(dir,file),Buffer.from(typed.buffer));
  const expected = ArrayBuffer.isView(out)?Array.from(out):out;
  cases.push({name,op,input:file,count:typed.length,config,expected,sha256:crypto.createHash('sha256').update(Buffer.from(typed.buffer)).digest('hex')});
}
const cfg={fs:12000,threshold:.1,fmin:40,fmax:1200};
for(const f of [39.9,40,40.1,60,100,200,499.9,500,1199,1200,1200.001,1202,1205,1210,1600,2400]) add('tone-'+f,'frame',tone(1024,f),cfg);
for(const n of [0,1,6,7,8,9,63,1023]) add('short-'+n,'frame',tone(n,200),cfg);
add('silence','frame',Array(1024).fill(0),cfg);
add('dc','frame',Array(1024).fill(.2),cfg);
add('tiny','frame',tone(1024,200,1e-6),cfg);
add('energy-threshold','frame',tone(1024,200,Math.sqrt(2e-10)),cfg);
add('impulse','frame',Array.from({length:1024},(_,i)=>i===0?.5:0),cfg);
add('step','frame',Array.from({length:1024},(_,i)=>i<512?.2:-.2),cfg);
let rng=0x12345678;
add('noise','frame',Array.from({length:1024},()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return ((rng/2**32)-.5)*.4;}),cfg);
add('invalid-rate','frame',tone(1024,200),{...cfg,fs:0});
add('invalid-range','frame',tone(1024,200),{...cfg,fmax:20});
for(const threshold of [.01,.3,0]) add('threshold-'+threshold,'frame',tone(1024,203.7),{...cfg,threshold});
add('track-tone','track',tone(2400,203.7),{...cfg,frameSize:1024,hop:120});
add('track-odd','track',tone(900,200),{...cfg,frameSize:301,hop:119});
add('track-short','track',tone(20,200),{...cfg,frameSize:1024,hop:120});
for(const coef of [.97,0,1]) {
  add('pcm-'+coef,'pcm',[32767,-32768,0,1,-1,14500,-16384],{coef});
  add('float-'+coef,'float',[.5,-.25,0,1e-30,-1e-30,.12345],{coef});
}
add('pcm-empty','pcm',[],{coef:.97});
add('float-empty','float',[],{coef:.97});
const sources = ['utils/phonetic/yin-pitch.js','utils/phonetic/pre-emphasis.js','utils/phonetic/resample.js'].map(p=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(baseline,p))).digest('hex')}));
const manifest = {profile:'legacy-pitch-bits-v1',rule:'Exact finite Float64 bits and Float32 stores; exact optional fields. Frozen before Rust comparison.',sources,cases};
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'manifest.json'))).digest('hex')}));
