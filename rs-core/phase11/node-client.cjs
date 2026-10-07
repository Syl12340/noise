'use strict';
const {Worker}=require('node:worker_threads'),path=require('node:path');
const {createAnalysisClient}=require('./worker-client.cjs');
function nodeTransport(worker){
 const swallow=()=>{};worker.on('error',swallow);worker.once('exit',()=>worker.off('error',swallow));
 const listen=(event,fn)=>{worker.on(event,fn);return ()=>worker.off(event,fn);};
 return {postMessage:(m,list)=>worker.postMessage(m,list),onMessage:fn=>listen('message',fn),onError:fn=>{const a=listen('error',fn),b=listen('messageerror',fn);return ()=>{a();b();};},onExit:fn=>listen('exit',fn),terminate:()=>worker.terminate()};
}
async function createNodeAnalysisClient(options){
 const worker=new Worker(path.join(__dirname,'node-worker.cjs'),{resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
 let client;try{client=createAnalysisClient({...options,transport:nodeTransport(worker)});await client.ready;return client;}catch(e){if(client)await client.close();else await worker.terminate();throw e;}
}
module.exports={nodeTransport,createNodeAnalysisClient};
