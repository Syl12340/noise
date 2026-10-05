const { analyzePcm } = require('./analysis');
async function analyzeSelection(rawPcm, sampleRate, startSeconds, endSeconds, options = {}) {
  if (!(rawPcm instanceof Int16Array) || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
    || startSeconds < 0 || endSeconds > rawPcm.length / sampleRate || endSeconds - startSeconds < .01) {
    throw new Error('选区或原始录音无效');
  }
  const start = Math.round(startSeconds * sampleRate), end = Math.round(endSeconds * sampleRate);
  const shift = start / sampleRate;
  const cuts = (options.discontinuityBoundariesSeconds || []).filter(cut => cut > shift && cut < end / sampleRate)
    .map(cut => cut - shift);
  const result = await analyzePcm(rawPcm.slice(start, end), sampleRate, { ...options, discontinuityBoundariesSeconds: cuts });
  for (const track of [result.pitchTrack, result.formantTracks, result.intensityTrack, result.harmonicity.track])
    for (const row of track) {
      row.time += shift;
      for (const model of row.sensitivityModels || []) if (Number.isFinite(model.time)) model.time += shift;
      for (const key of ['support', 'decisionSupport']) if (row[key]) {
        row[key].start += shift; row[key].end += shift;
      }
    }
  result.invalidIntervals = result.invalidIntervals.map(interval => ({ ...interval, start: interval.start + shift, end: interval.end + shift }));
  result.spectrogram.times = Float64Array.from(result.spectrogram.times, time => time + shift);
  if (result.analysisSegments) result.analysisSegments = result.analysisSegments.map(segment => ({ ...segment,
    start: segment.start + shift, end: segment.end + shift,
    startSample: segment.startSample + start, endSample: segment.endSample + start }));
  result.parameters.discontinuityBoundariesSeconds = cuts.map(cut => cut + shift);
  result.selection = { start: shift, end: end / sampleRate, method: 'independent-raw-pcm',
    requestedStart: startSeconds, requestedEnd: endSeconds, resetDspAndTracker: true };
  return result;
}
module.exports = { analyzeSelection };
