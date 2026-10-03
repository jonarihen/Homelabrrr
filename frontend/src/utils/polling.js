export function startPolling({ request, onUpdate, shouldContinue = () => true, onComplete, interval = 2500, retryInterval = 4000 }) {
  let active = true;
  let timer;
  const controller = new AbortController();

  const schedule = (delay) => {
    if (active) timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (!active) return;
    try {
      const data = await request(controller.signal);
      if (!active) return;
      onUpdate(data);
      if (!active) return;
      if (shouldContinue(data)) schedule(interval);
      else if (active) onComplete?.();
    } catch {
      schedule(retryInterval);
    }
  };

  schedule(interval);
  return () => {
    active = false;
    clearTimeout(timer);
    controller.abort();
  };
}
