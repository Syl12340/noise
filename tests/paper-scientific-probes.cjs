'use strict';
// Independent deterministic signal probes. Thresholds are engineering diagnostics,
// not IEC tolerances or clinical validation criteria. No production files are changed.
const fs = require('node:fs'), path = require('node:path');
const { AWeightingFilter, calculateRMS, calculateDb, calculateLeqFromEnergy } = require('../utils/audio-math');
const { resampleLowPass } = require('../utils/phonetic/resample');
const { yinPitchTrack } = require('../utils/phonetic/yin-pitch');
const { estimateHarmonicity } = require('../utils/phonetic/harmonicity');
const { analyzePcm } = require('../utils/phonetic/analysis');
const { computeSpectrum } = require('../utils/fft');
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
const rms = a => Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length);
const median = a => a.length ? a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)] : null;
let state = 20261005;
function uniform() { state = (Math.imul(state,1664525)+1013904223)>>>0; return (state+.5)/4294967296; }
function gaussian() { return Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform()); }
function periodic(f0, rate, seconds, rich) {
  const count = Math.round(rate*seconds), out = new Float64Array(count);
  const harmonics = rich ? Math.floor(5000/f0) : 1;
  for (let k=1;k<=harmonics;k++) for(let n=0;n<count;n++)
    out[n] += Math.cos(2*Math.PI*k*f0*n/rate + k*.37)/Math.sqrt(k);
  const peak = out.reduce((m,x)=>Math.max(m,Math.abs(x)),0);
  return out.map(x=>x*.3/peak);
}
function targetA(f) {
  const raw = x => 12194**2*x**4/((x*x+20.6**2)*Math.sqrt((x*x+107.7**2)*(x*x+737.9**2))*(x*x+12194**2));
  return 20*Math.log10(raw(f)/raw(1000));
}
function sinusAmplitude(x, rate, f, start) {
  let ss=0,cc=0,sc=0,ys=0,yc=0;
  for(let n=start;n<x.length;n++) { const s=Math.sin(2*Math.PI*f*n/rate),c=Math.cos(2*Math.PI*f*n/rate);
    ss+=s*s;cc+=c*c;sc+=s*c;ys+=x[n]*s;yc+=x[n]*c; }
  const det=ss*cc-sc*sc;
  return Math.hypot((ys*cc-yc*sc)/det,(yc*ss-ys*sc)/det);
}
function summarizeHnr(result) {
  const rows=result.track.filter(r=>r.time>=.15&&r.time<=.85), valid=rows.filter(r=>Number.isFinite(r.db));
  return {availableFrames:rows.length,acceptedFrames:valid.length,coverage:valid.length/rows.length,
    meanDb:mean(valid.map(r=>r.db)),medianDb:median(valid.map(r=>r.db)),
    minimumDb:valid.length?Math.min(...valid.map(r=>r.db)):null,
    maximumDb:valid.length?Math.max(...valid.map(r=>r.db)):null};
}
(async()=>{
  const report={generatedAt:new Date().toISOString(),seed:20261005,
    scope:'Synthetic numerical diagnostics only. Known periodic inputs, fixed parameters; no tuning or clinical conclusions.'};
  const rate=44100;
  report.aWeighting=[];
  for(const f of [20,25,31.5,40,63,100,200,500,1000,2000,4000,6300,8000,10000,12500,16000,20000]) {
    const input=Float64Array.from({length:rate*1.5},(_,n)=>.2*Math.sin(2*Math.PI*f*n/rate));
    const output=new AWeightingFilter(rate).process(input,false);
    const measuredDb=20*Math.log10(sinusAmplitude(output,rate,f,rate)/.2),targetDb=targetA(f);
    report.aWeighting.push({frequencyHz:f,measuredDb,targetDb,errorDb:measuredDb-targetDb});
  }
  const wave=periodic(237,rate,.25,true), full=new AWeightingFilter(rate).process(wave,false);
  const splitFilter=new AWeightingFilter(rate), split=new Float32Array(wave.length);
  for(let at=0;at<wave.length;) {const size=1+Math.floor(uniform()*1600),end=Math.min(wave.length,at+size);
    split.set(splitFilter.process(wave.subarray(at,end),false),at);at=end;}
  report.chunkInvariance={samples:wave.length,maxAbsoluteDifference:full.reduce((m,x,i)=>Math.max(m,Math.abs(x-split[i])),0)};
  const tone=Float64Array.from({length:rate},(_,n)=>.25*Math.sin(2*Math.PI*1000*n/rate));
  report.digitalLevel={measuredDbfs:calculateDb(calculateRMS(tone),1),expectedDbfs:20*Math.log10(.25/Math.SQRT2),
    integratedDbfs:calculateLeqFromEnergy(tone.reduce((s,x)=>s+x*x,0),tone.length,0)};
  report.resampling=[];
  for(const inputRate of [44100,48000]) for(const f of [1000,4000,5000,5500,5800,6000,6500,9000]) {
    const x=Float64Array.from({length:inputRate},(_,n)=>.2*Math.sin(2*Math.PI*f*n/inputRate+.3));
    const y=resampleLowPass(x,inputRate,12000,5500);
    report.resampling.push({inputRate,frequencyHz:f,outputRate:12000,
      outputRmsGainDb:20*Math.log10(rms(y.subarray(2400,9600))/(.2/Math.SQRT2))});
  }
  report.hnr=[];
  for(const f0 of [100,173,200,237,389,599]) for(const rich of [false,true]) for(const snr of rich?[null,10,20,30]:[null]) {
    const clean=periodic(f0,12000,1,rich), noise=Float64Array.from(clean,()=>gaussian());
    const gain=snr===null?0:rms(clean)/rms(noise)*10**(-snr/20);
    const signal=Float64Array.from(clean,(x,i)=>x+gain*noise[i]);
    const pitch=yinPitchTrack(signal,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200,threshold:.1});
    const oracle=pitch.map(row=>({time:row.time,f0,aperiodicity:0}));
    const options={frameSize:1024,hopSize:120,fmin:40,fmax:1200,requirePitch:true};
    const direct=estimateHarmonicity(signal,12000,{...options,pitchTrack:oracle});
    const gated=estimateHarmonicity(signal,12000,{...options,pitchTrack:pitch});
    report.hnr.push({f0,harmonics:rich?Math.floor(5000/f0):1,inputSnrDb:snr,
      noiseless:snr===null,medianEstimatedF0:median(pitch.filter(r=>r.f0>0).map(r=>r.f0)),
      oraclePitch:summarizeHnr(direct),yinGated:summarizeHnr(gated)});
  }
  report.productionNoiselessHnr=[];
  for(const f0 of [200,237,389]) {
    const clean=periodic(f0,44100,.6,true), pcm=Int16Array.from(clean,x=>Math.round(x*32768));
    const quantError=Float64Array.from(clean,(x,i)=>pcm[i]/32768-x);
    const result=await analyzePcm(pcm,44100);
    report.productionNoiselessHnr.push({f0,inputRate:44100,inputQuantizationSnrDb:20*Math.log10(rms(clean)/rms(quantError)),
      avgHNR:result.avgHNR,hnr:summarizeHnr(result.harmonicity),
      pitchCoverage:result.coverage.pitchAccepted/result.coverage.pitchTotal});
  }
  report.f0Boundary=[];
  for(const f0 of [39,40,40.5,83,137,331,479,1190,1200,1210]) {
    const signal=periodic(f0,44100,.6,false), reduced=resampleLowPass(signal,44100,12000,5500);
    const rows=yinPitchTrack(reduced,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200,threshold:.1}).filter(r=>r.time>=.15&&r.time<=.45);
    const valid=rows.filter(r=>r.f0>0);
    report.f0Boundary.push({f0,total:rows.length,accepted:valid.length,medianHz:median(valid.map(r=>r.f0)),
      maxRelativeError:valid.length?Math.max(...valid.map(r=>Math.abs(r.f0/f0-1))):null});
  }
  fs.writeFileSync(path.resolve(__dirname,'../docs/paper-scientific-probes-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({maxAWeightingErrorDb:Math.max(...report.aWeighting.map(r=>Math.abs(r.errorDb))),
    chunkInvariance:report.chunkInvariance,digitalLevel:report.digitalLevel,productionNoiselessHnr:report.productionNoiselessHnr,
    f0Boundary:report.f0Boundary}));
})().catch(error=>{console.error(error);process.exitCode=1;});
