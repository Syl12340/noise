'use strict';
// Follow-up after a subharmonic error in the independent HNR diagnostic.
const fs=require('node:fs'),path=require('node:path');
const {analyzePcm}=require('../utils/phonetic/analysis');
const {resampleLowPass}=require('../utils/phonetic/resample');
const {yinPitchTrack}=require('../utils/phonetic/yin-pitch');
const rms=x=>Math.sqrt(x.reduce((a,b)=>a+b*b,0)/x.length);
const median=x=>x.length?x.slice().sort((a,b)=>a-b)[Math.floor(x.length/2)]:null;
(async()=>{
 const rows=[];
 for(const snr of [10,20])for(const seed of [26100501,26100502,26100503]){
  let state=seed;
  const uniform=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return(state+.5)/4294967296;};
  const rate=44100,f0=237,n=26460,clean=new Float64Array(n);
  for(let k=1;k<=21;k++)for(let i=0;i<n;i++)clean[i]+=Math.cos(2*Math.PI*k*f0*i/rate+k*.37)/Math.sqrt(k);
  const peak=clean.reduce((m,x)=>Math.max(m,Math.abs(x)),0);
  for(let i=0;i<n;i++)clean[i]*=.3/peak;
  const noise=Float64Array.from(clean,()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform()));
  const gain=rms(clean)/rms(noise)*10**(-snr/20);
  const pcm=Int16Array.from(clean,(x,i)=>Math.round((x+gain*noise[i])*32768));
  const result=await analyzePcm(pcm,rate);
  const track=result.pitchTrack.filter(x=>x.time>=.15&&x.time<=.45),valid=track.filter(x=>x.f0>0);
  rows.push({sourceF0:f0,inputRate:rate,inputSnrDb:snr,seed,totalFrames:track.length,acceptedFrames:valid.length,
   medianHz:median(valid.map(x=>x.f0)),correctWithinOnePercent:valid.filter(x=>Math.abs(x.f0/f0-1)<=.01).length,
   medianAperiodicity:median(valid.map(x=>x.aperiodicity)),clipped:result.inputQuality.clipped,avgHNR:result.avgHNR});
 }
 const boundary=[];
 for(const f0 of [40,1200]){
  const signal=Float64Array.from({length:26460},(_,i)=>.3*Math.cos(2*Math.PI*f0*i/44100+.37));
  const reduced=resampleLowPass(signal,44100,12000,5500);
  const track=yinPitchTrack(reduced,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200,threshold:.1}).filter(x=>x.time>=.15&&x.time<=.45);
  boundary.push({f0,total:track.length,accepted:track.filter(x=>x.f0>0).length,
   reasons:track.reduce((a,x)=>{a[x.reason||'accepted']=(a[x.reason||'accepted']||0)+1;return a;},{}),
   rawMinimum:Math.min(...track.filter(x=>Number.isFinite(x.rawF0)).map(x=>x.rawF0)),
   rawMaximum:Math.max(...track.filter(x=>Number.isFinite(x.rawF0)).map(x=>x.rawF0))});
 }
 const report={generatedAt:new Date().toISOString(),source:'Known stationary 237 Hz, 21 harmonics, independent Gaussian noise seeds, full production Int16 pipeline.',
  note:'10 and 20 dB refer to full 44.1 kHz input SNR; low-pass changes in-band SNR. This is a numerical stress test, not a clinical corpus.',rows,boundary};
 fs.writeFileSync(path.resolve(__dirname,'../docs/paper-scientific-followup-probes-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
