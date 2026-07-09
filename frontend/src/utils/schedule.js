// Frontend helpers for per-VM power schedules — day bitmask math and label
// formatting shared by the VM card badge and the schedule editor modal.
// Mirrors backend/src/utils/schedule.js (keep the two in sync).

export const ALL_DAYS = 0b1111111; // 127
export const WEEKDAYS = 0b0111110; // Mon–Fri (62)
export const WEEKENDS = 0b1000001; // Sun + Sat (65)
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayActive(days, weekday) {
  return (days & (1 << weekday)) !== 0;
}

export function toggleDay(days, weekday) {
  return days ^ (1 << weekday);
}

// 'Every day' | 'Weekdays' | 'Weekends' | 'Mon, Wed, Fri'
export function describeDays(days) {
  if (days === ALL_DAYS) return 'Every day';
  if (days === WEEKDAYS) return 'Weekdays';
  if (days === WEEKENDS) return 'Weekends';
  const names = [];
  for (let d = 1; d <= 6; d += 1) if (dayActive(days, d)) names.push(DAY_LABELS[d]);
  if (dayActive(days, 0)) names.push(DAY_LABELS[0]);
  return names.length ? names.join(', ') : 'No days';
}

// "sleeps 23:00–08:00" (en-dash), used for the card badge.
export function sleepLabel(schedule) {
  if (!schedule || !schedule.stopTime || !schedule.startTime) return '';
  return `sleeps ${schedule.stopTime}–${schedule.startTime}`;
}

// The browser's IANA timezone (fallback UTC) — sensible default for new schedules.
export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
