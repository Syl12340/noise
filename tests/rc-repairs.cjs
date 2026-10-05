'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { runtime } = require('./runtime.cjs');
const { analyzePcm } = require('../utils/phonetic/analysis');
const { selectionCoverage } = require('../utils/phonetic/coverage');
const { assessLaboratoryVerification, describeLaboratoryVerification } = require('../utils/laboratory-verification');
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));
async function test(name, body) {
  try { await body(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
}
function recorderHandoff(options = {}) {
  const e = runtime({}, undefined, options), s = e.load('utils/recorder-session');
  const received = [], errors = [], states = [];
  s.observeRecorderEvent(e.recorder, 'Error', error => errors.push(error));
  s.observeRecorderState(e.recorder, state => states.push(state));
  s.bindRecorderFrameListener(e.recorder, () => received.push('A'));
  s.safeStartRecorder(e.recorder, { audioSource: 'voice_recognition' });
  e.recorder.stop = function () { this.running = false; };
  s.bindRecorderFrameListener(e.recorder, () => received.push('B'));
  s.safeStartRecorder(e.recorder, { audioSource: 'voice_recognition' });
  return { e, s, received, errors, states };
}
function displayRuntime(result, overrides = {}) {
  const paths = [], points = []; let current = [];
  const ctx = { clearRect() {}, beginPath() { current = []; }, moveTo(x, y) { current.push(['move', x, y]); },
    lineTo(x, y) { current.push(['line', x, y]); }, arc(x, y) { points.push({ x, y }); },
    stroke() { paths.push({ color: this.strokeStyle, commands: current.slice(), hollow: !current.length }); }, fill() {} };
  const e = runtime(overrides, (file, code) => file === 'pages/phonetic/phonetic.js'
    ? code + '\nmodule.exports.inject=(r,c,p)=>{analysisResult=r;ctxOverlay=c;rawPcm=p;};' : code);
  const module = e.load('pages/phonetic/phonetic.js');
  module.inject(result, ctx, new Int16Array(44100)); e.page.onShow();
  e.page._sgWidth = 444; e.page._sgHeight = 200;
  return { e, ctx, paths, points };
}
const formant = (time, freq = 600) => ({ time, support: { start: time - .0125, end: time + .0125 },
  F1: { freq, bandwidth: 100 }, F2: { freq: 0, bandwidth: 0 }, F3: { freq: 0, bandwidth: 0 } });
function emptyResult() {
  return { duration: 1, sampleRate: 44100, parameters: { maxFormant: 5000, windowMs: 25, hopSize: 120,
    analysisRate: 12000, hnrFrameSeconds: .08 }, pitchTrack: [], formantTracks: [], intensityTrack: [], harmonicity: { track: [] } };
}
const labInput = () => ({ captureProfile: 'profile', inputChain: 'mic; fixed gain', referenceInstrument: 'meter',
  referenceWeighting: 'Z', measuredWeighting: 'Z', integrationSeconds: 1,
  points: [{ frequencyHz: 500, referenceLevelDb: 60, measuredDbfs: -40 },
    { frequencyHz: 500, referenceLevelDb: 80, measuredDbfs: -30 }] });
(async () => {
  for (const options of [{}, { singleListener: true, noOff: true }]) {
    await test('Retiring errors and pauses preserve queued start: ' + JSON.stringify(options), () => {
      const { e, s, received, errors } = recorderHandoff(options);
      e.emit('Error', { errMsg: 'audioSource unsupported' }); e.emit('Pause', {});
      e.emit('FrameRecorded', {});
      assert.equal(s.isRecorderTransitioning(e.recorder), true); assert.equal(e.recorder.starts, 1);
      assert.equal(s.getPreferredAudioSource(), 'voice_recognition'); assert.equal(errors.length, 0); assert.equal(received.length, 0);
      e.emit('Stop', {}); e.emit('Error', { errMsg: 'old encoder failed' }); e.emit('Pause', {});
      e.clock.tick(0); e.emit('FrameRecorded', {});
      assert.equal(e.recorder.starts, 2); assert.deepEqual(received, ['B']); assert.equal(errors.length, 0);
      assert.equal(s.getRecorderCaptureInfo(e.recorder).sourceFallback, false);
    });
  }
  for (const stopFirst of [true, false]) await test('Handoff interruption waits for recovery and Stop: stopFirst=' + stopFirst, () => {
    const { e, s, states, errors } = recorderHandoff();
    e.emit('InterruptionBegin', {}); e.clock.tick(20000);
    assert.equal(e.recorder.starts, 1); assert.equal(s.isRecorderTransitioning(e.recorder), true);
    assert.ok(states.includes('waiting-interruption')); assert.equal(errors.length, 0);
    if (stopFirst) { e.emit('Stop', {}); e.clock.tick(0); assert.equal(e.recorder.starts, 1); e.emit('InterruptionEnd', {}); }
    else { e.emit('InterruptionEnd', {}); e.clock.tick(0); assert.equal(e.recorder.starts, 1); e.emit('Stop', {}); }
    e.clock.tick(0); assert.equal(e.recorder.starts, 2);
    e.emit('InterruptionEnd', {}); e.clock.tick(0); assert.equal(e.recorder.starts, 2);
  });
  await test('Interruption beginning on A cannot be delivered as a failure to queued B on recovery', () => {
    const e = runtime(), s = e.load('utils/recorder-session'); let ended = 0;
    s.bindRecorderFrameListener(e.recorder, () => {}); s.safeStartRecorder(e.recorder, {});
    e.recorder.stop = function () { this.running = false; };
    e.emit('InterruptionBegin', {});
    s.bindRecorderFrameListener(e.recorder, () => {}); s.safeStartRecorder(e.recorder, {});
    s.observeRecorderEvent(e.recorder, 'InterruptionEnd', () => ended++);
    e.emit('Stop', {}); e.emit('InterruptionEnd', {}); e.clock.tick(0);
    assert.equal(e.recorder.starts, 2); assert.equal(ended, 0);
  });
  await test('Canceled handoff stays canceled through interruption recovery', () => {
    const { e, s } = recorderHandoff(); e.emit('InterruptionBegin', {}); s.cancelRecorderStart(e.recorder);
    e.emit('Stop', {}); e.emit('InterruptionEnd', {}); e.clock.tick(0); assert.equal(e.recorder.starts, 1);
  });
  await test('Retiring Error without Stop times out instead of assuming hardware idle', () => {
    const { e, s, states } = recorderHandoff(); e.emit('Error', { errMsg: 'old error' }); e.clock.tick(2000);
    assert.equal(e.recorder.starts, 1); assert.equal(s.isRecorderTransitioning(e.recorder), false); assert.equal(states.at(-1), 'error');
  });
  await test('Current recording errors still reach the owner and permit explicit retry', () => {
    const e = runtime(), s = e.load('utils/recorder-session'); let errors = 0;
    s.bindRecorderFrameListener(e.recorder, () => {}); s.observeRecorderEvent(e.recorder, 'Error', () => errors++);
    s.safeStartRecorder(e.recorder, {}); e.emit('Error', { errMsg: 'permission denied' });
    assert.equal(errors, 1); assert.equal(s.getRecorderCaptureInfo(e.recorder).sourceAttempts[0].errorCategory, 'permission');
    s.safeStartRecorder(e.recorder, {}); assert.equal(e.recorder.starts, 2);
  });
  await test('Actual page handoff does not invalidate a new main record on retired Error/Pause', () => {
    const e = runtime(); e.storage.set('alarm', false); e.load('pages/calibrate/calibrate.js'); e.page.onShow();
    e.recorder.stop = function () { this.running = false; }; e.page.onHide();
    e.load('pages/main/main.js'); const main = e.page; main.onShow();
    e.emit('Error', { errMsg: 'old capture error' }); e.emit('Pause', {}); e.emit('Stop', {}); e.clock.tick(0);
    const pcm = Int16Array.from({ length: 8192 }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 1000 * i / 44100)));
    for (let i = 0; i < 6; i++) { e.clock.tick(8192 / 44100 * 1000); e.emit('FrameRecorded', { frameBuffer: pcm.buffer }); }
    main.stopNoiseMonitoring(); e.emit('Stop', { duration: Math.round(49152 / 44100 * 1000) }); main.saveResult();
    assert.equal(e.saved.length, 1); assert.equal(e.saved[0].dataQuality, 'valid');
  });
  await test('Rough calibration is invariant to tiny truncated tails and callback partition', () => {
    const n = 88200;
    for (const tail of [1, 2, 3]) {
      const phase = tail === 1 ? 2 * Math.PI * 137 / 44100 : Math.PI / 2 - 2 * Math.PI * 137 * (n - 1.5) / 44100;
      const pcm = Int16Array.from({ length: n }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 137 * i / 44100 + phase)));
      let expected;
      for (const size of [256, 8192]) {
        const e = runtime(); e.load('pages/calibrate/calibrate.js'); e.page.onShow();
        e.page.doRoughCalibrate({ currentTarget: { dataset: { spl: 80, name: 'test' } } });
        for (let start = 0; start < n - tail; start += size)
          e.emit('FrameRecorded', { frameBuffer: pcm.slice(start, Math.min(n - tail, start + size)).buffer });
        const last = new Int16Array(tail + 100); last.set(pcm.subarray(n - tail)); last.fill(32767, tail);
        e.emit('FrameRecorded', { frameBuffer: last.buffer });
        assert.equal(e.page.data.canSaveCalibration, true);
        const offset = e.page.completedCalibration.offset;
        if (expected !== undefined) assert.ok(Math.abs(offset - expected) < 1e-10); else expected = offset;
      }
    }
  });
  await test('Main startup watchdog pauses through a long system interruption before any received samples', () => {
    const e = runtime(); e.storage.set('alarm', false); e.load('pages/calibrate/calibrate.js'); e.page.onShow();
    e.recorder.stop = function () { this.running = false; }; e.page.onHide();
    e.load('pages/main/main.js'); const main = e.page; main.onShow();
    e.emit('InterruptionBegin', {}); e.emit('Stop', {}); e.clock.tick(30000);
    assert.equal(main.data.recordingState, 'starting'); assert.ok(main.data.recordingLabel.includes('等待恢复'));
    assert.equal(e.recorder.starts, 1);
    e.emit('InterruptionEnd', {}); e.clock.tick(0);
    for (let i = 0; i < 6; i++) {
      e.clock.tick(8192 / 44100 * 1000);
      const pcm = Int16Array.from({ length: 8192 }, (_, j) => Math.round(5000 * Math.sin(2 * Math.PI * 1000 * (i * 8192 + j) / 44100)));
      e.emit('FrameRecorded', { frameBuffer: pcm.buffer });
    }
    main.stopNoiseMonitoring(); e.emit('Stop', { duration: Math.round(49152 / 44100 * 1000) }); main.saveResult();
    assert.equal(e.saved.length, 1); assert.equal(e.saved[0].dataQuality, 'valid');
  });
  await test('Whole-interval calibration still rejects zero and constant DC input', () => {
    for (const value of [0, 3000]) {
      const e = runtime(); e.load('pages/calibrate/calibrate.js'); e.page.onShow();
      e.page.doRoughCalibrate({ currentTarget: { dataset: { spl: 80, name: 'test' } } });
      for (let i = 0; i < 11; i++) e.emit('FrameRecorded', { frameBuffer: new Int16Array(8192).fill(value).buffer });
      assert.equal(e.page.data.canSaveCalibration, false); assert.equal(e.page.completedCalibration, null);
    }
  });
  await test('Overlay breaks at null intensity, missing frames and segment changes', () => {
    const r = emptyResult();
    r.intensityTrack = [{ time: .1, db: -30 }, { time: .11, db: null }, { time: .12, db: -30 },
      { time: .13, db: -30 }, { time: .3, db: -30, segmentIndex: 1 }, { time: .31, db: -30, segmentIndex: 1 }];
    const { e, paths } = displayRuntime(r); e.page.drawOverlay();
    const intensity = paths.find(p => p.color === '#FFD700');
    assert.equal(intensity.commands.filter(p => p[0] === 'move').length, 3);
    assert.equal(intensity.commands.filter(p => p[0] === 'line').length, 2);
    assert.ok(intensity.commands.every(p => p[2] > 100));
  });
  await test('Pitch and formant curves do not bridge a missing segment', () => {
    const r = emptyResult(); r.pitchTrack = [{ time: .1, f0: 150, segmentIndex: 0 }, { time: .11, f0: 150, segmentIndex: 1 }, { time: .3, f0: 150, segmentIndex: 1 }];
    r.formantTracks = r.pitchTrack.map(p => ({ ...formant(p.time), segmentIndex: p.segmentIndex }));
    const { e, paths } = displayRuntime(r); e.page.drawOverlay();
    assert.equal(paths.flatMap(p => p.commands).filter(p => p[0] === 'line').length, 0);
  });
  await test('Independent sensitivity downgrade replaces the accepted overlay with a hollow candidate', () => {
    const r = emptyResult(); r.formantTracks = [formant(.2), formant(.4)];
    const independent = { ...emptyResult(), selection: { start: .3, end: .6 },
      formantTracks: [{ ...formant(.4, 0), exploratory: { F1: { freq: 800, bandwidth: 100 } } }] };
    const { e, points, paths } = displayRuntime(r); e.page._independentSelection = independent; e.page.drawOverlay();
    assert.equal(points.length, 2); assert.equal(points[1].x, 194); assert.ok(paths.some(p => p.hollow));
    assert.notEqual(points[0].y, points[1].y);
    e.page._independentSelection = null; points.length = 0; paths.length = 0; e.page.drawOverlay();
    assert.equal(points[0].y, points[1].y);
  });
  await test('Selection changes cancel late independent results instead of replacing current statistics', async () => {
    let resolve;
    const r = emptyResult(), { e } = displayRuntime(r, { 'utils/phonetic/selection-analysis.js': { analyzeSelection: () => new Promise(done => { resolve = done; }) } });
    e.page.setData({ selectionInputStart: '0.3', selectionInputEnd: '0.6' });
    const pending = e.page.reanalyzeSelection();
    e.page.setSelectionInput({ currentTarget: { dataset: { key: 'selectionInputStart' } }, detail: { value: '0.4' } });
    resolve({ ...r, selection: { start: .3, end: .6 } }); await pending;
    assert.equal(e.page._independentSelection, undefined); assert.equal(e.page.data.selectionBusy, false);
  });
  await test('Ordinary full selection retains failed windows in the shared denominator', async () => {
    let injected = false;
    const pcm = Int16Array.from({ length: 7200 }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 137 * i / 12000)));
    const r = await analyzePcm(pcm, 12000, { discontinuityBoundariesSeconds: [.3], onProgress: () => {
      if (!injected) { injected = true; throw Error('injected segment failure'); }
    } });
    const c = selectionCoverage(r, 0, r.duration);
    assert.equal(c.pitchTotal, r.coverage.pitchTotal); assert.equal(c.formantTotal, r.coverage.formantTotal);
    assert.ok(c.pitchTotal > c.pitchComputed); assert.ok(c.pitchFailedSegment > 0); assert.ok(c.formantFailedSegment > 0);
    const { e } = displayRuntime(r); e.page.computeSelectionStats(0, r.duration);
    assert.ok(e.page.data.selectionCoverage.includes('失败片段窗口')); assert.ok(e.page.data.selectionCoverage.includes('/' + c.pitchTotal));
    const short = selectionCoverage(r, .4, .41); assert.equal(short.pitchTotal, 0); assert.equal(short.formantTotal, 0);
    e.page.computeSelectionStats(.4, .41); assert.equal(e.page.data.selMeanF0, '--');
  });
  await test('Declared matching laboratory conditions retain residuals and level slopes', () => {
    const report = assessLaboratoryVerification(labInput(), 100, 'profile');
    assert.equal(report.comparability.comparable, true); assert.equal(report.maxAbsoluteResidualDb, 10);
    assert.equal(report.frequencyGroups[0].levelResponseSlope, .5);
    assert.equal(report.quantitativeUseValidated, false); assert.equal(report.compensationApplied, false);
  });
  await test('Weighting mismatch and unspecified conditions retain only raw differences', () => {
    for (const input of [{ ...labInput(), referenceWeighting: 'A' }, { points: labInput().points }]) {
      const report = assessLaboratoryVerification(input, 100, 'profile');
      assert.equal(report.maxAbsoluteRawDifferenceDb, 10); assert.equal(report.maxAbsoluteResidualDb, null);
      assert.ok(report.points.every(point => point.residualDb === null)); assert.equal(report.frequencyGroups[0].levelResponseSlope, null);
      assert.ok(describeLaboratoryVerification(report, 100, 'profile').includes('不作为可比较校准残差'));
    }
  });
  await test('Capture and integration mismatch are reported without losing original points', () => {
    const input = { ...labInput(), captureProfile: 'other', referenceIntegrationSeconds: 1, measuredIntegrationSeconds: 2 };
    const report = assessLaboratoryVerification(input, 100, 'profile');
    assert.deepEqual(report.comparability.reasons, ['capture-profile-mismatch', 'integration-mismatch']);
    assert.equal(report.points[1].measuredDbfs, -30);
  });
  await test('An imported derived comparable flag cannot override contradictory declared weighting', () => {
    const report = { ...assessLaboratoryVerification(labInput(), 100, 'profile'), referenceWeighting: 'A' };
    const before = plain(report), description = describeLaboratoryVerification(report, 100, 'profile');
    assert.ok(description.includes('计权不一致')); assert.ok(description.includes('不作为可比较校准残差'));
    assert.deepEqual(report, before);
  });
  await test('Subranges and whole selection use stable denominators across input sample rates', async () => {
    for (const rate of [12000, 22050, 44100, 48000]) {
      const pcm = Int16Array.from({ length: Math.floor(rate * .307) + 1 }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 137 * i / rate)));
      const r = await analyzePcm(pcm, rate, { discontinuityBoundariesSeconds: [.103, .207] });
      const all = selectionCoverage(r, 0, r.duration);
      assert.equal(all.pitchTotal, r.coverage.pitchTotal); assert.equal(all.formantTotal, r.coverage.formantTotal);
      for (const [start, end] of [[.005, .203], [.087, .301], [.113, .123]]) {
        const c = selectionCoverage(r, start, end);
        assert.ok(c.pitchAccepted <= c.pitchTotal); assert.ok(c.formantsAccepted.every(n => n <= c.formantTotal));
      }
    }
  });
  await test('Historical imported report keeps original values and exposes its original offset', () => {
    const report = assessLaboratoryVerification(labInput(), 100, 'profile'), original = plain(report);
    const e = runtime(), m = e.load('utils/data-model');
    const backup = { source: 'NoiseCalibration', calibrationSource: 'laboratory-preset', offset: 110, calibratedAt: 1000,
      validUntil: 2000, laboratoryVerification: report, laboratoryVerificationHistory: [report] };
    e.wx.getClipboardData = opts => opts.success({ data: JSON.stringify(backup) });
    let copied; e.wx.setClipboardData = opts => { copied = opts.data; };
    e.load('pages/advanced-calibrate/advanced-calibrate.js'); e.page.importCalibration();
    assert.equal(m.getOffset(), 110); assert.equal(m.getOffsetStatus().valid, true);
    assert.deepEqual(plain(e.storage.get('offsetMeta').laboratoryVerification), original);
    assert.ok(e.page.data.laboratorySummary.includes('原偏移量 100.00')); assert.ok(e.page.data.laboratorySummary.includes('当前参数未经本报告复核'));
    e.page.exportCalibration(); const exported = JSON.parse(copied);
    assert.deepEqual(exported.laboratoryVerification, original); assert.equal(exported.laboratoryVerificationHistory.length, 1);
  });
  await test('Repeated laboratory appends retain earlier evidence and calibration validity', () => {
    const e = runtime(), m = e.load('utils/data-model'); m.setOffset(100, { source: 'laboratory-preset', calibratedAt: 1000, validUntil: 2000 });
    m.invalidateOffset(); const original = plain(e.storage.get('offsetMeta'));
    const a = assessLaboratoryVerification(labInput(), 100, 'profile'), b = { ...a, recordedAt: a.recordedAt + 1000 };
    assert.equal(m.appendLaboratoryVerification(100, a, original), true); assert.equal(m.appendLaboratoryVerification(100, b, original), true);
    const after = plain(e.storage.get('offsetMeta'));
    assert.deepEqual(after.laboratoryVerificationHistory, [a, b]); assert.equal(e.storage.get('offsetValid'), false);
    const { laboratoryVerification, laboratoryVerificationHistory, ...unchanged } = after;
    const { laboratoryVerification: ignored, laboratoryVerificationHistory: ignoredHistory, ...before } = original;
    assert.deepEqual(unchanged, before);
  });
  await test('Legacy ID-less calibration revisions remain appendable after history growth', () => {
    const e = runtime(), m = e.load('utils/data-model'); e.storage.set('offset', 100);
    const meta = { source: 'laboratory-preset', calibratedAt: 1000 }; e.storage.set('offsetMeta', meta);
    for (const recordedAt of [1000, 2000]) assert.equal(m.appendLaboratoryVerification(100, { recordedAt }, meta), true);
    assert.equal(m.appendReferenceCheck(100, { residualDb: 0 }, meta), true);
    assert.equal(e.storage.get('offsetMeta').laboratoryVerificationHistory.length, 2);
  });
  await test('A laboratory draft without calibration is explicitly unsaved and does not create a recording gate', () => {
    const e = runtime(); e.load('pages/advanced-calibrate/advanced-calibrate.js');
    e.page.setData({ laboratoryInput: JSON.stringify(labInput()) }); e.page.recordLaboratoryVerification();
    assert.ok(e.page.data.laboratorySummary.startsWith('未保存摘要')); assert.equal(e.storage.has('offsetMeta'), false);
  });
  await test('Storage failure preserves prior evidence and displays an unsaved draft', () => {
    const e = runtime(), m = e.load('utils/data-model'); m.setOffset(100, { source: 'laboratory-preset', laboratoryVerification: { old: true } });
    const before = plain(e.storage.get('offsetMeta'));
    e.load('pages/advanced-calibrate/advanced-calibrate.js'); e.page.setData({ laboratoryInput: JSON.stringify(labInput()) });
    const set = e.wx.setStorageSync; e.wx.setStorageSync = (key, value) => { if (key === 'offsetMeta') throw Error('quota'); set(key, value); };
    e.page.recordLaboratoryVerification(); assert.deepEqual(plain(e.storage.get('offsetMeta')), before);
    assert.ok(e.page.data.laboratorySummary.includes('未保存摘要')); assert.ok(e.toasts.at(-1).title.includes('保存失败'));
  });
  const files = ['utils/recorder-session.js', 'pages/calibrate/calibrate.js', 'pages/phonetic/phonetic.js',
    'utils/phonetic/coverage.js', 'utils/phonetic/track-display.js', 'utils/laboratory-verification.js', 'utils/data-model.js',
    'pages/advanced-calibrate/advanced-calibrate.js', 'pages/main/main.js',
    'pages/advanced-calibrate/calibrate/calibrate.js', 'tests/rc-repairs.cjs'];
  const report = { generatedAt: new Date().toISOString(), algorithmVersion: require('../utils/measurement-version').ALGORITHM_VERSION,
    environment: 'Node + mocked native recorder and Canvas; not real-device or clinical validation',
    sourceSha256: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex')])),
    summary: { total: results.length, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, results };
  fs.writeFileSync(path.resolve(__dirname, '../docs/rc-repair-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary)); results.filter(row => row.status === 'FAIL').forEach(row => console.log(row.name, row.error));
  process.exitCode = report.summary.failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
