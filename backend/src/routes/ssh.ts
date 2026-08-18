import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sshKeys, vmSshConfigs, vmSshUserConfigs } from '../db/schema/index.ts';
import { requireAuth } from '../middleware/auth.ts';
import { userCanPerformVmOp } from '../utils/vmAccess.ts';
import { nodeLookupCandidates } from '../utils/nodeRef.ts';
import { normalizeSshHostFingerprint, scanSshHostFingerprint } from '../utils/sshHostKey.ts';
import { decryptSecret, encryptSecret } from '../utils/secrets.ts';
import { derivePublicKey } from '../utils/sshPublicKey.ts';
import { logAudit } from '../utils/audit.ts';
import { sendError } from '../utils/httpError.ts';
import { authorizeSshTarget, sshConnectionRateLimited } from '../services/sshTargetPolicy.ts';
import { sshClientError } from '../utils/sshError.ts';
import { log } from '../utils/logger.ts';

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

async function getGlobalSshConfig(node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  // Legacy rows may store the bare node name — match any candidate in one query,
  // then honour the candidate order (full ref preferred over bare name).
  const rows = await db
    .select({
      node: vmSshConfigs.node,
      host: vmSshConfigs.host,
      port: vmSshConfigs.port,
      host_fingerprint: vmSshConfigs.host_fingerprint,
    })
    .from(vmSshConfigs)
    .where(and(inArray(vmSshConfigs.node, candidates), eq(vmSshConfigs.vmid, parsedVmid)));
  for (const candidate of candidates) {
    const row = rows.find((r) => r.node === candidate);
    if (row) return row;
  }
  return null;
}

async function getUserSshConfig(userId, node, vmid) {
  const parsedVmid = parseInt(vmid, 10);
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  const rows = await db
    .select({ node: vmSshUserConfigs.node, username: vmSshUserConfigs.username })
    .from(vmSshUserConfigs)
    .where(and(
      eq(vmSshUserConfigs.user_id, userId),
      inArray(vmSshUserConfigs.node, candidates),
      eq(vmSshUserConfigs.vmid, parsedVmid),
    ));
  for (const candidate of candidates) {
    const row = rows.find((r) => r.node === candidate);
    if (row) return row;
  }
  return null;
}

// ─── SSH Keys ────────────────────────────────────────────────────────────────

router.get('/keys', async (req, res) => {
  const keys = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      private_key: sshKeys.private_key,
      public_key: sshKeys.public_key,
      created_at: sshKeys.created_at,
    })
    .from(sshKeys)
    .where(eq(sshKeys.user_id, req.session.userId))
    .orderBy(sshKeys.name);
  // Don't send private key to client — just add encrypted flag
  const result = [];
  for (const k of keys) {
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
        await db.update(sshKeys).set({ public_key: derived }).where(eq(sshKeys.id, k.id));
        publicKey = derived;
      }
    }
    result.push({
      id: k.id,
      name: k.name,
      public_key: publicKey,
      created_at: k.created_at,
      encrypted,
    });
  }
  res.json(result);
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
    const [inserted] = await db
      .insert(sshKeys)
      .values({
        user_id: req.session.userId,
        name,
        private_key: encryptSecret(finalKey),
        public_key: finalPublicKey,
      })
      .returning({ id: sshKeys.id });
    await logAudit(req, 'ssh_key_added', String(inserted.id), `name=${String(name).slice(0, 64)}`);
    res.json({
      id: inserted.id,
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

router.delete('/keys/:id', async (req, res) => {
  const keyId = parseInt(req.params.id, 10);
  const [key] = await db
    .select({ id: sshKeys.id })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.user_id, req.session.userId)))
    .limit(1);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  await logAudit(req, 'ssh_key_deleted', String(req.params.id), '');
  res.json({ ok: true });
});

// ─── VM SSH Config ───────────────────────────────────────────────────────────

router.get('/config/:node/:vmid', async (req, res) => {
  const { node, vmid } = req.params;
  if (!await userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.read')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const global = await getGlobalSshConfig(node, vmid);
  const userRow = await getUserSshConfig(req.session.userId, node, vmid);
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
  if (!await userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.write')) {
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
  await db
    .insert(vmSshConfigs)
    .values({
      node,
      vmid: parseInt(vmid),
      host: target.host,
      port: target.port,
      host_fingerprint: normalizedFingerprint,
      username: '',
    })
    .onConflictDoUpdate({
      target: [vmSshConfigs.node, vmSshConfigs.vmid],
      set: { host: target.host, port: target.port, host_fingerprint: normalizedFingerprint },
    });

  // Save username per-user
  await db
    .insert(vmSshUserConfigs)
    .values({ user_id: req.session.userId, node, vmid: parseInt(vmid), username })
    .onConflictDoUpdate({
      target: [vmSshUserConfigs.user_id, vmSshUserConfigs.node, vmSshUserConfigs.vmid],
      set: { username },
    });

  await logAudit(req, 'ssh_config_updated', `${node}/${vmid}`, `targetType=${target.resolvedAddresses.length ? 'resolved' : 'configured'}; port=${target.port}${target.adminOverride ? '; admin override' : ''}`);
  res.json({ ok: true });
});

// The scan opens a TCP/SSH handshake to a user-supplied host/port, which could
// be abused as an internal port probe. Legit use is a handful of scans while
// configuring a VM — rate-limit per user and leave an audit trail.
const SCAN_MAX_PER_WINDOW = 10;

router.post('/config/:node/:vmid/scan-fingerprint', async (req, res) => {
  const { node, vmid } = req.params;
  const { host, port = 22 } = req.body;
  if (!await userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sshConfig.scan')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!host) return res.status(400).json({ error: 'Host/IP required' });
  if (await sshConnectionRateLimited(req.session.userId, 'fingerprint', SCAN_MAX_PER_WINDOW)) {
    return res.status(429).json({ error: 'Too many fingerprint scans — try again in a minute' });
  }

  try {
    const target = await authorizeSshTarget({
      userId: req.session.userId, isAdmin: req.session.isAdmin, node, vmid, host, port,
    });
    await logAudit(req, 'ssh_fingerprint_scan', `${node}/${vmid}`, `port=${target.port}${target.adminOverride ? '; admin override' : ''}`);
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
  if (!await userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.ssh.connect')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const [key] = await db
    .select({ private_key: sshKeys.private_key })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, parseInt(keyId, 10)), eq(sshKeys.user_id, req.session.userId)))
    .limit(1);
  if (!key) return res.status(404).json({ error: 'SSH key not found' });

  const global = await getGlobalSshConfig(node, vmid);
  const userRow = await getUserSshConfig(req.session.userId, node, vmid);

  if (!global?.host) {
    return res.status(400).json({ error: 'SSH host is not configured for this VM' });
  }
  if (!global.host_fingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is not configured for this VM' });
  }

  if (await sshConnectionRateLimited(req.session.userId, 'connect', 30)) {
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

  await logAudit(req, 'ssh_session_created', `${node}/${vmid}`, `port=${port}${target.adminOverride ? '; admin override' : ''}`);
  res.json({ token });
});

export default router;
