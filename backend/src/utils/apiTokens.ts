import crypto from 'crypto';

// Personal API token helpers.
//
// A token is `hlr_<43 url-safe base64 chars of 32 random bytes>`. Only the
// SHA-256 hash of the full token string is stored in the database — the
// plaintext is returned to the caller exactly once at creation time and can
// never be recovered afterwards.

export const TOKEN_PREFIX = 'hlr_';

// Generate a new opaque token secret. ~256 bits of entropy.
export function generateApiToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

// Deterministic SHA-256 hash (hex) used as the lookup key / at-rest value.
export function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
