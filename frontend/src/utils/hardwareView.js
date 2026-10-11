// Pure presentation helpers for the PVE Hosts → node → Hardware section.
// Kept free of React so the states/labels/chart geometry are unit-tested.

const STATUS_TEXT = {
  not_tested: 'Not tested',
  online: 'Online',
  unreachable: 'Unreachable',
  authentication_failed: 'Authentication failed',
  insufficient_privilege: 'Insufficient privilege',
  tls_failed: 'TLS verification failed',
  unsupported: 'Unsupported capability',
  unsupported_identity: 'No stable system identity',
  identity_changed: 'Physical identity changed',
  invalid_target: 'Invalid management target',
};

export function connectionStatusText(status) {
  return STATUS_TEXT[status] || 'Unknown state';
}

export function connectionStatusTone(status) {
  if (status === 'online') return 'ok';
  if (status === 'not_tested') return 'info';
  return 'error';
}

// Operator-facing explanations. Never includes vendor payloads or secrets:
// everything here is derived from the safe connection DTO.
export function connectionNotices(connection) {
  if (!connection) return [];
  const notices = [];
  if (connection.verify_tls === false) {
    notices.push({ tone: 'warn', text: 'TLS verification is OFF for this iLO. Credentials are sent to whoever answers at this address. Prefer adding the private CA certificate and re-enabling verification.' });
  }
  switch (connection.last_status) {
    case 'tls_failed':
      notices.push({ tone: 'error', text: connection.has_ca_certificate
        ? 'The iLO certificate did not verify against the configured CA. Check that the CA is the issuer and that the management host matches the certificate name.'
        : 'The iLO certificate could not be verified. Add the issuing private CA (PEM) or use the hostname on the certificate; disabling verification is not a fix.' });
      break;
    case 'authentication_failed':
      notices.push({ tone: 'error', text: connection.collection_enabled
        ? 'iLO rejected the credentials. Collection backs off and will disable itself after repeated rejections to avoid an iLO account lockout.'
        : 'iLO rejected the credentials. Update the password and test again before re-enabling collection.' });
      break;
    case 'insufficient_privilege':
      notices.push({ tone: 'error', text: 'The account authenticated but lacks read privilege for a required Redfish resource. A read-only account with Login privilege is enough for monitoring.' });
      break;
    case 'unsupported':
      notices.push({ tone: 'error', text: 'A required Redfish resource was missing or not understood by this firmware.' });
      break;
    case 'unsupported_identity':
      notices.push({ tone: 'error', text: 'iLO reported neither a system UUID nor a serial number, so telemetry cannot be bound to a physical server.' });
      break;
    case 'identity_changed':
      notices.push({ tone: 'error', text: 'This address now answers as a different physical server. Decommission this connection and create a new one for the replacement.' });
      break;
    case 'unreachable':
      notices.push({ tone: 'error', text: 'The iLO did not answer within the request deadline.' });
      break;
    case 'invalid_target':
      notices.push({ tone: 'error', text: 'The management target resolves to a prohibited address or redirected the request.' });
      break;
    case 'not_tested':
      notices.push({ tone: 'info', text: 'Not tested since the last change. Collection and control stay off until a successful read-only test.' });
      break;
    default:
  }
  return notices;
}

export function writePrivilegeText(capabilities) {
  // Discovery never writes to find out, so it can only ever report unverified.
  return capabilities?.writePrivilege === 'unverified' ? 'unverified (proven only by an explicit controlled change)' : 'not tested';
}

// One state for the telemetry panel. Order matters: an unsupported metric
// or disabled collection is not "offline", and missing data is never zero.
export function telemetryState(connection, telemetry) {
  if (!telemetry) return { state: 'loading', text: 'Loading hardware history…' };
  if (connection?.capabilities?.monitoring === 'unsupported') return { state: 'unsupported', text: 'This iLO does not report actual input watts' };
  const latest = telemetry.latest;
  if (!telemetry.collectionEnabled) {
    return latest ? { state: 'disabled', text: 'Collection disabled · showing last stored reading' } : { state: 'disabled', text: 'Collection disabled' };
  }
  if (!latest) {
    return telemetry.lastErrorCode
      ? { state: 'offline', text: `No reading yet · last attempt failed (${telemetry.lastErrorCode})` }
      : { state: 'no_data', text: 'Waiting for the first reading' };
  }
  if (latest.stale) {
    return telemetry.lastErrorCode
      ? { state: 'offline', text: `Offline · last reading ${formatAge(latest.ageSeconds)} old (${telemetry.lastErrorCode})` }
      : { state: 'stale', text: `Stale · last reading ${formatAge(latest.ageSeconds)} old` };
  }
  return telemetry.lastErrorCode
    ? { state: 'degraded', text: `Degraded · last attempt failed (${telemetry.lastErrorCode})` }
    : { state: 'online', text: 'Collecting' };
}

export function formatAge(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'unknown';
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function formatWatts(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(0)} W`;
}

// Time-based chart geometry. Bins are placed by their timestamp within the
// requested range; a missing bin breaks the line so outages show as gaps
// instead of being bridged. Mode changes become vertical markers.
export function buildPowerChart(telemetry, { width = 300, height = 85, pad = 5 } = {}) {
  const points = Array.isArray(telemetry?.points) ? telemetry.points : [];
  const start = Date.parse(telemetry?.range?.start);
  const end = Date.parse(telemetry?.range?.end);
  const binMs = Number(telemetry?.range?.binSeconds) * 1000;
  if (!points.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || !(binMs > 0)) {
    return { segments: [], bands: [], markers: [], yMax: null };
  }
  // Number(null) is 0: treat absent values as missing, never as a zero reading.
  const num = (value) => (value == null || value === '' ? NaN : Number(value));
  const parsed = points.map((p) => ({ at: Date.parse(p.at), mean: num(p.mean_watts), min: num(p.min_watts), max: num(p.max_watts) }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.mean) && Number.isFinite(p.min) && Number.isFinite(p.max))
    .sort((a, b) => a.at - b.at);
  const yMax = Math.max(1, ...parsed.map((p) => p.max));
  // Bins are labelled by their start; plot at the bin centre.
  const x = (at) => Math.min(width, Math.max(0, ((at - start) / (end - start)) * width));
  const y = (watts) => height - pad - (watts / yMax) * (height - 2 * pad);
  const groups = [];
  for (const p of parsed) {
    const current = groups[groups.length - 1];
    if (current && p.at - current[current.length - 1].at <= binMs * 1.5) current.push(p);
    else groups.push([p]);
  }
  const fmt = (n) => n.toFixed(1);
  const segments = groups.map((g) => g.map((p, i) => `${i ? 'L' : 'M'}${fmt(x(p.at + binMs / 2))},${fmt(y(p.mean))}`).join(' '));
  const bands = groups.filter((g) => g.length > 1).map((g) => {
    const top = g.map((p, i) => `${i ? 'L' : 'M'}${fmt(x(p.at + binMs / 2))},${fmt(y(p.max))}`).join(' ');
    const bottom = [...g].reverse().map((p) => `L${fmt(x(p.at + binMs / 2))},${fmt(y(p.min))}`).join(' ');
    return `${top} ${bottom} Z`;
  });
  const markers = (Array.isArray(telemetry?.modeChanges) ? telemetry.modeChanges : [])
    .map((change) => ({ at: Date.parse(change.at), mode: change.mode, previousMode: change.previous_mode }))
    .filter((m) => Number.isFinite(m.at) && m.at >= start && m.at <= end)
    .map((m) => ({ ...m, x: Number(fmt(x(m.at))) }));
  return { segments, bands, markers, yMax };
}
