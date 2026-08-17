import crypto from 'node:crypto';

const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';

function parseSecretKey(rawValue, label = 'SECRET_ENCRYPTION_KEY') {
  if (!rawValue) return null;
  const raw = String(rawValue).trim();
  if (!raw) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return decoded;
  } catch { /* try UTF-8 below */ }

  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length === 32) return utf8;
  throw new Error(`${label} must be 32 bytes (base64, hex, or raw text)`);
}

function parsePreviousKeys(rawValue) {
  if (!rawValue) return new Map();
  let entries;
  try {
    const parsed = JSON.parse(rawValue);
    entries = Object.entries(parsed);
  } catch {
    entries = String(rawValue).split(',').filter(Boolean).map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) throw new Error('SECRET_ENCRYPTION_PREVIOUS_KEYS must be JSON or kid=key pairs');
      return [entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()];
    });
  }
  return new Map(entries.map(([id, value]) => {
    const keyId = String(id || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error(`Invalid encryption key id: ${keyId}`);
    return [keyId, parseSecretKey(value, `previous encryption key ${keyId}`)];
  }));
}

const CURRENT_KEY_ID = String(process.env.SECRET_ENCRYPTION_KEY_ID || 'primary').trim();
if (!/^[A-Za-z0-9._-]{1,64}$/.test(CURRENT_KEY_ID)) throw new Error('SECRET_ENCRYPTION_KEY_ID has an invalid format');
const CURRENT_KEY = parseSecretKey(process.env.SECRET_ENCRYPTION_KEY || '');
const PREVIOUS_KEYS = parsePreviousKeys(process.env.SECRET_ENCRYPTION_PREVIOUS_KEYS || '');
const KEYRING = new Map(PREVIOUS_KEYS);
if (CURRENT_KEY) KEYRING.set(CURRENT_KEY_ID, CURRENT_KEY);

export function assertSecretEncryptionKey() {
  if (!CURRENT_KEY) throw new Error('SECRET_ENCRYPTION_KEY must be set before the application can start');
  return CURRENT_KEY;
}

export function encryptionKeyStatus() {
  return { currentKeyId: CURRENT_KEY_ID, availableKeyIds: [...KEYRING.keys()], legacyKeyCount: PREVIOUS_KEYS.size };
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX));
}

function encryptWithKey(value, key, prefix) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function encryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'string' && value.startsWith(`${V2_PREFIX}${CURRENT_KEY_ID}:`)) return value;
  return encryptWithKey(value, assertSecretEncryptionKey(), `${V2_PREFIX}${CURRENT_KEY_ID}:`);
}

function decryptPayload(payload, key) {
  const [ivB64, tagB64, ciphertextB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error('Encrypted secret is malformed');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncryptedSecret(value)) return value;

  if (value.startsWith(V2_PREFIX)) {
    const rest = value.slice(V2_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) throw new Error('Encrypted secret key id is missing');
    const keyId = rest.slice(0, separator);
    const key = KEYRING.get(keyId);
    if (!key) throw new Error(`Encrypted secret requires unavailable key id ${keyId}`);
    return decryptPayload(rest.slice(separator + 1), key);
  }

  // v1 had no key identifier. Try the current key and then explicitly
  // configured legacy keys so an upgrade can re-encrypt it as v2.
  const payload = value.slice(V1_PREFIX.length);
  const candidates = [CURRENT_KEY, ...PREVIOUS_KEYS.values()].filter(Boolean);
  for (const key of candidates) {
    try { return decryptPayload(payload, key); } catch { /* try the next configured key */ }
  }
  throw new Error('Encrypted v1 secret could not be decrypted with the configured keyring');
}

export function secretNeedsMigration(value) {
  if (value === null || value === undefined || value === '') return false;
  if (!isEncryptedSecret(value)) return true;
  return !String(value).startsWith(`${V2_PREFIX}${CURRENT_KEY_ID}:`);
}
