// 共用分析流程；新请求或 cancel 会使旧任务在下个分片退出。
const { analyzePcm, PHONETIC_CONFIG } = require('./bundle');
let generation = 0;
worker.onMessage(async msg => {
  if (!msg) return;
  if (msg.type === 'cancel') { generation++; return; }
  if (msg.type !== 'analyze') return;
  const current = ++generation;
  const isCancelled = () => current !== generation;
  try {
    const result = await analyzePcm(new Int16Array(msg.pcm), msg.sampleRate === undefined ? PHONETIC_CONFIG.SAMPLE_RATE : msg.sampleRate, {
      parameters: msg.parameters, isCancelled,
      onProgress: (stage, percent) => { if (!isCancelled()) worker.postMessage({ type: 'progress', id: msg.id, stage, percent }); },
    });
    if (!isCancelled()) worker.postMessage({ type: 'result', id: msg.id, ...result });
  } catch (error) {
    if (!isCancelled() && error.name !== 'AbortError') worker.postMessage({ type: 'error', id: msg.id, message: error.message });
  }
});
