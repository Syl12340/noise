'use strict';
function attachFull({e,call,input,range,result,discarded}) {
  const object = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
    && Object.keys(v).every(k => keys.includes(k));
  const unshared = v => Object.prototype.toString.call(v.buffer) === '[object ArrayBuffer]';
  function handle(h) {
    if (!Number.isInteger(h) || h < 1 || h > 0xffffffff) throw new TypeError('Invalid full handle');
  }
  function invalid(message) { discarded(true); throw new Error(message); }
  function begin(pcm, opts = {}) {
    if (typeof e.speech_full_abi_version !== 'function' || call('speech_full_abi_version', []) !== 1)
      throw new Error('Build lacks full speech');
    if (!object(opts, ['sampleRate','parameters','discontinuityBoundariesSeconds'])) throw new TypeError('Invalid full options');
    const {sampleRate = 44100, parameters = {}, discontinuityBoundariesSeconds: cuts = new Float64Array()} = opts;
    if (!object(parameters, ['lpcOrder','maxFormant','windowMs','task'])) throw new TypeError('Invalid full parameters');
    const {lpcOrder = 12, maxFormant = 5000, windowMs = 25, task = 'sustained'} = parameters;
    if (![12000,16000,22050,24000,32000,44100,48000].includes(sampleRate)
      || ![8,10,12,14].includes(lpcOrder) || ![4000,4500,5000,5500,6000,7000,8000].includes(maxFormant)
      || ![25,40].includes(windowMs) || !['sustained','connected'].includes(task)
      || maxFormant + 1000 > sampleRate / 2 || !(cuts instanceof Float64Array) || !unshared(cuts) || cuts.length > 4096
      || !(pcm instanceof Int16Array) || !unshared(pcm) || !pcm.length || pcm.length > 262144 || pcm.length > 5.25 * sampleRate)
      throw new TypeError('Invalid full configuration');
    input(pcm, Int16Array, 262144, 'speech_pcm_ptr');
    try {
      const ptr = call('speech_frame_ptr', []);
      new Float64Array(range(ptr, cuts.byteLength, 8), ptr, cuts.length).set(cuts);
    } catch (error) { discarded(true); throw error; }
    const receipt = result('speech_full_begin', [pcm.length,sampleRate,lpcOrder,maxFormant,windowMs,task === 'connected' ? 1 : 0,cuts.length], 1);
    try { handle(receipt.handle); } catch (_) { invalid('Invalid full receipt'); }
    return receipt;
  }
  function next(h) {
    handle(h); const p = result('speech_full_next', [h], 1);
    if (!p || !['centered','pitch-resample','pitch','hnr','formant-resample','formants','spectrogram','intensity','complete'].includes(p.stage)
      || !Number.isInteger(p.segmentIndex) || p.segmentIndex < 0 || p.segmentIndex > 128
      || !Number.isInteger(p.completed) || !Number.isInteger(p.total) || p.completed < 0 || p.completed > p.total
      || p.total > 262144 || typeof p.done !== 'boolean') invalid('Invalid full progress');
    return p;
  }
  function cancel(h) {
    handle(h); const code = call('speech_full_cancel', [h]);
    if (code !== 0) { const error = new Error('Full cancel ' + code); error.code = code; throw error; }
  }
  function invalidMeta(meta) {
    const c = meta && meta.counts;
    return !c || !['pitch','formants','intensity','hnr','spectra'].every(k => Number.isInteger(c[k]) && c[k] >= 0 && c[k] <= (k === 'spectra' ? 2929 : 4096))
      || meta.profile !== 'pcm-speech-v2' || !meta.harmonicity || !meta.spectrogram
      || meta.spectrogram.height !== 512 || meta.spectrogram.width !== c.spectra
      || !Array.isArray(meta.spectrogram.times) || meta.spectrogram.times.length !== c.spectra
      || !meta.spectrogram.times.every((v,i,a) => Number.isFinite(v) && (i === 0 || v > a[i-1]))
      || !Number.isFinite(meta.duration) || meta.duration <= 0 || meta.duration > 5.25
      || ![12000,16000,22050,24000,32000,44100,48000].includes(meta.sampleRate);
  }
  function metadata(h) {
    handle(h); const meta = result('speech_full_finish', [h], 1);
    if (invalidMeta(meta)) invalid('Invalid full metadata');
    const counts = meta.counts; delete meta.counts;
    meta.signal = result('speech_full_read', [h,0,0], 2);
    if (meta.signal.length !== Math.round(meta.duration * meta.sampleRate)) invalid('Invalid full signal length');
    meta.pitchTrack = []; meta.formantTracks = []; meta.intensityTrack = []; meta.harmonicity.track = []; meta.spectrogram.data = [];
    meta.spectrogram.times = Float64Array.from(meta.spectrogram.times);
    return {meta, counts};
  }
  function* reads(h, meta, counts) {
    for (const [rows,kind,count] of [[meta.pitchTrack,1,counts.pitch],[meta.formantTracks,2,counts.formants],
      [meta.intensityTrack,3,counts.intensity],[meta.harmonicity.track,4,counts.hnr],[meta.spectrogram.data,5,counts.spectra]]) {
      for (let i = 0; i < count; i++) {
        const row = result('speech_full_read', [h,kind,i], kind === 5 ? 2 : 1);
        if (kind === 5 ? row.length !== 512 : !row || !Number.isFinite(row.time)) invalid('Invalid full row');
        rows.push(row); yield null;
      }
    }
  }
  function finish(h) {
    const {meta,counts} = metadata(h);
    for (const _ of reads(h,meta,counts)) { /* Copy before each acknowledgment. */ }
    return meta;
  }
  async function full(pcm, opts = {}, hooks = {}) {
    if (!object(hooks, ['yieldFn','onProgress','isCanceled'])) throw new TypeError('Invalid full hooks');
    const {yieldFn = () => new Promise(r => setTimeout(r,0)), onProgress = () => {}, isCanceled = () => false} = hooks;
    if (![yieldFn,onProgress,isCanceled].every(f => typeof f === 'function')) throw new TypeError('Invalid full hooks');
    const check = () => { if (isCanceled()) { const error = new Error('Full speech canceled'); error.name = 'AbortError'; throw error; } };
    check(); const h = begin(pcm,opts).handle;
    try {
      let done = false;
      while (!done) {
        check(); const p = next(h); done = p.done; await onProgress(p); check();
        if (!done) await yieldFn();
      }
      check(); const {meta,counts} = metadata(h); let copied = 0;
      for (const _ of reads(h,meta,counts)) {
        if (++copied % 128 === 0) { await yieldFn(); check(); }
      }
      check(); return meta;
    } finally { if (!discarded()) cancel(h); }
  }
  function burg(frame, order = 12) {
    if (!Number.isInteger(order) || order < 0 || order > 32 || !(frame instanceof Float64Array) || !unshared(frame)) throw new TypeError('Invalid LPC input');
    input(frame, Float64Array, 4096, 'speech_frame_ptr'); return result('speech_full_burg', [frame.length,order], 1);
  }
  function roots(coeff) {
    if (!(coeff instanceof Float64Array) || !unshared(coeff)) throw new TypeError('Invalid polynomial input');
    input(coeff, Float64Array, 33, 'speech_frame_ptr'); return result('speech_full_roots', [coeff.length], 1);
  }
  return {fullBegin:begin,fullNext:next,fullFinish:finish,fullCancel:cancel,analyzePcmSpeech:full,burgLpc:burg,findPolynomialRoots:roots};
}
module.exports = {attachFull};
