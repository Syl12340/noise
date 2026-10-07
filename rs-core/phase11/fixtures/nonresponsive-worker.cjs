'use strict';
// Test fixture: handshake works, analysis/cancel messages are never acknowledged.
const {parentPort}=require('node:worker_threads');
parentPort.on('message',m=>{if(m.type==='init')parentPort.postMessage({protocol:1,type:'ready',epoch:m.epoch});});
