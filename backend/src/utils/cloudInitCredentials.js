// Cloud-init login credentials for VM provisioning.
//
// Two rules live here, both of which decide whether a freshly deployed VM can
// actually be logged into:
//
//  1. An `ssh_keys` row is only usable for cloud-init if it has a stored public
//     key — that is the half cloud-init injects into the guest. The key store
//     knowingly keeps rows without one (an encrypted private key added without
//     its passphrase can't have its public half derived), so a selection has to
//     be resolved and any unusable key reported by name instead of dropped.
//  2. Distro cloud images ship with no default password and a locked default
//     user, so a cloud-init deploy with neither a password nor a usable key
//     produces a VM nobody can get into — not over SSH, not on the VNC console.
//     That is a correctness rule, not a policy preference.
//
// Pure: the caller passes the already-fetched `ssh_keys` rows in, so this module
// holds no DB handle and is unit-testable. A mirror of the usable/unusable
// predicate lives in frontend/src/utils/cloudInitCredentials.js — keep the two
// in step.

export const NO_LOGIN_MESSAGE =
  'This VM would have no way to log in. Set a cloud-init password, choose an SSH key, or both.';

// The single definition of "this stored key can be installed on a VM".
export function isUsableKeyRow(row) {
  return typeof row?.public_key === 'string' && row.public_key.trim() !== '';
}

// Resolve the SSH key ids a deploy asked for against the rows the caller loaded
// for that user. Returns:
//   keys     — the public-key lines to hand to cloud-init, in requested order
//   unusable — [{ id, name, reason }] for every requested id that can't be used;
//              reason is 'no-public-key' (row exists, public half missing) or
//              'missing' (no such key for this user, or a malformed id)
// Rows must already be scoped to the requesting user; an id with no matching row
// is reported as missing rather than silently ignored.
export function resolveSshKeys(requestedIds, keyRows) {
  const requested = Array.isArray(requestedIds) ? requestedIds : [];
  const rows = Array.isArray(keyRows) ? keyRows : [];
  const byId = new Map(rows.map((r) => [Number(r?.id), r]));

  const keys = [];
  const unusable = [];
  const seen = new Set();

  for (const raw of requested) {
    const id = Number(raw);
    if (!Number.isInteger(id)) {
      unusable.push({ id: raw, name: '', reason: 'missing' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const row = byId.get(id);
    if (!row) {
      unusable.push({ id, name: '', reason: 'missing' });
      continue;
    }
    if (!isUsableKeyRow(row)) {
      unusable.push({ id, name: row.name || '', reason: 'no-public-key' });
      continue;
    }
    keys.push(row.public_key.trim());
  }

  return { keys, unusable };
}

function keyLabel(entry) {
  return entry?.name ? `'${entry.name}'` : `#${entry?.id}`;
}

// Build the validation message for keys that were selected but can't be used.
// Returns null when everything resolved. Wording mirrors the cloud-init
// credential reset in routes/vms.js, which already refuses this case.
export function unusableKeysError(unusable) {
  const entries = Array.isArray(unusable) ? unusable : [];
  if (entries.length === 0) return null;

  const noPublicKey = entries.filter((e) => e.reason === 'no-public-key');
  const missing = entries.filter((e) => e.reason !== 'no-public-key');
  const parts = [];

  if (noPublicKey.length === 1) {
    parts.push(
      `Selected SSH key ${keyLabel(noPublicKey[0])} has no public key stored, so it can't be installed on the VM. `
      + 'Re-add it with its .pub file (or its passphrase), or pick another key.'
    );
  } else if (noPublicKey.length > 1) {
    parts.push(
      `Selected SSH keys ${noPublicKey.map(keyLabel).join(', ')} have no public key stored, so they can't be installed on the VM. `
      + 'Re-add them with their .pub files (or their passphrases), or pick other keys.'
    );
  }

  if (missing.length === 1) {
    parts.push(`Selected SSH key ${keyLabel(missing[0])} was not found.`);
  } else if (missing.length > 1) {
    parts.push(`Selected SSH keys ${missing.map(keyLabel).join(', ')} were not found.`);
  }

  return parts.join(' ');
}

// Refuse a cloud-init deploy that would leave the guest with no credentials at
// all. `sshKeys` accepts either the resolved array or the joined string the
// provisioning options carry. Non-cloud-init deploys (ISO / template installs
// that bring their own installer) are left alone. Throws a 400-tagged Error,
// matching the other assert* guards in this directory.
export function assertLoginPossible({ ciPassword, sshKeys, cloudInitCapable }) {
  if (!cloudInitCapable) return;

  const hasPassword = typeof ciPassword === 'string' && ciPassword.length > 0;
  const hasKey = Array.isArray(sshKeys)
    ? sshKeys.some((k) => typeof k === 'string' && k.trim() !== '')
    : typeof sshKeys === 'string' && sshKeys.trim() !== '';
  if (hasPassword || hasKey) return;

  const err = new Error(NO_LOGIN_MESSAGE);
  err.status = 400;
  throw err;
}
