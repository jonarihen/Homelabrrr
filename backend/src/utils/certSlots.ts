// Slot accounting for the inbound server-certificate list on a FortiGate
// SSL/SSH inspection profile.
//
// FortiOS caps `firewall/ssl-ssh-profile` → `server-cert` at 10 entries per
// profile. Going over returns:
//
//   Too many server certificate entries. Maximum number of entries: 10;
//   attribute set operator error, -4, discard the setting
//
// That cap is the whole reason this module exists. `caddy-forticertsync` names
// every synced cert `<domain>_<DDMMYYYY>`, so a renewal produces a *new* name
// for the *same* subject — appending it leaves the predecessor behind and burns
// a second slot. FortiOS then refuses to delete the old cert because the
// profile still references it, so the profile fills up and every further
// publish fails. Keying slots by the subject encoded in the name (rather than
// by the literal name) makes a renewal replace its predecessor in place.
//
// Everything here is pure string work on names read back from the FortiGate —
// no API calls, no DB — so it can be unit-tested standalone.

export const SERVER_CERT_MAX = 10;

// `caddy-forticertsync` (and the tools it was modelled on) mark a wildcard cert
// with a name prefix, since `*` is not legal in a FortiGate certname.
const WILDCARD_PREFIXES = ['wildcard_', 'wildcard-', 'wildcard.', 'star_', 'star-', 'star.', '*.', '_.'];

// A trailing `_DDMMYYYY` / `-DDMMYYYY` issue-date stamp, e.g. `jackjack_dk_26072026`.
const DATE_SUFFIX = /[_-](\d{2})(\d{2})(\d{4})$/;

/**
 * Strip a trailing `_DDMMYYYY` issue-date stamp off a cert name.
 *
 * The day/month ranges are validated so a domain that genuinely ends in eight
 * digits (`foo_99999999`) keeps its name instead of being silently truncated.
 */
export function stripCertDateSuffix(name) {
  const s = String(name || '');
  const m = s.match(DATE_SUFFIX);
  if (!m) return s;
  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return s;
  return s.slice(0, s.length - m[0].length);
}

/**
 * Recover the certificate subject a FortiGate cert name stands for.
 *
 *   jackjack_dk_26072026        → jackjack.dk
 *   music_jackjack_dk_30072026  → music.jackjack.dk
 *   wildcard_aaris_tech_2206... → *.aaris.tech
 *
 * Best-effort by construction: the name is the only thing the CMDB gives us
 * (FortiOS 7.6 dropped the monitor endpoint that carried the real subject), so
 * a hand-uploaded cert whose name doesn't follow the convention simply keys to
 * itself and gets its own slot.
 */
export function certNameToSubject(name) {
  let s = stripCertDateSuffix(name).trim().toLowerCase();
  let wildcard = false;
  for (const prefix of WILDCARD_PREFIXES) {
    if (s.startsWith(prefix)) {
      wildcard = true;
      s = s.slice(prefix.length);
      break;
    }
  }
  s = s.replace(/[_-]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  if (!s) return '';
  return wildcard ? `*.${s}` : s;
}

/**
 * The slot identity of a cert name: two names sharing this key are the same
 * certificate at two points in its renewal history and must never both occupy
 * a slot. Falls back to the raw lowercased name when no subject can be derived.
 */
export function certSlotKey(name) {
  return certNameToSubject(name) || String(name || '').trim().toLowerCase();
}

/** Whether a cert name denotes a wildcard certificate. */
export function isWildcardCertName(name) {
  return certNameToSubject(name).startsWith('*.');
}

/**
 * Whether the wildcard cert `certName` covers `domain`.
 *
 * Same single-label semantics as `hostCoveredByWildcard` in utils/caddy.js —
 * `*.example.com` covers `app.example.com` but neither `example.com` (the apex)
 * nor `a.b.example.com`. Reimplemented here rather than imported so this module
 * stays dependency-free and safe to pull into `fortigate.ts`.
 */
export function certWildcardCovers(certName, domain) {
  const subject = certNameToSubject(certName);
  if (!subject.startsWith('*.')) return false;
  const base = subject.slice(2);
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!base || !d.endsWith(`.${base}`)) return false;
  const label = d.slice(0, d.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

/**
 * Raised instead of letting FortiOS reject the PUT, so the caller can report a
 * blocked step (with the slots actually in the way) rather than a retryable
 * failure — a full profile never resolves by retrying.
 */
export class ServerCertLimitError extends Error {
  constructor(profileName, occupied, max = SERVER_CERT_MAX) {
    super(
      `SSL inspection profile "${profileName}" is full: FortiOS allows ${max} server certificates per profile and all ${max} slots are taken. ` +
      `Free a slot on the FortiGate — or issue one certificate covering several names — then retry. Occupied slots: ${occupied.join(', ')}`
    );
    this.name = 'ServerCertLimitError';
    this.code = 'server_cert_limit';
    this.profileName = profileName;
    this.occupied = occupied;
    this.max = max;
  }
}

/**
 * Decide what the profile's `server-cert` list should become.
 *
 * Returns `{ action, list, ... }` where action is one of:
 *   - `already-attached`  the exact name is already in the list — nothing to do
 *   - `covered`           a wildcard entry already covers `domain` — nothing to do
 *   - `replace`           an older cert for the same subject is swapped in place
 *   - `append`            a genuinely new subject takes a free slot
 *   - `limit`             appending would exceed `max`; caller should raise
 *
 * `list` is null for the no-op and `limit` actions.
 *
 * @param {Array<string|{name?: string}>} existingEntries current `server-cert` value
 * @param {string} certName cert to attach
 * @param {string} domain the site hostname, used for wildcard coverage
 */
export function planServerCertList(existingEntries, certName, domain = '', max = SERVER_CERT_MAX) {
  const existing = (Array.isArray(existingEntries) ? existingEntries : [])
    .map((c) => String((c && c.name) || c || '').trim())
    .filter(Boolean);

  if (existing.includes(certName)) {
    return { action: 'already-attached', list: null, occupied: existing };
  }

  // A renewal: same subject, newer date stamp. Swap it in place so the slot
  // count is unchanged and the superseded cert stops being referenced (which is
  // what lets it be deleted from the FortiGate at all).
  const key = certSlotKey(certName);
  const replaceIdx = existing.findIndex((n) => certSlotKey(n) === key);
  if (replaceIdx !== -1) {
    const list = existing.slice();
    const replaced = list[replaceIdx];
    list[replaceIdx] = certName;
    return { action: 'replace', list, replaced, occupied: existing };
  }

  // A wildcard already in the profile covers this hostname — attaching the
  // per-host cert would spend a slot for no added coverage.
  const coveredBy = domain ? existing.find((n) => certWildcardCovers(n, domain)) : undefined;
  if (coveredBy) {
    return { action: 'covered', list: null, coveredBy, occupied: existing };
  }

  if (existing.length >= max) {
    return { action: 'limit', list: null, occupied: existing };
  }

  return { action: 'append', list: [...existing, certName], occupied: existing };
}
