import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { basename, posix } from 'path';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { userCanAccessVm } from '../utils/vmAccess.js';
import { nodeLookupCandidates } from '../utils/nodeRef.js';
import { normalizeSshHostFingerprint } from '../utils/sshHostKey.js';
import { decryptSecret } from '../utils/secrets.js';
import { createSshConnection } from '../utils/sshConnect.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 100 MB

// ─── SFTP session store ─────────────────────────────────────────────────────

export const sftpSessions = new Map();

const TOKEN_TTL = 30 * 60 * 1000; // 30 minutes

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of sftpSessions) {
    if (v.expires < now) sftpSessions.delete(k);
  }
}

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

function resolveSession(token) {
  if (!token) return null;
  const sess = sftpSessions.get(token);
  if (!sess || sess.expires < Date.now()) {
    if (sess) sftpSessions.delete(token);
    return null;
  }
  // Extend expiry on activity
  sess.expires = Date.now() + TOKEN_TTL;
  return sess;
}

/** Open an SSH connection and start the SFTP subsystem, returning both. */
async function openSftp(sess) {
  const conn = await createSshConnection({
    host: sess.host,
    port: sess.port,
    username: sess.username,
    privateKey: sess.privateKey,
    passphrase: sess.passphrase,
    hostFingerprint: sess.hostFingerprint,
  });

  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        conn.end();
        return reject(err);
      }
      resolve({ conn, sftp });
    });
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Create an SFTP session token. */
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

  const global = getGlobalSshConfig(node, vmid);
  const userRow = getUserSshConfig(req.session.userId, node, vmid);

  if (!global?.host) {
    return res.status(400).json({ error: 'SSH host is not configured for this VM' });
  }
  if (!global.host_fingerprint) {
    return res.status(400).json({ error: 'SSH host fingerprint is not configured for this VM' });
  }

  purgeExpired();

  const token = uuidv4();
  sftpSessions.set(token, {
    userId: req.session.userId,
    sessionId: req.sessionID,
    host: global.host,
    port: global.port || 22,
    username: userRow?.username || 'root',
    hostFingerprint: normalizeSshHostFingerprint(global.host_fingerprint),
    privateKey: decryptSecret(key.private_key),
    passphrase,
    expires: Date.now() + TOKEN_TTL,
  });

  res.json({ token });
});

/** List a remote directory. */
router.post('/ls', async (req, res) => {
  const { token, path: dirPath = '/' } = req.body;
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));

    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, entries) => (err ? reject(err) : resolve(entries)));
    });

    const entries = list.map((e) => ({
      name: e.filename,
      type: e.attrs.isDirectory() ? 'directory' : e.attrs.isSymbolicLink() ? 'symlink' : 'file',
      size: e.attrs.size,
      modifyTime: e.attrs.mtime * 1000,
    }));

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    conn?.end();
  }
});

/** Download a remote file. */
router.get('/download', async (req, res) => {
  const { token, path: filePath } = req.query;
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));

    const stat = await new Promise((resolve, reject) => {
      sftp.stat(filePath, (err, s) => (err ? reject(err) : resolve(s)));
    });

    res.setHeader('Content-Disposition', `attachment; filename="${basename(filePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (stat.size != null) res.setHeader('Content-Length', stat.size);

    const stream = sftp.createReadStream(filePath);
    stream.pipe(res);

    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
      conn.end();
    });

    stream.on('end', () => conn.end());
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
    conn?.end();
  }
});

/** Upload a file to a remote directory. */
router.post('/upload', upload.single('file'), async (req, res) => {
  const { token, path: destDir = '/' } = req.body;
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const remotePath = posix.join(destDir, req.file.originalname);

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));

    await new Promise((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on('error', reject);
      writeStream.on('close', resolve);
      writeStream.end(req.file.buffer);
    });

    res.json({ ok: true, path: remotePath, size: req.file.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    conn?.end();
  }
});

/** Create a remote directory. */
router.post('/mkdir', async (req, res) => {
  const { token, path: dirPath } = req.body;
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  if (!dirPath) return res.status(400).json({ error: 'path is required' });

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));

    await new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    conn?.end();
  }
});

/** Delete a remote file or directory. */
router.post('/delete', async (req, res) => {
  const { token, path: targetPath, isDirectory = false } = req.body;
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  if (!targetPath) return res.status(400).json({ error: 'path is required' });

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));

    await new Promise((resolve, reject) => {
      const op = isDirectory ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
      op(targetPath, (err) => (err ? reject(err) : resolve()));
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    conn?.end();
  }
});

export default router;
