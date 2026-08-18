import crypto from 'node:crypto';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { recoveryCodes, sessions, webauthnCredentials } from '../db/schema/index.ts';

interface WebauthnConfigOptions {
  configuredOrigin?: string;
  allowedOrigin?: string;
  protocol?: string;
  host?: string;
  rpID?: string;
  rpName?: string;
}

export function resolveWebauthnConfig({ configuredOrigin = '', allowedOrigin = '', protocol = 'https', host = '', rpID = '', rpName = '' }: WebauthnConfigOptions) {
  const origin = configuredOrigin || allowedOrigin || `${protocol}://${host}`;
  let parsed;
  try { parsed = new URL(origin); }
  catch { throw new Error('WEBAUTHN_ORIGIN or ALLOWED_ORIGIN must be a valid origin'); }
  if (parsed.origin !== origin.replace(/\/$/, '') || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('WebAuthn origin must be an exact HTTP(S) origin without a path');
  }
  const relyingPartyId = rpID || parsed.hostname;
  if (parsed.hostname !== relyingPartyId && !parsed.hostname.endsWith(`.${relyingPartyId}`)) {
    throw new Error('WEBAUTHN_RP_ID must be the origin hostname or a registrable parent domain');
  }
  return { origin: parsed.origin, rpID: relyingPartyId, rpName: rpName || 'Homelabrrr' };
}

export function hashRecoveryCode(code: string | null | undefined): string {
  return crypto.createHash('sha256').update(String(code || '').replace(/\s|-/g, '').toUpperCase()).digest('hex');
}

export async function consumeRecoveryCode(database: DbOrTx, userId: number, codeHash: string): Promise<boolean> {
  // Atomic claim: the `used_at IS NULL` predicate inside the UPDATE is the
  // concurrency guard — two racing consumers cannot both observe rowCount === 1.
  const result = await database
    .update(recoveryCodes)
    .set({ used_at: new Date() })
    .where(and(
      eq(recoveryCodes.user_id, userId),
      eq(recoveryCodes.code_hash, codeHash),
      isNull(recoveryCodes.used_at),
    ));
  return result.rowCount === 1;
}

interface StoredSessionRow {
  sid: string;
  sess: unknown;
  expire: Date | null;
}

export function parseStoredSession(row: StoredSessionRow, currentSid: string) {
  // sess is jsonb — it arrives as an object; non-object payloads are treated
  // as corrupt, same contract as the old unparseable-JSON case.
  if (!row.sess || typeof row.sess !== 'object') return null;
  const data = row.sess as Record<string, any>;
  return {
    id: row.sid,
    current: row.sid === currentSid,
    createdAt: data.createdAt || null,
    lastSeenAt: data.lastSeenAt || null,
    expiresAt: row.expire || null,
    ip: data.clientIp || '',
    userAgent: data.userAgent || '',
    userId: data.userId,
  };
}

export async function removeWebauthnCredential(database: DbOrTx, userId: number, credentialId: string): Promise<{ id: string; name: string } | null> {
  // Owner-scoped delete; RETURNING reports what was removed (or that nothing was).
  const [credential] = await database
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.user_id, userId)))
    .returning({ id: webauthnCredentials.id, name: webauthnCredentials.name });
  return credential ?? null;
}

export async function revokeStoredSession(database: DbOrTx, userId: number, sessionId: string, currentSid: string) {
  if (sessionId === currentSid) return { ok: false, current: true };
  const [row] = await database
    .select({ sid: sessions.sid, sess: sessions.sess, expire: sessions.expire })
    .from(sessions)
    .where(eq(sessions.sid, sessionId))
    .limit(1);
  const parsed = row && parseStoredSession(row, currentSid);
  if (!parsed || parsed.userId !== userId) return { ok: false, missing: true };
  await database.delete(sessions).where(eq(sessions.sid, row.sid));
  return { ok: true, session: parsed };
}

export async function revokeOtherStoredSessions(database: DbOrTx, userId: number, currentSid: string): Promise<number> {
  // Ownership lives inside the sess payload, so read + filter + delete under one
  // transaction; the old per-row DELETE loop is a single inArray delete now.
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ sid: sessions.sid, sess: sessions.sess, expire: sessions.expire })
      .from(sessions)
      .where(ne(sessions.sid, currentSid));
    const sids = rows
      .filter((row) => parseStoredSession(row, currentSid)?.userId === userId)
      .map((row) => row.sid);
    if (sids.length === 0) return 0;
    const result = await tx.delete(sessions).where(inArray(sessions.sid, sids));
    return result.rowCount ?? 0;
  });
}
