'use strict';
// Export actual baseline-generated tables BEFORE any Rust comparison.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const base = path.join(root,'_work/baseline');
const output = path.join(root,'coefficients/noise-44100-v1');
assert.ok(!fs.existsSync(output),'Frozen table package exists; refusing overwrite.');
const fft = require(path.join(base,'utils/fft.js'));
const bands = require(path.join(base,'utils/canvas-spectrum.js'));
const quality = require(path.join(base,'utils/audio-quality.js'));
const cosine = Math.cos, sine = Math.sin, rotations = [];
try {
  Math.cos = value => {const result=cosine(value);rotations.push(result);return result;};
  Math.sin = value => {const result=sine(value);rotations.push(result);return result;};
  fft.fftInPlace(new Float64Array(32768),new Float64Array(32768),32768);
} finally { Math.cos=cosine; Math.sin=sine; }
assert.equal(rotations.length,30);
function f64(values) {const out=Buffer.alloc(values.length*8);values.forEach((v,i)=>out.writeDoubleLE(v,i*8));return out;}
const ranges=Buffer.alloc(29*8);
bands.BAND_BIN_RANGES.forEach((r,i)=>{ranges.writeUInt32LE(r.startBin,i*8);ranges.writeUInt32LE(r.endBin,i*8+4);});
const files = {
  'a_weighting.f64le':fs.readFileSync(path.join(root,'phase0/fixtures/filter_coefficients.bin')),
  'dc_pole.f64le':f64([new quality.DCBlocker(44100).pole]),
  'hann.f64le':f64(Array.from(fft.HANN_WINDOW)),
  'fft_rotations.f64le':f64(rotations),
  'band_ranges.u32le':ranges,
};
fs.mkdirSync(output,{recursive:true});
const manifest={baselineCommit:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sampleRate:44100,fftSize:32768,
  stageOrder:'len=2,4,...32768; each cos(angle),sin(angle) captured from actual fftInPlace',
  aOrder:'b1[3],a1[3],b2[3],a2[3],gain,fir[129]',files:{}};
for (const [name,buffer] of Object.entries(files)) {fs.writeFileSync(path.join(output,name),buffer);manifest.files[name]={bytes:buffer.length,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};}
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
