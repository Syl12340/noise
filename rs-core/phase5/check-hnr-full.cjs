'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {instantiateSpeech,attachSpeechInstance}=require('../phase3/speech-host.cjs');
const root=path.resolve(__dirname,'..'),ref=path.join(__dirname,'reference');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifestBytes=fs.readFileSync(path.join(ref,'manifest.json'));assert.equal(sha(manifestBytes),'39bb05fd1bdfa30b420fa9f45123ac0417163e8c2145759dcfdbdd991a46a3c1');
const manifest=JSON.parse(manifestBytes),bytes=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
const stats={cases:0,exactNumbers:0,dbNumbers:0,maxDbError:0,frames:0};
function compare(a,e,path,key='') {
    if(Array.isArray(e)){assert.equal(a.length,e.length,path);for(let i=0;i<e.length;i++)compare(a[i],e[i],path+'['+i+']',key);}
    else if(e!==null&&typeof e==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(e).sort(),path);for(const k of Object.keys(e))compare(a[k],e[k],path+'.'+k,k);}
    else if(typeof e==='number'){
        if(['db','avgHNR','partialMeanHNR'].includes(key)){const d=Math.abs(a-e);assert.ok(Number.isFinite(a)&&d<=1e-10,path);stats.dbNumbers++;stats.maxDbError=Math.max(stats.maxDbError,d);}
        else{assert.ok(Object.is(a,e),path+': '+a+' vs '+e);stats.exactNumbers++;}
    }else assert.equal(a,e,path);
}
async function main() {
    const host=await instantiateSpeech({api:WebAssembly,source:bytes});const tests=[];
    for(const c of manifest.cases){
        const b=fs.readFileSync(path.join(ref,c.input));assert.equal(sha(b),c.inputSha256);
        const signal=Float32Array.from({length:b.length/4},(_,i)=>b.readFloatLE(i*4));
        let n=0;const result=await host.harmonicityFull(signal,c.config,{yieldFn:async()=>{},onProgress:r=>{if(r.state==='frame'){assert.equal(r.index,n);n++;assert.equal(r.completed,n);}}});
        assert.equal(n,c.expected.track.length);stats.frames+=n;compare(result,c.expected,c.name);stats.cases++;
    }
    const zero=new Float32Array(2504),opts={requirePitch:true};
    const first=host.hnrBegin(zero,opts);assert.throws(()=>host.hnrFinish(first.handle),e=>e.code===-8);
    host.hnrNext(first.handle);host.preEmphasis(new Int16Array([100,200]));
    const second=host.hnrBegin(new Float32Array(1024),opts);
    assert.throws(()=>host.hnrBegin(zero,opts),e=>e.code===-6);
    while(!host.hnrNext(first.handle).done){}const result=host.hnrFinish(first.handle);compare(host.hnrFinish(first.handle),result,'idempotent');
    host.hnrCancel(first.handle);assert.throws(()=>host.hnrNext(first.handle),e=>e.code===-1);
    host.hnrNext(second.handle);host.hnrFinish(second.handle);host.hnrCancel(second.handle);tests.push('two sessions, no partial finish, idempotence and stale handles');
    let count=0,cancelFlag=false;
    await assert.rejects(host.harmonicityFull(zero,opts,{yieldFn:async()=>{},onProgress:()=>{count++;cancelFlag=true;},isCanceled:()=>cancelFlag}),e=>e.name==='AbortError');
    assert.equal(count,1);tests.push('cancellation releases exactly its session');
    await assert.rejects(host.harmonicityFull(zero,opts,{onProgress:async()=>{throw new Error('callback failed');}}),/callback failed/);
    const a=host.hnrBegin(zero,opts),b=host.hnrBegin(zero,opts);host.hnrCancel(a.handle);host.hnrCancel(b.handle);tests.push('async callback failure releases ownership');
    const module=await WebAssembly.compile(bytes),inst=new WebAssembly.Instance(module,{env:{hnr_sin:Math.sin}}),e=inst.exports,raw=attachSpeechInstance(inst);
    const h=raw.hnrBegin(zero,opts).handle;
    assert.equal(e.speech_pcm_emphasis(0,.97),0);assert.equal(e.speech_hnr_next(h),-3);assert.equal(e.speech_hnr_cancel(h),-3);e.speech_ack();
    const old=e.memory.buffer;e.memory.grow(1);assert.equal(old.byteLength,0);assert.equal(raw.hnrNext(h).index,0);raw.hnrCancel(h);tests.push('pending gate and memory growth preserve frame cursor');
    const full=manifest.cases[0],input=fs.readFileSync(path.join(ref,full.input)),signal=Float32Array.from({length:input.length/4},(_,i)=>input.readFloatLE(i*4));
    const owned=host.hnrBegin(signal,full.config);signal.fill(0);host.preEmphasis(new Int16Array([300,400]));let receipt;
    do{receipt=host.hnrNext(owned.handle);}while(!receipt.done);
    compare(host.hnrFinish(owned.handle),full.expected,'owned-input');host.hnrCancel(owned.handle);tests.push('owned signal and517row pitch input survive staging reuse');
    const pair=manifest.cases.filter(c=>['detuned','odd-grid'].includes(c.name)).map(c=>{
      const raw=fs.readFileSync(path.join(ref,c.input)),s=Float32Array.from({length:raw.length/4},(_,i)=>raw.readFloatLE(i*4));return {c,h:host.hnrBegin(s,c.config).handle,done:false};
    });
    while(pair.some(p=>!p.done)){for(const p of pair)if(!p.done)p.done=host.hnrNext(p.h).done;}
    for(const p of pair){compare(host.hnrFinish(p.h),p.c.expected,'interleaved-'+p.c.name);host.hnrCancel(p.h);}
    tests.push('round-robin sessions with different frame and hop settings match baseline');
    const canceledHandle=host.hnrBegin(zero,opts).handle,otherHandle=host.hnrBegin(new Float32Array(1024),opts).handle;
    host.hnrCancel(canceledHandle);host.hnrNext(otherHandle);assert.equal(host.hnrFinish(otherHandle).track.length,1);host.hnrCancel(otherHandle);
    tests.push('cancellation leaves the other session live');
    let yielded=0;
    await host.harmonicityFull(zero,opts,{yieldFn:async()=>{yielded++;host.preEmphasis(new Int16Array([2,3]));}});
    assert.equal(yielded,Math.floor((zero.length-1024)/120));tests.push('one yield between complete frames, including low-energy frames');
    const report={status:'PASS',stats,tests,artifact:{bytes:bytes.length,sha256:sha(bytes)},scope:'Full continuous-segment frame scheduling on Node; no capture-gap assembly or real WX/Worker/phone validation.'};
    fs.writeFileSync(path.join(root,'reports/hnr-full-wasm.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
