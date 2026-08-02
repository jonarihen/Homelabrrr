// Cloud-init login credentials — client half.
//
// Mirrors backend/src/utils/cloudInitCredentials.js so the deploy form refuses
// exactly what the API refuses, before a five-minute deploy instead of after it.
// Keep the two in step.
//
// A stored SSH key is only installable on a VM if it has a public key — that is
// the half cloud-init injects. The key list (GET /api/ssh/keys) returns
// `public_key` plus an `encrypted` flag, which is enough to say why a key can't
// be used.

export const NO_LOGIN_MESSAGE =
  'This VM would have no way to log in. Set a cloud-init password, choose an SSH key, or both.';

// The single definition of "this stored key can be installed on a VM".
export function isUsableKey(key) {
  return typeof key?.public_key === 'string' && key.public_key.trim() !== '';
}

// Headline for a key that can't be installed. Paired with unusableKeyReason so
// the SSH Keys page and the deploy form say the same thing.
export const NO_PUBLIC_KEY_LABEL = 'No public key';

// Why an unusable key can't be used, and how to fix it. '' when it's fine.
export function unusableKeyReason(key) {
  if (isUsableKey(key)) return '';
  return key?.encrypted
    ? 'The private key is passphrase-protected, so its public half can’t be derived — re-add it with its .pub file, or with its passphrase.'
    : 'Re-add this key with its matching .pub file.';
}

// True when a cloud-init deploy with these inputs would leave the guest with no
// credentials at all. Selected ids that point at unusable keys don't count.
export function cloudInitLoginMissing({ password, keyIds, keys }) {
  if (typeof password === 'string' && password.length > 0) return false;
  const usable = new Set((Array.isArray(keys) ? keys : []).filter(isUsableKey).map((k) => k.id));
  return !(Array.isArray(keyIds) ? keyIds : []).some((id) => usable.has(id));
}
