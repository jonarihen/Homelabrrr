import session from 'express-session';
import { and, eq, exists, gt, lt, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { sessions, users } from './schema/index.ts';
import { log } from '../utils/logger.ts';
import { revokeSftpSession } from '../utils/sftpSessions.ts';
import { closeSessionConsoles } from '../utils/consoleSockets.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

type Callback = (err?: unknown, result?: session.SessionData | null) => void;

// Drizzle-backed express-session store on the shared pool. Replaces
// better-sqlite3-session-store; unlike that store, the expiry prune interval
// is owned here and can be stopped, so shutdown no longer depends on
// process.exit() to defeat an unclosable timer. The sessions table lives in
// the normal schema (src/db/schema/auth.ts) — routes/auth.ts and
// utils/accountSecurity.ts query it directly for the active-sessions UI.
export class DrizzleSessionStore extends session.Store {
  private pruneTimer: NodeJS.Timeout | null = null;

  private expiryFor(sess: session.SessionData): Date {
    const maxAge = sess.cookie?.maxAge;
    return new Date(Date.now() + (typeof maxAge === 'number' && maxAge > 0 ? maxAge : DAY_MS));
  }

  get(sid: string, cb: Callback): void {
    db.select({ sess: sessions.sess, expire: sessions.expire })
      .from(sessions)
      .where(eq(sessions.sid, sid))
      .limit(1)
      .then(([row]) => {
        if (!row) return cb(null, null);
        if (row.expire.getTime() <= Date.now()) {
          // Expired — remove lazily and report a miss.
          closeSessionConsoles(sid);
          return db.delete(sessions).where(eq(sessions.sid, sid)).then(() => cb(null, null), () => cb(null, null));
        }
        // A row in the store is persisted by definition (covers rows stored
        // before the _persisted marker existed), so later saves stay UPDATE-only.
        cb(null, { ...(row.sess as object), _persisted: true } as unknown as session.SessionData);
      }, (err) => cb(err));
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    const expire = this.expiryFor(sess);
    const data = sess as session.SessionData & { _persisted?: boolean };
    // A session that was already stored is only ever UPDATEd: if it was revoked
    // (row deleted) while a request on it was in flight, that request's save
    // must not recreate it. Only a never-stored session may INSERT.
    if (data._persisted) {
      db.update(sessions)
        .set({ sess: data as object, expire })
        .where(eq(sessions.sid, sid))
        .then(() => cb?.(), (err) => cb?.(err));
      return;
    }
    const stored = { ...data, _persisted: true };
    db.insert(sessions)
      .values({ sid, sess: stored, expire })
      .onConflictDoUpdate({ target: sessions.sid, set: { sess: stored, expire } })
      .then(() => { data._persisted = true; cb?.(); }, (err) => cb?.(err));
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    revokeSftpSession(sid);
    closeSessionConsoles(sid);
    db.delete(sessions).where(eq(sessions.sid, sid)).then(() => cb?.(), (err) => cb?.(err));
  }

  // Console upgrades re-check their session after registering (see
  // utils/consoleSockets.ts); a deleted user keeps its session rows until the
  // next HTTP request, so the user must still exist too.
  async hasLiveSession(sid: string, userId: number): Promise<boolean> {
    const [row] = await db.select({ sess: sessions.sess })
      .from(sessions)
      .where(and(
        eq(sessions.sid, sid),
        gt(sessions.expire, sql`now()`),
        exists(db.select({ id: users.id }).from(users).where(eq(users.id, userId))),
      ))
      .limit(1);
    const stored = row?.sess as session.SessionData | undefined;
    return stored?.userId === userId && !stored.twoFactorEnrollmentOnly;
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    db.update(sessions)
      .set({ expire: this.expiryFor(sess) })
      .where(eq(sessions.sid, sid))
      .then(() => cb?.(), (err) => cb?.(err));
  }

  async pruneExpired(): Promise<number> {
    const removed = await db.delete(sessions)
      .where(lt(sessions.expire, sql`now()`))
      .returning({ sid: sessions.sid });
    for (const { sid } of removed) closeSessionConsoles(sid);
    return removed.length;
  }

  startPruning(intervalMs = PRUNE_INTERVAL_MS): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      this.pruneExpired().catch((err) => {
        log('warn', 'session_prune_failed', { error: err?.message });
      });
    }, intervalMs);
    this.pruneTimer.unref?.();
  }

  stopPruning(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}
