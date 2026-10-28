// Open SSH/VNC console WebSockets, by the login session that opened them.
// Consoles are only authenticated at upgrade, so without this a revoked
// session (logout elsewhere, credential change, user deletion) would keep
// every console it already had (#329).

interface ConsoleSocket {
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

const consoles = new Map<ConsoleSocket, { sessionId: string; userId: number }>();

// 4001: application-defined close code; the browser sees a plain disconnect.
const REVOKED = [4001, 'Session revoked'] as const;

export function trackConsoleSocket(ws: ConsoleSocket, sessionId: string, userId: number): void {
  consoles.set(ws, { sessionId, userId });
  ws.once('close', () => consoles.delete(ws));
}

function closeWhere(match: (owner: { sessionId: string; userId: number }) => boolean): number {
  let closed = 0;
  for (const [ws, owner] of consoles) {
    if (!match(owner)) continue;
    consoles.delete(ws);
    ws.close(...REVOKED);
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
