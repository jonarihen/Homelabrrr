import crypto from 'crypto';

const SECRET_PREFIX = 'enc:v1:';

function parseSecretKey(rawValue) {
  if (!rawValue) return null;

  const raw = String(rawValue).trim();
  if (!raw) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      return decoded;
    }
  } catch {
    // Fall through to utf8 validation.
  }

  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length === 32) return utf8;

  throw new Error('SECRET_ENCRYPTION_KEY must be 32 bytes (base64, hex, or raw text)');
}

const SECRET_KEY = parseSecretKey(process.env.SECRET_ENCRYPTION_KEY || '');

export function assertSecretEncryptionKey() {
  if (!SECRET_KEY) {
    throw new Error('SECRET_ENCRYPTION_KEY must be set before the application can start');
  }
  return SECRET_KEY;
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

export function encryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  if (isEncryptedSecret(value)) return value;

  const key = assertSecretEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncryptedSecret(value)) return value;

  const key = assertSecretEncryptionKey();
  const payload = String(value).slice(SECRET_PREFIX.length);
  const [ivB64, tagB64, ciphertextB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Encrypted secret is malformed');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

export function secretNeedsMigration(value) {
  return value !== null && value !== undefined && value !== '' && !isEncryptedSecret(value);
}
