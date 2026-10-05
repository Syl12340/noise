'use strict';
// Reference times come from frozen input length and explicitly declared test
// parameters, never from a production output array or coverage metadata.
function referenceFormantGrid(sampleCount, inputRate, parameters = {}) {
  const ceiling = parameters.maxFormant === undefined ? 5000 : parameters.maxFormant;
  const windowMs = parameters.windowMs === undefined ? 25 : parameters.windowMs;
  const rate = 2 * (ceiling + 1000), size = Math.round(rate * windowMs / 1000);
  const hop = Math.round(rate * .01), length = Math.floor(sampleCount * rate / inputRate);
  const times = [];
  for (let start = 0; start + size <= length; start += hop) {
    const time = (start + size / 2) / rate;
    if (time >= .1 - 1e-12 && time <= .4 + 1e-12) times.push(time);
  }
  return times;
}

function alignReferenceRows(track, times) {
  const rows = new Array(times.length).fill(null);
  let unexpectedRows = 0, duplicateRows = 0;
  for (const row of track) {
    if (row.time < .1 - 1e-12 || row.time > .4 + 1e-12) continue;
    let index = -1;
    for (let i = 0; i < times.length; i++) if (Math.abs(row.time - times[i]) <= 1e-7) { index = i; break; }
    if (index < 0) unexpectedRows++;
    else if (rows[index]) duplicateRows++;
    else rows[index] = row;
  }
  return { rows, missingRows: rows.filter(row => !row).length, duplicateRows, unexpectedRows };
}

module.exports = { referenceFormantGrid, alignReferenceRows };
