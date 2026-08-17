// Regression coverage for the upstream error translation layer (issue #69).
// Every row of the mapping table gets a real upstream string, plus the
// fall-through cases: unknown text, empty/null input, and a message that
// carries more than one signal.
// Run with:  node --test src/utils/upstreamError.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  translateUpstreamError,
  upstreamErrorPayload,
  flattenUpstreamError,
  ADMIN_PVE_HOSTS_HREF,
  ADMIN_FIREWALLS_HREF,
} from './upstreamError.ts';

/** Every returned shape must be complete — never half-filled. */
function assertWellFormed(shape) {
  assert.ok(shape, 'expected a translation');
  for (const key of ['title', 'detail', 'action']) {
    assert.equal(typeof shape[key], 'string', `${key} must be a string`);
    assert.ok(shape[key].length > 0, `${key} must not be empty`);
  }
  if ('href' in shape) {
    assert.equal(typeof shape.href, 'string');
    assert.ok(shape.href.startsWith('/'));
  }
  assert.deepEqual(
    Object.keys(shape).sort(),
    ('href' in shape ? ['action', 'detail', 'href', 'title'] : ['action', 'detail', 'title']),
  );
}

// ── row: PVE 401 / 403 / authentication failure ──────────────────────────────

test('PVE 401 maps to a token-rejected message pointing at Admin → PVE Hosts', () => {
  const shape = translateUpstreamError('Proxmox GET /nodes → 401: {"data":null}');
  assertWellFormed(shape);
  assert.match(shape.title, /Proxmox rejected/i);
  assert.match(shape.detail, /401/);
  assert.equal(shape.href, ADMIN_PVE_HOSTS_HREF);
});

test('PVE 403 maps to the same row and names the configured host', () => {
  const shape = translateUpstreamError(
    'Proxmox POST /nodes/pve1/qemu/105/status/start → 403: {"data":null}',
    { host: 'pve-cluster-a' },
  );
  assertWellFormed(shape);
  assert.match(shape.detail, /403/);
  assert.match(shape.detail, /pve-cluster-a/);
});

test('"authentication failure" without a status code still maps', () => {
  const shape = translateUpstreamError('Proxmox GET /nodes → 500: authentication failure');
  assertWellFormed(shape);
  assert.match(shape.title, /Proxmox rejected/i);
});

// ── row: TLS ─────────────────────────────────────────────────────────────────

test('unable to verify the first certificate maps to the TLS row', () => {
  const shape = translateUpstreamError('unable to verify the first certificate', { host: 'pve-01' });
  assertWellFormed(shape);
  assert.match(shape.title, /TLS/i);
  assert.match(shape.detail, /pve-01/);
  assert.match(shape.action, /Verify TLS/);
});

test('self signed certificate maps to the TLS row', () => {
  for (const msg of [
    'self signed certificate',
    'self-signed certificate in certificate chain',
    'Proxmox GET /version → 500: DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
  ]) {
    const shape = translateUpstreamError(msg);
    assertWellFormed(shape);
    assert.match(shape.title, /TLS/i, msg);
  }
});

test('a TLS failure on a FortiGate links to Admin → Firewalls, not PVE Hosts', () => {
  const shape = translateUpstreamError('FortiGate connection error: self signed certificate');
  assertWellFormed(shape);
  assert.equal(shape.href, ADMIN_FIREWALLS_HREF);
});

// ── row: unreachable ─────────────────────────────────────────────────────────

test('ECONNREFUSED / EHOSTUNREACH / timeout all map to "unreachable"', () => {
  for (const msg of [
    'connect ECONNREFUSED 10.0.0.5:8006',
    'connect EHOSTUNREACH 10.0.0.5:8006',
    'connect ENETUNREACH 10.0.0.5:8006',
    'connect ETIMEDOUT 10.0.0.5:8006',
    'Proxmox request timeout',
    'FortiGate request timeout',
  ]) {
    const shape = translateUpstreamError(msg);
    assertWellFormed(shape);
    assert.match(shape.title, /unreachable/i, msg);
  }
});

test('the unreachable message never echoes the IP from the upstream string', () => {
  const shape = translateUpstreamError('connect ECONNREFUSED 10.0.0.5:8006');
  assert.doesNotMatch(shape.detail, /10\.0\.0\.5/);
  assert.doesNotMatch(shape.title + shape.action, /10\.0\.0\.5/);
});

test('an IP supplied as the host label is redacted, not printed', () => {
  const shape = translateUpstreamError('Proxmox request timeout', { host: '10.0.0.5' });
  assert.doesNotMatch(shape.detail, /10\.0\.0\.5/);
  assert.match(shape.detail, /\[internal-host\]/);
});

test('"Timed out waiting for Proxmox task to complete" is NOT an unreachable host', () => {
  assert.equal(translateUpstreamError('Timed out waiting for Proxmox task to complete'), null);
});

// ── row: token privilege ─────────────────────────────────────────────────────

test('token privilege failures name the missing privilege when PVE reports it', () => {
  const shape = translateUpstreamError(
    'Proxmox POST /nodes/pve1/qemu/105/status/start → 403: {"data":null,"errors":{"":"Permission check failed (/vms/105, VM.PowerMgmt)"}}',
  );
  assertWellFormed(shape);
  assert.match(shape.title, /missing a privilege/i);
  assert.match(shape.detail, /VM\.PowerMgmt/);
  assert.equal(shape.href, ADMIN_PVE_HOSTS_HREF);
});

test('privilege wording stays generic when PVE does not name the privilege', () => {
  for (const msg of [
    "Proxmox GET /nodes → 500: no such user ('portal@pve!token')",
    "Proxmox POST /nodes/pve1/qemu/105/config → 500: you can't run this",
    'Proxmox GET /nodes → 500: insufficient privileges',
  ]) {
    const shape = translateUpstreamError(msg);
    assertWellFormed(shape);
    assert.match(shape.title, /missing a privilege/i, msg);
    assert.match(shape.detail, /VM\.PowerMgmt|privilege/i, msg);
  }
});

test('a privilege failure beats the bare 403 row', () => {
  const shape = translateUpstreamError(
    'Proxmox POST /nodes/pve1/qemu/105/status/start → 403: Permission check failed (/vms/105, VM.Config.Disk)',
  );
  assert.match(shape.title, /missing a privilege/i);
  assert.match(shape.detail, /VM\.Config\.Disk/);
});

// ── row: volume missing ──────────────────────────────────────────────────────

test('the motivating example — a missing disk — becomes readable', () => {
  const raw = 'Proxmox POST /nodes/pve1/qemu/105/status/start → 500: '
    + '{"data":null,"errors":{"":"volume \'local-lvm:vm-105-disk-0\' does not exist"}}';
  const shape = translateUpstreamError(raw, { node: 'pve1' });
  assertWellFormed(shape);
  assert.match(shape.title, /disk is missing/i);
  assert.match(shape.detail, /local-lvm/);
  assert.match(shape.detail, /pve1/);
  // The whole raw blob must not be handed back.
  assert.doesNotMatch(shape.detail, /api2|status\/start|\{"data"/);
});

test('a volume id with no storage prefix still produces a complete shape', () => {
  const shape = translateUpstreamError("volume 'orphan-disk' does not exist");
  assertWellFormed(shape);
  assert.match(shape.title, /disk is missing/i);
});

// ── row: storage missing / not enabled ───────────────────────────────────────

test('storage does not exist / is not enabled map to the storage row', () => {
  for (const msg of [
    "storage 'fast-nvme' does not exist",
    "storage 'fast-nvme' is not enabled",
    "storage 'fast-nvme' is not online",
    'storage fast-nvme not enabled',
  ]) {
    const shape = translateUpstreamError(msg, { node: 'pve3' });
    assertWellFormed(shape);
    assert.match(shape.title, /Storage is not available/i, msg);
    assert.match(shape.detail, /fast-nvme/, msg);
    assert.match(shape.detail, /pve3/, msg);
  }
});

test('the storage row falls back to "this node" without node context', () => {
  const shape = translateUpstreamError("storage 'fast-nvme' does not exist");
  assertWellFormed(shape);
  assert.match(shape.detail, /this node/);
});

// ── rows: locked guests ──────────────────────────────────────────────────────

test('VM is locked names the lock reason', () => {
  const shape = translateUpstreamError('Proxmox POST /nodes/pve1/qemu/105/status/start → 500: VM is locked (backup)');
  assertWellFormed(shape);
  assert.match(shape.title, /VM is locked/i);
  assert.match(shape.detail, /backup/);
  assert.match(shape.action, /Wait/i);
  assert.ok(!('href' in shape), 'a lock has no admin page to link to');
});

test('VM is locked without a reason still produces a complete shape', () => {
  const shape = translateUpstreamError('VM is locked');
  assertWellFormed(shape);
  assert.match(shape.title, /VM is locked/i);
});

test('CT is locked maps to the container wording', () => {
  const shape = translateUpstreamError('Proxmox POST /nodes/pve1/lxc/210/status/start → 500: CT is locked (migrate)');
  assertWellFormed(shape);
  assert.match(shape.title, /Container is locked/i);
  assert.match(shape.detail, /migrate/);
});

// ── rows: FortiGate ──────────────────────────────────────────────────────────

test('FortiGate -5 reports a duplicate object', () => {
  const shape = translateUpstreamError('FortiGate API error: -5');
  assertWellFormed(shape);
  assert.match(shape.detail, /-5/);
  assert.match(shape.detail, /already exists/i);
  assert.equal(shape.href, ADMIN_FIREWALLS_HREF);
});

test('FortiGate -3 reports a missing or still-referenced object', () => {
  const shape = translateUpstreamError('FortiGate API error: -3');
  assertWellFormed(shape);
  assert.match(shape.detail, /-3/);
  assert.match(shape.detail, /referenced/i);
});

test('an unmapped FortiGate CLI code falls through rather than guessing', () => {
  assert.equal(translateUpstreamError('FortiGate API error: -23'), null);
});

test('FortiGate 401 asks for the API key to be re-entered', () => {
  for (const msg of ['FortiGate API error: HTTP 401', 'FortiGate API error: 401 Unauthorized']) {
    const shape = translateUpstreamError(msg);
    assertWellFormed(shape);
    assert.match(shape.title, /FortiGate rejected the API key/i, msg);
    assert.match(shape.action, /Admin → Firewalls/, msg);
    assert.equal(shape.href, ADMIN_FIREWALLS_HREF, msg);
  }
});

test('a FortiGate 401 never falls into the Proxmox token row', () => {
  const shape = translateUpstreamError('FortiGate API error: HTTP 401');
  assert.doesNotMatch(shape.title, /Proxmox/i);
});

// ── fall-through ─────────────────────────────────────────────────────────────

test('unknown upstream text returns null so callers keep sanitized behaviour', () => {
  for (const msg of [
    'Proxmox GET /nodes → 500: {"data":null}',
    'something nobody has ever seen',
    'Proxmox task failed: WARNINGS: 1',
  ]) {
    assert.equal(translateUpstreamError(msg), null, msg);
  }
});

test('empty, null and undefined input return null instead of throwing', () => {
  for (const msg of ['', '   ', null, undefined, 0, false, NaN]) {
    assert.equal(translateUpstreamError(msg), null, String(msg));
  }
});

test('non-string input never throws', () => {
  for (const msg of [{}, [], new Error('VM is locked (backup)'), Symbol.iterator]) {
    assert.doesNotThrow(() => translateUpstreamError(msg));
  }
  // An Error is unwrapped via .message.
  assert.match(translateUpstreamError(new Error('VM is locked (backup)')).title, /VM is locked/i);
});

test('a bad context argument is ignored rather than fatal', () => {
  for (const ctx of [null, undefined, 'nonsense', 42]) {
    const shape = translateUpstreamError('VM is locked (backup)', ctx);
    assertWellFormed(shape);
  }
});

// ── precedence when a message carries several signals ────────────────────────

test('multiple signals resolve by table order: connection-level wins', () => {
  const raw = "Proxmox POST /nodes/pve1/qemu/105/status/start → 401: connect ECONNREFUSED 10.0.0.5:8006 "
    + "VM is locked (backup) volume 'local-lvm:vm-105-disk-0' does not exist";
  const shape = translateUpstreamError(raw);
  assertWellFormed(shape);
  assert.match(shape.title, /unreachable/i);
});

test('with no connection-level signal, a lock outranks a missing volume', () => {
  const raw = "VM is locked (backup) — volume 'local-lvm:vm-105-disk-0' does not exist";
  assert.match(translateUpstreamError(raw).title, /VM is locked/i);
});

test('a missing volume outranks the storage row it also mentions', () => {
  const raw = "volume 'local-lvm:vm-105-disk-0' does not exist, storage 'local-lvm' does not exist";
  assert.match(translateUpstreamError(raw).title, /disk is missing/i);
});

test('translation is deterministic for the same input', () => {
  const raw = 'Proxmox POST /nodes/pve1/qemu/105/status/start → 500: VM is locked (backup)';
  assert.deepEqual(translateUpstreamError(raw), translateUpstreamError(raw));
});

// ── flatten ──────────────────────────────────────────────────────────────────

test('flatten produces one readable line, and tolerates null', () => {
  const shape = translateUpstreamError('VM is locked (backup)');
  const line = flattenUpstreamError(shape);
  assert.ok(line.includes(shape.title));
  assert.ok(line.includes(shape.detail));
  assert.ok(line.includes(shape.action));
  assert.equal(flattenUpstreamError(null), '');
});

// ── upstreamErrorPayload ────────────────────────────────────────────────────────

test('a recognised failure yields both the legacy string and the rich shape', () => {
  const payload = upstreamErrorPayload(new Error('Proxmox POST /nodes/pve1/qemu/105/status/start → 500: VM is locked (backup)'));
  assert.equal(typeof payload.error, 'string');
  assert.match(payload.error, /VM is locked/i);
  assert.match(payload.detail, /backup/);
  assert.equal(typeof payload.action, 'string');
});

test('an unrecognised failure yields the sanitized string and nothing else', () => {
  const payload = upstreamErrorPayload(new Error('Proxmox GET /nodes → 500: mystery at 10.0.0.5'));
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.match(payload.error, /\[internal-host\]/);
  assert.doesNotMatch(payload.error, /10\.0\.0\.5/);
});

test('this layer never passes text through — a status on the error is not its call', () => {
  // Whether a message is portal-authored is decided in utils/httpError.js.
  // Everything reaching here is treated as upstream text, so an error that
  // happens to carry a status is still translated or redacted.
  const err = new Error('Caddy admin API error: dial tcp 10.0.0.9:2019 refused');
  err.statusCode = 400;
  assert.doesNotMatch(upstreamErrorPayload(err).error, /10\.0\.0\.9/);

  const tagged = Object.assign(new Error('Cannot reach 10.0.0.5 from the portal'), { status: 400 });
  assert.doesNotMatch(upstreamErrorPayload(tagged).error, /10\.0\.0\.5/);
});

test('upstreamErrorPayload picks up the host tag the Proxmox client attaches', () => {
  const err = new Error('connect ECONNREFUSED 10.0.0.5:8006');
  err.upstreamHost = 'pve-cluster-a';
  err.upstreamHref = ADMIN_PVE_HOSTS_HREF;
  const payload = upstreamErrorPayload(err);
  assert.match(payload.detail, /pve-cluster-a/);
  assert.equal(payload.href, ADMIN_PVE_HOSTS_HREF);
});

test('an explicit context beats the error tag', () => {
  const err = new Error('Proxmox request timeout');
  err.upstreamHost = 'tagged-host';
  assert.match(upstreamErrorPayload(err, { host: 'explicit-host' }).detail, /explicit-host/);
});

test('upstreamErrorPayload accepts a bare string and null', () => {
  assert.match(upstreamErrorPayload('VM is locked (backup)').error, /VM is locked/i);
  assert.deepEqual(upstreamErrorPayload(null), { error: 'Internal server error' });
  assert.deepEqual(upstreamErrorPayload(new Error('')), { error: 'Internal server error' });
});
