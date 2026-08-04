export async function boundedDrain(tasks, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout', results: [] }), timeoutMs);
  });
  const drained = Promise.allSettled(tasks).then((results) => ({ status: 'drained', results }));
  const result = await Promise.race([drained, timeout]);
  clearTimeout(timer);
  return result;
}
