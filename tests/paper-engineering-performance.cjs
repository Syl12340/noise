'use strict';
// Descriptive desktop timing, never a WeChat/mobile performance guarantee.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'..');
const {analyzePcm}=require(path.join(root,'utils/phonetic/analysis.js'));
const rate=44100,f0=237,seconds=5,x=new Float64Array(rate*seconds);
for(let k=1;k*f0<5000;k++)for(let n=0;n<x.length;n++)x[n]+=Math.cos(2*Math.PI*k*f0*n/rate+k*.37)/Math.sqrt(k);
const peak=x.reduce((m,v)=>Math.max(m,Math.abs(v)),0),pcm=Int16Array.from(x,v=>Math.round(v/peak*.3*32768));
(async()=>{
 const before=process.memoryUsage(),beats=[];let peakHeap=before.heapUsed;
 const timer=setInterval(()=>{beats.push(performance.now());peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},2);
 const start=performance.now();
 try {
  const result=await analyzePcm(pcm,rate),elapsed=(performance.now()-start)/1000;
  const gaps=beats.map((at,i)=>i?at-beats[i-1]:at-start);
  const report={generatedAt:new Date().toISOString(),node:process.version,algorithmVersion:result.ALGORITHM_VERSION,
   inputSeconds:seconds,inputRate:rate,inputSha256:crypto.createHash('sha256').update(Buffer.from(pcm.buffer)).digest('hex'),
   elapsedSeconds:elapsed,realTimeFactor:elapsed/seconds,heartbeatCount:beats.length,
   maxObservedHeartbeatGapMs:gaps.length?Math.max(...gaps):null,peakObservedHeapBytes:peakHeap,
   avgHNR:result.avgHNR,scope:'Single desktop run; observed timer/heap samples, not worst-case or native-device measurements.'};
  fs.writeFileSync(path.join(root,'docs/paper-engineering-performance-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 } finally {clearInterval(timer);}
})().catch(error=>{console.error(error);process.exitCode=1;});
