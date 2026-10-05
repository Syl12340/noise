'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { runtime } = require('./runtime.cjs');
const { inspectPcm, PcmQualityInspector } = require('../utils/audio-quality');
const { analyzePcm } = require('../utils/phonetic/analysis');
const { analyzeSelection } = require('../utils/phonetic/selection-analysis');
const { alignPoleCandidates } = require('../utils/phonetic/formant-extract');
const { assessLaboratoryVerification } = require('../utils/laboratory-verification');
const results = [];
async function test(name, body) {
  try { await body(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
}
const tone = (f, rate, seconds) => Int16Array.from({ length: Math.round(rate * seconds) },
  (_, i) => Math.round(Math.sin(2 * Math.PI * f * i / rate) * 5000));
function join(...parts) {
  const x = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { x.set(part, offset); offset += part.length; } return x;
}
function vowel() {
  const rate = 12000, n = 6000, f0 = 137; let x = new Float64Array(n);
  for (let k = 1; k * f0 < 5400; k++) for (let i = 0; i < n; i++) x[i] += Math.cos(2 * Math.PI * k * f0 * i / rate) / Math.sqrt(k);
  for (const [f, bw] of [[550, 95], [1620, 145], [2790, 185], [3820, 230], [4760, 290]]) {
    const r = Math.exp(-Math.PI * bw / rate), a = 2 * r * Math.cos(2 * Math.PI * f / rate), b = r * r;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] + (i ? a * y[i - 1] : 0) - (i > 1 ? b * y[i - 2] : 0);
    const peak = Math.max(...y.map(Math.abs)); x = y.map(value => value / peak);
  }
  const peak = Math.max(...x.map(Math.abs)); return Int16Array.from(x, value => Math.round(value / peak * 10000));
}
(async () => {
  await test('Rail pairs straddling a former 10 ms block are detected at every recording origin and rate', () => {
    for (const rate of [12000, 16000, 22050, 44100, 48000]) for (const shift of [0, 1, 11, 117]) {
      const n = Math.round(rate * .01), x = new Int16Array(n * 3 + shift);
      x[n - 1 + shift] = 32767; x[n + shift] = 32767;
      const q = inspectPcm(x, new PcmQualityInspector(rate)); assert.equal(q.clipped, true);
      assert.equal(q.clippingEvidence.maxConsecutiveRailSamples, 2);
    }
  });
  await test('Clipping evidence intervals remain identical across callback partitions', () => {
    const x = tone(120, 44100, .1); x[440] = 32767; x[441] = 32767;
    const whole = inspectPcm(x, new PcmQualityInspector(44100));
    for (const size of [1, 29, 441, 16384]) {
      const inspector = new PcmQualityInspector(44100); let q;
      for (let i = 0; i < x.length; i += size) q = inspectPcm(x.subarray(i, i + size), inspector);
      assert.deepEqual(q.clippingEvidence, whole.clippingEvidence);
    }
  });
  await test('A clipped local interval does not discard the remaining phonetic recording', async () => {
    const x = tone(137, 12000, .5); x[2400] = 32767; x[2401] = 32767;
    const r = await analyzePcm(x, 12000);
    assert.equal(r.inputQuality.clipped, true); assert.equal(r.jitter, null);
    assert.ok(r.pitchTrack.some(row => row.reason === 'clipped-input'));
    assert.ok(r.pitchTrack.some(row => row.f0 > 0 && row.time > .3));
    for (const row of r.intensityTrack.filter(row => Number.isFinite(row.db)))
      assert.ok(r.invalidIntervals.every(interval => row.support.end <= interval.start || row.support.start >= interval.end));
  });
  await test('Sub-rail limiting remains an explicit warning and recording stays analyzable', async () => {
    const x = tone(100, 12000, .3).map(value => Math.max(-2500, Math.min(2500, value)));
    const r = await analyzePcm(x, 12000); assert.equal(r.inputQuality.plateauSuspected, true);
    assert.equal(r.inputQuality.clipped, false); assert.ok(r.duration > 0);
  });
  await test('Coverage counts omitted boundary frames in the original continuous denominator', async () => {
    const x = tone(137, 12000, .5), whole = await analyzePcm(x, 12000);
    const r = await analyzePcm(x, 12000, { discontinuityBoundariesSeconds: [.05, .1, .15, .2, .25, .3, .35, .4, .45] });
    assert.equal(r.coverage.pitchTotal, whole.coverage.pitchTotal);
    assert.equal(r.coverage.pitchComputed, 0); assert.equal(r.coverage.pitchAccepted, 0);
    assert.equal(r.coverage.pitchExcludedBoundary, r.coverage.pitchTotal);
    assert.ok(r.coverage.formantExcludedBoundary > 0);
  });
  await test('A failed segment leaves valid later segment data and its original sample position intact', async () => {
    let injected = false;
    const right = tone(223, 12000, .3), x = join(tone(137, 12000, .3), right);
    const r = await analyzePcm(x, 12000, { discontinuityBoundariesSeconds: [.3], onProgress: () => {
      if (!injected) { injected = true; throw new Error('Injected segment failure'); }
    } });
    const single = await analyzePcm(right, 12000);
    assert.equal(r.analysisSegments[0].status, 'failed'); assert.equal(r.analysisSegments[1].status, 'analyzed');
    assert.deepEqual(r.signal.subarray(3600), single.signal);
    assert.ok(r.pitchTrack.every(row => row.segmentIndex === 1 && row.time >= .3));
    assert.ok(r.coverage.pitchFailedSegment > 0); assert.ok(r.coverage.formantFailedSegment > 0);
  });
  await test('Coverage accounting uses exact sample counts at fractional-second segment boundaries', async () => {
    for (const rate of [12000, 44100, 48000]) {
      const r = await analyzePcm(tone(137, rate, .3), rate,
        { discontinuityBoundariesSeconds: [1019 / rate, 3068 / rate] });
      for (const key of ['pitch', 'formant']) assert.equal(r.coverage[key + 'Computed']
        + r.coverage[key + 'ExcludedBoundary'] + r.coverage[key + 'FailedSegment'], r.coverage[key + 'Total']);
      for (const segment of r.analysisSegments) {
        assert.ok(Number.isInteger(segment.startSample)); assert.ok(Number.isInteger(segment.endSample));
      }
    }
  });
  await test('Cancellation propagates through segment isolation', async () => {
    await assert.rejects(() => analyzePcm(tone(137, 12000, .5), 12000,
      { discontinuityBoundariesSeconds: [.25], isCancelled: () => true }), { name: 'AbortError' });
  });
  await test('Competing close roots get globally unique monotonic matches', () => {
    const candidates = [{ freq: 1000, bandwidth: 100 }, { freq: 1030, bandwidth: 100 }];
    const roots = [{ freq: 995, bandwidth: 100 }, { freq: 1070, bandwidth: 100 }];
    assert.deepEqual(alignPoleCandidates(candidates, roots), roots);
    const one = alignPoleCandidates(candidates, roots.slice(0, 1));
    assert.equal(one.filter(Boolean).length, 1);
  });
  await test('Cross-model matching does not pair a narrow pole with a nearby very broad pole', () => {
    const result = alignPoleCandidates([{ freq: 1000, bandwidth: 100 }], [{ freq: 1000, bandwidth: 900 }]);
    assert.deepEqual(result, [null]);
  });
  await test('Independent selection results depend on selected exact PCM, not surrounding DC or pitch', async () => {
    const selected = tone(223, 12000, .3);
    const a = join(new Int16Array(1200).fill(9000), selected, tone(90, 12000, .1));
    const b = join(tone(500, 12000, .1), selected, new Int16Array(1200).fill(-7000));
    const r1 = await analyzeSelection(a, 12000, .1, .4), r2 = await analyzeSelection(b, 12000, .1, .4);
    assert.deepEqual(r1.pitchTrack, r2.pitchTrack); assert.deepEqual(r1.formantTracks, r2.formantTracks);
    assert.deepEqual(r1.harmonicity, r2.harmonicity); assert.deepEqual(r1.intensityTrack, r2.intensityTrack);
    assert.equal(r1.selection.resetDspAndTracker, true);
  });
  await test('Very short selections remain browsable with empty quantitative tracks', async () => {
    const r = await analyzeSelection(tone(137, 12000, .3), 12000, .1, .12);
    assert.equal(r.pitchTrack.length, 0); assert.equal(r.formantTracks.length, 0); assert.equal(r.avgHNR, null);
  });
  await test('Optional parameter sensitivity never upgrades a missing value and stores model residual evidence', async () => {
    const x = vowel(), base = await analyzePcm(x, 12000), checked = await analyzePcm(x, 12000, { includeSensitivity: true });
    assert.equal(checked.modelSensitivity.variants.length, 3);
    for (let i = 0; i < checked.formantTracks.length; i++) for (const key of ['F1', 'F2', 'F3'])
      if (checked.formantTracks[i][key].freq > 0) assert.equal(checked.formantTracks[i][key].freq, base.formantTracks[i][key].freq);
    assert.ok(checked.formantTracks.some(row => row.modelCandidates && row.modelCandidates.some(model => Number.isFinite(model.normalizedPredictionError))));
    assert.equal(checked.formantStatus.quantitativeUseValidated, false);
  });
  await test('Late independent selection analysis cannot overwrite a hidden page', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const env = runtime({ 'utils/phonetic/selection-analysis.js': { analyzeSelection: () => pending } },
      (file, code) => file === 'pages/phonetic/phonetic.js' ? code + '\nmodule.exports.inject=(page,result,pcm)=>{currentPhoneticPage=page;analysisResult=result;rawPcm=pcm;};' : code);
    const mod = env.load('pages/phonetic/phonetic.js'), page = env.page;
    page.setData({ state: 'result', selectionInputStart: '0', selectionInputEnd: '.3', pointNote: 'original' });
    mod.inject(page, { duration: .3, parameters: {} }, tone(137, 12000, .3));
    const work = page.reanalyzeSelection(); page.onHide(); resolve({}); await work;
    assert.equal(page.data.pointNote, 'original'); assert.equal(page.data.selectionBusy, false);
    assert.equal(page._independentSelection, undefined);
  });
  await test('Unknown source startup error offers a choice; a normal retry is still immediately usable', () => {
    const env = runtime(), s = env.load('utils/recorder-session.js');
    s.bindRecorderFrameListener(env.recorder, () => {});
    env.recorder.start = () => env.emit('Error', { errMsg: 'start:fail system error' });
    assert.equal(s.safeStartRecorder(env.recorder, s.createCamcorderRecordParams()), false);
    assert.equal(env.modals.length, 1);
    let selected;
    env.recorder.start = params => { selected = params.audioSource; env.recorder.running = true; env.emit('Start', {}); };
    assert.equal(s.safeStartRecorder(env.recorder, s.createCamcorderRecordParams()), true);
    assert.equal(selected, 'voice_recognition');
    env.modals[0].success({ confirm: true }); // A stale prompt cannot affect a running recording.
    assert.equal(s.getPreferredAudioSource(), 'voice_recognition');
  });
  await test('Re-recording during selection analysis cancels old work and clears the busy state', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const env = runtime({ 'utils/phonetic/selection-analysis.js': { analyzeSelection: () => pending } },
      (file, code) => file === 'pages/phonetic/phonetic.js' ? code + '\nmodule.exports.inject=(page,result,pcm)=>{currentPhoneticPage=page;analysisResult=result;rawPcm=pcm;};' : code);
    const mod = env.load('pages/phonetic/phonetic.js'), page = env.page;
    page.setData({ state: 'result', selectionInputStart: '0', selectionInputEnd: '.3' });
    mod.inject(page, { duration: .3, parameters: {} }, tone(137, 12000, .3));
    const work = page.reanalyzeSelection(); assert.equal(page.data.selectionBusy, true);
    page.startRecording(); resolve({}); await work;
    assert.equal(page.data.selectionBusy, false); assert.equal(page.data.state, 'recording');
    assert.equal(page._independentSelection, null);
  });
  await test('Explicit compatibility choice applies to the next session and preserves provenance', () => {
    const env = runtime(), s = env.load('utils/recorder-session.js');
    s.bindRecorderFrameListener(env.recorder, () => {});
    env.recorder.start = () => env.emit('Error', { errMsg: 'start:fail system error' });
    s.safeStartRecorder(env.recorder, s.createCamcorderRecordParams()); env.modals[0].success({ confirm: true });
    const calls = [];
    env.recorder.start = params => { calls.push(params.audioSource); env.emit('Start', {}); };
    assert.equal(s.safeStartRecorder(env.recorder, { ...s.createCamcorderRecordParams(), audioSource: 'voice_recognition' }), true);
    assert.deepEqual(calls, ['auto']);
    const capture = s.getRecorderCaptureInfo(env.recorder);
    assert.equal(capture.sourceCompatibilityReason, 'user-selected'); assert.equal(capture.sourceFallback, true);
    assert.equal(capture.sourceAttempts[0].outcome, 'started');
  });
  await test('Permission and configuration errors do not invite an unrelated source retry', () => {
    for (const errMsg of ['audioSource unsupported, permission denied', 'start:fail invalid sampleRate',
      'start:fail audioSource=voice_recognition, invalid sampleRate']) {
      const env = runtime(), s = env.load('utils/recorder-session.js'); s.bindRecorderFrameListener(env.recorder, () => {});
      env.recorder.start = () => env.emit('Error', { errMsg }); s.safeStartRecorder(env.recorder, s.createCamcorderRecordParams());
      assert.equal(env.modals.length, 0); assert.equal(s.getPreferredAudioSource(), 'voice_recognition');
    }
  });
  await test('Localized synchronous unsupported-source errors fall back once and capability cache follows the SDK environment', () => {
    const env = runtime(), s = env.load('utils/recorder-session.js');
    let sdk = 'old', calls = [];
    env.context.wx.getAppBaseInfo = () => ({ SDKVersion: sdk, version: 'wx-version' });
    s.bindRecorderFrameListener(env.recorder, () => {});
    env.recorder.start = params => {
      calls.push(params.audioSource);
      if (params.audioSource === 'voice_recognition') throw new Error('录音源不支持');
      env.recorder.running = true; env.emit('Start', {});
    };
    assert.equal(s.safeStartRecorder(env.recorder, s.createCamcorderRecordParams()), true); env.clock.tick(0);
    assert.deepEqual(calls, ['voice_recognition', 'auto']);
    const attempts = s.getRecorderCaptureInfo(env.recorder).sourceAttempts;
    assert.equal(attempts[0].errorCategory, 'unsupported-source'); assert.equal(attempts[1].outcome, 'started');
    assert.equal(s.getPreferredAudioSource(), 'auto'); sdk = 'new';
    assert.equal(s.getPreferredAudioSource(), 'voice_recognition');
  });
  await test('Optional laboratory sweep records real points and detects compressed level response without compensation', () => {
    const points = [];
    for (const frequencyHz of [500, 1000, 2000]) for (const referenceLevelDb of [60, 80])
      points.push({ frequencyHz, referenceLevelDb, measuredDbfs: referenceLevelDb === 60 ? -40 : -30 });
    const report = assessLaboratoryVerification({ points, captureProfile: 'profile', inputChain: 'mic', referenceInstrument: 'meter',
      referenceWeighting: 'Z', measuredWeighting: 'Z', integrationSeconds: 1 }, 100, 'profile');
    assert.equal(report.multiFrequencyAndLevel, true); assert.equal(report.maxAbsoluteResidualDb, 10);
    assert.ok(report.frequencyGroups.every(group => group.levelResponseSlope === .5));
    assert.equal(report.compensationApplied, false); assert.equal(report.quantitativeUseValidated, false);
  });
  await test('Lab evidence appends to an old preset without changing dates, grade, validity or binding', () => {
    const env = runtime(), m = env.load('utils/data-model.js');
    m.setOffset(100, { source: 'laboratory-preset', calibratedAt: 1000, validUntil: 2000, captureProfile: 'old' });
    const before = { ...env.storage.get('offsetMeta') };
    const report = assessLaboratoryVerification({ points: [{ frequencyHz: 1000, referenceLevelDb: 80, measuredDbfs: -20 }] }, 100, 'new');
    assert.equal(m.appendLaboratoryVerification(100, report, before), true);
    assert.deepEqual(JSON.parse(JSON.stringify(env.storage.get('offsetMeta'))),
      JSON.parse(JSON.stringify({ ...before, laboratoryVerification: report, laboratoryVerificationHistory: [report] })));
    assert.equal(m.getOffsetStatus({ captureProfile: 'new', deviceId: 'unknown' }).valid, true);
    m.setOffset(100); assert.equal(m.appendLaboratoryVerification(100, report, before), false);
  });
  await test('Malformed historical laboratory metadata cannot prevent opening advanced calibration', () => {
    const env = runtime(), m = env.load('utils/data-model.js'); m.setOffset(100, { source: 'laboratory-preset', laboratoryVerification: { old: true } });
    env.load('pages/advanced-calibrate/advanced-calibrate.js'); assert.doesNotThrow(() => env.page.onShow());
    assert.equal(m.getOffsetStatus().valid, true);
  });
  const report = { generatedAt: new Date().toISOString(), criteria: 'Engineering regressions; not clinical, laboratory or Android-device certification',
    summary: { total: results.length, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status !== 'PASS').length }, results };
  fs.writeFileSync(path.resolve(__dirname, '../docs/scientific-followup-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary)); for (const row of results.filter(row => row.status !== 'PASS')) console.log(row.name, row.error);
  process.exitCode = report.summary.failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
