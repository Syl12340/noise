// utils/phonetic/task-scheduler.js
// 基于 Promise 的分步任务调度器，每步后让出主线程更新 UI

/**
 * 按顺序执行任务队列，每步之间让出主线程（setTimeout 0ms）。
 * 每个任务完成后回调 onProgress 报告累计进度。
 * @param {Array<{name: string, weight: number, fn: function}>} tasks
 *   - name: 进度阶段描述
 *   - weight: 该步骤占总进度的权重比例
 *   - fn: 执行函数，返回该步骤的结果（可为 Promise）
 * @param {function} onProgress - (stageName, percent) 进度回调
 * @param {object} [options]
 * @param {function} [options.isCancelled] 返回 true 时在下一步骤前终止队列
 * @returns {Promise<Array>} 所有步骤返回值的有序数组
 */
function runTaskQueue(tasks, onProgress, options = {}) {
  const totalWeight = tasks.reduce((sum, t) => sum + t.weight, 0);
  const isCancelled = typeof options.isCancelled === 'function'
    ? options.isCancelled
    : () => false;
  let cumulative = 0;

  return tasks.reduce((chain, task) => {
    return chain.then(results => {
      if (isCancelled()) {
        const error = new Error('分析任务已取消');
        error.name = 'AbortError';
        throw error;
      }
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            if (isCancelled()) {
              const error = new Error('分析任务已取消');
              error.name = 'AbortError';
              reject(error);
              return;
            }
            onProgress(task.name, Math.round((cumulative / totalWeight) * 100));
            const result = task.fn();
            Promise.resolve(result).then(value => {
              if (isCancelled()) {
                const error = new Error('分析任务已取消');
                error.name = 'AbortError';
                reject(error);
                return;
              }
              cumulative += task.weight;
              results.push(value);
              resolve(results);
            }, reject);
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    });
  }, Promise.resolve([]));
}

module.exports = { runTaskQueue };
