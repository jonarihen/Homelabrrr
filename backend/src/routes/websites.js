import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { sanitizeError } from '../utils/sanitize.js';
import { encryptSecret } from '../utils/secrets.js';
import { createClient } from '../fortigate.js';
import { createCaddyClient } from '../utils/caddy.js';
import {
  normalizeDomain, isValidDomain, isValidUpstreamHost, parsePort,
  validateDomainDns, userCanReachUpstream, getUserAllowedUpstreams,
} from '../utils/websiteChecks.js';

const router = Router();
router.use(requireAuth);

const pWebsites = requirePermission('can_manage_websites');
const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';
const AUTH_TYPES = new Set(['none', 'bearer', 'basic', 'header']);

// DNS validation and publishing touch external resolvers / the Caddy admin API;
// rate-limit them per client so a user can't hammer DNS or the ACME pipeline.
const dnsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many DNS/publish attempts — slow down and try again in a few minutes.' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Step / status tracking (mirrors the provisioning stepper) ─────────────────

const INITIAL_STEPS = [
  { key: 'dns',     label: 'DNS points at homelab WAN IP' },
  { key: 'push',    label: 'Push reverse-proxy route to Caddy' },
  { key: 'cert',    label: "Let's Encrypt certificate issued & synced" },
  { key: 'inspect', label: 'Attach cert to FortiGate SSL inspection' },
  { key: 'live',    label: 'Site live' },
];

function stepList(steps) {
  return JSON.stringify(steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' })));
}

function setSiteStep(siteId, key, status, note) {
  const row = db.prepare('SELECT steps FROM caddy_sites WHERE id = ?').get(siteId);
  let steps = [];
  try { steps = row?.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  db.prepare('UPDATE caddy_sites SET steps = ? WHERE id = ?').run(JSON.stringify(steps), siteId);
}

function setSiteStatus(siteId, status, detail) {
  db.prepare('UPDATE caddy_sites SET status = ?, status_detail = ? WHERE id = ?').run(status, detail ?? '', siteId);
}

// ─── Serializers ───────────────────────────────────────────────────────────────

function serializeSite(row) {
  let steps = [];
  try { steps = row.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name || '',
    domain: row.domain,
    upstreamHost: row.upstream_host,
    upstreamPort: row.upstream_port,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username || null,
    status: row.status,
    statusDetail: row.status_detail || '',
    steps,
    fortigateId: row.fortigate_id,
    inspectionProfile: row.inspection_profile || '',
    certName: row.cert_name || '',
    createdAt: row.created_at,
    url: `https://${row.domain}`,
  };
}

function serializeServer(row) {
  const fw = row.fortigate_id ? db.prepare('SELECT name, external_ip, wan_interface, root_vdom FROM firewalls WHERE id = ?').get(row.fortigate_id) : null;
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    authType: row.auth_type || 'none',
    hasAuth: !!row.auth_secret,
    serverName: row.server_name || '',
    verifyTls: row.verify_tls !== 0,
    wanIp: effectiveWanIp(row),
    wanIpManual: row.wan_ip || '',
    fortigateId: row.fortigate_id || null,
    fortigateName: fw?.name || null,
    inspectionProfile: row.inspection_profile || '',
    createdAt: row.created_at,
    siteCount: db.prepare('SELECT COUNT(*) AS c FROM caddy_sites WHERE server_id = ?').get(row.id).c,
  };
}

// ─── Lookups ───────────────────────────────────────────────────────────────────

function getServerRow(id) {
  return db.prepare('SELECT * FROM caddy_servers WHERE id = ?').get(id);
}

// WAN IP used for DNS validation: the explicit manual value wins; otherwise fall
// back to the linked FortiGate's stored external IP.
function effectiveWanIp(server) {
  if (server.wan_ip) return server.wan_ip;
  if (server.fortigate_id) {
    const fw = db.prepare('SELECT external_ip FROM firewalls WHERE id = ?').get(server.fortigate_id);
    if (fw?.external_ip) return fw.external_ip;
  }
  return '';
}

// A site row joined with its owner + server name, scoped for reads.
const SITE_SELECT = `
  SELECT s.*, u.username AS owner_username, cs.name AS server_name, cs.server_name AS caddy_server_name
  FROM caddy_sites s
  LEFT JOIN users u ON u.id = s.owner_user_id
  LEFT JOIN caddy_servers cs ON cs.id = s.server_id
`;

function loadSiteForUser(req, id) {
  const row = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(id);
  if (!row) return { row: null };
  const owns = req.session.isAdmin || row.owner_user_id === req.session.userId;
  return { row, owns };
}

// ─── FortiGate cert discovery ──────────────────────────────────────────────────

function deriveCertCandidates(domain) {
  const d = domain.toLowerCase();
  return [d, d.replace(/\./g, '_'), d.replace(/\./g, '-'), `cert-${d}`, `le-${d}`];
}

// Find the local certificate `caddy-forticertsync` synced for this domain.
// Matching is best-effort (name equality against common derivations, then a
// substring fallback) since the sync tool's exact naming can vary.
async function findSyncedCert(fwClient, rootVdom, domain) {
  const certs = await fwClient.getLocalCertificates(rootVdom);
  const candidates = deriveCertCandidates(domain);
  const byName = certs.find((c) => candidates.includes(String(c.name || '').toLowerCase()));
  if (byName) return byName.name;
  const bySubstring = certs.find((c) => String(c.name || '').toLowerCase().includes(domain.toLowerCase()));
  return bySubstring ? bySubstring.name : null;
}

// ─── The end-to-end publish flow (runs in the background) ──────────────────────

const CERT_POLL_ATTEMPTS = 30;
const CERT_POLL_MS = 6000;

async function runSiteFlow(siteId) {
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(siteId);
  if (!site) return;
  const server = getServerRow(site.server_id);
  if (!server) {
    setSiteStep(siteId, 'push', 'error', 'Caddy server no longer registered');
    setSiteStatus(siteId, 'error', 'The Caddy server for this site was removed.');
    return;
  }

  // ── Push the route ──────────────────────────────────────────────────────────
  setSiteStep(siteId, 'push', 'active');
  setSiteStatus(siteId, 'pushing', '');
  try {
    const caddy = createCaddyClient(server);
    await caddy.upsertRoute(siteId, site.domain, site.upstream_host, site.upstream_port);
    setSiteStep(siteId, 'push', 'done');
  } catch (err) {
    setSiteStep(siteId, 'push', 'error', err.message);
    setSiteStatus(siteId, 'error', `Could not push the route to Caddy: ${err.message}`);
    return;
  }

  const fw = site.fortigate_id ? db.prepare('SELECT * FROM firewalls WHERE id = ?').get(site.fortigate_id) : null;
  const profileName = site.inspection_profile || '';

  // No inspection wiring requested → the site is already live through Caddy.
  if (!fw || !profileName) {
    setSiteStep(siteId, 'cert', 'skipped', 'No FortiGate inspection profile configured for this site');
    setSiteStep(siteId, 'inspect', 'skipped', 'No FortiGate inspection profile configured for this site');
    setSiteStep(siteId, 'live', 'done');
    setSiteStatus(siteId, 'live', 'Route published to Caddy. Certificate issuance is handled by Caddy/Let’s Encrypt.');
    return;
  }

  // ── Wait for the synced certificate, then attach it to the profile ──────────
  setSiteStep(siteId, 'cert', 'active');
  setSiteStatus(siteId, 'issuing', '');
  const rootVdom = fw.root_vdom || 'root';
  let certName = null;
  try {
    const client = createClient(fw);
    for (let i = 0; i < CERT_POLL_ATTEMPTS; i++) {
      certName = await findSyncedCert(client, rootVdom, site.domain).catch(() => null);
      if (certName) break;
      await sleep(CERT_POLL_MS);
    }

    if (!certName) {
      setSiteStep(siteId, 'cert', 'skipped', 'Certificate not synced to the FortiGate yet — retry once Let’s Encrypt has issued it');
      setSiteStep(siteId, 'inspect', 'skipped', 'Waiting on the certificate');
      setSiteStep(siteId, 'live', 'done');
      setSiteStatus(siteId, 'warning', 'Site is served by Caddy, but the certificate has not synced to the FortiGate yet. Use Retry after a minute to wire up SSL inspection.');
      return;
    }

    setSiteStep(siteId, 'cert', 'done');
    db.prepare('UPDATE caddy_sites SET cert_name = ? WHERE id = ?').run(certName, siteId);

    // ── Attach the cert to the SSL/SSH inspection profile ─────────────────────
    setSiteStep(siteId, 'inspect', 'active');
    setSiteStatus(siteId, 'inspecting', '');
    await client.setInspectionServerCert(profileName, certName, rootVdom);
    setSiteStep(siteId, 'inspect', 'done');
    setSiteStep(siteId, 'live', 'done');
    setSiteStatus(siteId, 'live', '');
  } catch (err) {
    setSiteStep(siteId, 'inspect', 'error', err.message);
    setSiteStatus(siteId, 'warning', `Route is live in Caddy, but attaching the certificate to SSL inspection failed: ${err.message}. You can retry.`);
  }
}

function startSiteFlow(siteId) {
  // Fire-and-forget; the UI polls status. Failures are captured onto the row.
  runSiteFlow(siteId).catch((err) => {
    console.error(`[websites] site ${siteId} flow crashed:`, err.message);
    try { setSiteStatus(siteId, 'error', sanitizeError(err.message)); } catch { /* ignore */ }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN — Caddy server registration
// ════════════════════════════════════════════════════════════════════════════

router.get('/servers', pWebsites, (req, res) => {
  const rows = db.prepare('SELECT * FROM caddy_servers ORDER BY name').all();
  res.json(rows.map(serializeServer));
});

function validateServerBody(body) {
  const { name, apiUrl } = body;
  if (!name || !apiUrl) return 'Name and admin API URL are required';
  let parsed;
  try { parsed = new URL(apiUrl); } catch { return 'Admin API URL is not a valid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Admin API URL must be http:// or https://';
  if (!parsed.hostname) return 'Admin API URL must include a host';
  const authType = body.authType || 'none';
  if (!AUTH_TYPES.has(authType)) return 'Invalid auth type';
  const verifyTls = body.verifyTls !== false;
  if (parsed.protocol === 'https:' && !verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return 'Disabling Caddy admin API TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set';
  }
  return null;
}

router.post('/servers', pWebsites, (req, res) => {
  const err = validateServerBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, apiUrl, authType = 'none', authSecret = '', serverName = '', verifyTls = true, wanIp = '', fortigateId = null, inspectionProfile = '' } = req.body;
  try {
    const r = db.prepare(`
      INSERT INTO caddy_servers (name, api_url, auth_type, auth_secret, server_name, verify_tls, wan_ip, fortigate_id, inspection_profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, apiUrl, authType,
      authSecret ? encryptSecret(authSecret) : '',
      serverName, verifyTls ? 1 : 0, wanIp,
      fortigateId || null, inspectionProfile,
    );
    logAudit(req, 'website_create_caddy_server', name, apiUrl);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

router.put('/servers/:id', pWebsites, (req, res) => {
  const existing = getServerRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Caddy server not found' });
  const err = validateServerBody({ ...req.body, name: req.body.name ?? existing.name, apiUrl: req.body.apiUrl ?? existing.api_url });
  if (err) return res.status(400).json({ error: err });

  const name = req.body.name ?? existing.name;
  const apiUrl = req.body.apiUrl ?? existing.api_url;
  const authType = req.body.authType ?? existing.auth_type;
  // Empty authSecret keeps the current one (matches the firewall/PVE pattern).
  const authSecret = req.body.authSecret ? encryptSecret(req.body.authSecret) : existing.auth_secret;
  const serverName = req.body.serverName ?? existing.server_name;
  const verifyTls = req.body.verifyTls === undefined ? existing.verify_tls !== 0 : !!req.body.verifyTls;
  const wanIp = req.body.wanIp ?? existing.wan_ip;
  const fortigateId = req.body.fortigateId === undefined ? existing.fortigate_id : (req.body.fortigateId || null);
  const inspectionProfile = req.body.inspectionProfile ?? existing.inspection_profile;

  db.prepare(`
    UPDATE caddy_servers SET name = ?, api_url = ?, auth_type = ?, auth_secret = ?, server_name = ?, verify_tls = ?, wan_ip = ?, fortigate_id = ?, inspection_profile = ? WHERE id = ?
  `).run(name, apiUrl, authType, authSecret, serverName, verifyTls ? 1 : 0, wanIp, fortigateId, inspectionProfile, req.params.id);
  logAudit(req, 'website_update_caddy_server', name, apiUrl);
  res.json({ ok: true });
});

router.delete('/servers/:id', pWebsites, (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  const siteCount = db.prepare('SELECT COUNT(*) AS c FROM caddy_sites WHERE server_id = ?').get(req.params.id).c;
  if (siteCount > 0) {
    return res.status(400).json({ error: `Remove the ${siteCount} published site(s) on this server first.` });
  }
  db.prepare('DELETE FROM caddy_servers WHERE id = ?').run(req.params.id);
  logAudit(req, 'website_delete_caddy_server', server.name, '');
  res.json({ ok: true });
});

router.get('/servers/:id/status', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  try {
    const caddy = createCaddyClient(server);
    const info = await caddy.ping();
    res.json(info);
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

// Auto-read the WAN IP from the linked FortiGate (stored external IP, else the
// live WAN interface address) and store it as the manual value.
router.post('/servers/:id/detect-wan-ip', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  if (!server.fortigate_id) return res.status(400).json({ error: 'Link a FortiGate to this Caddy server first' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(server.fortigate_id);
  if (!fw) return res.status(404).json({ error: 'Linked FortiGate not found' });
  try {
    let ip = fw.external_ip || '';
    if (!ip) {
      const client = createClient(fw);
      const iface = await client.getInterface(fw.wan_interface);
      ip = String(iface?.ip || '').split(' ')[0] || '';
    }
    if (!ip) return res.status(400).json({ error: 'Could not determine a WAN IP from the FortiGate' });
    db.prepare('UPDATE caddy_servers SET wan_ip = ? WHERE id = ?').run(ip, req.params.id);
    logAudit(req, 'website_detect_wan_ip', server.name, ip);
    res.json({ wanIp: ip });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// SSL/SSH inspection profiles + local certs on the linked FortiGate (admin, for
// picking the profile to wire certs into).
router.get('/servers/:id/inspection-profiles', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  if (!server.fortigate_id) return res.json({ profiles: [], certificates: [] });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(server.fortigate_id);
  if (!fw) return res.status(404).json({ error: 'Linked FortiGate not found' });
  try {
    const client = createClient(fw);
    const rootVdom = fw.root_vdom || 'root';
    const [profiles, certs] = await Promise.all([
      client.getSslSshProfiles(rootVdom),
      client.getLocalCertificates(rootVdom),
    ]);
    res.json({
      profiles: profiles.map((p) => ({ name: p.name, comment: p.comment || '' })),
      certificates: certs.map((c) => ({ name: c.name })),
    });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  ADMIN — all sites + ownership assignment
// ────────────────────────────────────────────────────────────────────────────

router.get('/admin/sites', pWebsites, (req, res) => {
  const rows = db.prepare(`${SITE_SELECT} ORDER BY s.created_at DESC`).all();
  res.json(rows.map(serializeSite));
});

// Minimal directories for the admin dropdowns. Exposed under can_manage_websites
// so a websites-only admin isn't forced to also hold can_manage_users /
// can_manage_firewalls just to assign an owner or link a FortiGate.
router.get('/admin/users', pWebsites, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin FROM users ORDER BY username').all();
  res.json(users.map((u) => ({ id: u.id, username: u.username, isAdmin: u.is_admin === 1 })));
});

router.get('/firewalls', pWebsites, (req, res) => {
  const fws = db.prepare('SELECT id, name, wan_interface, external_ip, root_vdom FROM firewalls ORDER BY name').all();
  res.json(fws.map((f) => ({ id: f.id, name: f.name, wanInterface: f.wan_interface, externalIp: f.external_ip || '', rootVdom: f.root_vdom || 'root' })));
});

router.post('/admin/sites/:id/assign', pWebsites, (req, res) => {
  const { userId } = req.body;
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  let newOwner = null;
  if (userId !== null && userId !== undefined && userId !== '') {
    newOwner = parseInt(userId, 10);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(newOwner);
    if (!target) return res.status(404).json({ error: 'User not found' });
  }
  db.prepare('UPDATE caddy_sites SET owner_user_id = ? WHERE id = ?').run(newOwner, req.params.id);
  logAudit(req, 'website_assign_site', site.domain, `owner=${newOwner ?? 'none'}`);
  res.json({ ok: true });
});

router.delete('/admin/sites/:id', pWebsites, async (req, res) => {
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  await removeSite(site);
  logAudit(req, 'website_delete_site', site.domain, 'admin');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  USER — self-service publishing
// ════════════════════════════════════════════════════════════════════════════

// Servers a user can publish to + whether they'd be able to (needs a WAN IP).
router.get('/config', (req, res) => {
  const servers = db.prepare('SELECT * FROM caddy_servers ORDER BY name').all().map((s) => ({
    id: s.id,
    name: s.name,
    wanIp: effectiveWanIp(s),
    hasInspection: !!(s.fortigate_id && s.inspection_profile),
  }));
  res.json({ servers, isAdmin: !!req.session.isAdmin });
});

// The concrete upstream targets this user is allowed to point a site at.
router.get('/upstream-options', (req, res) => {
  if (req.session.isAdmin) {
    return res.json({ isAdmin: true, vms: [], subnets: [] });
  }
  const { vmIps, subnets } = getUserAllowedUpstreams(req.session.userId);
  // Enrich the raw IPs with the assigned VM identity for a friendlier picker.
  const assignments = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(req.session.userId);
  const sshStmt = db.prepare('SELECT host FROM vm_ssh_configs WHERE vmid = ?');
  const vms = [];
  for (const a of assignments) {
    const cfg = sshStmt.get(a.vmid);
    if (cfg?.host && vmIps.includes(cfg.host)) {
      vms.push({ vmid: a.vmid, node: a.node, ip: cfg.host });
    }
  }
  res.json({ isAdmin: false, vms, subnets, vmIps });
});

router.get('/sites', (req, res) => {
  const rows = req.session.isAdmin
    ? db.prepare(`${SITE_SELECT} ORDER BY s.created_at DESC`).all()
    : db.prepare(`${SITE_SELECT} WHERE s.owner_user_id = ? ORDER BY s.created_at DESC`).all(req.session.userId);
  res.json(rows.map(serializeSite));
});

router.get('/sites/:id', (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  res.json(serializeSite(row));
});

router.get('/sites/:id/status', (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  res.json(serializeSite(row));
});

// Pre-flight DNS check used by the publishing stepper (no row created).
router.post('/validate-dns', dnsLimiter, async (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'Enter a valid domain name (e.g. app.example.com)' });
  const server = getServerRow(req.body.serverId);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  try {
    const result = await validateDomainDns(domain, effectiveWanIp(server));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// Shared validation for create/update.
function validateSiteInput(req, { domain, upstreamHost, upstreamPort }) {
  const d = normalizeDomain(domain);
  if (!isValidDomain(d)) return { error: 'Enter a valid domain name (e.g. app.example.com)' };
  if (!isValidUpstreamHost(upstreamHost)) return { error: 'Upstream host must be a valid IP address or hostname' };
  const port = parsePort(upstreamPort);
  if (port === null) return { error: 'Upstream port must be between 1 and 65535' };
  const reach = userCanReachUpstream(req.session.userId, upstreamHost, req.session.isAdmin);
  if (!reach.ok) return { error: reach.message };
  return { domain: d, upstreamHost, upstreamPort: port };
}

router.post('/sites', dnsLimiter, async (req, res) => {
  const server = getServerRow(req.body.serverId);
  if (!server) return res.status(404).json({ error: 'Select a valid Caddy server' });

  const parsed = validateSiteInput(req, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { domain, upstreamHost, upstreamPort } = parsed;

  // Domain uniqueness — friendly message before we hit the UNIQUE constraint.
  const clash = db.prepare('SELECT owner_user_id FROM caddy_sites WHERE domain = ?').get(domain);
  if (clash) {
    const mine = clash.owner_user_id === req.session.userId;
    return res.status(409).json({ error: mine ? 'You have already published this domain.' : 'This domain is already published by another user.' });
  }

  // DNS must point at the WAN IP before we create anything.
  const wanIp = effectiveWanIp(server);
  let dnsResult;
  try {
    dnsResult = await validateDomainDns(domain, wanIp);
  } catch (e) {
    return res.status(500).json({ error: sanitizeError(e.message) });
  }
  if (!dnsResult.ok) return res.status(400).json({ error: dnsResult.message });

  // Inspection wiring defaults come from the server; only admins may override.
  const fortigateId = req.session.isAdmin && req.body.fortigateId !== undefined
    ? (req.body.fortigateId || null)
    : (server.fortigate_id || null);
  const inspectionProfile = req.session.isAdmin && req.body.inspectionProfile !== undefined
    ? String(req.body.inspectionProfile || '')
    : (server.inspection_profile || '');

  const steps = INITIAL_STEPS.map((s) => ({ ...s, status: s.key === 'dns' ? 'done' : 'pending' }));

  let siteId;
  try {
    const r = db.prepare(`
      INSERT INTO caddy_sites (server_id, domain, upstream_host, upstream_port, owner_user_id, status, status_detail, steps, fortigate_id, inspection_profile)
      VALUES (?, ?, ?, ?, ?, 'pushing', '', ?, ?, ?)
    `).run(server.id, domain, upstreamHost, upstreamPort, req.session.userId, stepList(steps), fortigateId, inspectionProfile);
    siteId = r.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This domain is already published.' });
    }
    return res.status(500).json({ error: sanitizeError(e.message) });
  }

  logAudit(req, 'website_create_site', domain, `${upstreamHost}:${upstreamPort} → caddy#${server.id}`);
  startSiteFlow(siteId);

  const row = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(siteId);
  res.json(serializeSite(row));
});

router.put('/sites/:id', dnsLimiter, async (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  const server = getServerRow(row.server_id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });

  // Domain is immutable (it's the UNIQUE identity + the cert subject); only the
  // upstream target can change. Re-validate ownership of the new upstream.
  const parsed = validateSiteInput(req, { domain: row.domain, upstreamHost: req.body.upstreamHost, upstreamPort: req.body.upstreamPort });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  db.prepare('UPDATE caddy_sites SET upstream_host = ?, upstream_port = ? WHERE id = ?')
    .run(parsed.upstreamHost, parsed.upstreamPort, row.id);
  logAudit(req, 'website_update_site', row.domain, `${parsed.upstreamHost}:${parsed.upstreamPort}`);

  // Reset the pipeline and re-run so Caddy gets the new upstream.
  const steps = INITIAL_STEPS.map((s) => ({ ...s, status: s.key === 'dns' ? 'done' : 'pending' }));
  db.prepare('UPDATE caddy_sites SET steps = ?, status = ?, status_detail = ? WHERE id = ?')
    .run(stepList(steps), 'pushing', '', row.id);
  startSiteFlow(row.id);

  const updated = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(row.id);
  res.json(serializeSite(updated));
});

router.post('/sites/:id/retry', dnsLimiter, (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });

  const steps = INITIAL_STEPS.map((s) => ({ ...s, status: s.key === 'dns' ? 'done' : 'pending' }));
  db.prepare('UPDATE caddy_sites SET steps = ?, status = ?, status_detail = ? WHERE id = ?')
    .run(stepList(steps), 'pushing', '', row.id);
  logAudit(req, 'website_retry_site', row.domain, '');
  startSiteFlow(row.id);

  const updated = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(row.id);
  res.json(serializeSite(updated));
});

router.delete('/sites/:id', async (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  try {
    await removeSite(row);
  } catch (e) {
    return res.status(500).json({ error: sanitizeError(e.message) });
  }
  logAudit(req, 'website_delete_site', row.domain, '');
  res.json({ ok: true });
});

// Remove the Caddy route for a site (best-effort) and drop the DB row. The
// synced FortiGate cert is left in place — it may be shared, and stale certs are
// harmless — but we only ever touch our own @id-tagged Caddy route.
async function removeSite(site) {
  const server = getServerRow(site.server_id);
  if (server) {
    try {
      const caddy = createCaddyClient(server);
      await caddy.deleteRoute(site.id);
    } catch (err) {
      console.warn(`[websites] failed to delete Caddy route for site ${site.id}: ${err.message}`);
    }
  }
  db.prepare('DELETE FROM caddy_sites WHERE id = ?').run(site.id);
}

export default router;
