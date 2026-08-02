// Regression coverage for the portal readiness / prerequisites evaluation.
// Run with:  node --test src/utils/readiness.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHostFailure,
  evaluateReadiness,
  readinessSeverity,
  summarizeReadiness,
} from './readiness.js';

// A fully-configured install: every check should come back ok. Individual tests
// below take this and break exactly one thing, so a status change is always
// attributable to the field that was changed.
function healthy(overrides = {}) {
  return {
    hosts: [{ id: 1, name: 'pve-a' }, { id: 2, name: 'pve-b' }],
    hostStatuses: [
      { hostId: 1, online: true },
      { hostId: 2, online: true },
    ],
    hostStorages: [
      { hostId: 1, total: 3, exposed: 2 },
      { hostId: 2, total: 2, exposed: 1 },
    ],
    firewalls: [{ id: 10, name: 'fw-lab', externalIp: '46.32.144.243' }],
    vlanSyncCounts: [{ firewallId: 10, count: 4 }],
    templateCount: 2,
    cloudImageCount: 1,
    provisionUserCount: 3,
    caddyServers: [{ id: 20, name: 'caddy-edge', wanIp: '46.32.144.243' }],
    siteCount: 5,
    webhookCount: 1,
    env: {
      secretEncryptionKey: true,
      sessionSecret: true,
      allowedOrigin: 'https://portal.example.com',
      portalBaseUrl: 'https://portal.example.com',
      trustProxy: '1',
    },
    ...overrides,
  };
}

const byId = (checks, id) => checks.find((c) => c.id === id);
const statusOf = (data, id) => byId(evaluateReadiness(data), id)?.status;

// ── Shape ────────────────────────────────────────────────────────────────────

test('every check carries the documented shape', () => {
  for (const check of evaluateReadiness(healthy())) {
    assert.equal(typeof check.id, 'string', `id on ${check.id}`);
    assert.equal(typeof check.label, 'string', `label on ${check.id}`);
    assert.ok(['ok', 'warn', 'missing'].includes(check.status), `status on ${check.id}`);
    assert.ok(check.detail.length > 0, `detail on ${check.id}`);
    assert.ok(check.href === null || typeof check.href === 'string', `href on ${check.id}`);
  }
});

test('a fully configured install reports no problems', () => {
  const checks = evaluateReadiness(healthy());
  const bad = checks.filter((c) => c.status !== 'ok');
  assert.deepEqual(bad.map((c) => c.id), []);
  assert.equal(summarizeReadiness(checks).missing, 0);
});

test('check ids are unique', () => {
  const ids = evaluateReadiness(healthy()).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ── The empty-fleet case ─────────────────────────────────────────────────────

test('a brand-new install reports the missing host and nothing downstream of it', () => {
  const checks = evaluateReadiness({});
  assert.equal(byId(checks, 'pve_hosts').status, 'missing');
  // Token validity and storage exposure are meaningless with zero hosts — they
  // would just repeat "no host registered" in two more red rows.
  assert.equal(byId(checks, 'pve_tokens'), undefined);
  assert.equal(byId(checks, 'storage_exposed'), undefined);
  // Same for a VLAN sync with no firewall to sync it to.
  assert.equal(byId(checks, 'firewall_vlan_sync'), undefined);
  // Optional subsystems still get one row each — their absence is information.
  assert.equal(byId(checks, 'firewall_external_ip').status, 'warn');
  assert.equal(byId(checks, 'caddy_wan_ip').status, 'warn');
  // No env at all: secrets are reported missing, the soft ones warn.
  assert.equal(byId(checks, 'secrets_env').status, 'missing');
  assert.equal(byId(checks, 'allowed_origin').status, 'warn');
  assert.equal(byId(checks, 'trust_proxy').status, 'warn');
  // Nobody can provision yet, so a deploy source is not required.
  assert.equal(byId(checks, 'provision_sources').status, 'ok');
});

test('evaluateReadiness never throws on absent or partial input', () => {
  assert.ok(evaluateReadiness().length > 0);
  assert.ok(evaluateReadiness({ hosts: [{ id: 1, name: 'pve' }] }).length > 0);
});

// ── PVE hosts ────────────────────────────────────────────────────────────────

test('host reachability moves ok → warn → missing as hosts drop off', () => {
  assert.equal(statusOf(healthy(), 'pve_hosts'), 'ok');

  const oneDown = healthy({ hostStatuses: [{ hostId: 1, online: true }, { hostId: 2, online: false, error: 'connect ETIMEDOUT' }] });
  assert.equal(statusOf(oneDown, 'pve_hosts'), 'warn');
  assert.match(byId(evaluateReadiness(oneDown), 'pve_hosts').detail, /pve-b/);

  const allDown = healthy({ hostStatuses: [{ hostId: 1, online: false, error: 'x' }, { hostId: 2, online: false, error: 'x' }] });
  assert.equal(statusOf(allDown, 'pve_hosts'), 'missing');
});

test('a host with no collected status counts as unreachable rather than crashing', () => {
  const data = healthy({ hostStatuses: [{ hostId: 1, online: true }] });
  assert.equal(statusOf(data, 'pve_hosts'), 'warn');
});

// ── API tokens ───────────────────────────────────────────────────────────────

test('a Proxmox 401 is reported as an invalid token, not as an unreachable host', () => {
  const data = healthy({
    hostStatuses: [
      { hostId: 1, online: true },
      { hostId: 2, online: false, error: 'Proxmox GET /version → 401: {"data":null}' },
    ],
  });
  const check = byId(evaluateReadiness(data), 'pve_tokens');
  assert.equal(check.status, 'missing');
  assert.match(check.detail, /rejected the API token/);
  assert.match(check.detail, /pve-b/);
});

test('an unreachable host downgrades the token check to warn — it was never validated', () => {
  const data = healthy({
    hostStatuses: [
      { hostId: 1, online: true },
      { hostId: 2, online: false, error: 'connect ECONNREFUSED 10.0.0.9:8006' },
    ],
  });
  assert.equal(statusOf(data, 'pve_tokens'), 'warn');
});

test('classifyHostFailure separates auth, TLS and plain unreachability', () => {
  assert.equal(classifyHostFailure('Proxmox GET /version → 401: {}'), 'auth');
  assert.equal(classifyHostFailure('Proxmox GET /nodes → 403: permission denied'), 'auth');
  assert.equal(classifyHostFailure('authentication failure'), 'auth');
  assert.equal(classifyHostFailure('Proxmox host TLS verification is disabled.'), 'tls');
  assert.equal(classifyHostFailure('self-signed certificate in certificate chain'), 'tls');
  assert.equal(classifyHostFailure('Proxmox request timeout'), 'unreachable');
  assert.equal(classifyHostFailure(''), 'unreachable');
  assert.equal(classifyHostFailure(undefined), 'unreachable');
  // A 404 is not an auth problem.
  assert.equal(classifyHostFailure('Proxmox GET /version → 404: not found'), 'unreachable');
});

// ── Storage visibility ───────────────────────────────────────────────────────

test('a host with every pool hidden is missing, not merely a warning', () => {
  const data = healthy({ hostStorages: [{ hostId: 1, total: 3, exposed: 2 }, { hostId: 2, total: 2, exposed: 0 }] });
  const check = byId(evaluateReadiness(data), 'storage_exposed');
  assert.equal(check.status, 'missing');
  assert.match(check.detail, /pve-b/);
});

test('a host that reports no storage pools at all is missing', () => {
  const data = healthy({ hostStorages: [{ hostId: 1, total: 3, exposed: 2 }, { hostId: 2, total: 0, exposed: 0 }] });
  assert.equal(statusOf(data, 'storage_exposed'), 'missing');
});

test('a storage list that failed to load only warns — it is not evidence of a problem', () => {
  const data = healthy({ hostStorages: [{ hostId: 1, total: 3, exposed: 2 }, { hostId: 2, error: 'Proxmox request timeout' }] });
  assert.equal(statusOf(data, 'storage_exposed'), 'warn');
});

test('storage exposure warns instead of erroring when no host is reachable', () => {
  const data = healthy({ hostStatuses: [{ hostId: 1, online: false, error: 'x' }, { hostId: 2, online: false, error: 'x' }] });
  assert.equal(statusOf(data, 'storage_exposed'), 'warn');
});

// ── Provisioning sources ─────────────────────────────────────────────────────

test('no template and no image is only a problem once somebody can provision', () => {
  const nobody = healthy({ templateCount: 0, cloudImageCount: 0, provisionUserCount: 0 });
  assert.equal(statusOf(nobody, 'provision_sources'), 'ok');

  const somebody = healthy({ templateCount: 0, cloudImageCount: 0, provisionUserCount: 2 });
  const check = byId(evaluateReadiness(somebody), 'provision_sources');
  assert.equal(check.status, 'missing');
  assert.match(check.detail, /New VM page is empty/);
});

test('either a template or a cloud image alone satisfies the deploy-source check', () => {
  assert.equal(statusOf(healthy({ templateCount: 1, cloudImageCount: 0 }), 'provision_sources'), 'ok');
  assert.equal(statusOf(healthy({ templateCount: 0, cloudImageCount: 1 }), 'provision_sources'), 'ok');
});

// ── Firewall ─────────────────────────────────────────────────────────────────

test('a firewall without an external IP is missing; no firewall at all only warns', () => {
  assert.equal(statusOf(healthy({ firewalls: [] }), 'firewall_external_ip'), 'warn');

  const blank = healthy({ firewalls: [{ id: 10, name: 'fw-lab', externalIp: '   ' }] });
  const check = byId(evaluateReadiness(blank), 'firewall_external_ip');
  assert.equal(check.status, 'missing');
  assert.match(check.detail, /fw-lab/);
});

test('VLAN sync goes ok → warn → missing as firewalls lose their synced VLANs', () => {
  assert.equal(statusOf(healthy(), 'firewall_vlan_sync'), 'ok');

  const partial = healthy({
    firewalls: [{ id: 10, name: 'fw-a', externalIp: '1.2.3.4' }, { id: 11, name: 'fw-b', externalIp: '1.2.3.5' }],
    vlanSyncCounts: [{ firewallId: 10, count: 2 }],
  });
  assert.equal(statusOf(partial, 'firewall_vlan_sync'), 'warn');

  const none = healthy({ vlanSyncCounts: [] });
  assert.equal(statusOf(none, 'firewall_vlan_sync'), 'missing');

  // A row that exists but counts zero is the same as no row at all.
  const zeroRow = healthy({ vlanSyncCounts: [{ firewallId: 10, count: 0 }] });
  assert.equal(statusOf(zeroRow, 'firewall_vlan_sync'), 'missing');
});

// ── Reverse proxy ────────────────────────────────────────────────────────────

test('a reverse proxy with no WAN IP is missing once sites exist, and a warning before that', () => {
  assert.equal(statusOf(healthy({ caddyServers: [] }), 'caddy_wan_ip'), 'warn');

  const noIpNoSites = healthy({ caddyServers: [{ id: 20, name: 'caddy-edge', wanIp: '' }], siteCount: 0 });
  assert.equal(statusOf(noIpNoSites, 'caddy_wan_ip'), 'warn');

  const noIpWithSites = healthy({ caddyServers: [{ id: 20, name: 'caddy-edge', wanIp: '' }], siteCount: 3 });
  assert.equal(statusOf(noIpWithSites, 'caddy_wan_ip'), 'missing');
});

// ── Environment ──────────────────────────────────────────────────────────────

test('a missing secret env var is reported by name', () => {
  const data = healthy({ env: { ...healthy().env, sessionSecret: false } });
  const check = byId(evaluateReadiness(data), 'secrets_env');
  assert.equal(check.status, 'missing');
  assert.match(check.detail, /SESSION_SECRET/);
  assert.doesNotMatch(check.detail, /SECRET_ENCRYPTION_KEY/);
});

test('an unset ALLOWED_ORIGIN warns about the weaker websocket origin check', () => {
  const data = healthy({ env: { ...healthy().env, allowedOrigin: '' } });
  const check = byId(evaluateReadiness(data), 'allowed_origin');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /Host header/);
});

test('notification links only matter once a webhook exists, and ALLOWED_ORIGIN can stand in', () => {
  const noWebhook = healthy({ webhookCount: 0, env: { ...healthy().env, portalBaseUrl: '', allowedOrigin: '' } });
  assert.equal(statusOf(noWebhook, 'portal_base_url'), 'ok');

  const fellBack = healthy({ env: { ...healthy().env, portalBaseUrl: '' } });
  const fallbackCheck = byId(evaluateReadiness(fellBack), 'portal_base_url');
  assert.equal(fallbackCheck.status, 'ok');
  assert.match(fallbackCheck.detail, /fall back to ALLOWED_ORIGIN/);

  const linkless = healthy({ env: { ...healthy().env, portalBaseUrl: '', allowedOrigin: '' } });
  const linklessCheck = byId(evaluateReadiness(linkless), 'portal_base_url');
  assert.equal(linklessCheck.status, 'missing');
  assert.match(linklessCheck.detail, /no link back to the portal/);
});

test('TRUST_PROXY reports only whether it is set — never an observed hop count', () => {
  const unset = healthy({ env: { ...healthy().env, trustProxy: '' } });
  assert.equal(statusOf(unset, 'trust_proxy'), 'warn');

  const set = healthy({ env: { ...healthy().env, trustProxy: '2' } });
  const check = byId(evaluateReadiness(set), 'trust_proxy');
  assert.equal(check.status, 'ok');
  assert.match(check.detail, /"2"/);

  // "false" is a deliberate configuration, not an omission.
  assert.equal(statusOf(healthy({ env: { ...healthy().env, trustProxy: 'false' } }), 'trust_proxy'), 'ok');
});

// ── Summary helpers ──────────────────────────────────────────────────────────

test('summarizeReadiness counts each bucket', () => {
  const summary = summarizeReadiness([
    { status: 'ok' }, { status: 'ok' }, { status: 'warn' }, { status: 'missing' },
  ]);
  assert.deepEqual(summary, { ok: 2, warn: 1, missing: 1, total: 4 });
  assert.deepEqual(summarizeReadiness(), { ok: 0, warn: 0, missing: 0, total: 0 });
});

test('readinessSeverity orders missing above warn above ok', () => {
  assert.ok(readinessSeverity('missing') > readinessSeverity('warn'));
  assert.ok(readinessSeverity('warn') > readinessSeverity('ok'));
  assert.equal(readinessSeverity('anything-else'), 0);
});
