import { createGuardrails, generateSecret, generateURI, verifySync } from 'otplib';

// The issuer shown by the authenticator app next to the account name.
const ISSUER = 'VM Manager';

// otplib 13 refuses secrets shorter than 16 bytes, which is the right floor for
// anything issued from now on. Every secret enrolled under otplib 12 is 10
// bytes, though — its generateSecret() emitted 16 base32 characters — so the
// stock guardrail would reject the entire existing user base at sign-in rather
// than make their secrets any stronger. Verification therefore runs against a
// lowered floor; issuing does not, so new enrollments get the full 20 bytes.
const VERIFY_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 10 });

/**
 * A fresh base32 TOTP secret — 20 bytes (32 characters), up from the 10 bytes
 * otplib 12 issued.
 */
export function generateTotpSecret() {
  return generateSecret();
}

/**
 * Verify a code against a stored secret.
 *
 * Returns a plain boolean on purpose: otplib 13's verifySync resolves to a
 * `{ valid }` result object, and an object is always truthy — handing it
 * straight to an `if (!isValid)` check would accept every code, including an
 * empty one.
 */
export function verifyTotp(token, secret) {
  if (!token || !secret) return false;
  try {
    const result = verifySync({
      token: String(token).replace(/\s/g, ''),
      secret,
      guardrails: VERIFY_GUARDRAILS,
    });
    return result?.valid === true;
  } catch {
    // A malformed token or an unreadable secret is a failed check, not a 500.
    return false;
  }
}

/**
 * The otpauth:// URI an authenticator app scans during enrollment.
 *
 * otplib 13 omits period/digits/algorithm because they are the RFC defaults
 * (30s, 6 digits, SHA-1) — the same values otplib 12 wrote out explicitly, so
 * codes from an app enrolled either way still match.
 */
export function totpKeyUri(accountName, secret) {
  return generateURI({ secret, label: accountName, issuer: ISSUER });
}
