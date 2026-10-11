export const dkk = (ore) => Number.isFinite(ore) ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(ore / 100) : 'Unknown';
export const quantity = (value, digits = 1) => Number.isFinite(value) ? new Intl.NumberFormat('da-DK', { maximumFractionDigits: digits }).format(value) : 'Unknown';
export const localTime = (value) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
};
export const monthLabel = (month) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00Z`));
export const shiftMonth = (month, delta) => {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const currentMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(now);
export function fundingProgress(costOre, appliedOre) {
  if (!Number.isFinite(costOre) || costOre <= 0 || !Number.isFinite(appliedOre)) return null;
  return Math.max(0, Math.min(100, appliedOre / costOre * 100));
}
export function wattPath(points) {
  const values = (points || []).filter((point) => Number.isFinite(point.watts));
  if (values.length < 2) return '';
  const max = Math.max(1, ...values.map((point) => point.watts));
  return values.map((point, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * 600).toFixed(1)},${(110 - point.watts / max * 100).toFixed(1)}`).join(' ');
}
export function historyPath(points, field, from, through, binSeconds) {
  const start = Date.parse(from);
  const end = Date.parse(through);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(binSeconds) || binSeconds <= 0) return '';
  const valid = (points || []).filter((point) => Number.isFinite(point[field]) && Number.isFinite(Date.parse(point.at)));
  if (valid.length < 2) return '';
  const max = Math.max(0.000001, ...valid.map((point) => point[field]));
  let previous = null;
  return valid.map((point) => {
    const at = Date.parse(point.at);
    const command = previous === null || at - previous > binSeconds * 1500 ? 'M' : 'L';
    previous = at;
    return `${command}${(Math.max(0, Math.min(1, (at - start) / (end - start))) * 600).toFixed(1)},${(110 - point[field] / max * 100).toFixed(1)}`;
  }).join(' ');
}
