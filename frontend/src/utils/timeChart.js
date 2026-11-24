// Geometry for the interactive time charts (pure, unit-tested). All times are
// shown in Europe/Copenhagen, like the rest of the energy pages.
const TZ = 'Europe/Copenhagen';
const HOUR_MS = 3_600_000;
const HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

// Smallest step of 1, 2, 2.5 or 5 x 10^n that is at least `rough`.
function niceStep(rough) {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough * (1 - 1e-9));
  return { step, decimals: (String(Number(step.toPrecision(3))).split('.')[1] || '').length };
}

// Round zero-based axis: equal steps that reach `max`.
export function niceScale(max, count = 4) {
  const top = Number.isFinite(max) && max > 0 ? max : 1;
  const { step, decimals } = niceStep(top / count);
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  return { max: Number((step * steps).toPrecision(12)), decimals, ticks: Array.from({ length: steps + 1 }, (_, index) => Number((step * index).toFixed(decimals))) };
}

// Round axis around the data, for a line whose changes would vanish on a
// zero-based axis. Falls back to zero-based when the data comes near zero.
export function niceRange(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min < max * 0.3) return { min: 0, ...niceScale(max, count) };
  const { step, decimals } = niceStep(Math.max(max - min, max * 0.05) / count);
  const low = Math.floor(min / step + 1e-9);
  const high = Math.max(low + 1, Math.ceil(max / step - 1e-9));
  const value = (index) => Number((step * index).toFixed(decimals));
  return { min: value(low), max: value(high), decimals, ticks: Array.from({ length: high - low + 1 }, (_, index) => value(low + index)) };
}

// Ticks on local clock boundaries: every four hours for about a day, local
// midnights for longer spans. Thinned evenly when there is no room.
export function timeTicks(start, end, maxTicks = 8) {
  const daily = end - start > 36 * HOUR_MS;
  const all = [];
  for (let at = Math.ceil(start / HOUR_MS) * HOUR_MS; at <= end; at += HOUR_MS) {
    const hour = Number(HOUR.format(at));
    if (daily ? hour === 0 : hour % 4 === 0) all.push({ at, label: hour === 0 ? DAY.format(at) : TIME.format(at) });
  }
  const step = Math.max(1, Math.ceil(all.length / Math.max(1, maxTicks)));
  return all.filter((_, index) => index % step === 0);
}

export function binLabel(from, to) {
  return `${DATE.format(from)}, ${TIME.format(from)}–${TIME.format(to)}`;
}

// Marks for one series of binned points (`zero: false` fits the value axis to
// the data instead of starting at zero). Points more than 1.5 bins apart are
// not connected, so missing coverage stays a visible gap. Null when there is
// no trend to draw (fewer than two valid points).
export function buildTimeChart(points, field, from, through, binSeconds, { width = 640, height = 220, margin = { top: 12, right: 12, bottom: 26, left: 46 }, zero = true } = {}) {
  const start = Date.parse(from);
  const end = Date.parse(through);
  const bin = binSeconds * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(bin) || bin <= 0) return null;
  const valid = (points || []).map((point) => ({ point, at: Date.parse(point.at), value: point[field] }))
    .filter((item) => Number.isFinite(item.at) && Number.isFinite(item.value)).sort((a, b) => a.at - b.at);
  if (valid.length < 2) return null;
  const plot = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom };
  const values = valid.map((item) => item.value);
  const scale = zero ? { min: 0, ...niceScale(Math.max(...values)) } : niceRange(Math.min(...values), Math.max(...values));
  const x = (at) => plot.left + Math.max(0, Math.min(1, (at - start) / (end - start))) * (plot.right - plot.left);
  const y = (value) => plot.bottom - (Math.max(scale.min, value) - scale.min) / (scale.max - scale.min) * (plot.bottom - plot.top);
  const marks = valid.map((item, index) => ({ index, at: item.at, to: item.at + bin, value: item.value, point: item.point,
    left: x(item.at), right: x(item.at + bin), x: x(item.at + bin / 2), y: y(item.value) }));
  const groups = [];
  for (const mark of marks) {
    const current = groups[groups.length - 1];
    if (current && mark.at - current[current.length - 1].at <= bin * 1.5) current.push(mark);
    else groups.push([mark]);
  }
  return { plot, marks, min: scale.min, max: scale.max,
    segments: groups.filter((group) => group.length > 1).map((group) => group.map((mark, index) => `${index ? 'L' : 'M'}${mark.x.toFixed(1)},${mark.y.toFixed(1)}`).join(' ')),
    singles: groups.filter((group) => group.length === 1).map((group) => group[0]),
    yTicks: scale.ticks.map((value) => ({ value, y: y(value), label: new Intl.NumberFormat('da-DK', { minimumFractionDigits: scale.decimals, maximumFractionDigits: scale.decimals }).format(value) })),
    xTicks: timeTicks(start, end, Math.floor((plot.right - plot.left) / 72)).map((tick) => ({ ...tick, x: x(tick.at) })),
    x };
}

// The mark whose centre is closest to a horizontal position.
export function nearestMark(marks, position) {
  let best = -1;
  for (let index = 0; index < marks.length; index++) if (best < 0 || Math.abs(marks[index].x - position) < Math.abs(marks[best].x - position)) best = index;
  return best;
}
