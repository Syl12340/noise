'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { estimateHarmonicity, estimateHarmonicityAsync } = require('../utils/phonetic/harmonicity');
const { yinPitchTrack } = require('../utils/phonetic/yin-pitch');
const { resampleLowPass } = require('../utils/phonetic/resample');
const { analyzePcm } = require('../utils/phonetic/analysis');
const { referenceFormantGrid, alignReferenceRows } = require('./reference-formant-grid.cjs');
const results = [];
async function test(name, body) { try { await body(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); } }
const rate = 12000;
function periodic(f0, seconds=.4, ceiling=5500, phase=.19) {
  const x = new Float64Array(Math.round(rate*seconds));
  for(let k=1;k*f0<=ceiling;k++) for(let i=0;i<x.length;i++)
    x[i]+=Math.cos(2*Math.PI*k*f0*i/rate+k*phase)/Math.sqrt(k);
  const peak=x.reduce((m,v)=>Math.max(m,Math.abs(v)),0);return x.map(v=>v*.2/peak);
}
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const rms=a=>Math.sqrt(mean(Array.from(a,x=>x*x)));
function oracle(signal,f0) {
  const rows=[];for(let i=0;i+1024<=signal.length;i+=120)rows.push({time:(i+512)/rate,f0,aperiodicity:0});
  return {frameSize:1024,hopSize:120,fmin:40,fmax:1200,requirePitch:true,pitchTrack:rows};
}
(async()=>{
 for(const f0 of [89.7,151.3,263.2,431.5,733.1]) await test('Unseen noiseless 5.5 kHz harmonic input at F0='+f0,()=>{
  const signal=periodic(f0),result=estimateHarmonicity(signal,rate,oracle(signal,f0));
  assert.ok(result.coverage>=.95);assert.ok(result.avgHNR>=50,JSON.stringify(result));
  for(const row of result.track.filter(row=>Number.isFinite(row.db))) {
    assert.ok(row.peakCorrelation<=1&&row.peakCorrelation>=0);
    assert.ok(row.comparisonSamples>=2);assert.equal(row.refinementConverged,true);
  }
 });
 for(const snr of [10,20,30]) await test('Known white-noise SNR '+snr+' dB at fractional F0',()=>{
  const clean=periodic(263.2,.6,5000);let state=26100500+snr;
  const u=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return(state+.5)/4294967296;};
  const noise=Float64Array.from(clean,()=>Math.sqrt(-2*Math.log(u()))*Math.cos(2*Math.PI*u()));
  const scale=rms(clean)/rms(noise)*10**(-snr/20),signal=Float64Array.from(clean,(x,i)=>x+scale*noise[i]);
  const result=estimateHarmonicity(signal,rate,oracle(signal,263.2));
  assert.ok(result.coverage>=.9);assert.ok(Math.abs(result.avgHNR-snr)<1,'measured='+result.avgHNR);
 });
 await test('Constant offset does not increase HNR',()=>{
  const signal=periodic(263.2), shifted=signal.map(x=>x+.35);
  const a=estimateHarmonicity(signal,rate,oracle(signal,263.2)),b=estimateHarmonicity(shifted,rate,oracle(shifted,263.2));
  assert.ok(Math.abs(a.avgHNR-b.avgHNR)<1e-5);
 });
 await test('HNR yields cancellation during fractional-delay refinement',async()=>{
  const signal=periodic(263.2);let polls=0;
  await assert.rejects(estimateHarmonicityAsync(signal,rate,{...oracle(signal,263.2),isCancelled:()=>++polls>8}),{name:'AbortError'});
 });
 await test('Exact F0 endpoints survive numeric error; real outside frequencies are rejected',()=>{
  for(const f0 of [39,40,1200,1210])for(const phase of [.19,1.1,2.7]) {
    const x=Float64Array.from({length:26460},(_,i)=>.2*Math.cos(2*Math.PI*f0*i/44100+phase));
    const track=yinPitchTrack(resampleLowPass(x,44100,rate,5500),rate,{frameSize:1024,hopSize:120,fmin:40,fmax:1200,threshold:.1}).filter(r=>r.time>=.15&&r.time<=.45);
    assert.equal(track.length,30);
    if(f0===40||f0===1200)assert.equal(track.filter(r=>r.f0>0).length,30);
    else assert.equal(track.filter(r=>r.f0>0).length,0);
    for(const row of track.filter(r=>r.rangeBoundaryAdjusted)) {
      assert.ok(Math.abs(row.f0-row.rawF0)<=row.numericToleranceHz);
      assert.ok(row.numericToleranceHz<1e-4);
    }
  }
 });
 await test('Reference denominator retains deliberately removed production rows',()=>{
  for(const inputRate of [12000,44100,48000]) {
    const times=referenceFormantGrid(inputRate*.5,inputRate);assert.equal(times.length,30);
    const track=times.map(time=>({time}));track.splice(7,5);
    const a=alignReferenceRows(track,times);assert.equal(a.rows.length,30);assert.equal(a.missingRows,5);
  }
 });
 await test('Reference grid identifies duplicate and shifted outputs',()=>{
  const times=referenceFormantGrid(6000,12000),track=times.map(time=>({time}));
  track.push({...track[0]});track[1]={time:track[1].time+.002};
  const a=alignReferenceRows(track,times);assert.equal(a.duplicateRows,1);assert.equal(a.unexpectedRows,1);assert.equal(a.missingRows,1);
 });
 await test('Full Int16 pipeline keeps formants explicitly experimental',async()=>{
  const signal=periodic(263.2,.4,5000),pcm=Int16Array.from(signal,x=>Math.round(x*32768));
  const r=await analyzePcm(pcm,rate);
  assert.ok(r.avgHNR>=50);assert.equal(r.formantStatus.quantitativeUseValidated,false);
  assert.equal(r.parameters.hnrCorrelationMethod,'normalized-fractional-delay-sinc-129');
 });
 const report={generatedAt:new Date().toISOString(),criteria:'Targeted engineering and deterministic numerical regressions; not clinical or hardware certification',
  summary:{total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length},results};
 fs.writeFileSync(path.resolve(__dirname,'../docs/paper-engineering-repairs-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report.summary));for(const r of results.filter(r=>r.status==='FAIL'))console.log(r.name,r.error);
 process.exitCode=report.summary.failed?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
