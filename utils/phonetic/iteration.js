// 同步和异步入口使用同一个逐帧计算器，避免两套算法漂移。
function consume(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

async function consumeAsync(iterator, options = {}) {
  const cancelled = options.isCancelled || (() => false);
  let deadline = Date.now() + 8;
  try {
    while (true) {
      if (cancelled()) { const error = new Error('分析已取消'); error.name = 'AbortError'; throw error; }
      const step = iterator.next();
      if (step.done) return step.value;
      if (Date.now() >= deadline) {
        await new Promise(resolve => setTimeout(resolve, 0));
        deadline = Date.now() + 8;
      }
    }
  } finally {
    if (iterator.return) iterator.return();
  }
}

module.exports = { consume, consumeAsync };
