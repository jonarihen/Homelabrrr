// Open SSH/VNC console WebSockets, by the login session that opened them.
// Consoles are only authenticated at upgrade, so without this a revoked
// session (logout elsewhere, credential change, user deletion, expiry) would
// keep every console it already had (#329).

import { log } from './logger.ts';

interface ConsoleSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  once(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): unknown;
}

export interface ConsoleSessionCheck {
  hasLiveSession(sessionId: string, userId: number): Promise<boolean>;
}

const OPEN = 1;
const consoles = new Map<ConsoleSocket, { sessionId: string; userId: number }>();

// 4001: application-defined close code; the browser sees a plain disconnect.
const REVOKED = [4001, 'Session revoked'] as const;

// close() alone waits up to 30s for a peer that never acknowledges, and the
// proxy keeps forwarding its input meanwhile. The close frame is a courtesy;
// terminate() drops the connection now and fires 'close', which ends upstream.
function revoke(ws: ConsoleSocket): void {
  try { ws.close(...REVOKED); } catch { /* the close frame is best-effort */ }
  ws.terminate();
}

// Register first, then re-read the session: a revocation that swept before the
// registration has already deleted the row, and one that sweeps after it finds
// the socket. Resolves true only for a console that may be proxied.
export async function trackConsoleSocket(ws: ConsoleSocket, sessionId: string, userId: number, sessions: ConsoleSessionCheck): Promise<boolean> {
  if (ws.readyState !== OPEN) return false;
  consoles.set(ws, { sessionId, userId });
  ws.once('close', () => consoles.delete(ws));
  // No proxy handler is attached yet; an invalid frame must not crash the process.
  ws.on('error', (err) => log('warn', 'console_socket_error', { code: err?.code || err?.name || 'Error' }));
  let live = false;
  try {
    live = await sessions.hasLiveSession(sessionId, userId);
    if (!live) log('warn', 'websocket_upgrade_rejected', { reason: 'session_revoked', userId });
  } catch (err) {
    log('error', 'console_session_check_failed', { errorName: (err as Error)?.name || 'Error' });
  }
  if (!consoles.has(ws)) return false;
  if (live && ws.readyState === OPEN) return true;
  consoles.delete(ws);
  revoke(ws);
  return false;
}

function closeWhere(match: (owner: { sessionId: string; userId: number }) => boolean): number {
  let closed = 0;
  for (const [ws, owner] of consoles) {
    if (!match(owner)) continue;
    consoles.delete(ws);
    revoke(ws);
    closed += 1;
  }
  return closed;
}

export function closeSessionConsoles(sessionId: string): number {
  return closeWhere((owner) => owner.sessionId === sessionId);
}

export function closeUserConsoles(userId: number): number {
  return closeWhere((owner) => owner.userId === userId);
}
