// Only complete analysis windows belong to a selection. A frame centre is not its support.
function addSupport(track, windowSeconds, filterMarginSeconds = 0) {
  for (const row of track) row.support = {
    start: row.time - windowSeconds / 2 - filterMarginSeconds,
    end: row.time + windowSeconds / 2 + filterMarginSeconds,
  };
  return track;
}

function containedFrames(track, start, end, fallbackWindowSeconds = 0) {
  return (track || []).filter(row => {
    const support = row.support || { start: row.time - fallbackWindowSeconds / 2,
      end: row.time + fallbackWindowSeconds / 2 };
    return support.start >= start - 1e-9 && support.end <= end + 1e-9;
  });
}

function supportCrossesBoundary(row, boundaries) {
  if (!row || !row.support || !Array.isArray(boundaries) || !boundaries.length) return false;
  return boundaries.some(boundary => Number.isFinite(boundary)
    && row.support.start < boundary && row.support.end > boundary);
}

// Rasterize at actual STFT centre times. Never stretch the first/last frame to recording edges.
function spectrumFramesAtTime(times, start, end) {
  if (!times.length) return [0, 0];
  const lowerBound = time => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] < time) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const first = lowerBound(start), last = lowerBound(end);
  if (last > first) return [first, last];
  // At high zoom choose the nearest centre, but only within half of one hop.
  const centre = (start + end) / 2;
  const candidates = [first - 1, first].filter(i => i >= 0 && i < times.length);
  const nearest = candidates.reduce((best, i) => best < 0 || Math.abs(times[i] - centre) < Math.abs(times[best] - centre) ? i : best, -1);
  const halfHop = times.length > 1 ? (times[1] - times[0]) / 2 : 0;
  return nearest >= 0 && Math.abs(times[nearest] - centre) <= halfHop + 1e-9
    ? [nearest, nearest + 1] : [0, 0];
}

module.exports = { addSupport, containedFrames, spectrumFramesAtTime, supportCrossesBoundary };
