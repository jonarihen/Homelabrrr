import crypto from 'node:crypto';

export function resolveWebauthnConfig({ configuredOrigin = '', allowedOrigin = '', protocol = 'https', host = '', rpID = '', rpName = '' }) {
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

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code || '').replace(/\s|-/g, '').toUpperCase()).digest('hex');
}

export function consumeRecoveryCode(database, userId, codeHash) {
  const consume = database.transaction(() => {
    const code = database.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .get(userId, codeHash);
    if (!code) return false;
    return database.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(code.id).changes === 1;
  });
  return consume();
}

export function parseStoredSession(row, currentSid) {
  try {
    const data = JSON.parse(row.sess || '{}');
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
  } catch { return null; }
}

export function removeWebauthnCredential(database, userId, credentialId) {
  const credential = database.prepare('SELECT id, name FROM webauthn_credentials WHERE id = ? AND user_id = ?')
    .get(credentialId, userId);
  if (!credential) return null;
  database.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(credential.id, userId);
  return credential;
}

export function revokeStoredSession(database, userId, sessionId, currentSid) {
  if (sessionId === currentSid) return { ok: false, current: true };
  const row = database.prepare('SELECT sid, sess, expire FROM sessions WHERE sid = ?').get(sessionId);
  const parsed = row && parseStoredSession(row, currentSid);
  if (!parsed || parsed.userId !== userId) return { ok: false, missing: true };
  database.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
  return { ok: true, session: parsed };
}

export function revokeOtherStoredSessions(database, userId, currentSid) {
  const rows = database.prepare('SELECT sid, sess, expire FROM sessions WHERE sid != ?').all(currentSid);
  const remove = database.prepare('DELETE FROM sessions WHERE sid = ?');
  let revoked = 0;
  database.transaction(() => {
    for (const row of rows) {
      if (parseStoredSession(row, currentSid)?.userId === userId) revoked += remove.run(row.sid).changes;
    }
  })();
  return revoked;
}
