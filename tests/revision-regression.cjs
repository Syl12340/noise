'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { runtime } = require('./runtime.cjs');
const { analyzePcm, validateParameters } = require('../utils/phonetic/analysis');
const { yinPitchFrame, yinPitchTrack, yinPitchTrackAsync } = require('../utils/phonetic/yin-pitch');
const { formantTrack, formantTrackAsync, extractFormantsFromLPC } = require('../utils/phonetic/formant-extract');
const { resampleLowPass, resampleLowPassAsync } = require('../utils/phonetic/resample');
const { estimateHarmonicity, estimateHarmonicityAsync } = require('../utils/phonetic/harmonicity');
const { generateSpectrogram, generateSpectrogramAsync } = require('../utils/phonetic/spectrogram-gen');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
}
const tone = (f, rate, n) => Float64Array.from({length:n}, (_,i) => .1*Math.sin(2*Math.PI*f*i/rate));
const pcm = (f=200, rate=44100, n=22050) => Int16Array.from(tone(f,rate,n),x=>Math.round(x*32768));
function polynomial(poles) {
  let a=[1];
  for(const [f,bw] of poles) {
    const r=Math.exp(-Math.PI*bw/12000), b=[1,-2*r*Math.cos(2*Math.PI*f/12000),r*r], c=Array(a.length+2).fill(0);
    a.forEach((v,i)=>b.forEach((w,j)=>{c[i+j]+=v*w;}));a=c;
  }
  return Float64Array.from(a);
}
function calibratedMain() {
  const e=runtime(), s=e.load('utils/recorder-session'), m=e.load('utils/data-model');
  m.setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()});
  e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();e.clock.tick(50);
  for(let i=0;i<6;i++){e.clock.tick(8192/44100*1000);e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});}
  return e;
}
(async()=>{
  await test('Broad true pole retains ordinal slots',()=>{
    const r=extractFormantsFromLPC(polynomial([[700,600],[1000,120],[2500,180]]),12000);
    assert.equal(r.F1.freq,0);assert.equal(r.F2.freq,1000);assert.equal(r.F3.freq,2500);
    assert.equal(r._candidates.length,3);assert.equal(r._candidates[0].freq,700);
  });
  await test('Upper boundary never clamped into an accepted 1200 Hz',()=>{
    for(const f of [1200.5,1201,1205]) {
      const x=Float64Array.from({length:1024},(_,i)=>[1,.5,.3].reduce((s,a,k)=>s+a*Math.sin(2*Math.PI*f*(k+1)*i/12000),0));
      const r=yinPitchFrame(x,12000,.1,40,1200);
      assert.equal(r.f0,0);assert.ok(r.rawF0>1200);assert.ok(r.reason);
    }
  });
  await test('Sync/async numerical equality across all long stages',async()=>{
    const x=tone(200,12000,3600),opts={frameSize:1024,hopSize:120,fmin:40,fmax:1200};
    const p=yinPitchTrack(x,12000,opts);assert.deepEqual(await yinPitchTrackAsync(x,12000,opts),p);
    assert.deepEqual(await resampleLowPassAsync(x,12000,12000,5500),resampleLowPass(x,12000,12000,5500));
    assert.deepEqual(await estimateHarmonicityAsync(x,12000,opts),estimateHarmonicity(x,12000,opts));
    assert.deepEqual(await formantTrackAsync(x,12000,{pitchTrack:p}),formantTrack(x,12000,{pitchTrack:p}));
    assert.deepEqual(await generateSpectrogramAsync(x,12000),generateSpectrogram(x,12000));
  });
  await test('Cancellation can interrupt within pitch tracking',async()=>{
    let cancelled=false,completed=false;
    const promise=yinPitchTrackAsync(tone(180,12000,60000),12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200,isCancelled:()=>cancelled});
    setTimeout(()=>{cancelled=true;},0);
    await assert.rejects(promise.then(()=>{completed=true;}),{name:'AbortError'});assert.equal(completed,false);
  });
  await test('Shared analysis rejects invalid parameters and preserves metadata',async()=>{
    assert.throws(()=>validateParameters({lpcOrder:11}));
    assert.throws(()=>validateParameters({maxFormant:8000}));
    await assert.rejects(analyzePcm(pcm(),0));
    const r=await analyzePcm(pcm());
    assert.ok(r.RESULT_SCHEMA_VERSION && r.ALGORITHM_VERSION);
    assert.equal(r.parameters.compareOrders,true);assert.equal(r.duration,.5);
    assert.equal(r.formantStatus.quantitativeUseValidated,false);
    assert.equal(r.formantStatus.classification,'experimental-candidates');
    assert.ok(r.coverage.pitchAccepted>0);assert.ok(r.formantTracks.every(t=>t.reason||t.quality));
  });
  await test('Worker and foreground return identical full results',async()=>{
    const vm=require('node:vm');let listener,resolveResult,rejectResult;
    const completed=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
    const worker={onMessage:f=>{listener=f;},postMessage:m=>{if(m.type==='result')resolveResult(m);if(m.type==='error')rejectResult(Error(m.message));}};
    const filename=path.resolve(__dirname,'../workers/phonetic-analysis/index.js');
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{worker,Int16Array,require:s=>require(path.resolve(path.dirname(filename),s))});
    const input=pcm();listener({type:'analyze',id:3,pcm:input,sampleRate:44100});
    const actual=await completed,expected=await analyzePcm(input);delete actual.type;delete actual.id;
    assert.equal(JSON.stringify(actual),JSON.stringify(expected));
  });
  await test('Native stop acknowledgement precedes next start',()=>{
    const e=runtime(),s=e.load('utils/recorder-session');let framesA=0,framesB=0;
    s.bindRecorderFrameListener(e.recorder,()=>framesA++);s.safeStartRecorder(e.recorder,{});
    e.emit('FrameRecorded',{});assert.equal(framesA,1);
    e.recorder.stop=function(){this.running=false;}; // Stop acknowledgement is deliberately delayed.
    s.bindRecorderFrameListener(e.recorder,()=>framesB++);s.safeStartRecorder(e.recorder,{});
    e.clock.tick(500);assert.equal(e.recorder.starts,1);
    e.emit('FrameRecorded',{});assert.equal(framesB,0);
    e.emit('Stop',{});e.clock.tick(0);assert.equal(e.recorder.starts,2);
    e.emit('FrameRecorded',{});assert.equal(framesA,1);assert.equal(framesB,1);
  });
  await test('Stale callbacks are inert without native offFrameRecorded',()=>{
    const e=runtime(),s=e.load('utils/recorder-session');delete e.recorder.offFrameRecorded;
    let a=0,b=0;s.bindRecorderFrameListener(e.recorder,()=>a++);s.safeStartRecorder(e.recorder,{});
    e.emit('FrameRecorded',{});s.safeStopRecorder(e.recorder);
    s.bindRecorderFrameListener(e.recorder,()=>b++);s.safeStartRecorder(e.recorder,{});
    e.emit('FrameRecorded',{});assert.equal(a,1);assert.equal(b,1);
    s.clearRecorderFrameListener(e.recorder);e.emit('FrameRecorded',{});assert.equal(b,1);
  });
  await test('Cancelling pending start prevents restart on late stop',()=>{
    const e=runtime(),s=e.load('utils/recorder-session');s.safeStartRecorder(e.recorder,{});
    e.recorder.stop=()=>{};s.safeStartRecorder(e.recorder,{});s.cancelRecorderStart(e.recorder);
    e.emit('Stop',{});e.clock.tick(0);assert.equal(e.recorder.starts,1);assert.equal(e.timers.size,0);
  });
  await test('Calibration grades, installation binding and expiry are enforced',()=>{
    const e=runtime(),m=e.load('utils/data-model');
    m.setOffset(100);assert.equal(m.getOffsetStatus().riskEligible,false);
    m.setOffset(100,{source:'advanced-1khz-calibration'});assert.equal(m.getOffsetStatus().riskEligible,true);
    const meta=e.storage.get('offsetMeta');e.storage.set('offsetMeta',{...meta,installationId:'install-other'});
    assert.equal(m.getOffsetStatus().valid,false);
    e.storage.set('offsetMeta',{...meta,validUntil:0});assert.equal(m.getOffsetStatus().valid,false);
    m.setOffset(100,{calibratedAt:1000,validUntil:1500});assert.equal(e.storage.get('offsetMeta').validUntil,1500);
  });
  await test('Frozen stopped summary remains saveable after input timeout',()=>{
    const e=calibratedMain();assert.equal(e.page.archive().dataQuality,'valid');
    e.page.stopNoiseMonitoring();assert.equal(e.page.data.recordingState,'stopped');
    const before=e.page._completedSnapshot;e.clock.tick(10000);e.page.saveResult();
    assert.equal(e.saved.length,1);assert.equal(e.saved[0].sampleCount,before.sampleCount);
    assert.equal(e.saved[0].dataQuality,'valid');assert.equal(e.page.data.canSave,false);
    assert.ok(e.saved[0].algorithmVersion);assert.equal(e.saved[0].schemaVersion,2);
    assert.ok(Number.isFinite(e.saved[0].aWeightedEnergy));
  });
  await test('Restart discards stopped snapshot and disables saving until new input',()=>{
    const e=calibratedMain();e.page.stopNoiseMonitoring();e.page.restartMeasurement();e.clock.tick(0);
    assert.equal(e.page._completedSnapshot,null);assert.equal(e.page.data.canSave,false);
    e.page.saveResult();assert.equal(e.saved.length,0);
  });
  await test('Invalid and legacy records never receive safe colors',()=>{
    const e=runtime({},(f,c)=>f==='pages/result/result.js'?c+'\nmodule.exports.normalize=normalizeRecordsForDisplay;':c);
    const {normalize}=e.load('pages/result/result.js');
    const rows=normalize([null,{cne:null,threat:'安全',dataQuality:'invalid'},{cne:40,threat:'安全'},
      {cne:40,threat:'安全',dataQuality:'valid',calibrationGrade:'estimated'},
      {cne:40,threat:'nonsense',dataQuality:'valid',calibrationGrade:'reference'}]);
    for(const row of rows){assert.notEqual(row.threatColorClass,'bg-safe');assert.notEqual(row.threatDisplay,'安全');}
    const valid=normalize([{cne:40,threat:'安全',dataQuality:'valid',calibrationGrade:'reference'}])[0];
    assert.equal(valid.threatColorClass,'bg-safe');assert.equal(valid.threatDisplay,'安全');
  });
  await test('Selecting a range clears old point values and exposes coverage',()=>{
    const e=runtime({},(f,c)=>f==='pages/phonetic/phonetic.js'?c+'\nmodule.exports.inject=(r)=>{analysisResult=r;};':c);
    const mod=e.load('pages/phonetic/phonetic.js');e.page.data.f0='200';e.page.data.f1='500';
    mod.inject({pitchTrack:[{time:.2,f0:200},{time:.3,f0:0}],intensityTrack:[],formantTracks:[]});
    e.page.computeSelectionStats(.1,.4);
    assert.equal(e.page.data.f0,'--');assert.equal(e.page.data.f1,'--');
    assert.equal(e.page.data.selMeanF0,'200.0');assert.ok(e.page.data.selectionCoverage.includes('1/2'));
  });
  await test('Phonetic recorder can retry a synchronous native start error',()=>{
    const e=runtime();e.load('pages/phonetic/phonetic.js');
    const start=e.recorder.start;e.recorder.start=()=>e.emit('Error',{errMsg:'permission'});
    e.page.startRecording();assert.equal(e.page.data.state,'idle');assert.equal(e.timers.size,0);
    e.recorder.start=start;e.page.startRecording();assert.equal(e.page.data.state,'recording');
    e.page.cleanup();assert.equal(e.timers.size,0);
  });
  await test('Risk color belongs to projected exposure, not current Z level',()=>{
    const xml=fs.readFileSync(path.resolve(__dirname,'../pages/main/main.wxml'),'utf8');
    assert.ok(!/dashboard \{\{threatClass\}\}/.test(xml));
    assert.ok(/status-pill \{\{threatClass\}\}/.test(xml));
    assert.ok(xml.includes('当前短时 Z 计权'));
    assert.ok(xml.includes('预计暴露级（归一至 8 小时）'));
  });
  await test('Order-specific broad root does not displace stable higher formants',()=>{
    const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:(_frame,order)=>({a:polynomial(
      order===12 ? [[500,80],[1100,1200],[1500,120],[2500,180]]
        : [[500,80],[1500,120],[2500,180]]
    )})}});
    const signal=new Float64Array(300),pitchTrack=[{time:.0125,f0:100,aperiodicity:0}];
    const row=env.load('utils/phonetic/formant-extract.js').formantTrack(signal,12000,{pitchTrack})[0];
    assert.deepEqual([row.F1.freq,row.F2.freq,row.F3.freq],[500,1500,2500]);
    assert.equal(row.quality.F2.rawOrdinal,3);
    assert.equal(row.quality.F2.skippedCandidates.length,1);
  });
  await test('Cross-order broad root retains its ordinal position',()=>{
    const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:()=>({a:polynomial(
      [[700,600],[1000,120],[2500,180]]
    )})}});
    const signal=new Float64Array(300),pitchTrack=[{time:.0125,f0:100,aperiodicity:0}];
    const row=env.load('utils/phonetic/formant-extract.js').formantTrack(signal,12000,{pitchTrack})[0];
    assert.deepEqual([row.F1.freq,row.F2.freq,row.F3.freq],[0,1000,2500]);
    assert.equal(row.quality.F1.reason,'wide-bandwidth');
  });
  await test('Narrow pole matches by radius as well as frequency',()=>{
    const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:(_frame,order)=>({a:polynomial(
      order===10 ? [[500,80],[1500,120],[2490,2700],[2510,280]]
        : [[500,80],[1500,120],[2500,100]]
    )})}});
    const row=env.load('utils/phonetic/formant-extract.js').formantTrack(new Float64Array(300),12000,
      {pitchTrack:[{time:.0125,f0:100,aperiodicity:0}]})[0];
    assert.equal(row.F3.freq,2500);assert.equal(row.quality.F3.reason,'accepted');
  });
  await test('Track continuity cannot substitute a different ordinal',()=>{
    let frame=0;
    const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:()=>({a:polynomial(
      frame++<4 ? [[500,80],[1500,120],[2500,180]] : [[500,80],[2300,120],[3200,180]]
    )})}});
    const rows=env.load('utils/phonetic/formant-extract.js').formantTrack(new Float64Array(300+11*120),12000,
      {compareOrders:false,pitchTrack:Array.from({length:12},(_,i)=>({time:(i*120+150)/12000,f0:100,aperiodicity:0}))});
    assert.ok(rows.slice(4).every(row=>row.F3.freq!==2300));
    assert.ok(rows.slice(6).every(row=>row.F2.freq===2300&&row.F3.freq===3200));
  });
  await test('Leaving phonetic page cancels before delayed native stop',()=>{
    const e=runtime();e.load('pages/phonetic/phonetic.js');const page=e.page;
    page.startRecording();e.recorder.stop=()=>{};let completed=0;
    page.onRecordingComplete=()=>{completed++;};page.onHide();
    e.emit('Stop',{});e.clock.tick(0);
    assert.equal(page.data.state,'idle');assert.equal(completed,0);assert.equal(e.timers.size,0);
  });
  await test('Malformed PCM invalidates a live measurement without throwing',()=>{
    const e=calibratedMain();
    assert.doesNotThrow(()=>e.emit('FrameRecorded',{frameBuffer:new ArrayBuffer(3)}));
    assert.equal(e.page.data.recordingState,'invalid');e.page.saveResult();assert.equal(e.saved.length,0);
  });
  await test('Partial model evidence cannot erase a broad ordinal',()=>{
    const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:(_frame,order)=>({a:polynomial(
      order===14 ? [[500,80],[2500,180]]
        : [[500,80],[1500,700],[2500,180]]
    )})}});
    const row=env.load('utils/phonetic/formant-extract.js').formantTrack(new Float64Array(300),12000,
      {pitchTrack:[{time:.0125,f0:100,aperiodicity:0}]})[0];
    assert.equal(row.F2.freq,0);assert.equal(row.F3.freq,0);
    assert.equal(row.quality.F2.rawOrdinal,2);
    assert.equal(row.quality.F3.reason,'ambiguous-numbering');
  });
  const files=['utils/phonetic/analysis.js','utils/phonetic/formant-extract.js','utils/phonetic/yin-pitch.js',
    'utils/recorder-session.js','utils/data-model.js','pages/main/main.js','pages/phonetic/phonetic.js',
    'pages/result/result.js','pages/main/main.wxml','workers/phonetic-analysis/index.js',
    'workers/phonetic-analysis/bundle.js','tests/revision-regression.cjs','tests/runtime.cjs'];
  const report={generatedAt:new Date().toISOString(),summary:{total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length},
    sourceSha256:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',f))).digest('hex')])),results};
  fs.writeFileSync(path.resolve(__dirname,'../docs/revision-regression-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));for(const r of results.filter(r=>r.status==='FAIL'))console.log(r.name,r.error);
  process.exitCode=report.summary.failed?1:0;
})();
