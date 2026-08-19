import session from 'express-session';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { sessions } from './schema/index.ts';
import { log } from '../utils/logger.ts';

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
          return db.delete(sessions).where(eq(sessions.sid, sid)).then(() => cb(null, null), () => cb(null, null));
        }
        cb(null, row.sess as session.SessionData);
      }, (err) => cb(err));
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    const expire = this.expiryFor(sess);
    db.insert(sessions)
      .values({ sid, sess: sess as object, expire })
      .onConflictDoUpdate({ target: sessions.sid, set: { sess: sess as object, expire } })
      .then(() => cb?.(), (err) => cb?.(err));
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    db.delete(sessions).where(eq(sessions.sid, sid)).then(() => cb?.(), (err) => cb?.(err));
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    db.update(sessions)
      .set({ expire: this.expiryFor(sess) })
      .where(eq(sessions.sid, sid))
      .then(() => cb?.(), (err) => cb?.(err));
  }

  startPruning(intervalMs = PRUNE_INTERVAL_MS): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      db.delete(sessions).where(lt(sessions.expire, sql`now()`)).catch((err) => {
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
