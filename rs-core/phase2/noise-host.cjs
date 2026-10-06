'use strict';
// Standalone host only. No recorder, page mutation or JavaScript DSP fallback.
const EXPORTS = ['noise_abi_version','noise_input_capacity','noise_input_ptr','noise_result_ptr',
  'noise_result_len','noise_has_result','noise_last_status','noise_ack','noise_create',
  'noise_destroy','noise_process','noise_snapshot','noise_query','noise_next_event',
  'noise_finish','noise_invalidate'];
const isU32 = x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;

function attachNoiseInstance(instance) {
  const e = instance && instance.exports;
  if (!e || EXPORTS.some(key => typeof e[key] !== 'function') || !e.memory ||
      Object.prototype.toString.call(e.memory.buffer)!=='[object ArrayBuffer]' || typeof e.memory.grow !== 'function') {
    throw new Error('Invalid noise ABI exports or memory');
  }
  if (e.noise_abi_version() !== 1 || e.noise_input_capacity() !== 262144) throw new Error('Unsupported noise ABI identity');
  let poisoned = false;
  const alive = () => { if (poisoned) throw new Error('Noise instance discarded; create a new instance'); };
  function call(name,args) {
    alive();
    try { return e[name](...args); }
    catch (error) { poisoned=true; throw error; }
  }
  function range(ptr,len,alignment=1) {
    const buffer = e.memory.buffer;
    if (!isU32(ptr) || !isU32(len) || ptr % alignment !== 0 || ptr > buffer.byteLength || len > buffer.byteLength-ptr) {
      throw new Error('Invalid noise memory range');
    }
    return buffer;
  }
  function result(name,args) {
    const code=call(name,args);
    if (code!==0) { const error=new Error('Noise ABI status '+code); error.code=code; throw error; }
    try {
      if (call('noise_has_result',[])!==1) throw new Error('Missing noise result');
      const ptr=call('noise_result_ptr',[]),len=call('noise_result_len',[]);
      if (len===0 || len>2*1024*1024) throw new Error('Invalid noise result size');
      const copied=new Uint8Array(range(ptr,len),ptr,len).slice();
      // Wire strings are ASCII: fixed internal names/reasons and decimal numbers only.
      let text='';
      for (let i=0;i<copied.length;i+=8192) {
        const block=copied.subarray(i,i+8192);
        for (const b of block) if (b>127) throw new Error('Unexpected non-ASCII noise wire text');
        text+=String.fromCharCode.apply(null,block);
      }
      const decoded=JSON.parse(text);
      if (call('noise_ack',[])!==0) throw new Error('Result acknowledgment failed');
      return decoded;
    } catch (error) { poisoned=true; throw error; } // Never replay a committed call.
  }
  const handle = h => { if (!isU32(h)||h===0) throw new TypeError('Invalid session handle'); };
  return {
    get discarded() { return poisoned; },
    create(offset=100,capacity=128) {
      if (!Number.isFinite(offset)||!Number.isInteger(capacity)||capacity<1||capacity>128) throw new TypeError('Invalid session configuration');
      const h=call('noise_create',[offset,capacity]);
      if (!isU32(h)||h===0) { const code=call('noise_last_status',[]); const error=new Error('Create status '+code); error.code=code; throw error; }
      return h;
    },
    destroy(h) { handle(h); const code=call('noise_destroy',[h]); if (code!==0) {const error=new Error('Destroy status '+code);error.code=code;throw error;} },
    process(h,seq,pcm,needed=false) {
      handle(h); if (!isU32(seq)||!(pcm instanceof Int16Array)||pcm.length>262144||typeof needed!=='boolean') throw new TypeError('Invalid chunk');
      alive();
      if (call('noise_has_result',[])!==0) {const error=new Error('Pending result');error.code=-3;throw error;}
      try {
        const ptr=call('noise_input_ptr',[]);
        new Int16Array(range(ptr,pcm.length*2,2),ptr,pcm.length).set(pcm);
      } catch (error) { poisoned=true; throw error; }
      return result('noise_process',[h,seq,pcm.length,needed?1:0]);
    },
    snapshot(h) { handle(h);return result('noise_snapshot',[h]); },
    query(h) { handle(h);return result('noise_query',[h]); },
    nextEvent(h) { handle(h);return result('noise_next_event',[h]); },
    finish(h,invalid=false) { handle(h);if(typeof invalid!=='boolean')throw new TypeError('Invalid finish flag');return result('noise_finish',[h,invalid?1:0]); },
    invalidate(h,reason) { handle(h);if(!Number.isInteger(reason)||reason<0||reason>3)throw new TypeError('Invalid reason');return result('noise_invalidate',[h,reason]); },
    discard() { poisoned=true; },
  };
}
async function instantiateNoise({api,source}) {
  if (!api || typeof api.instantiate!=='function') throw new TypeError('Supply WebAssembly or WXWebAssembly API');
  // APIs exposing compilation introspection must reject imports explicitly.
  if (typeof api.compile==='function' && api.Module && typeof api.Module.imports==='function' && typeof source!=='string') {
    const module=await api.compile(source);
    if(api.Module.imports(module).length!==0) throw new Error('Noise module imports are not authorized');
    const loaded=await api.instantiate(module,{});
    return attachNoiseInstance(loaded.instance||loaded);
  }
  const loaded=await api.instantiate(source,{});
  return attachNoiseInstance(loaded.instance||loaded);
}
module.exports={attachNoiseInstance,instantiateNoise};
