'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{Worker}=require('node:worker_threads');
const {createNodeAnalysisClient,nodeTransport}=require('./node-client.cjs'),{createAnalysisClient}=require('./worker-client.cjs'),{createWorkerService}=require('./worker-service.cjs');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const mb=fs.readFileSync(path.join(root,'phase8/reference/manifest.json'));assert.equal(sha(mb),'ca5fe21b490389830d5b4231439d0947ab1b79f066693ced2599132b230223a3');const manifest=JSON.parse(mb);
const stats={cases:0,exactFields:0,dbFields:0,maxDbError:0,progress:0};
function compare(a,b,key=''){
 if(b!==null&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),key);for(const k of Object.keys(b))compare(a[k],b[k],k);}
 else if(typeof b==='number'&&['db','avgHNR','partialMeanHNR'].includes(key)){const d=Math.abs(a-b);assert.ok(Number.isFinite(a)&&d<=1e-10,key+': '+a+' vs '+b);stats.dbFields++;stats.maxDbError=Math.max(stats.maxDbError,d);}
 else{assert.ok(Object.is(a,b),key+': '+a+' vs '+b);stats.exactFields++;}
}
function pcm(c){const b=fs.readFileSync(path.join(root,'phase8/reference',c.input.file));assert.equal(sha(b),c.input.sha256);return Int16Array.from({length:b.length/2},(_,i)=>b.readInt16LE(i*2));}
const options=c=>({sampleRate:c.rate,discontinuityBoundariesSeconds:Float64Array.from(c.boundaries)});
const tick=()=>new Promise(r=>setImmediate(r));
function fakeTransport(){
 const listeners={message:new Set(),error:new Set(),exit:new Set()},sent=[];let service=null,terminated=0;
 const emit=(kind,value)=>{for(const fn of [...listeners[kind]])fn(value);};
 const subscribe=(kind,fn)=>{listeners[kind].add(fn);return ()=>listeners[kind].delete(fn);};
 return {sent,emit,setService:s=>{service=s;},get terminated(){return terminated;},get listenerCount(){return Object.values(listeners).reduce((n,s)=>n+s.size,0);},
  postMessage(m){const copied=structuredClone(m);sent.push(copied);if(service)queueMicrotask(()=>service.receive(copied));},onMessage:fn=>subscribe('message',fn),onError:fn=>subscribe('error',fn),onExit:fn=>subscribe('exit',fn),terminate(){terminated++;if(service)service.dispose();return Promise.resolve();}};
}
async function fakeClient({host,readyTimeoutMs=1000,jobTimeoutMs=1000,cancelTimeoutMs=100}={}){
 const transport=fakeTransport();if(host)transport.setService(createWorkerService({post:m=>queueMicrotask(()=>transport.emit('message',structuredClone(m))),createHost:async()=>host}));
 const client=createAnalysisClient({transport,wasmBytes:new Uint8Array([0]),readyTimeoutMs,jobTimeoutMs,cancelTimeoutMs});return {client,transport};
}
async function main(){
 const checks=[],client=await createNodeAnalysisClient({wasmBytes:bytes});
 try{
  for(const c of manifest.pipelines){let callbacks=0;const job=client.start(pcm(c),options(c),{onProgress:async p=>{assert.ok(!('values' in p)&&!('row' in p));callbacks++;await Promise.resolve();}});compare(await job.promise,c.expected);stats.progress+=callbacks;stats.cases++;assert.equal(client.busy,false);}
  checks.push('8 actual Node Worker PCM-to-HNR results match frozen baseline; bounded progress metadata');
  const c=manifest.pipelines.find(c=>c.name==='discontinuous-dc'),input=pcm(c),opts=options(c),job=client.start(input,opts);input.fill(0);opts.discontinuityBoundariesSeconds.fill(0);assert.throws(()=>client.start(pcm(c),options(c)),e=>e.name==='BusyError');compare(await job.promise,c.expected);checks.push('owned transfer copies and one-job admission');
  let count=0;const canceled=client.start(pcm(c),options(c),{onProgress:()=>{count++;if(count===1)canceled.cancel();}});await assert.rejects(canceled.promise,e=>e.name==='AbortError');assert.equal(client.busy,false);compare(await client.start(pcm(c),options(c)).promise,c.expected);
  const broken=client.start(pcm(c),options(c),{onProgress:async()=>{throw new Error('progress failure');}});await assert.rejects(broken.promise,/progress failure/);compare(await client.start(pcm(c),options(c)).promise,c.expected);checks.push('cancel and async hook failure clean up, then same Worker restarts');
  let heartbeats=0;const pulse=setInterval(()=>heartbeats++,1);try{await client.start(pcm(manifest.pipelines[7]),options(manifest.pipelines[7])).promise;}finally{clearInterval(pulse);}assert.ok(heartbeats>0);checks.push('main event loop remains active while Worker computes default5.25s');
 }finally{await client.close();}
 // Portable callback transport: a held progress callback proves exactly one outstanding message.
 let release,entered;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let produced=0;
 const simpleResult=manifest.pipelines[0].expected;
 const host={discarded:false,async analyzePcmHnr(_p,_o,h){for(let i=0;i<3;i++){if(h.isCanceled()){const e=new Error('cancel');e.name='AbortError';throw e;}produced++;await h.onProgress({stage:'pitch-frame',segmentIndex:0,index:i,completed:i+1,total:3,done:i===2,row:{large:'excluded'}});}if(h.isCanceled()){const e=new Error('cancel');e.name='AbortError';throw e;}return structuredClone(simpleResult);}};
 const portable=await fakeClient({host});await portable.client.ready;
 const held=portable.client.start(new Int16Array(6000),{sampleRate:12000},{onProgress:()=>{entered();return hold;}});await started;await tick();await tick();assert.equal(produced,1);held.cancel();await assert.rejects(held.promise,e=>e.name==='AbortError');release();await tick();assert.equal(portable.client.busy,false);
 compare(await portable.client.start(new Int16Array(6000),{sampleRate:12000}).promise,simpleResult);await portable.client.close();assert.equal(portable.transport.listenerCount,0);checks.push('injected clone transport, asynchronous ack backpressure, cancel releases stuck hook, listener cleanup');
 const noReady=await fakeClient({readyTimeoutMs:20});await assert.rejects(noReady.client.ready,e=>e.name==='TimeoutError');assert.equal(noReady.transport.terminated,1);await noReady.client.close();
 const bad=await fakeClient();bad.transport.emit('message',{protocol:1,type:'ready',epoch:bad.client.epoch});await bad.client.ready;const waiting=bad.client.start(new Int16Array(1024),{sampleRate:12000});bad.transport.emit('message',{protocol:1,type:'started',epoch:bad.client.epoch,id:waiting.id});
 bad.transport.emit('message',{protocol:9,type:'result',epoch:bad.client.epoch-1||0xffffffff,id:waiting.id,payload:{}});assert.equal(bad.client.busy,true);
 bad.transport.emit('message',{protocol:1,type:'result',epoch:bad.client.epoch,id:waiting.id,payload:{}});await assert.rejects(waiting.promise,e=>e.name==='ProtocolError');assert.equal(bad.client.state,'faulted');assert.equal(bad.transport.listenerCount,0);await bad.client.close();checks.push('ready timeout, stale epoch and malformed-result termination');
 const mismatch=await fakeClient();mismatch.transport.emit('message',{protocol:1,type:'ready',epoch:mismatch.client.epoch});await mismatch.client.ready;const mismatched=mismatch.client.start(new Int16Array(1024),{sampleRate:12000});mismatch.transport.emit('message',{protocol:1,type:'started',epoch:mismatch.client.epoch,id:mismatched.id});mismatch.transport.emit('message',{protocol:1,type:'result',epoch:mismatch.client.epoch,id:mismatched.id,payload:structuredClone(simpleResult)});await assert.rejects(mismatched.promise,/source/);await mismatch.client.close();checks.push('well-shaped result from a different source length is rejected');
 const numeric=await fakeClient();numeric.transport.emit('message',{protocol:1,type:'ready',epoch:numeric.client.epoch});await numeric.client.ready;const numberJob=numeric.client.start(new Int16Array(6000),{sampleRate:12000}),wrongNumbers=structuredClone(simpleResult);wrongNumbers.harmonicity.track[0].db='0';numeric.transport.emit('message',{protocol:1,type:'started',epoch:numeric.client.epoch,id:numberJob.id});numeric.transport.emit('message',{protocol:1,type:'result',epoch:numeric.client.epoch,id:numberJob.id,payload:wrongNumbers});await assert.rejects(numberJob.promise,e=>e.name==='ProtocolError');await numeric.client.close();checks.push('scientific numeric fields cannot be replaced with strings');
 const stalledWorker=new Worker(path.join(__dirname,'fixtures/nonresponsive-worker.cjs')),stalled=createAnalysisClient({transport:nodeTransport(stalledWorker),wasmBytes:bytes,jobTimeoutMs:20,cancelTimeoutMs:50});await stalled.ready;const deadline=stalled.start(new Int16Array(1024),{sampleRate:12000});await assert.rejects(deadline.promise,/cancellation timed out/);assert.equal(stalled.state,'faulted');await stalled.close();checks.push('actual nonresponsive Worker is terminated after deadline and missing cancel ack');
 const exitedWorker=new Worker(path.join(__dirname,'node-worker.cjs')),exited=createAnalysisClient({transport:nodeTransport(exitedWorker),wasmBytes:bytes});await exited.ready;const active=exited.start(pcm(manifest.pipelines[7]),options(manifest.pipelines[7]));await exitedWorker.terminate();await assert.rejects(active.promise,e=>e.name==='WorkerError');await exited.close();
 const recovered=await createNodeAnalysisClient({wasmBytes:bytes});try{compare(await recovered.start(pcm(manifest.pipelines[0]),options(manifest.pipelines[0])).promise,manifest.pipelines[0].expected);}finally{await recovered.close();}checks.push('unexpected Worker exit rejects job; explicit new Worker recovers without replay');
 const decodeWorker=new Worker(path.join(__dirname,'node-worker.cjs')),decode=createAnalysisClient({transport:nodeTransport(decodeWorker),wasmBytes:bytes});await decode.ready;const decodeJob=decode.start(pcm(manifest.pipelines[7]),options(manifest.pipelines[7]));decodeWorker.emit('messageerror',new Error('decode failure'));await assert.rejects(decodeJob.promise,/decode failure/);await decode.close();checks.push('Node messageerror event rejects active job and cleans Worker');
 await assert.rejects(createNodeAnalysisClient({wasmBytes:new Uint8Array([0,1,2])}));checks.push('invalid WASM initialization fails and cleans Worker');
 const report={status:'PASS',stats,checks,artifactSha256:sha(bytes),referenceSha256:sha(mb),limits:['Actual Node Worker and injected callback transport only; not WX/Android verification','No production integration, phone latency or clinical qualification']};fs.writeFileSync(path.join(root,'reports/worker-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
