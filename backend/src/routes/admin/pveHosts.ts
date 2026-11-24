import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { pveHosts } from '../../db/schema/index.ts';
import { getHostStatus, getHosts, getHost, getHostStoragePools, testHostConnection } from '../../proxmox.ts';
import { IloError, normalizeTlsFingerprint, probeIloCertificate } from '../../services/iloAdapter.ts';
import { setStorageExposed, storageVisibilityMap } from '../../utils/storageVisibility.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { encryptSecret } from '../../utils/secrets.ts';
import { encodeNodeRef } from '../../utils/nodeRef.ts';
import { listMaintenance, enterMaintenance, exitMaintenanceById } from '../../utils/nodeMaintenance.ts';
import { deletePveHost, pveHostDependencies } from '../../services/pveHostLifecycle.ts';
import { boundedString, validateHost, validatePort } from '../../utils/validation.ts';
import { ALLOW_INSECURE_UPSTREAM_TLS, pHosts } from './shared.ts';

const router = Router();

// ─── PVE Hosts ──────────────────────────────────────────────────────────────

router.get('/pve-hosts', pHosts, async (req, res) => {
  const hosts = (await getHosts()).map(h => ({
    id: h.id, name: h.name, host: h.host, port: h.port,
    token_id: h.token_id, verify_tls: h.verify_tls, tls_fingerprint: h.tls_fingerprint || null, created_at: h.created_at,
    // Don't send token_secret / ssh_secret to frontend
    ssh_host: h.ssh_host || '', ssh_port: h.ssh_port || 22,
    ssh_user: h.ssh_user || 'root', ssh_auth_type: h.ssh_auth_type || 'key',
    has_ssh: !!(h.ssh_host && h.ssh_secret),
  }));
  res.json(hosts);
});

router.get('/pve-hosts/:id/status', pHosts, async (req, res) => {
  const host = await getHost(parseInt(req.params.id));
  if (!host) return res.status(404).json({ error: 'Host not found' });
  const status = await getHostStatus(host);
  // Annotate each node with its maintenance state (amber, not down) so the
  // PVE Hosts page can render the drain and offer the per-node toggle.
  const maint = await listMaintenance();
  if (Array.isArray(status.nodes)) {
    status.nodes = status.nodes.map((n) => {
      const nodeRef = encodeNodeRef(host.id, n.node);
      const m = maint.find((x) => x.nodeRef === nodeRef || (x.hostId == null && x.node === n.node));
      return { ...n, nodeRef, maintenance: m ? { id: m.id, reason: m.reason, until: m.until, untilLabel: m.untilLabel } : null };
    });
  }
  res.json(status);
});

// A pinned certificate replaces CA verification, so it may stand in for
// verify_tls without the ALLOW_INSECURE_UPSTREAM_TLS break-glass.
const PVE_INSECURE_TLS_ERROR = 'Disabling Proxmox TLS verification is blocked unless the host certificate is pinned or ALLOW_INSECURE_UPSTREAM_TLS=true is set';
const pveTlsLabel = (verifyTls, pin) => (pin ? 'pinned' : verifyTls ? 'verify' : 'insecure');

// undefined keeps `existing`; null or '' means no pin; anything else must be
// a SHA-256 fingerprint (throws a 400-able error otherwise).
function pinFromBody(raw, existing = null) {
  if (raw === undefined) return existing;
  if (raw === null || raw === '') return null;
  const pin = normalizeTlsFingerprint(raw);
  if (!pin) throw Object.assign(new Error('The pinned certificate must be a SHA-256 fingerprint'), { field: 'tlsFingerprint' });
  return pin;
}

// Reads the certificate a PVE host presents so an admin can confirm and pin
// it. TLS handshake only: no HTTP request, so no token is ever sent.
router.post('/pve-hosts/certificate-probe', pHosts, async (req, res) => {
  let host, port;
  try {
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  try {
    // PVE hosts are admin-registered targets reached by name like every other
    // PVE call, so the iLO-specific address guard does not apply here.
    const certificate = await probeIloCertificate(host, port, { validateTarget: async (h) => h });
    res.set('Cache-Control', 'no-store').json(certificate);
  } catch (err) {
    if (err instanceof IloError) return res.status(502).json({ code: err.code, error: 'Could not read the host certificate' });
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Tries host/port/token with the given trust settings without saving
// anything. For an existing host (`id`) a blank secret reuses the stored one,
// but only while address, token ID and trust are unchanged.
router.post('/pve-hosts/test', pHosts, async (req, res) => {
  let host, port, pin;
  const { tokenId, tokenSecret, verifyTls = true, id } = req.body || {};
  try {
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
    pin = pinFromBody(req.body?.tlsFingerprint ?? null);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (!host || !tokenId) return res.status(400).json({ error: 'Host and tokenId are required' });
  if (!verifyTls && !pin && !ALLOW_INSECURE_UPSTREAM_TLS) return res.status(400).json({ error: PVE_INSECURE_TLS_ERROR });
  let secret = tokenSecret ? encryptSecret(tokenSecret) : null;
  if (!secret && id != null) {
    const existing = await getHost(Number.parseInt(id, 10));
    if (!existing) return res.status(404).json({ error: 'Host not found' });
    const unchanged = host === existing.host && port === Number(existing.port) && tokenId === existing.token_id
      && pin === (existing.tls_fingerprint || null) && (!!verifyTls || existing.verify_tls === false);
    if (unchanged) secret = existing.token_secret;
  }
  if (!secret) return res.status(400).json({ error: 'Enter the API token secret to test this connection', field: 'tokenSecret' });
  const result = await testHostConnection({ name: host, host, port, token_id: tokenId, token_secret: secret, verify_tls: !!verifyTls, tls_fingerprint: pin });
  res.set('Cache-Control', 'no-store').json(result);
});

router.post('/pve-hosts', pHosts, async (req, res) => {
  let name, host, port, pin;
  const { tokenId, tokenSecret, verifyTls = true } = req.body;
  try {
    name = boundedString(req.body?.name, { field: 'name', min: 1, max: 80 });
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
    if (req.body?.sshHost) validateHost(req.body.sshHost);
    pin = pinFromBody(req.body?.tlsFingerprint ?? null);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (!name || !host || !tokenId || !tokenSecret) {
    return res.status(400).json({ error: 'Name, host, tokenId and tokenSecret are required' });
  }
  if (!verifyTls && !pin && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: PVE_INSECURE_TLS_ERROR });
  }
  try {
    const [r] = await db.insert(pveHosts).values({
      name, host, port, token_id: tokenId, token_secret: encryptSecret(tokenSecret), verify_tls: !!verifyTls, tls_fingerprint: pin,
    }).returning({ id: pveHosts.id });
    const { sshHost, sshPort, sshUser, sshAuthType, sshSecret } = req.body;
    if (String(sshHost || '').trim() && sshSecret) {
      await db.update(pveHosts).set({
        ssh_host: String(sshHost).trim(), ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: String(sshUser || 'root').trim() || 'root',
        ssh_auth_type: sshAuthType === 'password' ? 'password' : 'key', ssh_secret: encryptSecret(sshSecret),
      }).where(eq(pveHosts.id, r.id));
    }
    await logAudit(req, 'pve_host_created', String(r.id), `name=${name}; host=${host}; port=${port}; tls=${pveTlsLabel(verifyTls, pin)}${pin ? `; pin=${pin}` : ''}`);
    res.json({ id: r.id, name, host, port });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/pve-hosts/:id', pHosts, async (req, res) => {
  let name, host, port, pin;
  const { tokenId, tokenSecret, verifyTls, sshHost, sshPort, sshUser, sshAuthType, sshSecret } = req.body;
  const existing = await getHost(parseInt(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Host not found' });
  try {
    name = boundedString(req.body?.name, { field: 'name', min: 1, max: 80 });
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
    if (sshHost) validateHost(sshHost);
    if (sshPort !== undefined) validatePort(sshPort);
    pin = pinFromBody(req.body?.tlsFingerprint, existing.tls_fingerprint || null);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (!name || !host || !tokenId) {
    return res.status(400).json({ error: 'Name, host and tokenId are required' });
  }

  const verifyTlsEnabled = verifyTls === undefined ? existing.verify_tls !== false : !!verifyTls;
  if (!verifyTlsEnabled && !pin && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: PVE_INSECURE_TLS_ERROR });
  }
  // A blank secret keeps the stored one only while the upstream target and its
  // TLS trust are unchanged; otherwise the stored secret would be sent to a
  // different server (new address, token id, pin, or verification switched off).
  const oldPin = existing.tls_fingerprint || null;
  const trustChanged = pin !== oldPin || (!verifyTlsEnabled && existing.verify_tls !== false);
  const targetChanged = host !== existing.host || port !== Number(existing.port) || tokenId !== existing.token_id;
  if (!tokenSecret && (trustChanged || targetChanged)) {
    return res.status(400).json({ error: 'Re-enter the API token secret when changing the address or TLS trust', field: 'tokenSecret' });
  }
  const sshHostNew = sshHost === undefined ? undefined : String(sshHost || '').trim();
  if (sshHostNew && !sshSecret && existing.ssh_secret
    && (sshHostNew !== (existing.ssh_host || '') || (parseInt(sshPort, 10) || 22) !== Number(existing.ssh_port || 22))) {
    return res.status(400).json({ error: 'Re-enter the SSH secret when changing the address', field: 'sshSecret' });
  }
  const secret = tokenSecret ? encryptSecret(tokenSecret) : existing.token_secret;
  await db.update(pveHosts).set({
    name, host, port, token_id: tokenId, token_secret: secret, verify_tls: verifyTlsEnabled, tls_fingerprint: pin,
  }).where(eq(pveHosts.id, Number(req.params.id)));
  if (pin !== oldPin) {
    await logAudit(req, 'pve_host_tls_pin_changed', String(req.params.id), `name=${name}; from=${oldPin || 'none'}; to=${pin || 'none'}`);
  }

  // Optional root SSH (used only for post-migration source-config cleanup).
  // Empty sshHost clears the whole SSH config; an empty sshSecret keeps the
  // stored one. Changing the SSH host re-pins the host key on next connect.
  if (sshHost !== undefined) {
    const newSshHost = String(sshHost || '').trim();
    if (!newSshHost) {
      await db.update(pveHosts).set({ ssh_host: '', ssh_secret: '', ssh_host_key: '' }).where(eq(pveHosts.id, Number(req.params.id)));
    } else {
      const sshSecretStored = sshSecret ? encryptSecret(sshSecret) : (existing.ssh_secret || '');
      const hostKey = newSshHost === (existing.ssh_host || '') ? (existing.ssh_host_key || '') : '';
      await db.update(pveHosts).set({
        ssh_host: newSshHost, ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: String(sshUser || 'root').trim() || 'root',
        ssh_auth_type: sshAuthType === 'password' ? 'password' : 'key', ssh_secret: sshSecretStored, ssh_host_key: hostKey,
      }).where(eq(pveHosts.id, Number(req.params.id)));
    }
  }
  await logAudit(req, 'pve_host_updated', String(req.params.id), `name=${name}; host=${host}; port=${port}; tls=${pveTlsLabel(verifyTlsEnabled, pin)}`);
  res.json({ ok: true });
});

router.get('/pve-hosts/:id/dependencies', pHosts, async (req, res) => {
  if (!await getHost(Number.parseInt(req.params.id, 10))) return res.status(404).json({ error: 'Host not found' });
  res.json(await pveHostDependencies(req.params.id));
});

router.delete('/pve-hosts/:id', pHosts, async (req, res) => {
  const host = await getHost(Number.parseInt(req.params.id, 10));
  if (!host) return res.status(404).json({ error: 'Host not found' });
  try {
    await deletePveHost(req.params.id);
    await logAudit(req, 'pve_host_deleted', String(req.params.id), `name=${host.name}; host=${host.host}`);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'PVE_LAST_HOST') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'PVE_HOST_HAS_DEPENDENCIES') {
      return res.status(409).json({ error: err.message, code: err.code, ...err.report });
    }
    throw err;
  }
});

// ─── Storage pool exposure ───────────────────────────────────────────────────
// Admins choose which Proxmox storage pools regular users may pick when creating
// VMs / editing disks. A pool with no stored row is exposed by default, so there
// is zero behavior change until an admin hides a pool.

router.get('/pve-hosts/:id/storages', pHosts, async (req, res) => {
  const hostId = parseInt(req.params.id, 10);
  const host = await getHost(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  try {
    const pools = await getHostStoragePools(host);
    const visibility = await storageVisibilityMap(hostId);
    const rows = pools
      .map((p) => ({
        storage: p.storage,
        type: p.type || '',
        content: p.content || '',
        // Missing row ⇒ exposed by default.
        exposed: visibility.has(p.storage) ? visibility.get(p.storage) : true,
      }))
      .sort((a, b) => a.storage.localeCompare(b.storage));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/pve-hosts/:id/storages/:storage', pHosts, async (req, res) => {
  const hostId = parseInt(req.params.id, 10);
  const host = await getHost(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  const storage = String(req.params.storage || '').trim();
  if (!storage || !/^[a-zA-Z0-9._-]+$/.test(storage)) {
    return res.status(400).json({ error: 'Invalid storage identifier' });
  }
  const exposed = req.body?.exposed !== false && req.body?.exposed !== 0;
  await setStorageExposed(hostId, storage, exposed);
  await logAudit(req, 'storage_visibility_change', `${host.name}/${storage}`, exposed ? 'exposed' : 'hidden');
  res.json({ ok: true, storage, exposed });
});

// ─── Node maintenance (soft drain) ───────────────────────────────────────────
// Toggle per-node maintenance. While active, provisioning to the node is
// blocked, a notice is auto-published, and Overview health renders it amber.
// Running VMs are untouched.

router.get('/node-maintenance', pHosts, async (req, res) => {
  try {
    res.json(await listMaintenance());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/node-maintenance', pHosts, async (req, res) => {
  const { node, reason = '', until = null } = req.body;
  if (!node) return res.status(400).json({ error: 'A node is required' });
  try {
    const row = await enterMaintenance({ node, reason, until, req });
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/node-maintenance/:id', pHosts, async (req, res) => {
  try {
    const ok = await exitMaintenanceById(parseInt(req.params.id, 10), req);
    if (!ok) return res.status(404).json({ error: 'Maintenance entry not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
