'use strict';
// Extended regression set; formerly a holdout, now used during debugging.
// All true poles remain in the denominator, including those rejected by production gates.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {analyzePcm}=require('../utils/phonetic/analysis');
let seed=260926;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed+.5)/4294967296;}
const rate=12000,n=6000;
function synth(f0,poles) {
  let x=new Float64Array(n);const phase=random()*2*Math.PI;
  for(let k=1;k*f0<rate*.45;k++)for(let i=0;i<n;i++)x[i]+=Math.cos(2*Math.PI*k*f0*i/rate+phase*k)/Math.sqrt(k);
  for(const [f,bw] of poles){
    const r=Math.exp(-Math.PI*bw/rate),a=2*r*Math.cos(2*Math.PI*f/rate),b=r*r,y=new Float64Array(n);
    for(let i=0;i<n;i++)y[i]=x[i]+(i?a*y[i-1]:0)-(i>1?b*y[i-2]:0);
    const peak=y.reduce((m,v)=>Math.max(m,Math.abs(v)),0);x=y.map(v=>v/peak);
  }
  for(let i=1;i<n;i++)x[i]+=.9*x[i-1];
  const peak=x.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
  return Int16Array.from(x,v=>Math.round(v/peak*10000));
}
function metrics(errors,denominator){
  const accepted=errors.length,wrong=errors.filter(e=>e>.1).length;
  return {truthFrames:denominator,acceptedFrames:accepted,coverage:accepted/denominator,
    missingFrames:denominator-accepted,missingRate:(denominator-accepted)/denominator,
    wrongAcceptedFrames:wrong,falseAcceptancePerTruthFrame:wrong/denominator,
    wrongFractionAmongAccepted:accepted?wrong/accepted:null,
    meanRelativeErrorAmongAccepted:accepted?errors.reduce((a,b)=>a+b,0)/accepted:null,
    maxRelativeErrorAmongAccepted:accepted?Math.max(...errors):null};
}
(async()=>{
 const cases=[],allErrors=[[],[],[]];let total=0;
 for(const poles of [
   [[420,65],[1320,105],[2670,155],[3700,220],[4650,290]],
   [[630,95],[1780,145],[2930,190],[3860,230],[4750,310]],
   [[820,130],[1180,110],[2380,165],[3570,210],[4600,300]],
   [[700,600],[1000,120],[2500,180],[3600,220],[4600,300]],
 ])for(const f0 of [93,177,287,413]){
   const result=await analyzePcm(synth(f0,poles),rate);
   const rows=result.formantTracks.filter(r=>r.time>=.1&&r.time<=.4);total+=rows.length;
   const stats=['F1','F2','F3'].map((key,i)=>{
     const errors=rows.filter(r=>r[key].freq>0).map(r=>Math.abs(r[key].freq/poles[i][0]-1));
     allErrors[i].push(...errors);return metrics(errors,rows.length);
   });
   const reasons={};for(const row of rows)for(const key of ['F1','F2','F3']){
     const why=row.reason||row.quality[key].reason;reasons[why]=(reasons[why]||0)+1;
   }
   cases.push({f0,poles,stats,reasons});
 }
 const aggregate=allErrors.map(errors=>metrics(errors,total));
 const noise=Int16Array.from({length:n},()=>Math.round((random()*2-1)*5000));
 const invalid=await analyzePcm(noise,rate);
 const nonperiodic={frames:invalid.formantTracks.length,acceptedFormants:invalid.formantTracks.reduce((sum,row)=>sum+['F1','F2','F3'].filter(key=>row[key].freq>0).length,0)};
 const files=['utils/phonetic/analysis.js','utils/phonetic/yin-pitch.js','utils/phonetic/formant-extract.js','utils/phonetic/burg-lpc.js','utils/phonetic/resample.js','tests/formant-holdout.cjs'];
 const report={generatedAt:new Date().toISOString(),seed:260926,
   criterion:'Extended known-pole regression (used during debugging); 10% frequency tolerance, 80% coverage. Missing is counted separately, never as accurate. Not a clinical benchmark.',
   sourceSha256:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',f))).digest('hex')])),
   aggregate,nonperiodic,cases};
 report.accuracyAndCoveragePassed=aggregate.every(s=>s.coverage>=.8&&s.wrongAcceptedFrames===0)&&nonperiodic.acceptedFormants===0;
 fs.writeFileSync(path.resolve(__dirname,'../docs/formant-holdout-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({accuracyAndCoveragePassed:report.accuracyAndCoveragePassed,aggregate,nonperiodic}));
 process.exitCode=report.accuracyAndCoveragePassed?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
