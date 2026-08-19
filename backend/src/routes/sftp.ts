import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';
import { basename, posix } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sshKeys, vmSshConfigs, vmSshUserConfigs } from '../db/schema/index.ts';
import { requireAuth } from '../middleware/auth.ts';
import { userCanPerformVmOp } from '../utils/vmAccess.ts';
import { nodeLookupCandidates } from '../utils/nodeRef.ts';
import { normalizeSshHostFingerprint } from '../utils/sshHostKey.ts';
import { decryptSecret } from '../utils/secrets.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { errorPayload } from '../utils/httpError.ts';
import { createSshConnection } from '../utils/sshConnect.ts';
import { authorizeSshTarget, sshConnectionRateLimited } from '../services/sshTargetPolicy.ts';
import { logAudit } from '../utils/audit.ts';
import { sftpClientError } from '../utils/sftpError.ts';
import { log } from '../utils/logger.ts';
import { boundedString } from '../utils/validation.ts';

const router = Router();
router.use(requireAuth);

/**
 * The upload path settles its response by hand — it has to hang up rather than
 * drain gigabytes of a rejected transfer — so it needs the body without the
 * send. Same contract as sendError() otherwise; the raw SSH string stays in the
 * log because a translated payload no longer carries it.
 */
function uploadFailure(req, err) {
  const { status: _status, ...payload } = sftpClientError(err);
  log('error', 'sftp_upload_failed', { requestId: req.requestId, code: payload.code, errorName: err?.name || 'Error' });
  return { ...payload, requestId: req.requestId };
}

function sendSftpError(req, res, err) {
  if (err?.status && err.status < 500) return res.status(err.status).json(errorPayload(err, err.status));
  const { status, ...payload } = sftpClientError(err);
  log('error', 'sftp_operation_failed', { requestId: req.requestId, code: payload.code, errorName: err?.name || 'Error' });
  return res.status(status).json({ ...payload, requestId: req.requestId });
}

// ─── SFTP session store ─────────────────────────────────────────────────────

export const sftpSessions = new Map();

const TOKEN_TTL = 30 * 60 * 1000; // 30 minutes

function pathAuditMetadata(value) {
  const depth = String(value || '').split('/').filter(Boolean).length;
  return `pathDepth=${Math.min(depth, 100)}`;
}

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of sftpSessions) {
    if (v.expires < now) sftpSessions.delete(k);
  }
}

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
router.post('/connect', async (req, res) => {
  const { node, vmid, keyId, passphrase = '' } = req.body;
  if (!node || !vmid || !keyId) {
    return res.status(400).json({ error: 'node, vmid, and keyId are required' });
  }
  if (!await userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, 'vm.sftp.connect')) {
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

  if (await sshConnectionRateLimited(req.session.userId, 'sftp-connect', 30)) {
    return res.status(429).json({ error: 'Too many SFTP connection attempts — try again in a minute' });
  }

  let target;
  try {
    target = await authorizeSshTarget({
      userId: req.session.userId, isAdmin: req.session.isAdmin, node, vmid,
      host: global.host, port: global.port || 22,
    });
  } catch (err) { return sendSftpError(req, res, err); }

  purgeExpired();

  const token = uuidv4();
  sftpSessions.set(token, {
    userId: req.session.userId,
    sessionId: req.sessionID,
    node,
    vmid,
    host: target.host,
    port: target.port,
    username: userRow?.username || 'root',
    hostFingerprint: normalizeSshHostFingerprint(global.host_fingerprint),
    privateKey: decryptSecret(key.private_key),
    passphrase,
    expires: Date.now() + TOKEN_TTL,
  });

  await logAudit(req, 'sftp_session_created', `${node}/${vmid}`, `port=${target.port}${target.adminOverride ? '; admin override' : ''}`);
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

    // Resolve '.' or '~' to the actual absolute path
    const resolvedPath = await new Promise((resolve) => {
      sftp.realpath(dirPath, (err, absPath) => (err ? resolve(dirPath) : resolve(absPath)));
    });

    const list = await new Promise((resolve) => {
      sftp.readdir(resolvedPath, (err, entries) => (err ? reject(err) : resolve(entries)));
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

    res.json({ path: resolvedPath, entries });
  } catch (err) {
    sendSftpError(req, res, err);
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

    const stat = await new Promise((resolve) => {
      sftp.stat(filePath, (err, s) => (err ? reject(err) : resolve(s)));
    });

    // Remote filename is untrusted — strip quotes/control chars from the ASCII
    // fallback and carry the real name RFC5987-encoded in filename*.
    const rawName = basename(filePath);
    const asciiName = rawName.replace(/["\\\x00-\x1f\x7f]/g, '_');
    const encodedName = encodeURIComponent(rawName)
      .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (stat.size != null) res.setHeader('Content-Length', stat.size);

    const stream = sftp.createReadStream(filePath);
    stream.pipe(res);

    stream.on('error', (err) => {
      if (!res.headersSent) {
        sendSftpError(req, res, err);
      } else {
        console.error('SFTP download failed mid-stream:', err?.message || err);
      }
      conn.end();
    });

    stream.on('end', () => conn.end());
  } catch (err) {
    if (!res.headersSent) {
      sendSftpError(req, res, err);
    } else {
      console.error('SFTP download failed:', err?.message || err);
    }
    conn?.end();
  }
});

/**
 * Upload a file to a remote directory.
 *
 * The multipart body is piped straight into the SFTP write stream, so an upload
 * never lands in this process's memory and the only ceiling on its size is free
 * space on the remote host. `token` and `path` are sent ahead of the file part,
 * which lets the session be checked before any bytes reach the guest.
 */
router.post('/upload', (req, res) => {
  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { files: 1 } });
  } catch {
    return res.status(400).json({ error: 'Expected a multipart/form-data upload' });
  }

  const fields = Object.create(null);
  let conn = null;
  let sawFile = false;
  let settled = false;
  /** Replaced once a partially written file can exist on the remote host. */
  let discardPartial = (done) => done();

  /** Stop parsing and answer at most once. */
  const settle = (respond) => {
    if (settled) return;
    settled = true;
    req.unpipe(bb);
    bb.removeAllListeners();
    respond();
  };

  const succeed = (body) => settle(() => {
    conn?.end();
    conn = null;
    const sess = resolveSession(fields.token);
    // Fire-and-forget: the upload has already completed and the response is
    // being sent from a non-async stream callback, so the audit write cannot be
    // awaited — never let an audit failure disrupt the reply (M13).
    if (sess) logAudit(req, 'sftp_upload', `${sess.node}/${sess.vmid}`, `${pathAuditMetadata(body.path)}; bytes=${body.size}`)
      .catch((err) => log('warn', 'sftp_upload_audit_failed', { requestId: req.requestId, error: err?.message }));
    if (!res.headersSent && res.writable) res.json(body);
  });

  // `body` is either a plain message or an already-built error payload.
  const fail = (status, body) => settle(() => {
    if (!res.headersSent && res.writable) {
      // Hang up rather than draining the rest of an upload we have already
      // rejected — what is still on the wire may be gigabytes.
      res.set('Connection', 'close');
      res.status(status).json(typeof body === 'string' ? { error: body } : body);
    }
    // Never leave a truncated file behind under the name the user expects.
    // Answering first keeps a stalled cleanup from hanging the request.
    discardPartial(() => { conn?.end(); conn = null; });
  });

  bb.on('field', (name, value) => { fields[name] = value; });

  bb.on('file', (name, fileStream, info) => {
    if (settled || sawFile || name !== 'file') return fileStream.resume();
    sawFile = true;

    if (!fields.token) return fail(400, 'token and path must be sent before the file part');
    const sess = resolveSession(fields.token);
    if (!sess) return fail(401, 'SFTP session expired or invalid');
    if (sess.userId !== req.session.userId) return fail(403, 'Access denied');

    const filename = basename(info.filename || '');
    if (!filename) return fail(400, 'No file uploaded');
    const remotePath = posix.join(fields.path || '/', filename);

    // Hold the part until the SSH channel is up; backpressure keeps the client
    // from running ahead of us.
    fileStream.pause();

    openSftp(sess).then(({ conn: sshConn, sftp }) => {
      if (settled) return sshConn.end();
      conn = sshConn;

      const writeStream = sftp.createWriteStream(remotePath);
      let bytes = 0;
      let touched = Date.now();

      discardPartial = (done) => sftp.unlink(remotePath, () => done());

      fileStream.on('data', (chunk) => {
        bytes += chunk.length;
        // A transfer measured in gigabytes can outlive TOKEN_TTL, which would
        // then reject every remaining file in the batch. Keep it warm.
        const now = Date.now();
        if (now - touched > 60_000) {
          touched = now;
          sess.expires = now + TOKEN_TTL;
        }
      });

      // `fail` settles synchronously, so the 'close' that destroy() triggers
      // can no longer be mistaken for a completed upload.
      fileStream.on('error', (err) => {
        fail(500, uploadFailure(req, err));
        writeStream.destroy();
      });
      writeStream.on('error', (err) => fail(500, uploadFailure(req, err)));
      writeStream.on('close', () => succeed({ ok: true, path: remotePath, size: bytes }));

      fileStream.pipe(writeStream);
    }).catch((err) => fail(500, uploadFailure(req, err)));
  });

  // A malformed multipart body — busboy's own text, not upstream, but there is
  // no reason for it to reach the browser unfiltered either.
  bb.on('error', (err) => fail(400, sanitizeError(err?.message)));
  bb.on('close', () => { if (!sawFile) fail(400, 'No file uploaded'); });

  // Tab closed or network dropped mid-transfer. The response is already gone,
  // so this just discards the partial file and releases the SSH connection.
  res.on('close', () => fail(499, 'Upload aborted'));

  req.pipe(bb);
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

    await new Promise((resolve) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });

    await logAudit(req, 'sftp_mkdir', `${sess.node}/${sess.vmid}`, pathAuditMetadata(dirPath));
    res.json({ ok: true });
  } catch (err) {
    sendSftpError(req, res, err);
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

    await new Promise((resolve) => {
      const op = isDirectory ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
      op(targetPath, (err) => (err ? reject(err) : resolve()));
    });

    await logAudit(req, isDirectory ? 'sftp_rmdir' : 'sftp_delete', `${sess.node}/${sess.vmid}`, pathAuditMetadata(targetPath));
    res.json({ ok: true });
  } catch (err) {
    sendSftpError(req, res, err);
  } finally {
    conn?.end();
  }
});

/** Rename a remote file or directory within its current directory. */
router.post('/rename', async (req, res) => {
  const { token, path: sourcePath } = req.body || {};
  const sess = resolveSession(token);
  if (!sess) return res.status(401).json({ error: 'SFTP session expired or invalid' });
  if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  let name;
  try {
    name = boundedString(req.body?.name, { field: 'name', min: 1, max: 255 });
    if (name !== basename(name) || ['.', '..'].includes(name)) throw new Error('name must not contain a path');
  } catch (err) { return res.status(400).json({ error: err.message }); }
  if (!sourcePath) return res.status(400).json({ error: 'path is required' });
  const targetPath = posix.join(posix.dirname(sourcePath), name);

  let conn, sftp;
  try {
    ({ conn, sftp } = await openSftp(sess));
    await new Promise((resolve, reject) => sftp.rename(sourcePath, targetPath, (err) => (err ? reject(err) : resolve())));
    await logAudit(req, 'sftp_rename', `${sess.node}/${sess.vmid}`, `${pathAuditMetadata(sourcePath)}; sameDirectory=true`);
    res.json({ ok: true });
  } catch (err) {
    sendSftpError(req, res, err);
  } finally {
    conn?.end();
  }
});

export default router;
