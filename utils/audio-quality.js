// 输入质量与直流处理；所有电平计算使用归一化 PCM。
function inspectPcm(pcm, inspector = null) {
  let clippedSamples = 0;
  let nearFullScaleSamples = 0;
  let peakAbs = 0;
  let min = 32767;
  let max = -32768;
  for (let i = 0; i < pcm.length; i++) {
    if (pcm[i] >= 32767 || pcm[i] <= -32768) clippedSamples++;
    const abs = Math.abs(pcm[i]);
    if (abs >= 32112) nearFullScaleSamples++;
    peakAbs = Math.max(peakAbs, abs);
    min = Math.min(min, pcm[i]);
    max = Math.max(max, pcm[i]);
  }

  const evidence = (inspector || new PcmQualityInspector()).process(pcm);
  const nearFullScale = nearFullScaleSamples > 0;
  const noAcSignal = pcm.length > 1 && max - min <= 2;
  const digitalSilence = pcm.length > 0 && (peakAbs <= 1 || noAcSignal);
  return {
    clippedSamples,
    nearFullScaleSamples,
    nearFullScale,
    peakAbs,
    digitalSilence,
    noAcSignal,
    plateauSuspected: evidence.plateauSuspected,
    clipped: evidence.clipped,
    clippingEvidence: evidence.clippingEvidence,
  };
}

// Sliding 10 ms evidence windows survive callback boundaries and shifts of
// the recording origin. Sub-rail limiting remains a warning, not rejection.
class PcmQualityInspector {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.windowSamples = Math.max(1, Math.round(sampleRate * .01));
    this.railLimit = Math.max(2, Math.ceil(this.windowSamples * .001));
    this.railWindow = new Uint8Array(this.windowSamples);
    this.position = 0;
    this.rails = 0;
    this.samples = 0;
    this.maxRails = 0;
    this.railRun = 0;
    this.maxRailRun = 0;
    this.clippedIntervals = [];
    this.previous = null;
    this.run = 0;
    this.runStart = null;
    this.plateauSuspected = false;
    this.clipped = false;
  }
  process(pcm) {
    for (const sample of pcm) {
      const rail = sample >= 32767 || sample <= -32768 ? 1 : 0;
      this.rails += rail - this.railWindow[this.position];
      this.railWindow[this.position] = rail;
      this.position = (this.position + 1) % this.windowSamples;
      this.samples++;
      this.railRun = rail ? this.railRun + 1 : 0;
      this.maxRails = Math.max(this.maxRails, this.rails);
      this.maxRailRun = Math.max(this.maxRailRun, this.railRun);
      if (this.rails >= this.railLimit) {
        this.clipped = true;
        const start = Math.max(0, this.samples - this.windowSamples) / this.sampleRate;
        const end = this.samples / this.sampleRate;
        const last = this.clippedIntervals[this.clippedIntervals.length - 1];
        if (last && start <= last.end) last.end = end;
        else this.clippedIntervals.push({ start, end });
      }
      if (sample === this.previous) this.run++;
      else {
        // Require an actual approach and departure, excluding constant DC.
        if (this.run >= 8 && Math.abs(this.previous) > 1024
            && this.runStart !== null && (this.previous - this.runStart) * (this.previous - sample) > 0) {
          this.plateauSuspected = true;
        }
        this.runStart = this.previous;
        this.run = 1;
      }
      this.previous = sample;
    }
    return { clipped: this.clipped, plateauSuspected: this.plateauSuspected,
      clippingEvidence: { windowSeconds: this.windowSamples / this.sampleRate,
        railLimit: this.railLimit, maxRails: this.maxRails, maxConsecutiveRailSamples: this.maxRailRun,
        intervals: this.clippedIntervals.map(interval => ({ ...interval })) } };
  }
}

function centeredSignal(pcm) {
  let mean = 0;
  for (let i = 0; i < pcm.length; i++) mean += pcm[i];
  mean = pcm.length ? mean / pcm.length : 0;
  const signal = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) signal[i] = (pcm[i] - mean) / 32768;
  return signal;
}

// 连续流不能逐块去均值，否则会在块边界产生跳变。2 Hz 高通保留跨块状态。
class DCBlocker {
  constructor(sampleRate) {
    this.pole = Math.exp(-2 * Math.PI * 2 / sampleRate);
    this.previousInput = 0;
    this.previousOutput = 0;
    this.initialized = false;
  }
  process(pcm) {
    const output = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i] / 32768;
      if (!this.initialized) {
        this.previousInput = x;
        this.initialized = true;
      }
      const y = (1 + this.pole) / 2 * (x - this.previousInput)
        + this.pole * this.previousOutput;
      output[i] = y;
      this.previousInput = x;
      this.previousOutput = y;
    }
    return output;
  }
}

module.exports = { inspectPcm, centeredSignal, DCBlocker, PcmQualityInspector };
