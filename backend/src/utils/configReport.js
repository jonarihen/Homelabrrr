// The single declared list of environment variables this backend recognises,
// plus a pure report over a given env object.
//
// Why this exists: every one of these is read somewhere in src/ with an inline
// `process.env.<NAME> || default`, so a variable that never reaches the container is
// indistinguishable from one the operator left alone — it just quietly behaves
// like the default. That is exactly how PORTAL_BASE_URL, NODE_HEALTH_POLL_MS,
// LEASE_CHECK_INTERVAL_MS and VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS ended up being
// documented but never passed through docker-compose.yml.
//
// Two things keep that from happening again:
//   1. index.js prints buildConfigReport() at boot, so an ignored variable is
//      visible in `docker compose logs backend` instead of being silent.
//   2. configReport.test.js asserts this table is a subset of the backend
//      service's `environment:` block in docker-compose.yml, and that every
//      `process.env.<NAME>` read anywhere in src/ appears in this file.
//
// Keep this module pure — no process.env, no db, no fs. buildConfigReport takes
// the environment as an argument so it can be unit-tested.

// Variables the backend refuses to start without (asserted in index.js /
// utils/secrets.js). Listed here so the compose sync test covers them too.
export const REQUIRED_ENV_VARS = ['SESSION_SECRET', 'SECRET_ENCRYPTION_KEY'];

// Recognised optional variables, in roughly the order they matter at boot.
//
//   name         env var name
//   defaultValue the value the code falls back to, as a string, or null when
//                there is no value-shaped default (the feature is just off)
//   effect       what the variable controls
//   unsetNote    what happens when it is not set; defaults to "defaults to <x>"
//   secret       never print the value, only whether it is set
export const OPTIONAL_ENV_VARS = [
  {
    name: 'PORT',
    defaultValue: '3000',
    effect: 'TCP port the API listens on',
  },
  {
    name: 'DB_PATH',
    defaultValue: '/app/data/db.sqlite',
    effect: 'SQLite database file (the db_data volume mount point in Docker)',
  },
  {
    name: 'ALLOWED_ORIGIN',
    defaultValue: null,
    effect: 'exact browser origin allowed for CORS and websocket upgrades',
    unsetNote: 'CORS is not enabled and websocket upgrades fall back to same-origin checks',
  },
  {
    name: 'SECRET_ENCRYPTION_KEY_ID',
    defaultValue: 'primary',
    effect: 'identifier embedded in newly encrypted secret values',
  },
  {
    name: 'SECRET_ENCRYPTION_PREVIOUS_KEYS',
    defaultValue: null,
    effect: 'legacy decryption keyring used during key rotation',
    secret: true,
  },
  {
    name: 'WEBAUTHN_RP_ID',
    defaultValue: null,
    effect: 'WebAuthn relying-party hostname',
    unsetNote: 'derived from WEBAUTHN_ORIGIN or ALLOWED_ORIGIN',
  },
  {
    name: 'WEBAUTHN_ORIGIN',
    defaultValue: null,
    effect: 'exact browser origin accepted for passkeys',
    unsetNote: 'falls back to ALLOWED_ORIGIN',
  },
  {
    name: 'WEBAUTHN_RP_NAME',
    defaultValue: 'Homelabrrr',
    effect: 'display name shown by passkey authenticators',
  },
  {
    name: 'COOKIE_SECURE',
    defaultValue: 'true',
    effect: 'marks session cookies Secure; only set false for plain-HTTP dev',
  },
  {
    name: 'TRUST_PROXY',
    defaultValue: '1',
    effect: 'proxy hops in front of the backend, for client IPs in the audit log',
    unsetNote: 'defaults to 1 hop (docker-compose passes 2 for the recommended topology)',
  },
  {
    name: 'ALLOW_INSECURE_UPSTREAM_TLS',
    defaultValue: 'false',
    effect: 'break-glass override for unverified Proxmox/FortiGate TLS',
  },
  {
    name: 'ALLOW_INTERNAL_IMAGE_URLS',
    defaultValue: 'false',
    effect: 'allow cloud-image/ISO downloads from internal or reserved addresses',
  },
  {
    name: 'PORTAL_BASE_URL',
    defaultValue: null,
    effect: 'absolute portal URL used for "open in portal" links in Discord embeds',
    unsetNote: 'falls back to ALLOWED_ORIGIN; links are omitted when neither is set',
  },
  {
    name: 'NODE_HEALTH_POLL_MS',
    defaultValue: '60000',
    effect: 'node health poll interval for unreachable/recovered notifications; 0 disables it',
  },
  {
    name: 'LEASE_CHECK_INTERVAL_MS',
    defaultValue: '900000',
    effect: 'how often expired VM leases are swept (floored at 60000)',
  },
  {
    name: 'WEBSITE_RECONCILE_INTERVAL_MS',
    defaultValue: '300000',
    effect: 'how often published websites are re-checked: admin-API routes a Caddy reload dropped are re-pushed, and every published site is re-probed (floored at 60000)',
  },
  {
    name: 'VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS',
    defaultValue: '120000',
    effect: 'grace period a scheduled shutdown waits before the hard-stop fallback',
  },
  {
    name: 'AUDIT_RETENTION_DAYS',
    defaultValue: '365',
    effect: 'retention window for security audit records',
  },
  {
    name: 'JOB_RETENTION_DAYS',
    defaultValue: '90',
    effect: 'retention window for terminal operational jobs',
  },
  {
    name: 'BACKUP_DIR',
    defaultValue: '/app/backups',
    effect: 'directory for encrypted SQLite backups',
  },
  {
    name: 'BACKUP_OFFSITE_DIR',
    fallback: '/app/backups-offsite',
    effect: 'separately mounted destination that receives and verifies the disaster-recovery copy',
  },
  {
    name: 'BACKUP_ENCRYPTION_KEY',
    defaultValue: null,
    effect: 'separate passphrase for encrypted database backups',
    secret: true,
  },
  {
    name: 'BACKUP_RETENTION_DAYS',
    defaultValue: '14',
    effect: 'retention window for verified encrypted backups',
  },
  {
    name: 'BACKUP_INTERVAL_MS',
    defaultValue: '86400000',
    effect: 'scheduled encrypted backup interval',
  },
  {
    name: 'INITIAL_ADMIN_USERNAME',
    defaultValue: null,
    effect: 'username of the first admin, created only on an empty database',
    unsetNote: 'no first-run admin bootstrap',
  },
  {
    name: 'INITIAL_ADMIN_PASSWORD',
    defaultValue: null,
    effect: 'password of the first admin, created only on an empty database',
    unsetNote: 'no first-run admin bootstrap',
    secret: true,
  },
];

// A variable that is present but empty counts as unset: docker-compose expands
// `${FOO:-}` to an empty string when .env has no FOO, so an empty value is the
// normal shape of "the operator did not set this", not a deliberate "".
function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

/**
 * Classify every recognised optional variable against an env object.
 *
 * status is one of:
 *   'unset'     — absent, or present but empty/whitespace
 *   'default'   — present with exactly the value the code would default to
 *   'set'       — present with a value that changes behaviour
 *
 * @param {Record<string, string|undefined>} env
 */
export function buildConfigReport(env = {}) {
  const entries = OPTIONAL_ENV_VARS.map((spec) => {
    const raw = env[spec.name];
    const blank = isBlank(raw);
    const value = blank ? null : String(raw);
    let status = 'set';
    if (blank) status = 'unset';
    else if (spec.defaultValue !== null && value === spec.defaultValue) status = 'default';

    return {
      name: spec.name,
      status,
      value,
      defaultValue: spec.defaultValue,
      effect: spec.effect,
      unsetNote: spec.unsetNote
        ?? (spec.defaultValue === null ? 'feature disabled' : `defaults to ${spec.defaultValue}`),
      secret: spec.secret === true,
    };
  });

  const namesWith = (status) => entries.filter((e) => e.status === status).map((e) => e.name);

  return {
    entries,
    set: namesWith('set'),
    defaulted: namesWith('default'),
    unset: namesWith('unset'),
  };
}

/**
 * Render a report as console lines. Secret values are never printed.
 * @param {ReturnType<typeof buildConfigReport>} report
 */
export function formatConfigReport(report) {
  const width = Math.max(...report.entries.map((e) => e.name.length));
  const lines = [
    `[config] optional environment: ${report.set.length} set, `
    + `${report.defaulted.length} at the documented default, ${report.unset.length} not set`,
  ];

  for (const entry of report.entries) {
    const name = entry.name.padEnd(width);
    if (entry.status === 'unset') {
      lines.push(`[config]   ${name}  not set — ${entry.unsetNote} (${entry.effect})`);
    } else {
      const shown = entry.secret ? '<set>' : entry.value;
      const suffix = entry.status === 'default' ? '  (same as the default)' : '';
      lines.push(`[config]   ${name}  = ${shown}${suffix}`);
    }
  }

  return lines;
}
