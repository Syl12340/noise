// 输入质量与直流处理；所有电平计算使用归一化 PCM。
function inspectPcm(pcm) {
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

  // 连续相同极值也可能来自正常低频波形的整数化，不能单独据此判定削顶。
  let plateauRun = 0;
  let maxPlateauRun = 0;
  if (pcm.length && max - min > 64 && peakAbs > 1024) {
    for (let i = 1; i < pcm.length; i++) {
      const atExtreme = pcm[i] === pcm[i - 1] && (pcm[i] === max || pcm[i] === min);
      plateauRun = atExtreme ? plateauRun + 1 : 0;
      maxPlateauRun = Math.max(maxPlateauRun, plateauRun + (atExtreme ? 1 : 0));
    }
  }

  const nearFullScale = nearFullScaleSamples > 0;
  const plateauSuspected = maxPlateauRun >= 3;
  const noAcSignal = pcm.length > 1 && max - min <= 2;
  const digitalSilence = pcm.length > 0 && (peakAbs <= 1 || noAcSignal);
  return {
    clippedSamples,
    nearFullScaleSamples,
    peakAbs,
    digitalSilence,
    noAcSignal,
    plateauSuspected,
    clipped: clippedSamples > 0 || nearFullScale,
  };
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

module.exports = { inspectPcm, centeredSignal, DCBlocker };
