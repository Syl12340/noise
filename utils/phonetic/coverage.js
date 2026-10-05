const { PHONETIC_CONFIG: C } = require('./phonetic-config');
const { countFrames } = require('./frame-segment');
const { containedFrames } = require('./time-support');

// The denominator represents possible windows in received PCM, including
// windows for which a segment failed. It never depends on retained track rows.
function summarizeCoverage(sampleCount, sampleRate, parameters, pitchTrack, formantTracks, segments, range = null) {
  const start = range ? range.start : 0, end = range ? range.end : sampleCount / sampleRate;
  const formantRate = 2 * (parameters.maxFormant + 1000);
  const pitchWindow = C.PITCH_FRAME_SIZE / C.ANALYSIS_SAMPLE_RATE;
  const formantSize = Math.round(formantRate * parameters.windowMs / 1000);
  const formantWindow = formantSize / formantRate;
  const selectedPitch = range ? containedFrames(pitchTrack, start, end, pitchWindow) : pitchTrack;
  const selectedFormants = range ? containedFrames(formantTracks, start, end, formantWindow) : formantTracks;
  const count = (rate, size, hop) => {
    const total = countFrames(range ? Math.floor((end - start) * rate + 1e-7)
      : Math.floor(sampleCount * rate / sampleRate), size, hop);
    const inSegment = segment => {
      const origin = segment.startSample / sampleRate;
      const n = Math.floor((segment.endSample - segment.startSample) * rate / sampleRate);
      const available = countFrames(n, size, hop);
      const first = Math.max(0, Math.ceil(((start - origin) * rate - 1e-7) / hop));
      const last = Math.min(available - 1, Math.floor(((end - origin) * rate - size + 1e-7) / hop));
      return Math.max(0, last - first + 1);
    };
    const inSegments = segments.reduce((sum, segment) => sum + inSegment(segment), 0);
    return { total, excluded: Math.max(0, total - inSegments),
      failed: segments.filter(segment => segment.status === 'failed').reduce((sum, segment) => sum + inSegment(segment), 0) };
  };
  const pitch = count(C.ANALYSIS_SAMPLE_RATE, C.PITCH_FRAME_SIZE, C.ANALYSIS_HOP_SIZE);
  const formant = count(formantRate, formantSize, Math.round(formantRate * .01));
  return { denominator: 'ideal-continuous-received-pcm',
    pitchTotal: pitch.total, pitchComputed: selectedPitch.length,
    pitchExcludedBoundary: pitch.excluded, pitchFailedSegment: pitch.failed,
    pitchInvalidInput: selectedPitch.filter(row => ['clipped-input', 'capture-gap-boundary', 'incomplete-filter-support'].includes(row.reason)).length,
    pitchAccepted: selectedPitch.filter(row => row.f0 > 0).length,
    formantTotal: formant.total, formantComputed: selectedFormants.length,
    formantExcludedBoundary: formant.excluded, formantFailedSegment: formant.failed,
    formantInvalidInput: selectedFormants.filter(row => ['clipped-input', 'capture-gap-boundary'].includes(row.reason)).length,
    formantsAccepted: ['F1', 'F2', 'F3'].map(key => selectedFormants.filter(row => row[key].freq > 0).length),
    formantsExploratory: ['F1', 'F2', 'F3'].map(key => selectedFormants.filter(row => row.exploratory && row.exploratory[key]).length) };
}

function selectionCoverage(result, start, end) {
  const parameters = result.parameters;
  const rate = result.sampleRate || parameters && parameters.sampleRate;
  if (!parameters || !Number.isFinite(rate) || !Number.isFinite(result.duration)) {
    const pitch = containedFrames(result.pitchTrack, start, end, C.PITCH_FRAME_SIZE / C.ANALYSIS_SAMPLE_RATE);
    const formants = containedFrames(result.formantTracks, start, end, .025);
    return { denominator: 'unavailable-metadata', pitchTotal: null, formantTotal: null,
      pitchComputed: pitch.length, formantComputed: formants.length,
      pitchExcludedBoundary: null, formantExcludedBoundary: null, pitchFailedSegment: null, formantFailedSegment: null,
      pitchInvalidInput: null, formantInvalidInput: null };
  }
  const sampleCount = Math.round(result.duration * rate);
  const segments = result.analysisSegments || [{ startSample: 0, endSample: sampleCount, status: 'analyzed' }];
  return summarizeCoverage(sampleCount, rate, parameters, result.pitchTrack, result.formantTracks, segments, { start, end });
}
module.exports = { summarizeCoverage, selectionCoverage };
