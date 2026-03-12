import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { userCanAccessVm } from '../utils/vmAccess.js';
import { normalizeSshHostFingerprint, scanSshHostFingerprint } from '../utils/sshHostKey.js';

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

// SSH session store (token → { host, port, username, privateKey, expires })
export const sshSessions = new Map();

// ─── SSH Keys ────────────────────────────────────────────────────────────────

router.get('/keys', (req, res) => {
  const keys = db.prepare(
    'SELECT id, name, private_key, public_key, created_at FROM ssh_keys WHERE user_id = ? ORDER BY name'
  ).all(req.session.userId);
  // Don't send private key to client — just add encrypted flag
  res.json(keys.map(k => ({
    id: k.id,
    name: k.name,
    public_key: k.public_key,
    created_at: k.created_at,
    encrypted: k.private_key.includes('ENCRYPTED') || k.private_key.includes('aes256-cbc') || k.private_key.includes('Encryption: aes'),
  })));
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
      return res.status(400).json({ error: `PPK conversion failed: ${err.message}` });
    }
  }

  try {
    const r = db.prepare(
      'INSERT INTO ssh_keys (user_id, name, private_key, public_key) VALUES (?, ?, ?, ?)'
    ).run(req.session.userId, name, finalKey, publicKey || '');
    res.json({ id: r.lastInsertRowid, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/keys/:id', (req, res) => {
  const key = db.prepare('SELECT id FROM ssh_keys WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── VM SSH Config ───────────────────────────────────────────────────────────

router.get('/config/:node/:vmid', (req, res) => {
  const { node, vmid } = req.params;
  if (!userCanAccessVm(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const global = db.prepare('SELECT host, port, host_fingerprint FROM vm_ssh_configs WHERE node = ? AND vmid = ?')
    .get(node, parseInt(vmid));
  const userRow = db.prepare('SELECT username FROM vm_ssh_user_configs WHERE user_id = ? AND node = ? AND vmid = ?')
    .get(req.session.userId, node, parseInt(vmid));
  if (!global && !userRow) return res.json(null);
  res.json({
    host: global?.host || null,
    port: global?.port || 22,
    hostFingerprint: global?.host_fingerprint || '',
    username: userRow?.username || 'root',
  });
});

router.put('/config/:node/:vmid', (req, res) => {
  const { node, vmid } = req.params;
  const { host, port = 22, username = 'root', hostFingerprint = '' } = req.body;
  if (!userCanAccessVm(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!host) return res.status(400).json({ error: 'Host/IP required' });
  const normalizedFingerprint = normalizeSshHostFingerprint(hostFingerprint);
  if (!normalizedFingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is required' });
  }

  // Save host/port globally (shared across users)
  db.prepare(`
    INSERT INTO vm_ssh_configs (node, vmid, host, port, host_fingerprint, username)
    VALUES (?, ?, ?, ?, ?, '')
    ON CONFLICT(node, vmid) DO UPDATE SET host = ?, port = ?, host_fingerprint = ?
  `).run(node, parseInt(vmid), host, port, normalizedFingerprint, host, port, normalizedFingerprint);

  // Save username per-user
  db.prepare(`
    INSERT INTO vm_ssh_user_configs (user_id, node, vmid, username)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, node, vmid) DO UPDATE SET username = ?
  `).run(req.session.userId, node, parseInt(vmid), username, username);

  res.json({ ok: true });
});

router.post('/config/:node/:vmid/scan-fingerprint', async (req, res) => {
  const { node, vmid } = req.params;
  const { host, port = 22 } = req.body;
  if (!userCanAccessVm(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!host) return res.status(400).json({ error: 'Host/IP required' });

  try {
    const hostFingerprint = await scanSshHostFingerprint(host, parseInt(port, 10) || 22);
    res.json({ hostFingerprint });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSH Connect (create token) ──────────────────────────────────────────────

router.post('/connect', (req, res) => {
  const { node, vmid, keyId, passphrase = '' } = req.body;
  if (!node || !vmid || !keyId) {
    return res.status(400).json({ error: 'node, vmid, and keyId are required' });
  }
  if (!userCanAccessVm(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const key = db.prepare('SELECT private_key FROM ssh_keys WHERE id = ? AND user_id = ?')
    .get(keyId, req.session.userId);
  if (!key) return res.status(404).json({ error: 'SSH key not found' });

  const global = db.prepare('SELECT host, port, host_fingerprint FROM vm_ssh_configs WHERE node = ? AND vmid = ?')
    .get(node, parseInt(vmid));
  const userRow = db.prepare('SELECT username FROM vm_ssh_user_configs WHERE user_id = ? AND node = ? AND vmid = ?')
    .get(req.session.userId, node, parseInt(vmid));

  if (!global?.host) {
    return res.status(400).json({ error: 'SSH host is not configured for this VM' });
  }
  if (!global.host_fingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is not configured for this VM' });
  }

  const host = global.host;
  const port = global.port || 22;
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
    host, port, username, hostFingerprint,
    privateKey: key.private_key,
    passphrase,
    expires: Date.now() + 120_000,
  });

  res.json({ token });
});

export default router;
