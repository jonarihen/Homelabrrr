// Session ids that were revoked (logout, "sign out other sessions", credential
// change). A request already in flight on a revoked session still calls
// store.set() when it finishes, and that upsert would recreate the deleted row;
// DrizzleSessionStore.set() refuses sids listed here.
// shortcut: in-process only, like sftpSessions — fine for the single backend
// process; move to a table if the backend is ever scaled out.
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
const revoked = new Map<string, number>();

export function markSessionsRevoked(sids: Iterable<string>): void {
  const now = Date.now();
  for (const [sid, until] of revoked) if (until <= now) revoked.delete(sid);
  for (const sid of sids) revoked.set(sid, now + TOMBSTONE_MS);
}

export function isSessionRevoked(sid: string): boolean {
  return (revoked.get(sid) ?? 0) > Date.now();
}
