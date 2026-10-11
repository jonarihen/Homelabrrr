export function healthAvailability(latest, capability, items) {
  if (!latest) return 'No observation';
  if (latest.stale) return 'Stale observation';
  if (capability === 'unavailable') return 'Temporarily unavailable';
  if (capability === 'unsupported') return 'Unsupported';
  if (!Array.isArray(items) || items.length === 0) return 'No sensor readings';
  return items.some((item) => item?.celsius == null && item?.value == null && item?.health == null && item?.state == null)
    ? 'Partial readings' : 'Observed';
}

export function formatTemperature(item) {
  return item?.celsius == null ? 'Reading unavailable' : `${Number(item.celsius).toFixed(1)} °C`;
}

export function formatFan(item) {
  if (item?.value == null) return 'Reading unavailable';
  return item.unit === 'percent' ? `${Number(item.value).toFixed(0)}%` : item.unit === 'rpm' ? `${Number(item.value).toFixed(0)} RPM` : 'Reading unavailable';
}
