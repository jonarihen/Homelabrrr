// Regression coverage for the FortiGate TLS-verification flag.
//
// `firewalls.verify_tls` was an SQLite INTEGER (0/1) and is a real PostgreSQL
// boolean since the migration. `createClient()` still compared it against `0`,
// and because `false !== 0` is true, a firewall whose admin had explicitly
// turned verification OFF was handed `verifyTls: true` anyway — so every call
// to a box with a self-signed certificate failed with
// `unable to verify the first certificate`, and the guard that is supposed to
// refuse insecure upstreams (and say so plainly) was unreachable dead code.
//
// Run with:  node --test src/fortigate.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, FortiGateAPI } from './fortigate.ts';

// Captured at module load in fortigate.ts, so it cannot be flipped per-test.
const INSECURE_ALLOWED = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// A firewalls row as Drizzle hands it back: real booleans, plaintext api_key
// (decryptSecret passes through anything without an `enc:` prefix).
function row(verifyTls) {
  return {
    host: '172.21.12.254',
    port: 443,
    api_key: 'plaintext-token',
    vdom: 'lab',
    verify_tls: verifyTls,
  };
}

// ─── createClient — the verify_tls mapping ───────────────────────────────────

test('verify_tls false disables verification instead of silently keeping it on', () => {
  assert.equal(createClient(row(false)).verifyTls, false);
});

test('verify_tls true verifies', () => {
  assert.equal(createClient(row(true)).verifyTls, true);
});

test('a null verify_tls stays secure', () => {
  // The column is nullable (`boolean().default(true)`), so a row written
  // before the default existed can be null. Only an explicit false is insecure.
  assert.equal(createClient(row(null)).verifyTls, true);
  assert.equal(createClient(row(undefined)).verifyTls, true);
});

test('createClient carries the rest of the row through', () => {
  const client = createClient(row(true));
  assert.equal(client.host, '172.21.12.254');
  assert.equal(client.port, 443);
  assert.equal(client.apiKey, 'plaintext-token');
  assert.equal(client.vdom, 'lab');
});

// ─── the insecure-upstream guard is reachable again ──────────────────────────

test('an unverified client refuses to make a request without the env opt-out', async (t) => {
  if (INSECURE_ALLOWED) return t.skip('ALLOW_INSECURE_UPSTREAM_TLS=true in this environment');
  // Rejects before opening a socket, so the unroutable host is never dialled.
  await assert.rejects(
    () => createClient(row(false)).request('GET', 'cmdb/system/interface'),
    /TLS verification is disabled/,
  );
});

test('a verifying client gets past the guard', async () => {
  // Reaches the network layer (and fails there), which is what proves the
  // guard did not fire — the message is a connection error, not a TLS refusal.
  const client = new FortiGateAPI('fortigate.invalid', 443, 'token', 'lab', true);
  await assert.rejects(
    () => client.request('GET', 'cmdb/system/interface'),
    (err) => !/TLS verification is disabled/.test(err.message),
  );
});
