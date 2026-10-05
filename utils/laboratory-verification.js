// Optional external laboratory observations. No automatic response correction,
// grade upgrade, expiry extension, or recording gate is derived from this data.
function comparisonConditions(input, captureProfile) {
  const weighting = value => ['A', 'C', 'Z'].includes(value) ? value : 'unspecified';
  const seconds = value => Number.isFinite(value) && value > 0 ? value : null;
  const referenceWeighting = weighting(input.referenceWeighting), measuredWeighting = weighting(input.measuredWeighting);
  const referenceIntegrationSeconds = seconds(input.referenceIntegrationSeconds === undefined ? input.integrationSeconds : input.referenceIntegrationSeconds);
  const measuredIntegrationSeconds = seconds(input.measuredIntegrationSeconds === undefined ? input.integrationSeconds : input.measuredIntegrationSeconds);
  const reasons = [];
  if (referenceWeighting === 'unspecified' || measuredWeighting === 'unspecified') reasons.push('weighting-unspecified');
  else if (referenceWeighting !== measuredWeighting) reasons.push('weighting-mismatch');
  if (typeof input.captureProfile !== 'string' || !input.captureProfile) reasons.push('capture-profile-unspecified');
  else if (input.captureProfile !== captureProfile) reasons.push('capture-profile-mismatch');
  if (!referenceIntegrationSeconds || !measuredIntegrationSeconds) reasons.push('integration-unspecified');
  else if (referenceIntegrationSeconds !== measuredIntegrationSeconds) reasons.push('integration-mismatch');
  if (typeof input.inputChain !== 'string' || !input.inputChain.trim()) reasons.push('input-chain-unspecified');
  const comparable = reasons.length === 0;
  return { referenceWeighting, measuredWeighting, referenceIntegrationSeconds, measuredIntegrationSeconds,
    comparability: { comparable, reasons, basis: 'user-declared-conditions-only', captureChainVerified: false } };
}

function assessLaboratoryVerification(input, offset, captureProfile) {
  if (!input || !Array.isArray(input.points) || !input.points.length || input.points.length > 200
    || !Number.isFinite(offset)) throw new Error('需要 1–200 个实验室复核点');
  const conditions = comparisonConditions(input, captureProfile);
  const comparable = conditions.comparability.comparable;
  const points = input.points.map(point => {
    const { frequencyHz, referenceLevelDb, measuredDbfs } = point;
    if (![frequencyHz, referenceLevelDb, measuredDbfs].every(Number.isFinite)
      || frequencyHz < 20 || frequencyHz > 20000 || referenceLevelDb < 20 || referenceLevelDb > 140
      || measuredDbfs > 0 || measuredDbfs < -160) throw new Error('频率、参考声级或 dBFS 数据无效');
    if (point.uncertaintyDb !== undefined && point.uncertaintyDb !== null
      && (!Number.isFinite(point.uncertaintyDb) || point.uncertaintyDb < 0)) throw new Error('不确定度无效');
    const uncertaintyDb = Number.isFinite(point.uncertaintyDb) ? point.uncertaintyDb : null;
    return { frequencyHz, referenceLevelDb, measuredDbfs, uncertaintyDb,
      rawDifferenceDb: measuredDbfs + offset - referenceLevelDb,
      residualDb: comparable ? measuredDbfs + offset - referenceLevelDb : null,
      measuredAt: typeof point.measuredAt === 'string' ? point.measuredAt.slice(0, 80) : null };
  });
  const frequencies = [...new Set(points.map(point => point.frequencyHz))].sort((a, b) => a - b);
  const levels = [...new Set(points.map(point => point.referenceLevelDb))].sort((a, b) => a - b);
  const frequencyGroups = frequencies.map(frequencyHz => {
    const rows = points.filter(point => point.frequencyHz === frequencyHz);
    const x = rows.reduce((sum, row) => sum + row.referenceLevelDb, 0) / rows.length;
    const y = rows.reduce((sum, row) => sum + row.measuredDbfs, 0) / rows.length;
    const xx = rows.reduce((sum, row) => sum + (row.referenceLevelDb - x) ** 2, 0);
    const xy = rows.reduce((sum, row) => sum + (row.referenceLevelDb - x) * (row.measuredDbfs - y), 0);
    return { frequencyHz, testedLevelsDb: [...new Set(rows.map(row => row.referenceLevelDb))].sort((a, b) => a - b),
      meanRawDifferenceDb: rows.reduce((sum, row) => sum + row.rawDifferenceDb, 0) / rows.length,
      rawLevelResponseSlope: xx > 0 ? xy / xx : null,
      meanResidualDb: comparable ? rows.reduce((sum, row) => sum + row.residualDb, 0) / rows.length : null,
      levelResponseSlope: comparable && xx > 0 ? xy / xx : null };
  });
  return { schemaVersion: 2, source: 'user-imported-laboratory-observations', recordedAt: Date.now(),
    offsetUsed: offset, captureProfile: typeof input.captureProfile === 'string' ? input.captureProfile.slice(0, 300) : null,
    currentCaptureProfile: captureProfile, captureProfileMatches: input.captureProfile === captureProfile,
    inputChain: typeof input.inputChain === 'string' ? input.inputChain.slice(0, 500) : '',
    referenceInstrument: typeof input.referenceInstrument === 'string' ? input.referenceInstrument.slice(0, 500) : '',
    ...conditions,
    integrationSeconds: Number.isFinite(input.integrationSeconds) && input.integrationSeconds > 0 ? input.integrationSeconds : null,
    frequenciesHz: frequencies, levelsDb: levels, frequencyGroups, points,
    maxAbsoluteRawDifferenceDb: Math.max(...points.map(point => Math.abs(point.rawDifferenceDb))),
    maxAbsoluteResidualDb: comparable ? Math.max(...points.map(point => Math.abs(point.residualDb))) : null,
    multiFrequencyAndLevel: frequencies.length >= 3 && frequencyGroups.every(group => group.testedLevelsDb.length >= 2),
    uncertaintyStatement: typeof input.uncertaintyStatement === 'string' ? input.uncertaintyStatement.slice(0, 1000) : '',
    frequencyResponseVerification: 'observed-discrete-points-only',
    compensationApplied: false, quantitativeUseValidated: false,
    scope: 'Only listed frequency-level points; no interpolation, broadband certification or clinical accuracy claim.' };
}

// Presentation only: never mutate imported reports or re-evaluate old presets.
function describeLaboratoryVerification(report, currentOffset, currentProfile, saved = true) {
  if (!report || !Array.isArray(report.points) || !Array.isArray(report.frequenciesHz)
    || !Array.isArray(report.levelsDb)) return '历史复核元数据已保留，当前未生成测点摘要。';
  const reasons = { 'weighting-unspecified': '计权未说明', 'weighting-mismatch': '计权不一致',
    'capture-profile-unspecified': '采集配置未说明', 'capture-profile-mismatch': '采集配置不一致',
    'integration-unspecified': '积分时长未说明', 'integration-mismatch': '积分时长不一致',
    'input-chain-unspecified': '输入链未说明' };
  // A serialized derived flag is not enough to establish comparable conditions.
  // This affects the description only; imported calibration data stay untouched.
  const declared = comparisonConditions(report, report.currentCaptureProfile);
  const comparison = report.comparability && report.comparability.comparable === true
    ? declared.comparability : report.comparability;
  const raw = Number.isFinite(report.maxAbsoluteRawDifferenceDb) ? report.maxAbsoluteRawDifferenceDb : report.maxAbsoluteResidualDb;
  const offsetMatches = Number.isFinite(report.offsetUsed) && report.offsetUsed === currentOffset;
  const profileMatches = typeof report.captureProfile === 'string' && report.captureProfile === currentProfile;
  const originalComparable = comparison && comparison.comparable === true && Number.isFinite(report.maxAbsoluteResidualDb);
  const metric = originalComparable ? (offsetMatches && profileMatches ? '声明条件下最大绝对残差 ' : '原条件最大绝对残差 ')
    + report.maxAbsoluteResidualDb.toFixed(2) + ' dB'
    : Number.isFinite(raw) ? '原始读数差最大绝对值 ' + raw.toFixed(2) + ' dB（不作为可比较校准残差）' : '尚无可比较残差摘要';
  const note = originalComparable ? '仅按声明条件比较，采集链未经实测验证。'
    : '条件说明：' + (comparison && Array.isArray(comparison.reasons)
      ? comparison.reasons.map(reason => reasons[reason] || '测量条件未知').join('、') : '历史报告未记录可比性') + '。';
  const offset = Number.isFinite(report.offsetUsed) ? report.offsetUsed.toFixed(2) + ' dB' : '未说明';
  const date = Number.isFinite(report.recordedAt) ? new Date(report.recordedAt).toLocaleDateString() : '未说明';
  return (saved ? '已保存 ' : '未保存摘要：') + report.points.length + ' 个外部复核点，频率 ' + report.frequenciesHz.join('/') +
    ' Hz，声级 ' + report.levelsDb.join('/') + ' dB；' + metric + '。' + note +
    '原偏移量 ' + offset + '，报告日期 ' + date + '；参考/测量计权 ' + (report.referenceWeighting || '未说明') + '/' +
    (report.measuredWeighting || '未说明') + '；原采集配置 ' + (report.captureProfile || '未说明') + '。' +
    '参考/测量积分 ' + (declared.referenceIntegrationSeconds || '未说明') + '/' +
    (declared.measuredIntegrationSeconds || '未说明') + ' s，输入链 ' + (report.inputChain || '未说明') + '。' +
    (!offsetMatches || !profileMatches ? '历史或其他条件证据，当前参数未经本报告复核。' : '') +
    '仅适用于所列测点；不自动补偿、不改变校准等级或检测可用性。';
}

function laboratoryVerificationHistory(meta = {}) {
  const history = Array.isArray(meta.laboratoryVerificationHistory) ? meta.laboratoryVerificationHistory.slice() : [];
  const latest = meta.laboratoryVerification;
  if (latest && !history.some(report => JSON.stringify(report) === JSON.stringify(latest))) history.push(latest);
  return history;
}
module.exports = { assessLaboratoryVerification, describeLaboratoryVerification, laboratoryVerificationHistory };
