export const dkk = (ore) => {
  // PostgreSQL financial aggregates are serialized as decimal strings. Only
  // whole, safely representable øre may be converted to a JS number here.
  const amount = typeof ore === 'string' && /^-?\d+$/.test(ore) ? Number(ore) : ore;
  return Number.isSafeInteger(amount) ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(amount / 100) : 'Unknown';
};
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

const MODE_LABELS = { low: 'Low', dynamic: 'Dynamic', high: 'High', os_control: 'OS Control', unknown: 'Unknown' };
export const modeLabel = (mode) => (mode ? MODE_LABELS[mode] || String(mode).replaceAll('_', ' ') : 'Unknown');

const REASON_TEXT = {
  schedule: 'weekly schedule',
  default: 'default mode outside schedule windows',
  manual: 'manual override',
  price_high: 'price exceeds the expensive-price limit',
  price_low: 'cheap-price boost',
  price_unavailable_fallback: 'price data unavailable, weekly/default fallback',
  paused: 'automation paused',
  drift_hold: 'held after an external change',
  disabled: 'physical control disabled',
  no_automation: 'automation not enabled',
  unsafe_actual_mode: 'current hardware mode cannot be safely controlled',
  unsupported_mode: 'mode not supported by this server',
  policy_invalid: 'stored policy invalid, restricted',
  policy_unavailable: 'policy unavailable',
};
export const reasonText = (reason) => (reason ? REASON_TEXT[reason] || String(reason).replaceAll('_', ' ') : 'reason unavailable');

/** e.g. "Dynamic: price exceeds the expensive-price limit until 14:15". */
export function decisionText({ mode, reason, validUntil } = {}) {
  const until = (reason === 'price_high' || reason === 'price_low' || reason === 'manual') && validUntil && Number.isFinite(Date.parse(validUntil))
    ? ` until ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(new Date(validUntil))}` : '';
  const text = `${reasonText(reason)}${until}`;
  return mode ? `${modeLabel(mode)}: ${text}` : `No mode selected: ${text}`;
}

const BASIS_LABELS = {
  variable_retail_including_vat: 'Retail incl. tariffs, taxes and VAT (fixed fees excluded)',
  spot_only_excluding_retail_additions: 'Spot price only (tariffs, taxes and VAT excluded)',
};
export const basisLabel = (basis) => (basis ? BASIS_LABELS[basis] || String(basis).replaceAll('_', ' ') : 'Price basis not configured');

const COST_STATUS = {
  finalized: 'Finalized', finalized_partial: 'Finalized, partial coverage', calculated: 'Calculated so far',
  partial: 'Partial', unavailable: 'Unavailable', error: 'Source error',
};
export const costStatusLabel = (status) => COST_STATUS[status] || (status ? String(status).replaceAll('_', ' ') : 'Unavailable');

const COMPONENT_STATUS = { calculated: 'calculated', partial: 'partial', estimated: 'estimate', incomplete: 'incomplete', pending_month_end: 'added at month end' };
export const componentStatusLabel = (status) => COMPONENT_STATUS[status] || String(status || 'unknown').replaceAll('_', ' ');

const FUNDING_STATUS = {
  reconciled: 'Reconciled', partial: 'Not yet allocated', unavailable: 'No allocation yet',
  recalculation_pending: 'Recalculation pending', error: 'Source error',
};
export const fundingStatusLabel = (status) => FUNDING_STATUS[status] || (status ? String(status).replaceAll('_', ' ') : 'Unavailable');

const PROGRESS_BASIS = { finalized_lab_cost: 'finalized lab cost', current_estimate: 'current estimate (cost calculated so far)' };
export const progressBasisLabel = (basis) => PROGRESS_BASIS[basis] || 'unknown basis';

/** Server-computed progress only; never derives a percentage client-side. */
export function progressView(progress) {
  if (!progress || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100) return null;
  return { percent: progress.percent, basis: progressBasisLabel(progress.basis), estimate: progress.basis === 'current_estimate' };
}

/** Percentage positions of time markers inside [from, through] for a chart. */
export function markerPositions(markers, from, through) {
  const start = Date.parse(from);
  const end = Date.parse(through);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return (markers || []).filter((marker) => Number.isFinite(Date.parse(marker.at)))
    .map((marker) => ({ ...marker, x: (Date.parse(marker.at) - start) / (end - start) * 600 }))
    .filter((marker) => marker.x >= 0 && marker.x <= 600);
}
