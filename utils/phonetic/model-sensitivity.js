// Optional independent analysis. Agreement never upgrades a missing/candidate
// value; disagreement can only downgrade an already accepted value.
async function assessModelSensitivity(pcm, sampleRate, result, options, analyze) {
  const base = result.parameters;
  const ceilings = [4000, 4500, 5000, 5500, 6000, 7000, 8000]
    .filter(ceiling => ceiling !== base.maxFormant && ceiling + 1000 <= sampleRate / 2)
    .sort((a, b) => Math.abs(a - base.maxFormant) - Math.abs(b - base.maxFormant)).slice(0, 2);
  const variants = ceilings.map(maxFormant => ({ ...base, maxFormant }));
  variants.push({ ...base, windowMs: base.windowMs === 25 ? 40 : 25 });
  const models = [];
  for (let i = 0; i < variants.length; i++) {
    if (options.isCancelled && options.isCancelled()) { const error = new Error('分析已取消'); error.name = 'AbortError'; throw error; }
    const model = await analyze(pcm, sampleRate, { ...options, includeSensitivity: false,
      parameters: variants[i], onProgress: options.onProgress ? (stage, percent) =>
        options.onProgress('参数敏感性复核：' + stage, Math.round((i + percent / 100) / variants.length * 100)) : undefined });
    models.push(model);
  }
  const cursors = models.map(() => 0);
  let downgraded = 0;
  for (const row of result.formantTracks) {
    const matched = models.map((model, index) => {
      const rows = model.formantTracks;
      while (cursors[index] + 1 < rows.length && Math.abs(rows[cursors[index] + 1].time - row.time)
        < Math.abs(rows[cursors[index]].time - row.time)) cursors[index]++;
      const other = rows[cursors[index]];
      return other && Math.abs(other.time - row.time) <= .01 ? other : null;
    });
    row.sensitivity = {};
    row.sensitivityModels = models.map((model, index) => ({
      maxFormant: model.parameters.maxFormant, windowMs: model.parameters.windowMs,
      effectiveFormantOrder: model.parameters.effectiveFormantOrder,
      time: matched[index] ? matched[index].time : null,
      modelCandidates: matched[index] && matched[index].modelCandidates || [],
    }));
    for (const key of ['F1', 'F2', 'F3']) {
      const candidate = row[key];
      const frequencies = matched.map(other => other && other[key].freq > 0 ? other[key].freq : null);
      const stable = candidate.freq > 0 && frequencies.every(frequency => frequency !== null
        && Math.abs(Math.log(frequency / candidate.freq)) <= Math.log(1.1));
      row.sensitivity[key] = { stable, frequenciesHz: frequencies,
        criterion: '10-percent-parameter-correspondence-not-accuracy' };
      if (candidate.freq > 0 && !stable) {
        row.exploratory = row.exploratory || {};
        row.exploratory[key] = { ...candidate, reason: 'parameter-sensitive', quantitativeUseValidated: false };
        row[key] = { freq: 0, bandwidth: 0 };
        row.quality[key] = { ...row.quality[key], reason: 'parameter-sensitive' };
        downgraded++;
      }
    }
    // Sensitivity decisions include every input/tracker context they consulted.
    for (const other of matched.filter(Boolean)) for (const key of ['support', 'decisionSupport']) {
      if (other[key] && row[key]) {
        row[key].start = Math.min(row[key].start, other[key].start);
        row[key].end = Math.max(row[key].end, other[key].end);
      }
    }
  }
  result.coverage.formantsAccepted = ['F1', 'F2', 'F3'].map(key => result.formantTracks.filter(row => row[key].freq > 0).length);
  result.coverage.formantsExploratory = ['F1', 'F2', 'F3'].map(key => result.formantTracks.filter(row => row.exploratory && row.exploratory[key]).length);
  result.modelSensitivity = { classification: 'experimental', downgraded, variants: models.map(model => ({
    maxFormant: model.parameters.maxFormant, windowMs: model.parameters.windowMs,
    formantAnalysisRate: model.parameters.formantAnalysisRate, effectiveFormantOrder: model.parameters.effectiveFormantOrder })),
    note: 'Residuals and parameter stability are diagnostic evidence only; common model bias and sparse harmonics remain possible.' };
  return result;
}
module.exports = { assessModelSensitivity };
