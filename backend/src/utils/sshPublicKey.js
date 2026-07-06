import ssh2 from 'ssh2';

// ssh2 is CommonJS; `utils` isn't picked up as a named ESM export, so reach it
// through the default (module.exports) object.
const { parseKey } = ssh2.utils;

// Derive the OpenSSH `authorized_keys` public-key line from a private key, so a
// key added with only its private half can still be used for cloud-init
// provisioning (which injects the public key into the guest).
//
// Returns '' when the public key can't be derived — most commonly an encrypted
// private key added without its passphrase, or an unsupported key format. The
// caller treats '' as "no public key" and warns the user.
export function derivePublicKey(privateKey, passphrase = '') {
  try {
    const result = parseKey(privateKey, passphrase ? passphrase : undefined);
    const key = Array.isArray(result) ? result[0] : result;
    if (!key || key instanceof Error || typeof key.getPublicSSH !== 'function') return '';
    const type = key.type;
    const blob = key.getPublicSSH();
    if (!type || !blob || !blob.length) return '';
    const comment = typeof key.comment === 'string' ? key.comment.trim() : '';
    return `${type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`;
  } catch {
    return '';
  }
}
