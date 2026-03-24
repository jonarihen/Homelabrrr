import express from 'express';
import session from 'express-session';
import SqliteStore from 'better-sqlite3-session-store';
import db from './db.js';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import https from 'https';
import { Client as SSHClient } from 'ssh2';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import vmRoutes, { vncSessions } from './routes/vms.js';
import sshRoutes, { sshSessions } from './routes/ssh.js';
import provisionRoutes from './routes/provision.js';
import { normalizeSshHostFingerprint, sshHostFingerprint } from './utils/sshHostKey.js';
import { decryptSecret, encryptSecret } from './utils/secrets.js';

const app = express();
const server = createServer(app);

function parseTrustProxy(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

app.use(express.json());
if (ALLOWED_ORIGIN) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return origin === ALLOWED_ORIGIN ? cb(null, true) : cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
}
const SqliteSessionStore = SqliteStore(session);
const sessionMiddleware = session({
  store: new SqliteSessionStore({
    client: db,
    expired: { clear: true, intervalMs: 900000 },
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

app.use((req, res, next) => {
  if (!req.session?.userId) return next();

  const user = db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return req.session.destroy(() => next());
  }

  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;
  next();
});

app.use((req, res, next) => {
  if (!req.session?.twoFactorEnrollmentOnly) return next();

  const allowedPaths = new Set([
    '/api/auth/me',
    '/api/auth/logout',
    '/api/auth/2fa/setup',
    '/api/auth/2fa/enable',
    '/api/health',
  ]);

  if (allowedPaths.has(req.path)) return next();

  return res.status(403).json({ error: 'Two-factor setup is required before accessing the portal' });
});

import { sanitizeError } from './utils/sanitize.js';

app.use('/api/auth',  authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/vms',   vmRoutes);
app.use('/api/ssh',   sshRoutes);
app.use('/api/provision', provisionRoutes);
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Global error handler — sanitize leaked details
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: sanitizeError(err.message) });
});

// ─── VNC WebSocket Proxy ──────────────────────────────────────────────────────

const vncWss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols.has('binary')) return 'binary';
    return false;
  },
});

// ─── SSH WebSocket Proxy ──────────────────────────────────────────────────────

const sshWss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols.has('vmmgr-shell')) return 'vmmgr-shell';
    return false;
  },
});

function rejectUpgrade(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function isAllowedUpgradeOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN;

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function requestedWebSocketProtocols(request) {
  const raw = request.headers['sec-websocket-protocol'];
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function extractUpgradeToken(request, url) {
  const protocolToken = requestedWebSocketProtocols(request)
    .find(protocol => protocol.startsWith('vmmgr-token-'));
  if (protocolToken) {
    return protocolToken.slice('vmmgr-token-'.length);
  }
  return url.searchParams.get('token');
}

function loadUpgradeSession(request) {
  return new Promise((resolve, reject) => {
    sessionMiddleware(request, {
      getHeader() { return undefined; },
      setHeader() {},
      end() {},
    }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== '/api/vnc' && url.pathname !== '/api/ssh') {
    socket.destroy();
    return;
  }

  if (!isAllowedUpgradeOrigin(request)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }

  try {
    await loadUpgradeSession(request);
  } catch (err) {
    console.error('Failed to load websocket session:', err.message);
    rejectUpgrade(socket, 500, 'Internal Server Error');
    return;
  }

  if (!request.session?.userId) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  if (url.pathname === '/api/vnc') {
    const token = extractUpgradeToken(request, url);
    const sess = vncSessions.get(token);
    if (!sess || sess.expires < Date.now() || sess._consumed) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (sess.userId !== request.session.userId || sess.sessionId !== request.sessionID) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    // Mark as consumed immediately to prevent parallel replays, but keep the
    // entry until the upgrade completes so a failed upgrade doesn't lose data.
    sess._consumed = true;
    vncWss.handleUpgrade(request, socket, head, (ws) => {
      vncSessions.delete(token);
      vncWss.emit('connection', ws, sess);
    });
  } else if (url.pathname === '/api/ssh') {
    const token = extractUpgradeToken(request, url);
    const sess = sshSessions.get(token);
    if (!sess || sess.expires < Date.now() || sess._consumed) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (sess.userId !== request.session.userId || sess.sessionId !== request.sessionID) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    sess._consumed = true;
    sshWss.handleUpgrade(request, socket, head, (ws) => {
      sshSessions.delete(token);
      sshWss.emit('connection', ws, sess);
    });
  } else {
    socket.destroy();
  }
});

// ─── VNC connection handler ──────────────────────────────────────────────────

import { getHostForNode } from './proxmox.js';

vncWss.on('connection', async (clientWs, vncSession) => {
  const { node, vmid, ticket, port, vmtype = 'qemu' } = vncSession;

  let pveHost;
  try {
    pveHost = await getHostForNode(node);
  } catch (err) {
    console.error(`VNC: could not resolve host for node ${node}:`, err.message);
    clientWs.close();
    return;
  }

  const TOKEN = `PVEAPIToken=${pveHost.tokenId}=${pveHost.tokenSecret}`;
  const vncUrl = `wss://${pveHost.host}:${pveHost.port}/api2/json/nodes/${node}/${vmtype}/${vmid}/vncwebsocket`
    + `?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

  const agent = new https.Agent({ rejectUnauthorized: pveHost.verifyTls });

  const proxmoxWs = new WebSocket(vncUrl, ['binary'], {
    headers: { Authorization: TOKEN },
    agent,
  });

  proxmoxWs.on('open', () => {
    console.log(`VNC proxy open: ${node}/${vmid}`);
  });

  proxmoxWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  proxmoxWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
  });

  proxmoxWs.on('error', (err) => {
    console.error(`Proxmox WS error (${node}/${vmid}):`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('message', (data, isBinary) => {
    if (proxmoxWs.readyState === WebSocket.OPEN) {
      proxmoxWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('close', () => {
    if (proxmoxWs.readyState === WebSocket.OPEN) proxmoxWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Client WS error:', err.message);
    if (proxmoxWs.readyState === WebSocket.OPEN) proxmoxWs.close();
  });
});

// ─── SSH connection handler ──────────────────────────────────────────────────

sshWss.on('connection', (clientWs, sshSession) => {
  const { host, port, username, privateKey, passphrase, hostFingerprint } = sshSession;
  const conn = new SSHClient();
  const expectedHostFingerprint = normalizeSshHostFingerprint(hostFingerprint);
  let hostVerificationError = '';

  conn.on('ready', () => {
    console.log(`SSH connected: ${username}@${host}:${port}`);
    clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) {
        clientWs.send(JSON.stringify({ type: 'error', error: err.message }));
        clientWs.close();
        return;
      }

      stream.on('data', (data) => {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
        }
      });

      stream.on('close', () => {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
          clientWs.close();
        }
      });

      stream.stderr.on('data', (data) => {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
        }
      });

      clientWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'data') {
            stream.write(Buffer.from(msg.data, 'base64'));
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            stream.setWindow(msg.rows, msg.cols, 0, 0);
          }
        } catch { /* ignore bad messages */ }
      });

      clientWs.on('close', () => {
        stream.close();
        conn.end();
      });
    });
  });

  conn.on('error', (err) => {
    const message = hostVerificationError || err.message;
    console.error(`SSH error (${host}):`, message);
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', error: message }));
      clientWs.close();
    }
  });

  conn.on('close', () => {
    if (clientWs.readyState === 1) clientWs.close();
  });

  try {
    conn.connect({
      host,
      port,
      username,
      privateKey,
      passphrase: passphrase || undefined,
      readyTimeout: 10000,
      hostVerifier: (key) => {
        const presentedFingerprint = sshHostFingerprint(key);
        if (presentedFingerprint !== expectedHostFingerprint) {
          hostVerificationError = `SSH host key mismatch. Expected ${expectedHostFingerprint}, got ${presentedFingerprint}`;
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    console.error(`SSH connect error (${host}):`, err.message);
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', error: err.message }));
      clientWs.close();
    }
  }
});

// ─── Migrate any stored PPK keys to OpenSSH at startup ───────────────────────

async function convertPpkKey(ppkContent) {
  const id = Math.random().toString(36).slice(2);
  const inPath      = join(tmpdir(), `${id}.ppk`);
  const outPath     = join(tmpdir(), `${id}.pem`);
  const newPassPath = join(tmpdir(), `${id}.newpass`);
  const oldPassPath = join(tmpdir(), `${id}.oldpass`);
  try {
    await writeFile(inPath, ppkContent, { mode: 0o600 });
    await writeFile(oldPassPath, '', { mode: 0o600 });
    await writeFile(newPassPath, '', { mode: 0o600 });
    await new Promise((resolve, reject) => {
      execFile('puttygen', [inPath, '-O', 'private-openssh', '-o', outPath,
        '--old-passphrase', oldPassPath, '--new-passphrase', newPassPath],
        (err, _stdout, stderr) => err ? reject(new Error(stderr?.trim() || err.message)) : resolve());
    });
    return await readFile(outPath, 'utf8');
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
    await unlink(oldPassPath).catch(() => {});
    await unlink(newPassPath).catch(() => {});
  }
}

const ppkKeys = db.prepare('SELECT id, private_key FROM ssh_keys').all();
for (const k of ppkKeys) {
  try {
    const privateKey = decryptSecret(k.private_key);
    if (!privateKey.startsWith('PuTTY-User-Key-File')) continue;
    const openssh = await convertPpkKey(privateKey);
    db.prepare('UPDATE ssh_keys SET private_key = ? WHERE id = ?').run(encryptSecret(openssh), k.id);
    console.log(`Migrated PPK key id=${k.id} to OpenSSH format`);
  } catch (err) {
    console.warn(`Could not auto-convert PPK key id=${k.id} (may be encrypted): ${err.message}`);
  }
}

const PORT_NUM = parseInt(process.env.PORT || '3000');
server.listen(PORT_NUM, () => {
  console.log(`Backend running on port ${PORT_NUM}`);
});
