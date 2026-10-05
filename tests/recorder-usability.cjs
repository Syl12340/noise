'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./runtime.cjs');
const results=[];
function test(name,fn){try{fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',error:error.stack});}}
function env(options={},overrides={}){
  const e=runtime(overrides,undefined,options),s=e.load('utils/recorder-session');
  e.load('utils/data-model').setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()});
  e.storage.set('alarm',false);return e;
}
function feed(e,blocks=6){for(let b=0;b<blocks;b++){
  e.clock.tick(8192/44100*1000);
  e.emit('FrameRecorded',{frameBuffer:Int16Array.from({length:8192},(_,i)=>Math.round(3276.8*Math.sin(2*Math.PI*1000*(b*8192+i)/44100))).buffer});
}}
for(const singleListener of [false,true]){
  const options={singleListener,noOff:true},tag=singleListener?'single native listener':'multiple native listeners';
  test('Main records twice with '+tag,()=>{
    const e=env(options);e.load('pages/main/main.js');e.page.onShow();
    for(let i=0;i<2;i++){
      if(i)e.page.restartMeasurement();e.clock.tick(0);feed(e);
      assert.equal(e.page.data.recordingState,'recording');assert.equal(e.page.archive().sampleCount,49152);
      e.page.stopNoiseMonitoring();assert.equal(e.page.data.recordingState,'stopped');
    }
  });
  test('Rough calibration re-enters twice with '+tag,()=>{
    const e=env(options);e.load('pages/calibrate/calibrate.js');
    for(let i=0;i<2;i++){
      e.page.onShow();e.clock.tick(0);e.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'测试场景'}}});feed(e,11);
      assert.equal(e.page.data.canSaveCalibration,true);e.page.onHide();
    }
  });
  test('Advanced calibration completes twice with '+tag,()=>{
    const e=env(options);e.load('pages/advanced-calibrate/calibrate/calibrate.js');e.page.onShow();
    for(let i=0;i<2;i++){
      e.page.startCalibrationProcess();e.clock.tick(0);e.clock.tick(3000);feed(e,27);
      assert.ok(Number(e.page.data.newOffset)>90);assert.equal(e.modals.length,i+1);
      const modal=e.modals[i];modal.success({confirm:false});modal.complete();e.clock.tick(0);
    }
    e.page.onHide();assert.equal(e.timers.size,0);
  });
  test('Speech records twice without native off methods with '+tag,()=>{
    const captured=[];
    const e=env(options,{'utils/phonetic/analysis.js':{analyzePcm:pcm=>{captured.push(pcm.length);return new Promise(()=>{});}}});
    e.load('pages/phonetic/phonetic.js');
    for(let i=0;i<2;i++){
      e.page.startRecording();e.clock.tick(0);feed(e);e.page.stopRecording();
      assert.equal(captured.length,i+1);assert.equal(captured[i],49152);
      e.page.resetToIdle();
    }
    e.page.onUnload();assert.equal(e.timers.size,0);
  });
}
for(const oldPath of ['pages/main/main.js','pages/calibrate/calibrate.js','pages/advanced-calibrate/calibrate/calibrate.js','pages/phonetic/phonetic.js']) {
  test('Late unload cannot stop a newer page: '+oldPath,()=>{
    const e=env({singleListener:true,noOff:true});e.load(oldPath);const oldPage=e.page;
    if(oldPath.includes('phonetic'))oldPage.startRecording();else oldPage.onShow();
    e.clock.tick(0);feed(e,2);oldPage.onHide();
    const nextPath=oldPath==='pages/main/main.js'?'pages/calibrate/calibrate.js':'pages/main/main.js';
    e.load(nextPath);const nextPage=e.page;nextPage.onShow();e.clock.tick(0);feed(e,2);
    oldPage.onUnload();
    assert.equal(e.recorder.running,true);feed(e,4);
    if(nextPath.includes('main'))assert.equal(nextPage.archive().sampleCount,49152);
    else {feed(e,1);assert.ok(Number(nextPage.data.dbspl)>0);}
    nextPage.onHide();
  });
}
test('No calibration and expired calibration both save labelled estimates',()=>{
  for(const expired of [false,true]) {
    const e=runtime();
    if(expired)e.load('utils/data-model').setOffset(107,{source:'advanced-1khz-calibration',calibratedAt:1000,validUntil:2000});
    e.storage.set('alarm',false);e.load('pages/main/main.js');e.page.onShow();feed(e);e.page.stopNoiseMonitoring();e.page.saveResult();
    assert.equal(e.saved.length,1);assert.equal(e.saved[0].calibrationVerified,false);
    assert.ok(Number.isFinite(e.saved[0].leqA));assert.ok(e.saved[0].calibrationLabel.includes('估算'));
    assert.equal(e.page.data.threatClass,'detail-init');
  }
});
test('Delayed calibration startup does not spend integration time before native Start',()=>{
  for(const route of ['pages/calibrate/calibrate.js','pages/advanced-calibrate/calibrate/calibrate.js']) {
    const e=env({singleListener:true,noOff:true});
    e.recorder.start=function(){this.running=true;this.starts++;this.startedAt=e.context.Date.now();};
    e.load(route);e.page.onShow();
    if(route.includes('advanced'))e.page.startCalibrationProcess();
    else e.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});
    e.clock.tick(0);e.clock.tick(6000);assert.equal(e.recorder.running,true);e.emit('Start',{});
    if(route.includes('advanced')){e.clock.tick(3000);feed(e,27);assert.ok(Number(e.page.data.newOffset)>90);}
    else {feed(e,11);assert.equal(e.page.data.canSaveCalibration,true);}
    e.page.onHide();
  }
});
test('Native stop dispatch finishes before the next start',()=>{
  const e=env({singleListener:true,noOff:true}),s=e.load('utils/recorder-session');
  let dispatching=false;const start=e.recorder.start;
  e.recorder.start=function(){assert.equal(dispatching,false);return start.call(this);};
  e.recorder.stop=function(){this.running=false;dispatching=true;e.emit('Stop',{});dispatching=false;};
  s.observeRecorderEvent(e.recorder,'Stop',()=>s.safeStartRecorder(e.recorder,{}));
  s.safeStartRecorder(e.recorder,{});s.safeStopRecorder(e.recorder);
  assert.equal(e.recorder.starts,1);e.clock.tick(0);assert.equal(e.recorder.starts,2);
});
test('Speech uses native audio duration rather than delayed JS stop callback time',()=>{
  const captured=[],e=env({singleListener:true,noOff:true},{'utils/phonetic/analysis.js':{analyzePcm:pcm=>{captured.push(pcm.length);return new Promise(()=>{});}}});
  e.load('pages/phonetic/phonetic.js');e.page.startRecording();feed(e);
  e.recorder.stop=function(){this.running=false;e.context.setTimeout(()=>e.emit('Stop',{duration:Math.round(49152/44100*1000)}),1000);};
  e.page.stopRecording();e.clock.tick(1000);
  assert.equal(captured[0],49152);assert.ok(e.page.data.captureNote.includes('增益控制') && e.page.data.captureNote.includes('未核验'));e.page.resetToIdle();
});
test('Old laboratory backups import and export with provenance intact',()=>{
  const e=runtime(),m=e.load('utils/data-model');let copied;
  const backup={source:'NoiseCalibration',calibrationSource:'laboratory-preset',offset:118.806247,calibratedAt:1000,validUntil:2000,captureProfile:'old-profile',deviceId:'old-device',installationId:'old-installation'};
  e.wx.getClipboardData=opts=>opts.success({data:JSON.stringify(backup)});
  e.wx.setClipboardData=opts=>{copied=opts.data;};
  e.load('pages/advanced-calibrate/advanced-calibrate.js');e.page.importCalibration();
  assert.equal(m.getOffset(),backup.offset);assert.equal(e.storage.get('offsetMeta').source,'laboratory-preset');
  assert.equal(e.storage.get('offsetMeta').importedFrom.deviceId,'old-device');
  e.page.exportCalibration();assert.equal(JSON.parse(copied).calibrationSource,'laboratory-preset');
  assert.equal(JSON.parse(copied).calibratedAt,1000);
});
test('An old calibration modal cannot restart a newer calibration session',()=>{
  const e=env({singleListener:true,noOff:true});e.load('pages/advanced-calibrate/calibrate/calibrate.js');e.page.onShow();
  e.page.startCalibrationProcess();e.clock.tick(3000);feed(e,27);const old=e.modals[0];
  e.page.startCalibrationProcess();e.clock.tick(3000);const starts=e.recorder.starts;
  old.complete();assert.equal(e.recorder.starts,starts);feed(e,27);
  assert.equal(e.modals.length,2);e.page.onHide();
});
test('A rough calibration can retry after a native startup error without leaving the page',()=>{
  const e=env({singleListener:true,noOff:true}),original=e.recorder.start;let first=true;
  e.recorder.start=function(){if(first){first=false;e.emit('Error',{errMsg:'start failed'});}else original.call(this);};
  e.load('pages/calibrate/calibrate.js');e.page.onShow();
  e.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'retry'}}});feed(e,11);
  assert.equal(e.page.data.canSaveCalibration,true);e.page.onHide();
});
test('A stopped partial record keeps its scope and neutral risk presentation in history',()=>{
  const e=env({}, {'utils/result-manager.js':{add:r=>r}});
  e.load('pages/main/main.js');e.page.onShow();feed(e);
  e.recorder.stop=function(){this.running=false;e.emit('Stop',{duration:2000});};
  e.page.stopNoiseMonitoring();const record=e.page.archive();
  assert.equal(record.dataQuality,'partial');assert.equal(e.page.data.levelScopeLabel,'片段估算 LAeq');
  const viewer=runtime({},(f,c)=>f==='pages/result/result.js'?c+'\nmodule.exports.normalize=normalizeRecordsForDisplay;':c);
  const row=viewer.load('pages/result/result.js').normalize([record])[0];
  assert.notEqual(row.cneDisplay,'--');assert.ok(row.qualityLabel.includes('片段'));
  assert.equal(row.threatColorClass,'bg-unknown');
});
test('Native duration limit completes as a saveable received-audio record',()=>{
  const e=env();e.load('pages/main/main.js');e.page.onShow();feed(e);
  e.emit('Stop',{duration:600000});
  assert.equal(e.page.data.recordingState,'stopped');assert.equal(e.page.data.canSave,true);
  assert.equal(e.page.archive().dataQuality,'partial');assert.equal(e.page.archive().measurementScope,'received-audio');
});
test('A tiny silent tail does not invalidate an otherwise complete capture',()=>{
  const e=env();e.load('pages/main/main.js');e.page.onShow();feed(e);
  e.emit('FrameRecorded',{frameBuffer:new Int16Array([0]).buffer});e.page.stopNoiseMonitoring();
  assert.equal(e.page.archive().dataQuality,'valid');assert.equal(e.page.archive().silentSampleCount,1);
});
test('Saved calibrated records disclose unverified capture chain without blocking save',()=>{
  const e=env(),s=e.load('utils/recorder-session');
  e.load('utils/data-model').setOffset(100,{captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId(),source:'advanced-1khz-calibration',
    evidence:{referenceInstrument:'Class 1 / LAB-7',inputChain:'external mic; fixed gain',uncertaintyDb:0.3}});
  e.load('pages/main/main.js');e.page.onShow();feed(e);e.page.stopNoiseMonitoring();e.page.saveResult();
  assert.equal(e.saved.length,1);assert.equal(e.saved[0].captureChainVerification,'unverified');
  assert.equal(e.saved[0].calibrationProcessCompleted,true);assert.equal(e.saved[0].calibrationVerified,false);
  assert.ok(e.saved[0].riskEstimate);assert.ok(e.saved[0].captureChainNote.includes('输入路由'));
});
test('Reference evidence and verification cannot silently promote or re-enable calibration',()=>{
  const e=env(),s=e.load('utils/recorder-session'),m=e.load('utils/data-model');
  const binding={captureProfile:s.getMeasurementCaptureProfile(),deviceId:s.getCurrentDeviceCalibrationId()};
  m.setOffset(100,{...binding,source:'advanced-1khz-calibration'});
  assert.equal(m.getOffsetStatus(binding).riskEligible,false);
  m.setOffset(100,{...binding,source:'advanced-1khz-calibration',evidence:{referenceInstrument:'Class 1',inputChain:'external mic',uncertaintyDb:0.4}});
  assert.equal(m.getOffsetStatus(binding).riskEligible,true);
  m.invalidateOffset();
  assert.equal(m.appendReferenceCheck(100,{residualDb:2,residualLimitDb:1,status:'failed'},e.storage.get('offsetMeta')),true);
  assert.equal(e.storage.get('offsetValid'),false);
  assert.equal(m.getOffsetStatus(binding).valid,false);
});
test('Advanced calibration restarts its countdown after interruption during preparation',()=>{
  const e=env({singleListener:true,noOff:true});e.load('pages/advanced-calibrate/calibrate/calibrate.js');e.page.onShow();
  e.page.startCalibrationProcess();e.clock.tick(1000);e.emit('InterruptionBegin',{});
  assert.equal(e.page.data.isCalibratingUI,false);assert.equal(e.page.data.newOffset,'--');
  const starts=e.recorder.starts;e.page.startCalibrationProcess();e.clock.tick(3000);
  assert.equal(e.recorder.starts,starts); // A real interruption remains active until the native recovery event.
  e.emit('InterruptionEnd',{});e.clock.tick(0);e.clock.tick(3000);feed(e,27);assert.ok(Number(e.page.data.newOffset)>90);
  e.page.onHide();
});
test('Advanced calibration stores actual reference evidence and input declaration',()=>{
  const e=env();e.load('pages/advanced-calibrate/calibrate/calibrate.js');e.page.onShow();
  for(const [key,value] of [['referenceLevel','94'],['referenceInstrument','Class 1 / LAB-7'],['inputChain','internal mic; fixed stand'],['referenceUncertainty','0.3']])
    e.page.setReferenceField({currentTarget:{dataset:{key}},detail:{value}});
  e.page.startCalibrationProcess();e.clock.tick(3000);feed(e,27);const modal=e.modals[0];modal.success({confirm:true});modal.complete();
  const meta=e.storage.get('offsetMeta');assert.equal(meta.evidence.referenceLevelDb,94);
  assert.equal(meta.evidence.referenceInstrument,'Class 1 / LAB-7');assert.equal(meta.inputChain,'internal mic; fixed stand');
  assert.ok(Math.abs(meta.evidence.measuredDbfs+23.0103)<.05);e.page.onHide();
});
const summary={total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length};
const files=['utils/recorder-session.js','utils/data-model.js','pages/main/main.js','pages/result/result.js',
  'pages/calibrate/calibrate.js','pages/phonetic/phonetic.js','pages/advanced-calibrate/advanced-calibrate.js',
  'pages/advanced-calibrate/calibrate/calibrate.js','tests/runtime.cjs','tests/recorder-usability.cjs'];
const sourceSha256=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',f))).digest('hex')]));
fs.writeFileSync(path.join(__dirname,'../docs/recorder-usability-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),environment:'Simulated native recorder: single/multiple listeners and no off methods; no physical device',algorithmVersion:require('../utils/measurement-version').ALGORITHM_VERSION,summary,sourceSha256,results},null,2)+'\n');
console.log(JSON.stringify(summary));results.filter(r=>r.status==='FAIL').forEach(r=>console.log(r.name,r.error));
process.exitCode=summary.failed?1:0;
