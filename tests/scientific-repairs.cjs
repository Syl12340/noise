'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { runtime } = require('./runtime.cjs');
const { inspectPcm, PcmQualityInspector } = require('../utils/audio-quality');
const { analyzePcm } = require('../utils/phonetic/analysis');
const { summarizeHarmonicity } = require('../utils/phonetic/harmonicity');
const results = [];
async function test(name, body) {
  try { await body(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
}
const tone = (frequency, rate, seconds, amplitude = .1, dc = 0) => Int16Array.from(
  { length: Math.round(rate * seconds) }, (_, i) => Math.round((dc + amplitude * Math.sin(2 * Math.PI * frequency * i / rate)) * 32768));
function selectionEnvironment() {
  const env = runtime({}, (file, code) => file === 'pages/phonetic/phonetic.js'
    ? code + '\nmodule.exports.__setResult=(result)=>{analysisResult=result;};' : code);
  const module = env.load('pages/phonetic/phonetic.js');
  return { ...env, page: env.page, inject: module.__setResult };
}
(async () => {
  await test('Near-full quantized 25 Hz sine is usable, without confirmed clipping', () => {
    const q = inspectPcm(tone(25, 44100, .5, .99));
    assert.equal(q.nearFullScale, true); assert.equal(q.clipped, false);
  });
  await test('Sub-rail limiting produces a warning and remains usable', () => {
    const x = tone(100, 44100, .3, .8).map(value => Math.max(-9830, Math.min(9830, value)));
    const q = inspectPcm(x); assert.equal(q.plateauSuspected, true); assert.equal(q.clipped, false);
  });
  await test('Clipping and plateau evidence is invariant under callback partitioning', () => {
    const inputs = [tone(25, 44100, .3, .99), tone(100, 44100, .3, .8).map(value => Math.max(-9000, Math.min(9000, value)))];
    const rail = tone(1000, 44100, .3); rail[1378] = 32767; rail[1379] = 32767; inputs.push(rail);
    for (const x of inputs) for (const size of [1, 17, 1379, 8192]) {
      const inspector = new PcmQualityInspector(); let final;
      for (let start = 0; start < x.length; start += size) final = inspectPcm(x.subarray(start, start + size), inspector);
      const whole = inspectPcm(x); assert.equal(final.clipped, whole.clipped); assert.equal(final.plateauSuspected, whole.plateauSuspected);
    }
  });
  await test('Constant DC is not classified as a limited AC plateau', () => {
    const q = inspectPcm(new Int16Array(10000).fill(9000)); assert.equal(q.plateauSuspected, false); assert.equal(q.digitalSilence, true);
  });
  await test('All-invalid selected intensity does not throw or turn null into zero', () => {
    const e = selectionEnvironment();
    e.inject({ pitchTrack: [], formantTracks: [], intensityTrack: [{ time: .5, db: null }, { time: .6, db: NaN }, { time: .7, db: Infinity }] });
    e.page.computeSelectionStats(0, 1); assert.equal(e.page.data.selMaxIntensity, '--');
  });
  await test('Mixed selected intensity retains the finite maximum', () => {
    const e = selectionEnvironment();
    e.inject({ pitchTrack: [], formantTracks: [], intensityTrack: [{ time: .5, db: null }, { time: .6, db: -40 }, { time: .7, db: -23 }] });
    e.page.computeSelectionStats(0, 1); assert.equal(e.page.data.selMaxIntensity, '-23.0');
  });
  await test('HNR excludes unvoiced frames but keeps failed eligible voiced frames in coverage', () => {
    const rows = Array.from({ length: 10 }, () => ({ db: 12 }));
    rows.push(...Array.from({ length: 30 }, () => ({ db: null, reason: 'low-periodicity' })),
      ...Array.from({ length: 100 }, () => ({ db: null, reason: 'unvoiced-or-uncertain' })));
    const h = summarizeHarmonicity(rows); assert.equal(h.coverage, .25); assert.equal(h.activeFrames, 40);
    assert.equal(h.avgHNR, null); assert.equal(h.partialMeanHNR, 12);
  });
  await test('A single HNR frame stays an explicitly partial estimate', () => {
    const h = summarizeHarmonicity([{ db: 20 }]); assert.equal(h.avgHNR, null); assert.equal(h.validDurationSeconds, .01);
  });
  await test('A new calibration with the same numeric offset rejects obsolete verification', () => {
    const e = runtime(), m = e.load('utils/data-model.js');
    m.setOffset(100); const original = e.storage.get('offsetMeta'); m.setOffset(100);
    assert.notEqual(original.calibrationId, e.storage.get('offsetMeta').calibrationId);
    assert.equal(m.appendReferenceCheck(100, { status: 'passed' }, original), false);
    assert.equal(e.storage.get('offsetMeta').referenceCheck, null);
  });
  await test('Uncertainty never expands the 1 dB drift acceptance limit', () => {
    const e = runtime(), m = e.load('utils/data-model.js'), evidence = uncertaintyDb => ({ uncertaintyDb, uncertaintyCoverageFactor: 2 });
    assert.equal(m.evaluateReferenceCheck(.2, evidence(.1), evidence(.1)).status, 'passed');
    assert.equal(m.evaluateReferenceCheck(2, evidence(.1), evidence(.1)).status, 'failed');
    assert.equal(m.evaluateReferenceCheck(2, evidence(10), evidence(10)).status, 'inconclusive');
    assert.equal(m.evaluateReferenceCheck(0, {}, {}).status, 'inconclusive');
  });
  await test('Manual and historical preset offsets have no invented 1 kHz provenance', () => {
    const e = runtime(), m = e.load('utils/data-model.js'); m.setOffset(100);
    assert.equal(e.storage.get('offsetMeta').calibrationFrequencyHz, null);
    m.setOffset(100, { source: 'laboratory-preset', calibratedAt: 1000, validUntil: 2000 });
    const status = m.getOffsetStatus({ captureProfile: 'changed', deviceId: 'unknown-device' });
    assert.equal(status.valid, true); assert.equal(status.historical, true); assert.equal(status.meta.calibrationFrequencyHz, null);
  });
  await test('Unsupported Android source falls back once; subsequent recording is usable', () => {
    const e = runtime(), s = e.load('utils/recorder-session.js');
    let calls = [], errorEvents = 0;
    e.recorder.start = params => { calls.push(params.audioSource);
      if (params.audioSource === 'voice_recognition') e.emit('Error', { errMsg: 'start:fail audioSource unsupported' });
      else { e.recorder.running = true; e.emit('Start', {}); }
    };
    s.bindRecorderFrameListener(e.recorder, () => {}); s.observeRecorderEvent(e.recorder, 'Error', () => errorEvents++);
    assert.equal(s.getPreferredAudioSource(), 'voice_recognition');
    assert.equal(s.safeStartRecorder(e.recorder, s.createCamcorderRecordParams()), true); e.clock.tick(0);
    assert.deepEqual(calls, ['voice_recognition', 'auto']); assert.equal(errorEvents, 0);
    const capture = s.getRecorderCaptureInfo(e.recorder); assert.equal(capture.selectedAudioSource, 'auto'); assert.equal(capture.sourceFallback, true);
    s.safeStopRecorder(e.recorder); assert.equal(s.safeStartRecorder(e.recorder, s.createCamcorderRecordParams()), true);
    assert.equal(calls.at(-1), 'auto');
  });
  await test('Permission errors do not silently trigger a different audio source', () => {
    const e = runtime(), s = e.load('utils/recorder-session.js'); let calls = 0, errors = 0;
    e.recorder.start = () => { calls++; e.emit('Error', { errMsg: 'start:fail permission denied' }); };
    s.bindRecorderFrameListener(e.recorder, () => {}); s.observeRecorderEvent(e.recorder, 'Error', () => errors++);
    assert.equal(s.safeStartRecorder(e.recorder, s.createCamcorderRecordParams()), false); e.clock.tick(0);
    assert.equal(calls, 1); assert.equal(errors, 1);
  });
  await test('Android source fallback preserves noise saving and marks the changed calibration profile', () => {
    const e = runtime(), s = e.load('utils/recorder-session.js'), m = e.load('utils/data-model.js');
    m.setOffset(100, { source: 'advanced-1khz-calibration', captureProfile: s.getMeasurementCaptureProfile(),
      deviceId: s.getCurrentDeviceCalibrationId(), evidence: { referenceInstrument: 'meter', inputChain: 'mic', uncertaintyDb: .2 } });
    let calls = 0;
    e.recorder.start = () => {
      calls++; if (calls === 1) e.emit('Error', { errMsg: 'start:fail audioSource unsupported' });
      else { e.recorder.running = true; e.recorder.startedAt = 100000; e.emit('Start', {}); }
    };
    e.load('pages/main/main.js'); e.page.startMainMonitoring(); e.clock.tick(0);
    const input = tone(1000, 44100, .2); e.clock.tick(200); e.emit('FrameRecorded', { frameBuffer: input.buffer });
    e.page.stopNoiseMonitoring(); const snapshot = e.page._completedSnapshot;
    assert.ok(snapshot); assert.equal(snapshot.dataQuality, 'valid'); assert.equal(snapshot.calibrationGrade, 'estimated');
    assert.equal(snapshot.sourceFallback, true); assert.equal(snapshot.selectedAudioSource, 'auto');
    assert.equal(snapshot.riskEstimate, null); e.page.saveResult(); assert.equal(e.saved.length, 1);
  });
  await test('LTAS omits join windows rather than adding artificial high-frequency energy', () => {
    const env = runtime({}, (file, code) => file === 'pages/phonetic/phonetic.js'
      ? code.replace('dbMax = Math.ceil(dbMax / 10) * 10;', 'globalThis.__psd=Array.from(avgDb);dbMax = Math.ceil(dbMax / 10) * 10;')
        + '\nmodule.exports.__setResult=(page,result)=>{analysisResult=result;currentPhoneticPage=page;};' : code);
    const module = env.load('pages/phonetic/phonetic.js'), page = env.page;
    page._ltasCtx = new Proxy({}, { get: () => () => {} }); page._ltasW = 600; page._ltasH = 300; page.initLTASCanvas = callback => callback();
    const input = new Float32Array(44100).fill(.1);
    module.__setResult(page, { signal: input, duration: 1, sampleRate: 44100 }); page.drawLTAS(); const continuous = env.context.__psd;
    input.fill(-.1, 22050);
    module.__setResult(page, { signal: input, duration: 1, sampleRate: 44100, parameters: { discontinuityBoundariesSeconds: [.5] } }); page.drawLTAS();
    const segmented = env.context.__psd;
    assert.ok(segmented.every((db, i) => Math.abs(db - continuous[i]) < 1e-7));
  });
  await test('Segments are analyzed independently before DC removal, resampling and tracking', async () => {
    const left = tone(100, 12000, .3, .08, .1), right = tone(400, 12000, .3, .08, -.15);
    const joined = new Int16Array(left.length + right.length); joined.set(left); joined.set(right, left.length);
    const single = await analyzePcm(right, 12000), segmented = await analyzePcm(joined, 12000, { discontinuityBoundariesSeconds: [.3] });
    assert.deepEqual(segmented.signal.subarray(left.length), single.signal);
    const shifted = segmented.pitchTrack.filter(row => row.segmentIndex === 1).map(row => row.f0);
    assert.deepEqual(shifted, single.pitchTrack.map(row => row.f0));
    assert.equal(segmented.jitter, null);
    for (const row of segmented.formantTracks.filter(row => row.F1.freq > 0 || row.F2.freq > 0 || row.F3.freq > 0)) {
      const segment = segmented.analysisSegments[row.segmentIndex];
      assert.ok(row.support.start >= segment.start && row.support.end <= segment.end);
      assert.ok(row.decisionSupport.start >= segment.start && row.decisionSupport.end <= segment.end);
    }
  });
  await test('Formant selection distinguishes input support from persistent tracking context', async () => {
    const r = await analyzePcm(tone(200, 12000, .5), 12000);
    const row = r.formantTracks.find(row => row.decisionSupport && row.time > .25);
    assert.ok(row); assert.ok(row.decisionSupport.start < row.support.start);
    assert.ok(row.support.end - row.support.start >= 1024 / 12000);
  });
  const report = { generatedAt: new Date().toISOString(), criteria: 'Engineering regressions; no clinical or device certification',
    summary: { total: results.length, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status !== 'PASS').length }, results };
  fs.writeFileSync(path.join(__dirname, '../docs/scientific-repairs-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary)); for (const row of results.filter(row => row.status !== 'PASS')) console.log(row.name, row.error);
  process.exitCode = report.summary.failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
