const { containedFrames } = require('./time-support');

function overlayTracks(whole, independent) {
  const tracks = {};
  for (const key of ['pitchTrack', 'formantTracks', 'intensityTrack']) {
    if (!independent || !independent.selection) { tracks[key] = whole[key] || []; continue; }
    const { start, end } = independent.selection;
    const outside = (whole[key] || []).filter(row => {
      const support = row.support || { start: row.time, end: row.time };
      return support.end < start || support.start > end;
    }).map(row => ({ ...row, displaySource: 'whole' }));
    const inside = containedFrames(independent[key], start, end)
      .map(row => ({ ...row, displaySource: 'selection' }));
    tracks[key] = outside.concat(inside).sort((a, b) => a.time - b.time);
  }
  return tracks;
}

function canConnectFrames(previous, current, hopSeconds = .01) {
  return !!previous && Number.isFinite(previous.time) && Number.isFinite(current.time)
    && current.time > previous.time && current.time - previous.time <= hopSeconds * 1.5 + 1e-9
    && previous.segmentIndex === current.segmentIndex && previous.displaySource === current.displaySource;
}
module.exports = { overlayTracks, canConnectFrames };
