// Pure, dependency-free helpers for per-VM power schedules (vm_schedules).
//
// A schedule describes an OFF window: the VM is asked to stop at stop_time and
// start again at start_time, on the configured days, in the configured IANA
// timezone. All timezone math is done with the built-in Intl API — no external
// tz database. The scheduler loop (scheduler.js) drives the actual Proxmox
// power actions; this module only computes state so it stays trivially testable.

// Day bitmask: bit 0 = Sunday, bit 1 = Monday … bit 6 = Saturday.
export const ALL_DAYS = 0b1111111; // 127
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// 'HH:MM', 24-hour.
export function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

export function timeToMinutes(value) {
  const [h, m] = String(value).split(':').map((n) => Number.parseInt(n, 10));
  return h * 60 + m;
}

export function minutesToTime(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// A days mask is valid when it's an integer in [0, 127] with at least one day.
export function isValidDaysMask(value) {
  return Number.isInteger(value) && value >= 1 && value <= ALL_DAYS;
}

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Throws RangeError on an unknown/invalid IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function dayActive(days, weekday) {
  return (days & (1 << weekday)) !== 0;
}

// Wall-clock parts (weekday index + minute-of-day) for an instant in a zone.
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  let hour = Number.parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some ICU builds render midnight as '24' under h23
  const minute = Number.parseInt(get('minute'), 10) || 0;
  return { weekday, minuteOfDay: hour * 60 + minute };
}

// True when the instant `{ weekday, minuteOfDay }` falls inside a scheduled OFF
// window. The window's owning day is the day the STOP fires; the morning tail of
// a midnight-crossing window (before start_time) is attributed to the previous
// day so a Friday-night "sleep" honours a weekdays-only mask.
export function offWindowContains({ weekday, minuteOfDay }, { stopM, startM, days }) {
  if (stopM === startM) return false; // zero-length window
  if (stopM < startM) {
    // Same-day window (e.g. stop 01:00, start 08:00).
    return dayActive(days, weekday) && minuteOfDay >= stopM && minuteOfDay < startM;
  }
  // Crosses midnight (the common case: stop 23:00, start 08:00).
  if (minuteOfDay >= stopM) return dayActive(days, weekday); // evening tail (today)
  if (minuteOfDay < startM) return dayActive(days, (weekday + 6) % 7); // morning tail (yesterday)
  return false;
}

// Next epoch-ms at which the wall clock hits `targetMinuteOfDay` in `timeZone`,
// strictly after `fromMs`. Minute-by-minute scan (bounded to 8 days) keeps it
// correct across DST transitions without pulling in a tz-offset library.
export function nextTimeOccurrence(fromMs, timeZone, targetMinuteOfDay) {
  const start = Math.ceil(fromMs / 60000) * 60000;
  for (let i = 0; i <= 8 * 24 * 60; i += 1) {
    const d = new Date(start + i * 60000);
    if (zonedParts(d, timeZone).minuteOfDay === targetMinuteOfDay) return d.getTime();
  }
  return fromMs + 24 * 60 * 60 * 1000; // unreachable fallback
}

// Human-readable day summary for a mask: 'Every day', 'Weekdays', 'Weekends',
// or a comma list like 'Mon, Wed, Fri'.
export function describeDays(days) {
  if (days === ALL_DAYS) return 'Every day';
  if (days === 0b0111110) return 'Weekdays';
  if (days === 0b1000001) return 'Weekends';
  const names = [];
  for (let d = 1; d <= 6; d += 1) if (dayActive(days, d)) names.push(DAY_LABELS[d]);
  if (dayActive(days, 0)) names.push(DAY_LABELS[0]);
  return names.length ? names.join(', ') : 'No days';
}

// Shape a vm_schedules row for API responses (camelCase, derived flags).
export function serializeSchedule(row, now = Date.now()) {
  if (!row) return null;
  const skipUntil = Number(row.skip_until) || 0;
  return {
    enabled: row.enabled === 1,
    stopTime: row.stop_time || '',
    startTime: row.start_time || '',
    days: Number(row.days),
    timezone: row.timezone || 'UTC',
    skipUntil,
    skipActive: skipUntil > now,
    runningDueToManual: row.running_due_to_manual === 1,
    lastAction: row.last_action || '',
    lastActionAt: Number(row.last_action_at) || 0,
  };
}

// Compact summary used for the VM card badge (no derived-state internals).
export function scheduleBadge(row, now = Date.now()) {
  if (!row || row.enabled !== 1 || !row.stop_time || !row.start_time) return null;
  const skipUntil = Number(row.skip_until) || 0;
  return {
    enabled: true,
    stopTime: row.stop_time,
    startTime: row.start_time,
    days: Number(row.days),
    timezone: row.timezone || 'UTC',
    skipActive: skipUntil > now,
  };
}
