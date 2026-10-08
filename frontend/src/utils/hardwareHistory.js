import { historyPath } from './energyView.js';

export function hardwareWattPath(points, from, through, binSeconds) {
  const normalized = (points || []).map((point) => {
    const raw = point.mean_watts;
    const watts = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : null;
    return { at: point.at, watts: Number.isFinite(watts) ? watts : null };
  });
  return historyPath(normalized, 'watts', from, through, binSeconds);
}
