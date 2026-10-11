import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPowerChart, connectionNotices, connectionStatusText, formatAge, telemetryState, testFailureText, writePrivilegeText } from './hardwareView.js';

test('every backend connection state has operator text', () => {
  for (const status of ['not_tested', 'online', 'unreachable', 'authentication_failed', 'insufficient_privilege', 'tls_failed', 'unsupported', 'unsupported_identity', 'identity_changed', 'invalid_target']) {
    assert.notEqual(connectionStatusText(status), 'Unknown state', status);
  }
  assert.equal(connectionStatusText('something_new'), 'Unknown state');
});

test('TLS-off and certificate problems are explained, never silently accepted', () => {
  const off = connectionNotices({ verify_tls: false, last_status: 'online' });
  assert.equal(off.length, 1);
  assert.equal(off[0].tone, 'warn');
  assert.match(off[0].text, /TLS verification is OFF/);
  const certNoCa = connectionNotices({ verify_tls: true, last_status: 'tls_failed', has_ca_certificate: false });
  assert.match(certNoCa[0].text, /Add the issuing private CA/);
  const certWithCa = connectionNotices({ verify_tls: true, last_status: 'tls_failed', has_ca_certificate: true });
  assert.match(certWithCa[0].text, /did not verify against the configured CA/);
  assert.match(connectionNotices({ verify_tls: true, last_status: 'insufficient_privilege' })[0].text, /lacks read privilege/);
  assert.match(connectionNotices({ verify_tls: true, last_status: 'authentication_failed', collection_enabled: false })[0].text, /Update the password/);
  assert.deepEqual(connectionNotices({ verify_tls: true, last_status: 'online' }), []);
  assert.deepEqual(connectionNotices(null), []);
  assert.match(connectionNotices({ verify_tls: true, last_status: 'unreachable' })[0].text, /could not be reached.*backend container/);
  assert.match(connectionNotices({ verify_tls: false, last_status: 'tls_failed' }).at(-1).text, /handshake.*even without certificate verification/);
});

test('write privilege is reported as unverified, never as granted', () => {
  assert.match(writePrivilegeText({ writePrivilege: 'unverified' }), /^unverified/);
  assert.equal(writePrivilegeText(null), 'not tested');
});

test('telemetry panel states distinguish unsupported, disabled, waiting, offline, stale and online', () => {
  const connection = { capabilities: { monitoring: 'supported' } };
  assert.equal(telemetryState(connection, null).state, 'loading');
  assert.equal(telemetryState({ capabilities: { monitoring: 'unsupported' } }, { collectionEnabled: true }).state, 'unsupported');
  assert.equal(telemetryState(connection, { collectionEnabled: false, latest: null }).state, 'disabled');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: null, lastErrorCode: null }).state, 'no_data');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: null, lastErrorCode: 'timeout' }).state, 'offline');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: { stale: true, ageSeconds: 900 }, lastErrorCode: 'unreachable' }).state, 'offline');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: { stale: true, ageSeconds: 900 }, lastErrorCode: null }).state, 'stale');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: { stale: false, ageSeconds: 20 }, lastErrorCode: 'timeout' }).state, 'degraded');
  assert.equal(telemetryState(connection, { collectionEnabled: true, latest: { stale: false, ageSeconds: 20 }, lastErrorCode: null }).state, 'online');
  assert.equal(formatAge(45), '45s');
  assert.equal(formatAge(900), '15 min');
  assert.equal(formatAge(null), 'unknown');
});

const range = { start: '2026-10-08T00:00:00.000Z', end: '2026-10-08T01:00:00.000Z', binSeconds: 60 };
const point = (minute, mean, min = mean, max = mean) => ({ at: new Date(Date.parse(range.start) + minute * 60_000).toISOString(), mean_watts: String(mean), min_watts: String(min), max_watts: String(max) });

test('chart places bins by time and breaks the line at missing bins', () => {
  const chart = buildPowerChart({ range, points: [point(0, 100), point(1, 100), point(2, 100), point(30, 200), point(31, 200)] }, { width: 600, height: 100, pad: 0 });
  assert.equal(chart.segments.length, 2, 'a 28-minute outage is a gap, not a bridge');
  assert.equal(chart.yMax, 200);
  // Bin at minute 30 is centred at 30.5 min of a 60-min range = x 305.
  assert.ok(chart.segments[1].startsWith('M305.0,0.0'), chart.segments[1]);
  assert.ok(chart.segments[0].startsWith('M5.0,50.0'), chart.segments[0]);
  assert.equal(chart.bands.length, 2);
});

test('chart has no geometry without data and drops non-numeric bins (never plotted as zero)', () => {
  assert.deepEqual(buildPowerChart({ range, points: [] }).segments, []);
  assert.deepEqual(buildPowerChart(null).segments, []);
  const chart = buildPowerChart({ range, points: [point(0, 100), { at: point(1, 0).at, mean_watts: null, min_watts: null, max_watts: null }, point(2, 100)] });
  assert.equal(chart.segments.length, 2);
  assert.equal(chart.segments.join(' ').includes('NaN'), false);
});

test('mode changes become markers inside the visible range only', () => {
  const chart = buildPowerChart({ range, points: [point(0, 100), point(1, 100)], modeChanges: [
    { at: '2026-10-08T00:30:00.000Z', mode: 'high', previous_mode: 'low' },
    { at: '2026-10-07T23:00:00.000Z', mode: 'low', previous_mode: 'high' },
  ] }, { width: 600 });
  assert.equal(chart.markers.length, 1);
  assert.equal(chart.markers[0].x, 300);
  assert.equal(chart.markers[0].mode, 'high');
  assert.equal(chart.markers[0].previousMode, 'low');
});

test('a failed test names the category and the backend diagnosis', () => {
  assert.equal(testFailureText({ status: 'unreachable', detail: 'connection refused — nothing is listening on that port (ECONNREFUSED)' }),
    'Connection test failed: Unreachable — connection refused — nothing is listening on that port (ECONNREFUSED)');
  assert.equal(testFailureText({ status: 'tls_failed' }), 'Connection test failed: TLS verification failed');
  assert.equal(testFailureText({ error: 'Connection not found' }), 'Connection not found');
  assert.equal(testFailureText(undefined), 'Connection test failed');
});
