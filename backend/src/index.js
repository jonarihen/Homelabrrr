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
import { v4 as uuidv4 } from 'uuid';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import vmRoutes, { vncSessions } from './routes/vms.js';
import sshRoutes, { sshSessions } from './routes/ssh.js';
import sftpRoutes from './routes/sftp.js';
import provisionRoutes from './routes/provision.js';
import migrateRoutes from './routes/migrate.js';
import cloudImageRoutes from './routes/cloudimages.js';
import isoRoutes from './routes/isos.js';
import portalRoutes from './routes/portal.js';
import notificationRoutes from './routes/notifications.js';
import { pollNodeHealth } from './utils/notify.js';
import websiteRoutes, { stopWebsiteMaintenance } from './routes/websites.js';
import workflowRoutes from './routes/workflows.js';
import publicIpRoutes from './routes/publicIps.js';
import operationsRoutes from './routes/operations.js';
import { seedAllFirewalls } from './workflows/store.js';
import { normalizeSshHostFingerprint, sshHostFingerprint } from './utils/sshHostKey.js';
import { decryptSecret, encryptSecret } from './utils/secrets.js';
import { sendableCloseCode } from './utils/wsClose.js';
import { decodeNodeRef } from './utils/nodeRef.js';
import { sweepExpiredMaintenance } from './utils/nodeMaintenance.js';
import { runFullTagSync, isTagSyncRunning, getTagSyncSettings } from './utils/vmTags.js';
import { logAuditEntry } from './utils/audit.js';
import { authenticateApiToken, enforceApiTokenScope } from './middleware/apiToken.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { parseTrustProxy } from './utils/proxyChain.js';
import { trustProxyCheck, inspectProxyChain } from './middleware/trustProxyCheck.js';
import { buildConfigReport, formatConfigReport } from './utils/configReport.js';
import { startScheduler, stopScheduler, waitForSchedulerIdle } from './scheduler.js';
import { sshClientError } from './utils/sshError.js';
import { collectBoundedBody } from './utils/boundedBody.js';
import { installConsoleRedaction, log, redactText, requestContext } from './utils/logger.js';
import { csrfProtection } from './middleware/requestSecurity.js';
import { liveness, metricsText, observeRequests, readiness } from './utils/observability.js';
import { auditMutations } from './middleware/mutationAudit.js';
import { runDatabaseMaintenance } from './services/databaseMaintenance.js';
import { startBackupScheduler, waitForBackupIdle } from './services/backupService.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { boundedDrain } from './utils/shutdown.js';
import { stopAcceptingBackgroundWork, waitForBackgroundWork } from './services/backgroundWork.js';
import { enforceTwoFactorEnrollmentOnly } from './middleware/twoFactorEnrollment.js';

const app = express();
const server = createServer(app);
let shuttingDown = false;
installConsoleRedaction();

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

app.use(requestContext);
app.use(observeRequests);
app.use((req, res, next) => {
  if (!shuttingDown) return next();
  res.set('Connection', 'close');
  return res.status(503).json({ error: 'Server is shutting down', requestId: req.requestId });
});
// Probes deliberately bypass cookie/session loading. Liveness answers only
// whether this process can serve HTTP; readiness performs the database/schema
// checks that decide whether the instance should receive application traffic.
app.get('/api/health', (_req, res) => res.json(liveness()));
app.get('/api/health/live', (_req, res) => res.json(liveness()));
app.get('/api/health/ready', (_req, res) => {
  const status = readiness();
  res.status(status.ok ? 200 : 503).json(status);
});
app.use(express.json({ limit: '1mb' }));
if (ALLOWED_ORIGIN) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return origin === ALLOWED_ORIGIN ? cb(null, true) : cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
}
// An empty/weak secret boots fine but yields trivially forgeable session
// signatures — fail fast instead (SECRET_ENCRYPTION_KEY is already asserted
// the same way in utils/secrets.js).
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  throw new Error('SESSION_SECRET must be set to a random string of at least 16 characters');
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
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: 24 * 60 * 60 * 1000,
  },
});
// A request carrying `Authorization: Bearer <token>` is authenticated by the
// API-token middleware, which sets a plain req.session-shaped context and skips
// the cookie session entirely (no session row/cookie is created for scripts).
// Everything else falls through to the normal cookie session middleware.
app.use((req, res, next) => {
  const authz = req.headers.authorization;
  if (authz && /^Bearer\s+/i.test(authz)) {
    return authenticateApiToken(req, res, next);
  }
  return sessionMiddleware(req, res, next);
});
app.use(enforceApiTokenScope);
app.use(csrfProtection({ allowedOrigin: ALLOWED_ORIGIN || '' }));

app.use((req, res, next) => {
  if (!req.session?.userId) return next();
  // Token auth already resolved the live user; don't re-hydrate (and never try
  // to destroy) the plain token session object.
  if (req.apiToken) return next();

  const user = db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return req.session.destroy(() => next());
  }

  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;
  if (!req.session.lastSeenAt || Date.now() - Number(req.session.lastSeenAt) > 5 * 60 * 1000) {
    req.session.lastSeenAt = Date.now();
    req.session.clientIp = String(req.ip || '').slice(0, 128);
    req.session.userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
  }
  next();
});

// Compare the observed X-Forwarded-For hop count against TRUST_PROXY on the
// first few authenticated requests and warn once if they disagree — a wrong
// value silently breaks per-IP login lockout and audit attribution.
app.use(trustProxyCheck);
app.use(auditMutations);

app.use(enforceTwoFactorEnrollmentOnly);

app.use('/api/auth',  authRoutes);
app.use('/api/admin/operations', operationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/vms',   vmRoutes);
app.use('/api/ssh',   sshRoutes);
app.use('/api/sftp',  sftpRoutes);
app.use('/api/provision', provisionRoutes);
app.use('/api/migrate', migrateRoutes);
app.use('/api/cloud-images', cloudImageRoutes);
app.use('/api/isos', isoRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/websites', websiteRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/public-ips', publicIpRoutes);
app.get('/api/metrics', requireAdmin, (_req, res) => {
  res.type('text/plain; version=0.0.4').send(metricsText({
    vncWebSockets: vncWss.clients.size,
    sshWebSockets: sshWss.clients.size,
  }));
});

// Self-diagnosis for the reverse-proxy chain: what address does the portal
// actually see for *this* caller, how many X-Forwarded-For hops arrived, and
// does that match TRUST_PROXY? Auth-gated — it reflects request headers back,
// so it must only ever describe the caller's own request. Nothing beyond the
// caller's request metadata and the configured hop count is returned.
app.get('/api/health/client-ip', requireAuth, (req, res) => {
  const analysis = inspectProxyChain(req);
  res.json({
    ip: req.ip || '',
    forwardedFor: String(req.headers['x-forwarded-for'] || ''),
    hops: analysis.hops,
    trustProxy: process.env.TRUST_PROXY || '(default 1)',
    agrees: analysis.agrees,
    suspicious: analysis.suspicious,
    reason: analysis.reason,
  });
});

// Seed built-in default workflows for every registered firewall (migration).
// Idempotent: only inserts a workflow+steps for a (firewall, trigger) with none.
try {
  const count = seedAllFirewalls();
  if (count > 0) console.log(`[workflows] Ensured default provisioning workflows for ${count} firewall(s)`);
} catch (err) {
  console.warn('[workflows] Default workflow seeding failed:', err.message);
}

// Global error handler — the raw error stays in the log for operators; the
// browser gets a translated payload where we recognise the failure, and the
// sanitized string otherwise.
app.use(globalErrorHandler);

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
  if (shuttingDown) {
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host}`);
  log('info', 'websocket_upgrade_requested', { path: url.pathname, origin: request.headers.origin || '' });

  if (url.pathname !== '/api/vnc' && url.pathname !== '/api/ssh') {
    console.log('[WS-upgrade] rejected: unknown path');
    socket.destroy();
    return;
  }

  if (!isAllowedUpgradeOrigin(request)) {
    console.log(`[WS-upgrade] rejected: origin not allowed (origin=${request.headers.origin}, allowed=${ALLOWED_ORIGIN})`);
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }

  try {
    await loadUpgradeSession(request);
  } catch (err) {
    console.error('[WS-upgrade] rejected: session load failed:', err.message);
    rejectUpgrade(socket, 500, 'Internal Server Error');
    return;
  }

  if (!request.session?.userId) {
    console.log('[WS-upgrade] rejected: no userId in session');
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  if (url.pathname === '/api/vnc') {
    const token = extractUpgradeToken(request, url);
    const sess = vncSessions.get(token);
    if (!sess || sess.expires < Date.now() || sess._consumed) {
      log('warn', 'websocket_upgrade_rejected', { path: 'vnc', reason: 'invalid_or_expired_handoff' });
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (sess.userId !== request.session.userId || sess.sessionId !== request.sessionID) {
      log('warn', 'websocket_upgrade_rejected', { path: 'vnc', reason: 'session_mismatch', userId: request.session.userId });
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

// Mirror a peer's close onto the other side, degrading an unsendable code to a
// plain no-status close instead of throwing.
function relayClose(ws, code, reason) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const safe = sendableCloseCode(code);
  try {
    if (safe === null) ws.close();
    else ws.close(safe, reason);
  } catch {
    // Last resort: never let a close frame take the process down.
    try { ws.close(); } catch { /* already gone */ }
  }
}

vncWss.on('connection', async (clientWs, vncSession) => {
  const { node, vmid, ticket, port, vmtype = 'qemu', createdAt } = vncSession;
  const { nodeName } = decodeNodeRef(node);
  const proxmoxNode = nodeName || node;
  const elapsed = createdAt ? Date.now() - createdAt : -1;

  log('info', 'vnc_proxy_connecting', { node: proxmoxNode, vmtype, vmid, port, ticketAgeMs: elapsed });

  let pveHost;
  try {
    pveHost = await getHostForNode(node);
  } catch (err) {
    console.error(`VNC: could not resolve host for node ${node}:`, err.message);
    clientWs.close();
    return;
  }

  const TOKEN = `PVEAPIToken=${pveHost.tokenId}=${pveHost.tokenSecret}`;
  const vncUrl = `wss://${pveHost.host}:${pveHost.port}/api2/json/nodes/${proxmoxNode}/${vmtype}/${vmid}/vncwebsocket`
    + `?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

  log('info', 'vnc_upstream_connecting', { node: proxmoxNode, vmtype, vmid, port, verifyTls: pveHost.verifyTls });

  const agent = new https.Agent({ rejectUnauthorized: pveHost.verifyTls });

  const proxmoxWs = new WebSocket(vncUrl, ['binary'], {
    headers: { Authorization: TOKEN },
    agent,
  });

  proxmoxWs.on('open', () => {
    console.log(`[VNC-ws] proxy OPEN: ${proxmoxNode}/${vmid} (${Date.now() - createdAt}ms since ticket)`);
  });

  proxmoxWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  proxmoxWs.on('close', (code, reason) => {
    relayClose(clientWs, code, reason);
  });

  proxmoxWs.on('error', (err) => {
    const age = createdAt ? Date.now() - createdAt : -1;
    console.error(`[VNC-ws] Proxmox WS error (${proxmoxNode}/${vmtype}/${vmid}): ${err.message} ticketAge=${age}ms`);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  proxmoxWs.on('unexpected-response', async (_req, res) => {
    const contentType = String(res.headers['content-type'] || '');
    const body = /^(?:text\/|application\/(?:json|problem\+json))/i.test(contentType)
      ? redactText(await collectBoundedBody(res, { maxBytes: 4096 }))
      : '[non-text response omitted]';
    log('error', 'vnc_upstream_rejected', {
      node: proxmoxNode, vmtype, vmid, status: res.statusCode, body,
      ticketAgeMs: createdAt ? Date.now() - createdAt : -1,
    });
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
  const { host, port, username, privateKey, passphrase, hostFingerprint, requestId, node, vmid } = sshSession;
  const conn = new SSHClient();
  const expectedHostFingerprint = normalizeSshHostFingerprint(hostFingerprint);
  let hostVerificationError = '';

  conn.on('ready', () => {
    log('info', 'ssh_connected', { requestId, node, vmid, port });
    clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) {
        clientWs.send(JSON.stringify({ type: 'error', ...sshClientError(err) }));
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
    const clientError = sshClientError(message);
    log('error', 'ssh_connection_failed', { code: clientError.code, errorName: err?.name || 'Error' });
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', ...clientError }));
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
    log('error', 'ssh_connect_threw', { requestId, node, vmid, error: err });
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', ...sshClientError(err) }));
      clientWs.close();
    }
  }
});

// ─── Migrate any stored PPK keys to OpenSSH at startup ───────────────────────

async function convertPpkKey(ppkContent) {
  const id = uuidv4();
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

// ─── Node maintenance auto-expire ────────────────────────────────────────────
// Lifts any node maintenance whose end time has passed and closes its notice.
// Runs once at startup (catches windows that expired while the server was down)
// then on a one-minute tick.
function tickMaintenance() {
  try {
    const lifted = sweepExpiredMaintenance();
    if (lifted > 0) console.log(`[maintenance] auto-expired ${lifted} node maintenance window(s)`);
  } catch (err) {
    console.error('[maintenance] sweep failed:', err.message);
  }
}
tickMaintenance();
const maintenanceTimer = setInterval(tickMaintenance, 60_000);

// ─── Background PVE tag auto-sync scheduler ───────────────────────────────────
//
// Periodically walks the fleet and corrects owner/VLAN tag drift (VMs re-tagged
// in the raw PVE UI, renamed VLANs, migrations/restores, lost assignment writes).
// The tick is coarse (every few minutes); each tick checks whether a full run is
// actually due based on the persisted interval and last-run time, so the cadence
// survives restarts and honours the DB-backed pause switch. A run is skipped when
// paused or when one is already in flight (in-memory single-run lock lives in
// utils/vmTags.js — the backend is single-process). Shares the exact fleet loop
// used by POST /admin/sync-vm-tags via runFullTagSync().
//
// NOTE (#21/#26 tie-in): these issues propose shared background-scheduler
// plumbing. This feature ships its own self-contained ticker; if that shared
// scheduler lands, this block can be folded into it.
const TAG_SYNC_TICK_MS = 5 * 60 * 1000;   // re-evaluate whether a run is due
const tagSyncSchedulerStart = Date.now();

async function tagSyncTick() {
  try {
    if (isTagSyncRunning()) return;
    const settings = getTagSyncSettings();
    if (settings.paused) return;

    // Anchor the cadence to the last completed run (persisted) so restarts don't
    // reset the clock; fall back to process start when nothing has run yet.
    const lastRunAt = settings.lastRun?.time ? Date.parse(settings.lastRun.time) : NaN;
    const anchor = Number.isFinite(lastRunAt) ? lastRunAt : tagSyncSchedulerStart;
    const dueAt = anchor + settings.intervalHours * 60 * 60 * 1000;
    if (Date.now() < dueAt) return;

    const summary = await runFullTagSync({ trigger: 'scheduled' });
    logAuditEntry({
      username: 'system',
      action: 'vm_tags_sync_scheduled',
      target: 'all',
      detail: `${summary.checked} checked, ${summary.updated} updated, ${summary.failed} failed`,
    });
    console.log(`[tag-sync] scheduled run: ${summary.checked} checked, ${summary.updated} updated, ${summary.failed} failed (${summary.durationMs}ms)`);
  } catch (err) {
    if (err.code === 'TAG_SYNC_BUSY') return;   // manual run raced us — fine
    console.warn(`[tag-sync] scheduled run failed: ${err.message}`);
  }
}

const tagSyncTimer = setInterval(() => { tagSyncTick(); }, TAG_SYNC_TICK_MS);
tagSyncTimer.unref?.();   // don't keep the process alive just for the ticker

// ─── VM lease sweeper ────────────────────────────────────────────────────────
// Periodically finds expired leases and gracefully stops (never deletes) the
// VMs, flagging them for the admin reclaimable view. Interval is configurable;
// a short initial delay lets the cluster connections settle after boot.
import { runLeaseSweep } from './utils/leases.js';

const LEASE_CHECK_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.LEASE_CHECK_INTERVAL_MS || '900000', 10) || 900_000,
);

async function sweepLeasesSafe() {
  try {
    const result = await runLeaseSweep();
    if (result.checked > 0) {
      console.log(`[leases] sweep: checked ${result.checked}, stopped ${result.stopped}`);
    }
  } catch (err) {
    console.warn(`[leases] sweep failed: ${err.message}`);
  }
}

const leaseStartTimer = setTimeout(sweepLeasesSafe, 30_000);
const leaseTimer = setInterval(sweepLeasesSafe, LEASE_CHECK_INTERVAL_MS);

// ─── Node health monitor (Discord notifications for node up/down) ────────────
// Polls the same host/node health the Overview page shows and fires
// node.unreachable / node.recovered on state transitions. Fully self-contained
// and best-effort — pollNodeHealth() never throws. Disable by setting the
// interval to 0.
const NODE_HEALTH_POLL_MS = parseInt(process.env.NODE_HEALTH_POLL_MS || '60000');
const nodeHealthTimer = NODE_HEALTH_POLL_MS > 0
  ? setInterval(() => { pollNodeHealth().catch(() => {}); }, NODE_HEALTH_POLL_MS)
  : null;
// Background enforcement of per-VM power schedules (vm_schedules).
startScheduler();

const maintenanceStartTimer = setTimeout(() => {
  try { runDatabaseMaintenance(); } catch (err) { log('warn', 'database_maintenance_failed', { error: err }); }
}, 5 * 60 * 1000);
const databaseMaintenanceTimer = setInterval(() => {
  try { runDatabaseMaintenance(); } catch (err) { log('warn', 'database_maintenance_failed', { error: err }); }
}, 24 * 60 * 60 * 1000);
maintenanceStartTimer.unref?.();
databaseMaintenanceTimer.unref?.();
const stopBackupScheduler = startBackupScheduler();

// Every optional setting is read inline as `process.env.<NAME> || <default>`, so a
// variable that never reaches the process is indistinguishable from one left at
// its default — which is how four documented settings went unnoticed for as long
// as docker-compose.yml failed to pass them through. Print what was actually
// recognised at boot so "I set it and nothing happened" shows up in the logs.
const PORT_NUM = parseInt(process.env.PORT || '3000');
for (const line of formatConfigReport(buildConfigReport(process.env))) console.log(line);
server.listen(PORT_NUM, () => {
  log('info', 'server_listening', { port: PORT_NUM });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
  stopAcceptingBackgroundWork();

  clearInterval(maintenanceTimer);
  clearInterval(tagSyncTimer);
  clearTimeout(leaseStartTimer);
  clearInterval(leaseTimer);
  clearTimeout(maintenanceStartTimer);
  clearInterval(databaseMaintenanceTimer);
  stopBackupScheduler();
  if (nodeHealthTimer) clearInterval(nodeHealthTimer);
  stopScheduler();
  stopWebsiteMaintenance();

  for (const ws of [...vncWss.clients, ...sshWss.clients]) {
    try { ws.close(1001, 'Server shutting down'); } catch { ws.terminate(); }
  }
  vncSessions.clear();
  sshSessions.clear();

  const closed = new Promise((resolve) => server.close(resolve));
  const drained = await boundedDrain([
    closed,
    waitForSchedulerIdle(10_000),
    waitForBackupIdle(10_000),
    waitForBackgroundWork(),
  ], 15_000);
  if (drained.status === 'timeout') server.closeAllConnections?.();

  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (err) {
    log('warn', 'shutdown_checkpoint_failed', { error: err });
  }
  try { db.close(); } catch { /* already closed */ }
  log('info', 'shutdown_complete', {
    signal,
    forcedConnections: drained.status === 'timeout',
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown(signal).then(() => {
      // better-sqlite3-session-store owns an internal expiry interval without
      // exposing a close handle. All application drains and the final WAL
      // checkpoint have completed above, so terminate explicitly instead of
      // allowing that implementation-detail timer to hold the process open.
      process.exit(0);
    }).catch((err) => {
      log('error', 'shutdown_failed', { signal, error: err });
      process.exit(1);
    });
  });
}
