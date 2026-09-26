// utils/phonetic/formant-extract.js
// 从 LPC 系数提取共振峰 F1, F2, F3

const { burgLPC } = require('./burg-lpc');
const { findRoots } = require('./poly-roots');

/**
 * 从 LPC 系数中提取共振峰。
 * 流程：剔除分析频率范围外的根；范围内宽带候选保留编号但不输出数值。
 * @param {Float64Array} a - LPC 系数 [a0=1, a1, ..., ap]
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {number} [options.minFreq=90] - 共振峰最低频率 (Hz)
 * @param {number} [options.maxFreq=5000] - 共振峰最高频率 (Hz)
 * @param {number} [options.maxBandwidth=500] - 最大带宽 (Hz)
 * @returns {{ F1: object, F2: object, F3: object }} 共振峰对象
 */
function extractFormantsFromLPC(a, sampleRate, options = {}) {
  const {
    minFreq = 90,
    maxFreq = 5000,
    maxBandwidth = 500,
  } = options;

  // LPC 多项式系数：A(z) = a0 + a1*z^-1 + ... + ap*z^-p
  // findRoots 期望 [a0, a1, ..., ap]
  const roots = findRoots(a);

  const formants = [];
  for (const root of roots) {
    const mag = Math.sqrt(root.re * root.re + root.im * root.im);

    // 只取单位圆内的根（稳定的极点）
    if (!Number.isFinite(mag)) throw new Error('共振峰根无效');
    if (mag >= 1.0 || mag < 1e-10) continue;

    // 只取上半平面（避免共轭对重复计数）
    if (root.im <= 0) continue;

    // 转换为频率 Hz
    const freq = Math.atan2(root.im, root.re) * sampleRate / (2 * Math.PI);

    // 转换为带宽 Hz
    const bandwidth = -Math.log(mag) * sampleRate / Math.PI;

    // 筛选合理范围
    // 先保留带宽不合格的候选位置，不能删除后让高阶峰递补。
    if (freq > 0) {
      formants.push({ freq: Math.round(freq * 10) / 10, bandwidth: Math.round(bandwidth * 10) / 10 });
    }
  }

  // 按频率升序排序
  formants.sort((a, b) => a.freq - b.freq);
  const rawCandidates = formants.filter(formant => (
    formant.freq >= minFreq
    && formant.freq <= maxFreq
  ));
  // 根的带宽与间距不能证明其为伪根；保留完整顺序及候选证据。
  const numberedCandidates = rawCandidates;
  const accepted = formant => isUsableFormant(formant, maxBandwidth);
  const missing = () => ({ freq: 0, bandwidth: 0 });

  return {
    F1: accepted(numberedCandidates[0]) ? numberedCandidates[0] : missing(),
    F2: accepted(numberedCandidates[1]) ? numberedCandidates[1] : missing(),
    F3: accepted(numberedCandidates[2]) ? numberedCandidates[2] : missing(),
    _all: formants,
    _valid: numberedCandidates.filter(accepted),
    _candidates: numberedCandidates,
    _rawCandidates: rawCandidates,
  };
}

function isUsableFormant(candidate, maxBandwidth) {
  return !!candidate && Number.isFinite(candidate.freq) && candidate.freq > 0
    && Number.isFinite(candidate.bandwidth) && candidate.bandwidth > 0
    && candidate.bandwidth <= maxBandwidth;
}

// 不依据带宽或相邻距离删除范围内的根，以免改变共振峰编号。

/**
 * 对单帧信号执行完整的共振峰提取。
 * @param {Float64Array} frame - 加窗后的单帧信号
 * @param {number} lpcOrder - LPC 阶数
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 筛选配置
 * @returns {{ F1: object, F2: object, F3: object }}
 */
function extractFormants(frame, lpcOrder, sampleRate, options = {}) {
  const { a } = burgLPC(frame, lpcOrder);
  return extractFormantsFromLPC(a, sampleRate, options);
}

/**
 * 对整个信号逐帧提取共振峰轨迹。
 * @param {Float32Array} signal - 在分析采样率上预加重后的浮点信号
 * @param {number} sampleRate - 采样率
 * @param {object} [options] - 配置
 * @param {Array} options.pitchTrack - 同一时间轴上的基频轨迹；没有可信有声证据的帧不输出共振峰
 * @returns {Array<{time: number, F1: object, F2: object, F3: object}>}
 */
function* iterateFormants(signal, sampleRate, options = {}) {
  const {
    frameSize = Math.round(sampleRate * 0.025),
    hopSize = Math.round(sampleRate * 0.01),
    lpcOrder = 12,
    minFreq = 90,
    maxFreq = 5000,
    maxBandwidth = 500,
    pitchTrack = [],
    compareOrders = true,
    minFundamentalRatio = 1.5,
  } = options;

  const { segmentFrames } = require('./frame-segment');
  const frames = segmentFrames(signal, frameSize, hopSize);
  const track = [];
  let pitchIndex = 0;
  let anchors = null;
  const pendingReacquisition = [null, null, null];

  for (let i = 0; i < frames.length; i++) {
    const time = (i * hopSize + frameSize / 2) / sampleRate;
    const empty = () => ({ time, F1: { freq: 0, bandwidth: 0 }, F2: { freq: 0, bandwidth: 0 }, F3: { freq: 0, bandwidth: 0 } });
    while (pitchIndex + 1 < pitchTrack.length && Math.abs(pitchTrack[pitchIndex + 1].time - time) < Math.abs(pitchTrack[pitchIndex].time - time)) pitchIndex++;
    const pitch = pitchTrack[pitchIndex];
    if (!pitch || pitch.f0 <= 0 || pitch.aperiodicity > 0.3 || Math.abs(pitch.time - time) > hopSize / sampleRate) {
      track.push({ ...empty(), reason: 'unvoiced-or-uncertain' });
      anchors = null;
      pendingReacquisition.fill(null);
      yield;
      continue;
    }
    try {
      const result = extractFormants(frames[i], lpcOrder, sampleRate, { minFreq, maxFreq, maxBandwidth });
      const candidates = result._candidates;
      const alternativeOrders = compareOrders ? [lpcOrder - 2, lpcOrder + 2].filter(order => order >= 4 && order < frameSize - 1) : [];
      const alternatives = alternativeOrders.map(order => extractFormants(frames[i], order, sampleRate,
        { minFreq, maxFreq, maxBandwidth })._candidates);
      // 只把在相邻阶数中均有同频证据的根用于共振峰编号。单一阶数新增的
      // 宽带根仍保留在 candidates/modelCandidates 中，但不再挤占后续稳定峰。
      // 若宽带根跨阶数稳定存在，它仍占用自身编号，不能被静默删除。
      const consensus = buildCrossOrderNumbering(candidates, alternatives, maxBandwidth, sampleRate);
      const numberedCandidates = consensus.map(item => item.candidate);
      const matched = matchFormantCandidates(numberedCandidates, anchors);
      // 时间连续性不能覆盖当前帧的序号证据。若最近旧锚点落在另一个
      // 编号上，先留空，再通过该编号自己的连续三帧候选恢复。
      for (let slot = 0; slot < 3; slot++) {
        if (matched[slot] && matched[slot] !== numberedCandidates[slot]) matched[slot] = null;
      }
      if (!anchors) {
        anchors = [0, 1, 2].map(slot => numberedCandidates[slot] ? numberedCandidates[slot].freq : 0);
      }
      for (let slot = 0; slot < 3; slot++) {
        if (isUsableFormant(matched[slot], maxBandwidth)) {
          pendingReacquisition[slot] = null;
          continue;
        }
        const proposal = numberedCandidates[slot];
        const conflicts = matched.some((other, otherSlot) => other && otherSlot !== slot && (
          other === proposal || (proposal && (otherSlot < slot
            ? other.freq >= proposal.freq : other.freq <= proposal.freq))
        ));
        if (!isUsableFormant(proposal, maxBandwidth) || conflicts) {
          pendingReacquisition[slot] = null;
          continue;
        }
        const previous = pendingReacquisition[slot];
        const stable = previous && Math.abs(Math.log(proposal.freq / previous.freq)) <= 0.1;
        const count = stable ? previous.count + 1 : 1;
        pendingReacquisition[slot] = { freq: proposal.freq, count };
        if (count >= 3) {
          matched[slot] = proposal;
          pendingReacquisition[slot] = null;
        }
      }
      const row = empty();
      row.candidates = candidates;
      row.modelCandidates = [{ order: lpcOrder, candidates }, ...alternativeOrders.map((order, index) => (
        { order, candidates: alternatives[index] }
      ))];
      row.quality = {};
      row.orders = [lpcOrder, ...alternativeOrders];
      ['F1', 'F2', 'F3'].forEach((key, slot) => {
        const candidate = matched[slot];
        // 1.5*F0 是保守的工程拒绝规则，不是生理边界或可辨识性证明。
        // 稀疏谐波时保留原始候选及拒绝原因，不将其作为可信测量值。
        const resolvedAboveFundamental = candidate && candidate.freq >= minFundamentalRatio * pitch.f0;
        const evidence = consensus.find(item => item.candidate === candidate);
        const fallback = candidates[slot] || null;
        const usableAcrossOrders = evidence && evidence.matches.every(root => (
          isUsableFormant(root, maxBandwidth)
        ));
        const priorUnresolvedOrdinal = consensus.slice(0, slot).some(item => !item.stable);
        const reason = !candidate ? (fallback && alternatives.length ? 'model-disagreement' : 'no-candidate')
          : evidence && !evidence.stable ? 'model-disagreement'
          : priorUnresolvedOrdinal ? 'ambiguous-numbering'
          : !isUsableFormant(candidate, maxBandwidth) ? 'wide-bandwidth'
          : alternatives.length && !usableAcrossOrders ? 'model-bandwidth-disagreement'
          : !resolvedAboveFundamental ? 'sparse-harmonics' : 'accepted';
        row.quality[key] = { reason, candidate: candidate || fallback,
          identification: evidence && alternatives.length
            ? (evidence.stable ? 'cross-order-consensus' : 'unresolved-ordinal') : 'single-model',
          rawOrdinal: evidence ? evidence.rawIndex + 1 : null,
          skippedCandidates: evidence ? candidates.slice(0, evidence.rawIndex)
            .filter(root => !numberedCandidates.includes(root)) : [],
          frequencySpreadHz: evidence && evidence.matches.some(Boolean)
            ? Math.max(...evidence.matches.filter(Boolean).map(root => Math.abs(root.freq - candidate.freq))) : null };
        if (reason === 'accepted') {
          anchors[slot] = candidate.freq;
          row[key] = candidate;
        }
      });
      track.push(row);
    } catch (error) {
      pendingReacquisition.fill(null);
      // 单帧数值失败不丢弃已得到的 F0、声强与其余帧。
      track.push({ ...empty(), reason: 'numerical-failure' });
    }
    yield;
  }

  return track;
}

function nearestPoleCandidate(candidate, roots, sampleRate, tolerance = Math.log(1.1)) {
  let best = null, bestDistance = Infinity;
  const radius = Math.exp(-Math.PI * candidate.bandwidth / sampleRate);
  const angle = 2 * Math.PI * candidate.freq / sampleRate;
  for (const root of roots) {
    if (Math.abs(Math.log(root.freq / candidate.freq)) > tolerance) continue;
    // 同频率的宽带根与窄带根不是同一极点。以 z 平面的距离匹配，
    // 同时利用角度（频率）与半径（带宽），不优先删除任一类根。
    const otherRadius = Math.exp(-Math.PI * root.bandwidth / sampleRate);
    const otherAngle = 2 * Math.PI * root.freq / sampleRate;
    const distance = Math.hypot(radius * Math.cos(angle) - otherRadius * Math.cos(otherAngle),
      radius * Math.sin(angle) - otherRadius * Math.sin(otherAngle));
    if (distance < bestDistance) {
      best = root;
      bestDistance = distance;
    }
  }
  return best;
}

function buildCrossOrderNumbering(candidates, alternatives, maxBandwidth, sampleRate) {
  if (!alternatives.length) return candidates.map((candidate, rawIndex) => (
    { candidate, rawIndex, matches: [], stable: true }
  ));
  const evidence = candidates.map((candidate, rawIndex) => ({
    candidate,
    rawIndex,
    matches: alternatives.map(roots => nearestPoleCandidate(candidate, roots, sampleRate)),
  }));
  const duplicateMatches = new Set();
  for (let model = 0; model < alternatives.length; model++) {
    const seen = new Map();
    for (const item of evidence) {
      const root = item.matches[model];
      if (!root) continue;
      if (seen.has(root)) {
        duplicateMatches.add(item);
        duplicateMatches.add(seen.get(root));
      } else seen.set(root, item);
    }
  }
  let hasStableLowerRoot = false;
  const numbered = [];
  for (const item of evidence) {
    item.stable = item.matches.every(Boolean) && !duplicateMatches.has(item);
    // 只允许跳过位于已确认低阶峰之后、且本身带宽超限的非共识根。
    // 最低根和任何可用但模型不一致的根仍占位并输出缺失，防止整列错号。
    const maySkipAsOrderSpecificBroadRoot = hasStableLowerRoot && !item.matches.some(Boolean)
      && !isUsableFormant(item.candidate, maxBandwidth);
    if (!maySkipAsOrderSpecificBroadRoot) numbered.push(item);
    if (item.stable) hasStableLowerRoot = true;
  }
  return numbered;
}

// 单调匹配保留跨帧编号；不明确的匹配留空，不强行连接。
function matchFormantCandidates(candidates, anchors) {
  if (!anchors) return candidates.slice(0, 3);
  let bestCost = Infinity, best = [];
  function visit(slot, from, selected, cost) {
    if (slot === 3) {
      if (cost < bestCost) { bestCost = cost; best = selected.slice(); }
      return;
    }
    visit(slot + 1, from, selected.concat(null), cost + 0.4);
    for (let j = from; j < candidates.length; j++) {
      const anchor = anchors[slot];
      const distance = anchor > 0 ? Math.abs(Math.log(candidates[j].freq / anchor)) : (j === slot ? 0 : Infinity);
      if (distance > 0.35) continue;
      visit(slot + 1, j + 1, selected.concat(candidates[j]), cost + distance);
    }
  }
  visit(0, 0, [], 0);
  return best;
}

const { consume, consumeAsync } = require('./iteration');
function formantTrack(signal, sampleRate, options = {}) {
  return consume(iterateFormants(signal, sampleRate, options));
}
function formantTrackAsync(signal, sampleRate, options = {}) {
  return consumeAsync(iterateFormants(signal, sampleRate, options), options);
}
module.exports = { extractFormantsFromLPC, extractFormants, formantTrack, formantTrackAsync };
