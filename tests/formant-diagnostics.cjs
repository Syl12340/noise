'use strict';
// Layered observations; acceptance limits are kept in the frozen validation suites.
const fs = require('node:fs'), path = require('node:path');
const { formantTrack } = require('../utils/phonetic/formant-extract');
const { yinPitchTrack } = require('../utils/phonetic/yin-pitch');
const { emphasizeFloat } = require('../utils/phonetic/resample');
const { runtime } = require('./runtime.cjs');
function vowel(f0, duration = 1, rate = 12000) {
  let signal = Float64Array.from({ length: Math.round(duration * rate) }, (_, i) => i % (rate / f0) === 0 ? 1 : 0);
  for (const [frequency, bandwidth] of [[500, 80], [1500, 120], [2500, 180]]) {
    const radius = Math.exp(-Math.PI * bandwidth / rate);
    const b1 = -2 * radius * Math.cos(2 * Math.PI * frequency / rate), b2 = radius * radius;
    const filtered = new Float64Array(signal.length);
    for (let i = 0; i < signal.length; i++) filtered[i] = signal[i] - (i ? b1 * filtered[i - 1] : 0) - (i > 1 ? b2 * filtered[i - 2] : 0);
    signal = filtered;
  }
  const rms = Math.sqrt(signal.reduce((sum, value) => sum + value * value, 0) / signal.length);
  signal = signal.map(value => value * .1 / rms);
  const tilted = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) tilted[i] = signal[i] + (i ? .97 * tilted[i - 1] : 0);
  return tilted;
}
const observations = [100, 200, 400].map(f0 => {
  const signal = vowel(f0), pitchTrack = yinPitchTrack(signal, 12000, { frameSize: 1024, hopSize: 120, fmin: 40, fmax: 1200 });
  const track = formantTrack(emphasizeFloat(signal), 12000, { pitchTrack });
  const central = track.filter(row => row.time >= .1 && row.time <= .9);
  return { f0, pitchMedian: pitchTrack.filter(row => row.f0 > 0).map(row => row.f0).sort((a, b) => a - b)[Math.floor(pitchTrack.length / 2)],
    reasons: Object.fromEntries(['F1', 'F2', 'F3'].map(key => [key, central.reduce((counts, row) => {
      const reason = row.reason || row.quality[key].reason; counts[reason] = (counts[reason] || 0) + 1; return counts;
    }, {})])), middleFrame: central[Math.floor(central.length / 2)] };
});
for (const observation of observations) console.log(JSON.stringify({ f0: observation.f0, pitchMedian: observation.pitchMedian, reasons: observation.reasons }));
const validation = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/formant-validation-results.json'), 'utf8'));
for (const entry of validation.cases.filter(entry => entry.stats.some(slot => slot.wrongAcceptedFrames > 0))) {
  console.log(JSON.stringify({ diagnostic: 'frozen-grid-wrong-accepted', f0: entry.f0, poles: entry.poles,
    wrongAcceptedFrames: entry.stats.map(slot => slot.wrongAcceptedFrames) }));
}
const windowExperiments = [];
for (const frameSize of [300, 600]) {
  const env = runtime({ 'utils/phonetic/frame-segment.js': { segmentFrames(signal, size, hop) {
    const frames = [];
    for (let start = 0; start + size <= signal.length; start += hop) frames.push(Float64Array.from({ length: size }, (_, i) =>
      signal[start + i] * (Math.exp(-48 * ((i - (size - 1) / 2) / size) ** 2) - Math.exp(-12)) / (1 - Math.exp(-12))));
    return frames;
  } } });
  for (const f0 of [100, 200, 400]) {
    const signal = vowel(f0), pitchTrack = yinPitchTrack(signal, 12000, { frameSize: 1024, hopSize: 120, fmin: 40, fmax: 1200 });
    const track = env.load('utils/phonetic/formant-extract.js').formantTrack(emphasizeFloat(signal), 12000, { frameSize, pitchTrack }).filter(row => row.time >= .1 && row.time <= .9);
    const experiment = { diagnostic: 'gaussian-window', physicalWindowMs: frameSize / 12, f0,
      slots: ['F1', 'F2', 'F3'].map(key => {
        const values = track.map(row => row[key].freq).filter(value => value > 0).sort((a, b) => a - b);
        return { coverage: values.length / track.length, median: values[Math.floor(values.length / 2)] || null };
      }) };
    windowExperiments.push(experiment);
    console.log(JSON.stringify(experiment));
  }
}
fs.writeFileSync(path.join(__dirname, '../docs/formant-diagnostics-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  criterion: 'Layered diagnostics, not independent Praat execution or clinical validation; no acceptance threshold changes',
  observations, windowExperiments,
  frozenGridWrongAcceptedCases: validation.cases.filter(entry => entry.stats.some(slot => slot.wrongAcceptedFrames > 0)) }, null, 2) + '\n');
