'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline'),dir=path.join(root,'phase5/reference');
if(fs.existsSync(path.join(dir,'manifest.json')))throw new Error('Full HNR references already frozen');fs.mkdirSync(dir,{recursive:true});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');let calls=new Map();
const bits=x=>{const b=Buffer.alloc(8);b.writeDoubleLE(x);return b.readBigUInt64LE();};
const math=Object.create(Math);math.sin=x=>{const y=Math.sin(x);calls.set(bits(x),y);return y;};
const fctx={module:{exports:{}},Math:math,Float64Array};
vm.runInNewContext(fs.readFileSync(path.join(base,'utils/phonetic/fractional-correlation.js'),'utf8'),fctx);
const hctx={module:{exports:{}},Math,Float64Array,Number,require:name=>name==='./fractional-correlation'?fctx.module.exports:name==='../fft'?require(path.join(base,'utils/fft.js')):require(path.join(base,'utils/phonetic',name+'.js'))};
vm.runInNewContext(fs.readFileSync(path.join(base,'utils/phonetic/harmonicity.js'),'utf8'),hctx);
const cfg={fs:12000,frameSize:1024,hopSize:120,fmin:40,fmax:1200,requirePitch:true,minPeakCorrelation:.2,maxPitchDeviation:.15};
const motif=Float32Array.from({length:60},(_,i)=>.25*Math.sin(2*Math.PI*i/60));
const repeated=n=>Float32Array.from({length:n},(_,i)=>motif[i%60]);
const cases=[];
function add(name,signal,extra={}) {
  const c={...cfg,...extra};
  if(c.pitchTrack===undefined)c.pitchTrack=Array.from({length:Math.max(0,Math.floor((signal.length-c.frameSize)/c.hopSize)+1)},(_,i)=>({time:(i*c.hopSize+c.frameSize/2)/c.fs,f0:200,aperiodicity:.1}));
  calls=new Map();const expected=hctx.module.exports.estimateHarmonicity(signal,c.fs,c),input=Buffer.from(signal.buffer),oracle=Buffer.alloc(calls.size*16);let i=0;
  for(const [key,value] of calls){oracle.writeBigUInt64LE(key,i*16);oracle.writeDoubleLE(value,i*16+8);i++;}
  const inp=name+'.f32le',tr=name+'.sin.bin';fs.writeFileSync(path.join(dir,inp),input);fs.writeFileSync(path.join(dir,tr),oracle);
  cases.push({name,input:inp,oracle:tr,inputSha256:sha(input),oracleSha256:sha(oracle),config:c,expected});
}
add('default-5_25s',repeated(63000));
add('detuned',Float32Array.from({length:4096},(_,i)=>.2*Math.sin(2*Math.PI*203.7*i/12000)),{pitchTrack:Array.from({length:26},(_,i)=>({time:(i*120+512)/12000,f0:203.7,aperiodicity:.1}))});
add('silence-voiced',Float32Array.from({length:4096},(_,i)=>i<1400?0:motif[i%60]),{pitchTrack:[{time:512/12000,f0:0,aperiodicity:1},{time:2000/12000,f0:200,aperiodicity:.1},{time:3500/12000,f0:200,aperiodicity:.1}]});
add('sparse-boundary',repeated(2504),{pitchTrack:[{time:512/12000-.01,f0:200,aperiodicity:.1},{time:752/12000+.01,f0:400,aperiodicity:.1},{time:1400/12000,f0:0,aperiodicity:1}]});
add('odd-grid',repeated(4096),{frameSize:521,hopSize:119,pitchTrack:Array.from({length:31},(_,i)=>({time:(i*119+260.5)/12000,f0:200,aperiodicity:.1}))});
add('no-evidence',repeated(10240),{pitchTrack:[]});
add('empty',new Float32Array());add('short',repeated(1023));
const manifest={profile:'legacy-hnr-full-session-v1',rule:'Existing exact-bits and1e-10dB rules; freeze before session comparisons',cases};
const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(dir,'manifest.json'),raw);
console.log(JSON.stringify({cases:cases.length,defaultFrames:cases[0].expected.track.length,oracleBytes:cases.reduce((n,c)=>n+fs.statSync(path.join(dir,c.oracle)).size,0),sha256:sha(raw)}));
