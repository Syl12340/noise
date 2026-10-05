'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { runtime } = require('./runtime.cjs');
const { analyzePcm, validateParameters, validateCaptureLength } = require('../utils/phonetic/analysis');
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
  m.setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId(),source:'advanced-1khz-calibration',
    evidence:{referenceInstrument:'Class 1',inputChain:'external mic',uncertaintyDb:0.3}});
  e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();
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
    assert.throws(()=>validateParameters({maxFormant:7500}));
    await assert.rejects(analyzePcm(pcm(),0));
    const r=await analyzePcm(pcm());
    assert.ok(r.RESULT_SCHEMA_VERSION && r.ALGORITHM_VERSION);
    assert.equal(r.parameters.compareOrders,true);assert.equal(r.duration,.5);
    assert.equal(r.formantStatus.quantitativeUseValidated,false);
    assert.equal(r.formantStatus.classification,'experimental-candidates');
    assert.ok(r.coverage.pitchAccepted>0);assert.ok(r.formantTracks.every(t=>t.reason||t.quality));
  });
  await test('Speech capture accepts recorder stop overrun within the declared tolerance',()=>{
    assert.equal(validateCaptureLength(Math.round(5.1*44100),44100),true);
    assert.equal(validateCaptureLength(Math.round(5.25*44100),44100),true);
    assert.equal(validateCaptureLength(Math.round(5.251*44100),44100),false);
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
    m.setOffset(100,{source:'advanced-1khz-calibration',evidence:{referenceInstrument:'Class 1',inputChain:'external mic',uncertaintyDb:0.3}});assert.equal(m.getOffsetStatus().riskEligible,true);
    const meta=e.storage.get('offsetMeta');e.storage.set('offsetMeta',{...meta,installationId:'install-other'});
    assert.equal(m.getOffsetStatus().valid,false);
    e.storage.set('offsetMeta',{...meta,validUntil:0});assert.equal(m.getOffsetStatus().valid,false);
    m.setOffset(100,{calibratedAt:1000,validUntil:1500});assert.equal(e.storage.get('offsetMeta').validUntil,1500);
  });
  await test('Frozen stopped summary remains saveable after input timeout',()=>{
    const e=calibratedMain();assert.equal(e.page.archive().dataQuality,'pending');
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
    const valid=normalize([{cne:40,threat:'安全',dataQuality:'valid',calibrationGrade:'reference',algorithmVersion:require('../utils/measurement-version').ALGORITHM_VERSION}])[0];
    assert.equal(valid.threatColorClass,'bg-safe');assert.equal(valid.threatDisplay,'安全');
  });
  await test('Selecting a range clears old point values and exposes coverage',()=>{
    const e=runtime({},(f,c)=>f==='pages/phonetic/phonetic.js'?c+'\nmodule.exports.inject=(r)=>{analysisResult=r;};':c);
    const mod=e.load('pages/phonetic/phonetic.js');e.page.data.f0='200';e.page.data.f1='500';
    mod.inject({pitchTrack:[{time:.2,f0:200},{time:.3,f0:0}],intensityTrack:[],formantTracks:[]});
    e.page.computeSelectionStats(.1,.4);
    assert.equal(e.page.data.f0,'--');assert.equal(e.page.data.f1,'--');
    assert.equal(e.page.data.selMeanF0,'200.0');assert.ok(e.page.data.selectionCoverage.includes('1/未记录'));
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
  await test('YIN rejects a single transient with unsupported comparison windows',()=>{
    const x=new Float32Array(12000);x[6000]=.5;
    const rows=yinPitchTrack(x,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200});
    assert.equal(rows.filter(row=>row.f0>0).length,0);
  });
  await test('Low-periodicity HNR is missing instead of reporting maximum-noise-peak bias',()=>{
    const noisy=(snr)=>{
      let state=1;
      const uniform=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)+.5)/2**32;
      const gaussian=()=>{let u=uniform(),v=uniform();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
      const x=tone(200,12000,12000),sigma=.1/Math.sqrt(2)*10**(-snr/20);
      for(let i=0;i<x.length;i++)x[i]+=sigma*gaussian();
      return estimateHarmonicity(x,12000);
    };
    assert.equal(noisy(-20).avgHNR,null);
    assert.equal(noisy(-10).avgHNR,null);
    assert.ok(Number.isFinite(noisy(10).avgHNR));
  });
  await test('Formant ceiling changes the fitted signal bandwidth and rate',async()=>{
    const input=pcm(200,44100,22050);
    const low=await analyzePcm(input,44100,{parameters:{maxFormant:4000}});
    const high=await analyzePcm(input,44100,{parameters:{maxFormant:5000}});
    assert.equal(low.parameters.formantAnalysisRate,10000);
    assert.equal(high.parameters.formantAnalysisRate,12000);
    assert.equal(low.parameters.effectiveFormantOrder,10);
    assert.equal(high.parameters.effectiveFormantOrder,12);
    assert.notEqual(low.parameters.formantAnalysisRate,high.parameters.formantAnalysisRate);
  });
  await test('Main stop includes a final native PCM block before freezing the snapshot',()=>{
    const e=calibratedMain(),before=e.page.archive().sampleCount;
    const tail=pcm(1000,44100,4096);
    e.recorder.stop=function(){if(!this.running)return; e.emit('FrameRecorded',{frameBuffer:tail.buffer});this.running=false;e.emit('Stop',{duration:Math.round((before+tail.length)/44100*1000)});};
    e.page.stopNoiseMonitoring();
    assert.equal(e.page._completedSnapshot.sampleCount,before+tail.length);
    assert.equal(e.page.data.recordingState,'stopped');
  });
  await test('Sparse callbacks cannot masquerade as continuous main or phonetic capture',()=>{
    const main=runtime(),s=main.load('utils/recorder-session'),m=main.load('utils/data-model');
    m.setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()});
    main.storage.set('alarm',false);main.load('pages/main/main.js');main.page.onShow();main.clock.tick(50);
    for(let i=0;i<5;i++){main.clock.tick(1000);main.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});}
    assert.equal(main.page.archive().dataQuality,'pending');
    main.page.stopNoiseMonitoring();
    assert.equal(main.page.archive().dataQuality,'partial');
    assert.equal(main.page.archive().measurementScope,'received-audio');
    assert.ok(main.page.archive().coverage.captureCoverageRatio<.3);

    const speech=runtime();speech.load('pages/phonetic/phonetic.js');speech.page.startRecording();
    speech.emit('FrameRecorded',{frameBuffer:pcm(200,44100,8192).buffer});
    speech.clock.tick(3000);speech.page.stopRecording();
    assert.equal(speech.page.data.state,'analyzing');
    assert.ok(speech.page.data.captureNote.includes('仅分析已接收片段'));
    speech.page.resetToIdle();
  });
  await test('Advanced calibration rejects malformed PCM and cannot later certify the session',()=>{
    const e=runtime();e.load('pages/advanced-calibrate/calibrate/calibrate.js');
    e.page.onShow();e.page.startCalibrationProcess();e.clock.tick(3000);
    assert.doesNotThrow(()=>e.emit('FrameRecorded',{frameBuffer:new ArrayBuffer(3)}));
    for(let block=0;block<27;block++){
      const data=Int16Array.from({length:8192},(_,i)=>Math.round(3276.8*Math.sin(2*Math.PI*1000*(block*8192+i)/44100)));
      e.emit('FrameRecorded',{frameBuffer:data.buffer});
    }
    assert.equal(e.page.data.newOffset,'--');assert.equal(e.modals.length,0);
  });
  await test('Stale advanced calibration confirmation cannot overwrite a newer offset',()=>{
    const e=runtime(),m=e.load('utils/data-model');e.load('pages/advanced-calibrate/calibrate/calibrate.js');
    e.page.onShow();e.page.startCalibrationProcess();e.clock.tick(3000);
    for(let block=0;block<27;block++){
      const data=Int16Array.from({length:8192},(_,i)=>Math.round(3276.8*Math.sin(2*Math.PI*1000*(block*8192+i)/44100)));
      e.emit('FrameRecorded',{frameBuffer:data.buffer});
    }
    assert.equal(e.modals.length,1);const modal=e.modals[0];e.page.onHide();
    m.setOffset(115,{source:'manual-settings'});modal.success({confirm:true});
    assert.equal(m.getOffset(),115);
  });
  await test('Settings reset persists the displayed default offset',()=>{
    const e=runtime(),s=e.load('utils/recorder-session'),m=e.load('utils/data-model');
    m.setOffset(115,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId(),source:'advanced-1khz-calibration'});
    e.load('pages/settings/settings.js');e.page.onShow();e.page.reset();e.page.save();
    assert.equal(e.page.data.offset,100);assert.equal(m.getOffset(),100);
  });
  await test('Quantitative monitoring suppresses haptic contamination and owns vibration timers',()=>{
    const e=calibratedMain();let vibrations=0;e.wx.vibrateLong=()=>vibrations++;
    assert.equal(e.page.doVibrate(5,500),false);e.clock.tick(2500);assert.equal(vibrations,0);
    e.page.onHide();assert.equal(e.page.doVibrate(5,500),true);assert.equal(vibrations,1);
    e.page.stopMainMonitoring();e.clock.tick(2500);assert.equal(vibrations,1);
  });
  await test('Production preprocessing never turns isolated clicks into voiced pitch',async()=>{
    for(const position of [1,8191,22049,22050,22051,44098]) {
      for(const amplitude of [4096,16384,-16384]) {
        const input=new Int16Array(44100);input[position]=amplitude;
        const r=await analyzePcm(input);
        assert.equal(r.pitchTrack.filter(t=>t.f0>0).length,0,`click ${position}/${amplitude}`);
      }
    }
    for(const noise of [1,3,33]) {
      let seed=1;
      const input=Int16Array.from({length:44100},()=>{
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        return Math.round(noise*(2*seed/2**32-1));
      });
      input[22050]=16384;
      assert.equal((await analyzePcm(input)).pitchTrack.filter(t=>t.f0>0).length,0);
    }
  });
  await test('Conservative pitch confidence retains short periodic bursts',async()=>{
    const input=new Int16Array(44100);
    for(let i=0;i<1323;i++)input[22050+i]=Math.round(3276.8*Math.sin(2*Math.PI*200*i/44100));
    const voiced=(await analyzePcm(input)).pitchTrack.filter(t=>t.f0>0);
    assert.ok(voiced.length>0);
    assert.ok(voiced.every(t=>Math.abs(t.f0-200)<2));
  });
  await test('Live and stopping previews cannot be saved or return to recording',()=>{
    const e=calibratedMain();
    assert.equal(e.page.data.canSave,false);assert.equal(e.page.archive().dataQuality,'pending');
    e.page.saveResult();assert.equal(e.saved.length,0);
    e.recorder.stop=function(){};e.page.stopNoiseMonitoring();
    e.clock.tick(8192/44100*1000);e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});
    assert.equal(e.page.data.recordingState,'stopping');assert.equal(e.page.data.canSave,false);
    e.page.saveResult();assert.equal(e.saved.length,0);
    e.emit('Stop',{duration:Math.round(7*8192/44100*1000)});
    assert.equal(e.page.archive().dataQuality,'valid');assert.equal(e.page.data.canSave,true);
  });
  await test('Missing loud blocks cannot certify a result biased by over 10 dB',()=>{
    function capture(drop) {
      const e=runtime(),s=e.load('utils/recorder-session'),m=e.load('utils/data-model');
      m.setOffset(100,{source:'advanced-1khz-calibration',captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()});
      e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();
      for(let block=0;block<30;block++) {
        e.clock.tick(8192/44100*1000);
        const loud=block>=12&&block<=14;
        if(drop&&loud)continue;
        const input=Int16Array.from({length:8192},(_,i)=>Math.round((loud?3276.8:327.68)*Math.sin(2*Math.PI*1000*(block*8192+i)/44100)));
        e.emit('FrameRecorded',{frameBuffer:input.buffer});
      }
      e.page.stopNoiseMonitoring();return e;
    }
    const reference=capture(false),dropped=capture(true),a=reference.page.archive(),b=dropped.page.archive();
    const level=r=>10*Math.log10(r.aWeightedEnergy/r.sampleCount)+100;
    assert.ok(level(a)-level(b)>10);
    assert.equal(a.dataQuality,'valid');assert.equal(b.dataQuality,'partial');
    assert.equal(b.measurementScope,'received-audio');assert.ok(Number.isFinite(b.leqA));
    assert.equal(dropped.page.data.threatClass,'detail-init');assert.ok(b.threat.includes('片段'));
    assert.ok(b.coverage.sampleDelta< -24000);assert.equal(dropped.page.data.canSave,true);
    dropped.page.saveResult();assert.equal(dropped.saved.length,1);assert.equal(dropped.saved[0].dataQuality,'partial');
  });
  await test('Unknown native duration and known mismatches save distinct noncertified records',()=>{
    for(const deltaMs of [null,NaN,Infinity,0,5,-5,20,-20]) {
      const e=calibratedMain(),duration=e.page.archive().sampleCount/44100*1000;
      e.recorder.stop=function(){this.running=false;e.emit('Stop',deltaMs===null?{}:{duration:deltaMs===0?0:duration+deltaMs});};
      e.page.stopNoiseMonitoring();const unknown=deltaMs===null||!Number.isFinite(deltaMs)||deltaMs===0;
      assert.equal(e.page.archive().dataQuality,unknown?'unverified':'partial',String(deltaMs));
      assert.equal(e.page.archive().measurementScope,'received-audio');
      assert.equal(e.page.data.canSave,true);assert.equal(e.page.data.threatClass,'detail-init');
      e.page.saveResult();assert.equal(e.saved.length,1);
    }
  });
  await test('Complete batches tolerate callback jitter and delayed stop acknowledgement',()=>{
    const e=calibratedMain(),samples=e.page.archive().sampleCount;
    // No new native audio: JS callback wall time alone must not invalidate the final duration match.
    e.clock.tick(600);e.recorder.stop=function(){};e.page.stopNoiseMonitoring();e.clock.tick(1800);
    e.emit('Stop',{duration:Math.floor(samples/44100*1000)});
    assert.equal(e.page.archive().dataQuality,'valid');assert.equal(e.page.data.canSave,true);
    const snapshot=e.page.archive();e.clock.tick(10000);assert.equal(e.page.archive(),snapshot);
  });
  await test('Missing stop acknowledgement fails closed and late callback cannot revive result',()=>{
    const e=calibratedMain();e.recorder.stop=function(){};e.page.stopNoiseMonitoring();e.clock.tick(2250);
    assert.equal(e.page.archive().dataQuality,'invalid');assert.equal(e.page.data.canSave,false);
    e.emit('Stop',{duration:Math.round(6*8192/44100*1000)});
    assert.equal(e.page.archive().dataQuality,'invalid');
  });
  await test('Loud tail updates final risk, colour and levels from the same frozen snapshot',()=>{
    const e=runtime(),s=e.load('utils/recorder-session'),m=e.load('utils/data-model');
    m.setOffset(115,{source:'advanced-1khz-calibration',captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId(),
      evidence:{referenceInstrument:'Class 1',inputChain:'external mic',uncertaintyDb:0.3}});
    e.storage.set('alarm',false);e.storage.set('expectedExposure',8);
    e.load('pages/main/main.js');e.page.onShow();
    for(let block=0;block<6;block++) {
      e.clock.tick(8192/44100*1000);
      e.emit('FrameRecorded',{frameBuffer:Int16Array.from({length:8192},(_,i)=>Math.round(327.68*Math.sin(2*Math.PI*1000*(block*8192+i)/44100))).buffer});
    }
    assert.ok(e.page.data.threat.includes('安全'));assert.notEqual(e.page.data.threatClass,'detail-safe');
    e.recorder.stop=function(){
      const tail=Int16Array.from({length:4096},(_,i)=>Math.round(16384*Math.sin(2*Math.PI*1000*(6*8192+i)/44100)));
      e.emit('FrameRecorded',{frameBuffer:tail.buffer});this.running=false;
      e.emit('Stop',{duration:Math.round((6*8192+4096)/44100*1000)});
    };
    e.page.stopNoiseMonitoring();const result=e.page.archive();
    assert.equal(result.dataQuality,'valid');assert.ok(result.cneUnrounded>90);
    assert.equal(e.page.data.threat,result.threat);assert.equal(e.page.data.threatClass,result.threatClass);
    assert.notEqual(result.threat,'安全');assert.notEqual(result.threatClass,'detail-safe');
    assert.ok(Number(e.page.data.dbspl)>100);assert.equal(Number(e.page.data.cne),Number(result.cne.toFixed(1)));
    e.page.saveResult();assert.equal(e.saved[0].threat,e.page.data.threat);
  });
  await test('Main waits for a delayed first frame without applying the running-stream timeout',()=>{
    const e=runtime(),s=e.load('utils/recorder-session'),m=e.load('utils/data-model');
    m.setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()});
    e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();e.clock.tick(3000);
    assert.notEqual(e.page.data.recordingState,'invalid');assert.equal(e.recorder.running,true);
    e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});
    assert.equal(e.page.data.recordingState,'recording');
    e.clock.tick(2250);assert.equal(e.page.data.recordingState,'recording');
    assert.ok(e.page.data.recordingLabel.includes('交付延迟'));
    e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});
    e.page.stopNoiseMonitoring();assert.equal(e.page.data.recordingState,'stopped');
  });
  await test('Historical numeric results remain visible with an old-algorithm label',()=>{
    const e=runtime({},(file,code)=>file==='pages/result/result.js'
      ? code+'\nmodule.exports = { normalizeRecordsForDisplay };' : code);
    const {normalizeRecordsForDisplay}=e.load('pages/result/result.js');
    const records=normalizeRecordsForDisplay([
      {cne:81.25,threat:'需要注意'},
      {cne:'82.50',algorithmVersion:'old',threat:'需要注意'},
      {cne:95,algorithmVersion:'old',dataQuality:'invalid',threat:'高风险'},
      {cne:80,algorithmVersion:'old',dataQuality:'pending'},
      {cne:'',algorithmVersion:'old'},
    ]);
    assert.equal(records[0].cneDisplay,'81.25');assert.equal(records[1].cneDisplay,'82.50');
    assert.ok(records[0].comparisonNote.includes('过时算法'));
    assert.ok(records[1].threatDisplay.includes('历史结果'));
    assert.equal(records[2].cneDisplay,'--');assert.equal(records[3].cneDisplay,'--');assert.equal(records[4].cneDisplay,'--');
  });
  await test('Native startup can await microphone authorization beyond two seconds',()=>{
    const e=runtime(),s=e.load('utils/recorder-session');
    e.recorder.start=function(){this.running=true;this.starts++;this.startedAt=e.context.Date.now();};
    e.load('pages/main/main.js');e.page.onShow();e.clock.tick(3000);
    assert.equal(e.recorder.running,true);assert.notEqual(e.page.data.recordingState,'invalid');
    e.emit('Start',{});e.clock.tick(2500);
    assert.notEqual(e.page.data.recordingState,'invalid');
    e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});
    assert.equal(e.page.data.recordingState,'recording');e.page.onHide();
    assert.equal(e.recorder.running,false);assert.equal(e.timers.size,0);
  });
  await test('Historical laboratory presets stay usable without rebinding or expiry gates',()=>{
    const e=runtime(),m=e.load('utils/data-model');
    m.setOffset(103.123456,{source:'laboratory-preset',captureProfile:'old-profile',deviceId:'old-device',calibratedAt:1000,validUntil:2000});
    const meta={...e.storage.get('offsetMeta'),installationId:'previous-installation'};
    e.storage.set('offsetMeta',meta);const before=JSON.stringify(meta);
    e.storage.delete('offsetValid'); // 兼容尚未写入新版有效标记的实验室历史参数。
    const status=m.getOffsetStatus({captureProfile:'current-profile',deviceId:'unknown-device'});
    assert.equal(status.valid,true);assert.equal(status.laboratoryPreset,true);
    assert.equal(status.offset,103.123456);assert.ok(status.label.includes('实验室'));
    assert.equal(JSON.stringify(e.storage.get('offsetMeta')),before);
    e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();
    for(let i=0;i<6;i++){e.clock.tick(8192/44100*1000);e.emit('FrameRecorded',{frameBuffer:pcm(1000,44100,8192).buffer});}
    e.page.stopNoiseMonitoring();e.page.saveResult();
    assert.equal(e.saved.length,1);assert.equal(e.saved[0].calibration.source,'laboratory-preset');
    assert.ok(e.page.data.calibrationLabel.includes('实验室'));assert.equal(e.page.data.calibrationDateLabel,'参数记录日期');
  });
  await test('Discontinuous joins reset DSP and exclude every crossing dependent window',async()=>{
    const boundary=.5,r=await analyzePcm(pcm(200,44100,44100),44100,{discontinuityBoundariesSeconds:[boundary]});
    const crosses=row=>row.support&&row.support.start<boundary&&row.support.end>boundary;
    const pitch=r.pitchTrack.filter(crosses),formants=r.formantTracks.filter(crosses),hnr=r.harmonicity.track.filter(crosses);
    assert.equal(r.parameters.discontinuityPolicy,'segment-before-dsp');
    assert.equal(r.analysisSegments.length,2);
    assert.ok(pitch.every(row=>row.f0===0&&row.reason==='capture-gap-boundary'));
    assert.ok(formants.every(row=>['F1','F2','F3'].every(key=>row[key].freq===0)&&row.reason==='capture-gap-boundary'));
    assert.ok(hnr.every(row=>row.db===null&&row.reason==='capture-gap-boundary'));
    assert.ok(Array.from(r.spectrogram.times).every(time=>Math.abs(time-boundary)>=.005/2));
    assert.equal(r.jitter,null);
  });
  const files=['utils/phonetic/analysis.js','utils/phonetic/formant-extract.js','utils/phonetic/yin-pitch.js',
    'utils/phonetic/harmonicity.js','utils/recorder-session.js','utils/data-model.js',
    'pages/main/main.js','pages/phonetic/phonetic.js','pages/settings/settings.js',
    'pages/advanced-calibrate/calibrate/calibrate.js',
    'pages/result/result.js','pages/main/main.wxml','workers/phonetic-analysis/index.js',
    'workers/phonetic-analysis/bundle.js','tests/revision-regression.cjs','tests/runtime.cjs'];
  const report={generatedAt:new Date().toISOString(),summary:{total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length},
    sourceSha256:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',f))).digest('hex')])),results};
  fs.writeFileSync(path.resolve(__dirname,'../docs/revision-regression-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));for(const r of results.filter(r=>r.status==='FAIL'))console.log(r.name,r.error);
  process.exitCode=report.summary.failed?1:0;
})();
