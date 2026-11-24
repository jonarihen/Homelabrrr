export const SERVICES = [
  { name: 'ALL', label: 'All Traffic' },
  { name: 'HTTP', label: 'HTTP' },
  { name: 'HTTPS', label: 'HTTPS' },
  { name: 'SSH', label: 'SSH' },
  { name: 'RDP', label: 'RDP' },
  { name: 'DNS', label: 'DNS' },
  { name: 'PING', label: 'Ping' },
  { name: 'ALL_TCP', label: 'All TCP' },
  { name: 'ALL_UDP', label: 'All UDP' },
];

const SERVICE_LABELS = Object.fromEntries(SERVICES.map(service => [service.name, service.label]));

// AARIS tokens only (aaris-tokens.css): services are grouped by role, the mono
// labels carry the exact service.
export const SERVICE_COLORS = {
  ALL: 'var(--ok)',
  HTTP: 'var(--accent)',
  HTTPS: 'var(--accent)',
  SSH: 'var(--warning)',
  RDP: 'var(--warning)',
  DNS: 'var(--ink)',
  PING: 'var(--ink)',
  ALL_TCP: 'var(--muted)',
  ALL_UDP: 'var(--muted)',
};
const FALLBACK_COLOR = 'var(--muted)';

export const DENY_COLOR = 'var(--danger)';
export const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function servicePalette(services = [], action = 'accept') {
  if (action !== 'accept') return [DENY_COLOR];

  const unique = Array.from(new Set(services.filter(Boolean)));
  if (unique.length === 0) return [SERVICE_COLORS.ALL];

  const ordered = unique.length > 1
    ? [...unique.filter(s => s !== 'ALL'), ...(unique.includes('ALL') ? ['ALL'] : [])]
    : unique;

  return ordered.slice(0, 4).map(s => SERVICE_COLORS[s] || FALLBACK_COLOR);
}

export function badgeStyle(service, action = 'accept') {
  const color = action !== 'accept' ? DENY_COLOR : (SERVICE_COLORS[service] || FALLBACK_COLOR);
  return {
    color,
    backgroundColor: tint(color, 10),
    borderColor: tint(color, 20),
  };
}

export function describeServices(services = []) {
  if (!services.length || services.includes('ALL')) return 'All traffic';
  const labels = services.map(service => SERVICE_LABELS[service] || service);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
