const events = new Map();

export function incrementMetric(name, labels = '') {
  const key = `${name}:${labels}`;
  events.set(key, (events.get(key) || 0) + 1);
}

export function metricEvents() {
  return [...events.entries()];
}
