'use strict';
// NAC1 adapter for the SAME P0 validator. DSP always runs in compiled Rust WASM.
const fs=require('node:fs');
const path=require('node:path');
const {instantiateNoise,attachNoiseInstance}=require('./noise-host.cjs');
const root=path.resolve(__dirname,'..');
async function main() {
  const bytes=fs.readFileSync(process.argv[2]);
  let pos=12;
  function take(n) { if(!Number.isSafeInteger(n)||n<0||pos+n>bytes.length)throw new Error('Truncated NAC1');const b=bytes.subarray(pos,pos+n);pos+=n;return b; }
  if(bytes.length<12||bytes.toString('ascii',0,4)!=='NAC1')throw new Error('NAC1 header');
  const source=fs.readFileSync(path.join(root,'target/wasm32-unknown-unknown/release/noise_wasm.wasm'));
  const host=process.argv.includes('--harmonicity')?attachNoiseInstance((await WebAssembly.instantiate(source,{env:{hnr_sin:()=>{throw new Error('Noise invoked HNR math');}}})).instance):await instantiateNoise({api:WebAssembly,source});
  const h=host.create(bytes.readDoubleLE(4));
  const emit=obj=>process.stdout.write(JSON.stringify(obj)+'\n');
  while(pos<bytes.length) {
    const op=take(1)[0];
    if(op===1) {
      const hdr=take(9),seq=hdr.readUInt32LE(0),len=hdr.readUInt32LE(4),flag=hdr[8];
      if(len>262144||flag>1)throw new Error('Invalid NAC1 chunk');
      const raw=take(len*2),pcm=new Int16Array(len);
      for(let i=0;i<len;i++)pcm[i]=raw.readInt16LE(i*2);
      const result=host.process(h,seq,pcm,flag===1);emit(result.receipt);emit(result.snapshot);
    } else if(op===2) {
      const s=host.query(h);emit(s||{type:'spectrum',status:'insufficient_data'});
    } else if(op===3) {
      const flag=take(1)[0];if(flag>1)throw new Error('Invalid finish flag');emit(host.finish(h,flag===1));
    } else if(op===4) {
      const reason=take(take(4).readUInt32LE(0)).toString('utf8');
      const map=new Map([['invalid_format',0],['system_interruption',1],['stop_timeout',2],['stream_discontinuity',3],
        ['音频数据格式无效，请重新测量',0],['录音被系统中断，本次结果无效',1]]);
      if(!map.has(reason))throw new Error('Unmapped application reason: '+reason);
      host.invalidate(h,map.get(reason));emit({type:'hard_invalid',reason});
    } else if(op===5) {
      let event;while((event=host.nextEvent(h))!==null)emit(event);
    } else throw new Error('This WASM session adapter supports NAC1 ops 1..5 only');
  }
  host.destroy(h);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
