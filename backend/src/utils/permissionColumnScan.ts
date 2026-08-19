// Static guard against the RBAC bug class from issue #71.
//
// Reading a granular permission straight off the `users` table —
// `SELECT can_something FROM users WHERE id = ?` — silently ignores
// `users.role_id`, so a user who was granted the permission by a role (which
// includes everyone on the built-in Administrator role) is treated as not
// having it. The whole point of utils/permissions.js is that the role wins.
//
// This module is pure (contents in, findings out) so the regression test can
// feed it the real source tree and assert nothing new sneaks in.

/**
 * One line of code that reads a legacy `can_*` column off `users`.
 * Deliberately line-scoped: the bug shape is a compact one-line lookup, and
 * the multi-line user-listing queries in the admin UI legitimately select
 * every column for display/editing rather than for an access decision.
 */
export const LEGACY_PERMISSION_COLUMN_READ =
  /\bSELECT\b[^;]*\bcan_[a-z_]+\b[^;]*\bFROM\s+users\b/i;

/**
 * The one place allowed to read a permission column directly, and why.
 * `requires` are substrings the matched line must contain — pinning
 * `role_id` is the point: the query only passes because loadProvisioner()
 * folds the role in immediately afterwards.
 */
export const SANCTIONED_COLUMN_READS = [
  {
    file: 'src/routes/provision.ts',
    requires: ['can_provision', 'role_id'],
    why: 'loadProvisioner() re-derives can_provision from the role right after this read',
  },
];

const toPosix = (p) => String(p).replace(/\\/g, '/');

/**
 * Scan one file's contents. Returns [{ file, line, text }] for every
 * non-comment line that reads a legacy permission column off `users`.
 */
export function scanForLegacyPermissionColumnReads(filePath, contents) {
  const findings = [];
  const lines = String(contents ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    // Comments describing the pattern (like the ones above) are not code.
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
    if (LEGACY_PERMISSION_COLUMN_READ.test(text)) {
      findings.push({ file: toPosix(filePath), line: i + 1, text });
    }
  }
  return findings;
}

/** True when a finding is one of the explicitly allowed reads. */
export function isSanctionedColumnRead(finding, sanctioned = SANCTIONED_COLUMN_READS) {
  return sanctioned.some((s) =>
    toPosix(finding.file).endsWith(toPosix(s.file))
    && s.requires.every((needle) => finding.text.includes(needle)));
}

/** Findings that are NOT allowed — a non-empty result is a bug. */
export function unsanctionedColumnReads(findings, sanctioned = SANCTIONED_COLUMN_READS) {
  return findings.filter((f) => !isSanctionedColumnRead(f, sanctioned));
}
