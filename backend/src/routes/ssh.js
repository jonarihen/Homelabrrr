import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { userCanPerformVmOp } from '../utils/vmAccess.js';
import { nodeLookupCandidates } from '../utils/nodeRef.js';
import { normalizeSshHostFingerprint, scanSshHostFingerprint } from '../utils/sshHostKey.js';
import { decryptSecret, encryptSecret } from '../utils/secrets.js';
import { derivePublicKey } from '../utils/sshPublicKey.js';
import { logAudit } from '../utils/audit.js';
import { sendError } from '../utils/httpError.js';
import { authorizeSshTarget, sshConnectionRateLimited } from '../services/sshTargetPolicy.js';
import { sshClientError } from '../utils/sshError.js';
import { log } from '../utils/logger.js';

// Convert a PPK key (any version) to OpenSSH PEM using puttygen.
// passphrase is the PPK decryption passphrase (empty string if unencrypted).
async function ppkToOpenSSH(ppkContent, passphrase = '') {
  const id = uuidv4();
  const inPath       = join(tmpdir(), `${id}.ppk`);
  const outPath      = join(tmpdir(), `${id}.pem`);
  const oldPassPath  = join(tmpdir(), `${id}.oldpass`);
  const newPassPath  = join(tmpdir(), `${id}.newpass`);
  try {
    await writeFile(inPath, ppkContent, { mode: 0o600 });
    await writeFile(oldPassPath, passphrase, { mode: 0o600 });
    await writeFile(newPassPath, '', { mode: 0o600 });
    await new Promise((resolve, reject) => {
      const args = [inPath, '-O', 'private-openssh', '-o', outPath,
        '--old-passphrase', oldPassPath,
        '--new-passphrase', newPassPath];
      execFile('puttygen', args, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve();
      });
    });
    return await readFile(outPath, 'utf8');
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
    await unlink(oldPassPath).catch(() => {});
    await unlink(newPassPath).catch(() => {});
  }
}

const router = Router();
router.use(requireAuth);

function sendSshError(req, res, err) {
  if (err?.status && err.status < 500) return sendError(res, err);
  const payload = sshClientError(err);
  const status = payload.code === 'SSH_TIMEOUT' ? 504 : payload.code === 'SSH_CONNECTION_FAILED' ? 500 : 502;
  log('error', 'ssh_operation_failed', { requestId: req.requestId, code: payload.code, errorName: err?.name || 'Error' });
  return res.status(status).json({ ...payload, requestId: req.requestId });
}

// SSH session store (token → { host, port, username, privateKey, expires })
export const sshSessions = new Map();

function getGlobalSshConfig(node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  for (const candidate of nodeLookupCandidates(node)) {
    const row = db.prepare(
      'SELECT host, port, host_fingerprint FROM vm_ssh_configs WHERE node = ? AND vmid = ?'
    ).get(candidate, parsedVmid);
    if (row) return row;
  }
  return null;
}

function getUserSshConfig(userId, node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  for (const candidate of nodeLookupCandidates(node)) {
    const row = db.prepare(
      'SELECT username FROM vm_ssh_user_configs WHERE user_id = ? AND node = ? AND vmid = ?'
    ).get(userId, candidate, parsedVmid);
    if (row) return row;
  }
  return null;
}

// ─── SSH Keys ────────────────────────────────────────────────────────────────

router.get('/keys', (req, res) => {
  const keys = db.prepare(
    'SELECT id, name, private_key, public_key, created_at FROM ssh_keys WHERE user_id = ? ORDER BY name'
  ).all(req.session.userId);
  // Don't send private key to client — just add encrypted flag
  res.json(keys.map(k => {
    const privateKey = decryptSecret(k.private_key);
    const encrypted = privateKey.includes('ENCRYPTED')
      || privateKey.includes('aes256-cbc')
      || privateKey.includes('Encryption: aes');
    // Backfill: keys stored before public-key derivation (or added without one)
    // can be recovered here for any unencrypted key, so they become usable for
    // cloud-init provisioning without the user re-adding them.
    let publicKey = k.public_key;
    if (!publicKey && !encrypted) {
      const derived = derivePublicKey(privateKey);
      if (derived) {
        db.prepare('UPDATE ssh_keys SET public_key = ? WHERE id = ?').run(derived, k.id);
        publicKey = derived;
      }
    }
    return {
      id: k.id,
      name: k.name,
      public_key: publicKey,
      created_at: k.created_at,
      encrypted,
    };
  }));
});

router.post('/keys', async (req, res) => {
  const { name, privateKey, publicKey, passphrase = '' } = req.body;
  if (!name || !privateKey) {
    return res.status(400).json({ error: 'Name and private key required' });
  }
  if (!privateKey.includes('PRIVATE KEY') && !privateKey.includes('PuTTY-User-Key-File')) {
    return res.status(400).json({ error: 'Invalid key format (must be OpenSSH/PEM or PuTTY PPK)' });
  }

  let finalKey = privateKey;
  // Convert PPK to OpenSSH so ssh2 can always use it
  if (privateKey.includes('PuTTY-User-Key-File')) {
    try {
      finalKey = await ppkToOpenSSH(privateKey, passphrase);
    } catch (err) {
      console.error('PPK conversion failed:', err);
      return res.status(400).json({ error: 'PPK conversion failed. Verify the key format and passphrase.' });
    }
  }

  // The public key is what cloud-init injects into provisioned VMs. When the
  // user doesn't paste one, derive it from the private key so the key is usable
  // for provisioning; warn if it can't be derived (e.g. an encrypted key with
  // no passphrase) so the user knows this key won't work for cloud-init.
  let finalPublicKey = (publicKey || '').trim();
  const derived = !finalPublicKey && derivePublicKey(finalKey, passphrase);
  if (derived) finalPublicKey = derived;

  try {
    const r = db.prepare(
      'INSERT INTO ssh_keys (user_id, name, private_key, public_key) VALUES (?, ?, ?, ?)'
    ).run(req.session.userId, name, encryptSecret(finalKey), finalPublicKey);
    logAudit(req, 'ssh_key_added', String(r.lastInsertRowid), `name=${String(name).slice(0, 64)}`);
    res.json({
      id: r.lastInsertRowid,
      name,
      publicKeyDerived: !!derived,
      hasPublicKey: !!finalPublicKey,
      warning: finalPublicKey ? null
        : 'This key has no public key, so it can’t be used to set up key-based login when deploying VMs. Add the matching public key (.pub), or if the private key is encrypted, re-add it with its passphrase.',
    });
  } catch (err) {
    sendSshError(req, res, err);
  }
});

router.delete('/keys/:id', (req, res) => {
  const key = db.prepare('SELECT id FROM ssh_keys WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(req.params.id);
  logAudit(req, 'ssh_key_deleted', String(req.params.id), '');
  res.json({ ok: true });
});

// ─── VM SSH Config ───────────────────────────────────────────────────────────

router.get('/config/:node/:vmid', (req, res) => {
  const { node, vmid } = req.params;
  if (!userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.read')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const global = getGlobalSshConfig(node, vmid);
  const userRow = getUserSshConfig(req.session.userId, node, vmid);
  if (!global && !userRow) return res.json(null);
  res.json({
    host: global?.host || null,
    port: global?.port || 22,
    hostFingerprint: global?.host_fingerprint || '',
    username: userRow?.username || 'root',
  });
});

router.put('/config/:node/:vmid', async (req, res) => {
  const { node, vmid } = req.params;
  const { host, port = 22, username = 'root', hostFingerprint = '' } = req.body;
  if (!userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.write')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!host) return res.status(400).json({ error: 'Host/IP required' });
  const normalizedFingerprint = normalizeSshHostFingerprint(hostFingerprint);
  if (!normalizedFingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is required' });
  }

  let target;
  try {
    target = await authorizeSshTarget({
      userId: req.session.userId, isAdmin: req.session.isAdmin, node, vmid, host, port,
    });
  } catch (err) { return sendError(res, err); }

  // Save host/port globally (shared across users). Non-admin DNS names are
  // pinned to the authorized address to prevent DNS rebinding at connect time.
  db.prepare(`
    INSERT INTO vm_ssh_configs (node, vmid, host, port, host_fingerprint, username)
    VALUES (?, ?, ?, ?, ?, '')
    ON CONFLICT(node, vmid) DO UPDATE SET host = ?, port = ?, host_fingerprint = ?
  `).run(node, parseInt(vmid), target.host, target.port, normalizedFingerprint, target.host, target.port, normalizedFingerprint);

  // Save username per-user
  db.prepare(`
    INSERT INTO vm_ssh_user_configs (user_id, node, vmid, username)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, node, vmid) DO UPDATE SET username = ?
  `).run(req.session.userId, node, parseInt(vmid), username, username);

  logAudit(req, 'ssh_config_updated', `${node}/${vmid}`, `targetType=${target.resolvedAddresses.length ? 'resolved' : 'configured'}; port=${target.port}${target.adminOverride ? '; admin override' : ''}`);
  res.json({ ok: true });
});

// The scan opens a TCP/SSH handshake to a user-supplied host/port, which could
// be abused as an internal port probe. Legit use is a handful of scans while
// configuring a VM — rate-limit per user and leave an audit trail.
const SCAN_MAX_PER_WINDOW = 10;

router.post('/config/:node/:vmid/scan-fingerprint', async (req, res) => {
  const { node, vmid } = req.params;
  const { host, port = 22 } = req.body;
  if (!userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.scan')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!host) return res.status(400).json({ error: 'Host/IP required' });
  if (sshConnectionRateLimited(req.session.userId, 'fingerprint', SCAN_MAX_PER_WINDOW)) {
    return res.status(429).json({ error: 'Too many fingerprint scans — try again in a minute' });
  }

  try {
    const target = await authorizeSshTarget({
      userId: req.session.userId, isAdmin: req.session.isAdmin, node, vmid, host, port,
    });
    logAudit(req, 'ssh_fingerprint_scan', `${node}/${vmid}`, `port=${target.port}${target.adminOverride ? '; admin override' : ''}`);
    const hostFingerprint = await scanSshHostFingerprint(target.host, target.port);
    res.json({ hostFingerprint });
  } catch (err) {
    sendSshError(req, res, err);
  }
});

// ─── SSH Connect (create token) ──────────────────────────────────────────────

router.post('/connect', async (req, res) => {
  const { node, vmid, keyId, passphrase = '' } = req.body;
  if (!node || !vmid || !keyId) {
    return res.status(400).json({ error: 'node, vmid, and keyId are required' });
  }
  if (!userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.ssh.connect')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const key = db.prepare('SELECT private_key FROM ssh_keys WHERE id = ? AND user_id = ?')
    .get(keyId, req.session.userId);
  if (!key) return res.status(404).json({ error: 'SSH key not found' });

  const global = getGlobalSshConfig(node, vmid);
  const userRow = getUserSshConfig(req.session.userId, node, vmid);

  if (!global?.host) {
    return res.status(400).json({ error: 'SSH host is not configured for this VM' });
  }
  if (!global.host_fingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is not configured for this VM' });
  }

  if (sshConnectionRateLimited(req.session.userId, 'connect', 30)) {
    return res.status(429).json({ error: 'Too many SSH connection attempts — try again in a minute' });
  }

  let target;
  try {
    target = await authorizeSshTarget({
      userId: req.session.userId, isAdmin: req.session.isAdmin, node, vmid,
      host: global.host, port: global.port || 22,
    });
  } catch (err) { return sendError(res, err); }
  const host = target.host;
  const port = target.port;
  const username = userRow?.username || 'root';
  const hostFingerprint = normalizeSshHostFingerprint(global.host_fingerprint);

  // Purge expired
  for (const [k, v] of sshSessions) {
    if (v.expires < Date.now()) sshSessions.delete(k);
  }

  const token = uuidv4();
  sshSessions.set(token, {
    userId: req.session.userId,
    sessionId: req.sessionID,
    requestId: req.requestId || '',
    node, vmid,
    host, port, username, hostFingerprint,
    privateKey: decryptSecret(key.private_key),
    passphrase,
    expires: Date.now() + 120_000,
  });

  logAudit(req, 'ssh_session_created', `${node}/${vmid}`, `port=${port}${target.adminOverride ? '; admin override' : ''}`);
  res.json({ token });
});

export default router;
