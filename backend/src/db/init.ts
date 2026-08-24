import bcrypt from 'bcryptjs';
import { existsSync } from 'node:fs';
import { and, eq, count, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx } from './client.ts';
import { runMigrations } from './migrate.ts';
import { setSetting, getSetting } from './settings.ts';
import { importDatabase } from '../scripts/importSqlite.ts';
import {
  users, roles, rolePermissions, sshKeys, pveHosts, firewalls,
  notificationWebhooks, caddyServers, provisionedVms, vmMigrations, isos,
} from './schema/index.ts';
import {
  assertSecretEncryptionKey, decryptSecret, encryptSecret, isEncryptedSecret, secretNeedsMigration,
} from '../utils/secrets.ts';
import { PERMISSION_KEYS } from '../utils/permissionKeys.ts';
import { validatePassword, validateUsername } from '../utils/validation.ts';
import { log } from '../utils/logger.ts';

// Explicit startup bootstrap — the PostgreSQL replacement for the import-time
// side effects the old SQLite layer (now src/scripts/legacySqliteDb.ts)
// performed. index.ts awaits initDatabase() before wiring any middleware;
// nothing else may touch the pool earlier.

// The registry of encrypted-at-rest columns. Values carry the enc:v2:<kid>:
// envelope from utils/secrets.ts and are copied byte-for-byte by the SQLite
// import tool — a value that loses its prefix would be re-encrypted here and
// garbled forever, which is why rotation inspects before it writes.
const ENCRYPTED_COLUMNS = [
  { label: 'ssh_keys.private_key', table: sshKeys, id: sshKeys.id, column: sshKeys.private_key, key: 'private_key' as const },
  { label: 'pve_hosts.token_secret', table: pveHosts, id: pveHosts.id, column: pveHosts.token_secret, key: 'token_secret' as const },
  { label: 'pve_hosts.ssh_secret', table: pveHosts, id: pveHosts.id, column: pveHosts.ssh_secret, key: 'ssh_secret' as const },
  { label: 'users.totp_secret', table: users, id: users.id, column: users.totp_secret, key: 'totp_secret' as const },
  { label: 'firewalls.api_key', table: firewalls, id: firewalls.id, column: firewalls.api_key, key: 'api_key' as const },
  { label: 'notification_webhooks.url', table: notificationWebhooks, id: notificationWebhooks.id, column: notificationWebhooks.url, key: 'url' as const },
  { label: 'caddy_servers.auth_secret', table: caddyServers, id: caddyServers.id, column: caddyServers.auth_secret, key: 'auth_secret' as const },
  { label: 'caddy_servers.ssh_secret', table: caddyServers, id: caddyServers.id, column: caddyServers.ssh_secret, key: 'ssh_secret' as const },
];

type EncryptedColumn = (typeof ENCRYPTED_COLUMNS)[number];

async function migrateEncryptedColumn(
  tx: DbOrTx,
  entry: EncryptedColumn,
  shouldMigrate: (value: string) => boolean = secretNeedsMigration,
): Promise<number> {
  const rows = await tx
    .select({ id: entry.id, value: entry.column })
    .from(entry.table)
    .where(and(isNotNull(entry.column), ne(entry.column, '')));
  let migrated = 0;
  for (const row of rows) {
    const value = row.value as string;
    if (!shouldMigrate(value)) continue;
    const plaintext = isEncryptedSecret(value) ? decryptSecret(value) : value;
    await tx.update(entry.table).set({ [entry.key]: encryptSecret(plaintext) }).where(eq(entry.id, row.id));
    migrated += 1;
  }
  return migrated;
}

export async function planEncryptedSecretRotation() {
  const plan = { total: 0, decryptable: 0, undecryptable: 0, columns: {} as Record<string, number> };
  for (const entry of ENCRYPTED_COLUMNS) {
    const rows = await db
      .select({ id: entry.id, value: entry.column })
      .from(entry.table)
      .where(and(isNotNull(entry.column), ne(entry.column, '')));
    let columnCount = 0;
    for (const row of rows) {
      const value = row.value as string;
      if (!secretNeedsMigration(value)) continue;
      columnCount += 1;
      plan.total += 1;
      try {
        if (isEncryptedSecret(value)) decryptSecret(value);
        plan.decryptable += 1;
      } catch {
        plan.undecryptable += 1;
      }
    }
    plan.columns[entry.label] = columnCount;
  }
  return plan;
}

export async function rotateEncryptedSecrets(): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const counts: Record<string, number> = {};
    for (const entry of ENCRYPTED_COLUMNS) {
      counts[entry.label] = await migrateEncryptedColumn(tx, entry);
    }
    await setSetting('secret_rotation_last', JSON.stringify({ at: new Date().toISOString(), counts }), tx);
    return counts;
  });
}

// Automatic startup work is deliberately narrower than an operator-requested
// key rotation. It adopts plaintext and legacy v1 envelopes, but leaves v2
// values encrypted by a previous key ID visible in the dry-run plan until an
// administrator has verified the backup/keyring and explicitly rotates them.
async function migrateLegacySecrets(): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const counts: Record<string, number> = {};
    const isLegacy = (value: string) => !isEncryptedSecret(value) || String(value).startsWith('enc:v1:');
    for (const entry of ENCRYPTED_COLUMNS) {
      counts[entry.label] = await migrateEncryptedColumn(tx, entry, isLegacy);
    }
    const pveTlsMigrationKey = 'pve_verify_tls_secure_default_v1';
    if (!(await getSetting(pveTlsMigrationKey, tx))) {
      await tx.update(pveHosts)
        .set({ verify_tls: true })
        .where(and(eq(pveHosts.verify_tls, false), sql`${pveHosts.created_at} < '2026-03-12'`));
      await setSetting(pveTlsMigrationKey, '1', tx);
    }
    return counts;
  });
}

// Seed the built-in roles once (empty table = fresh database — an imported
// SQLite database arrives with its roles and skips this).
// "Administrator" grants every portal permission (it does NOT make the account
// an admin — is_admin stays a separate flag); "User" is the no-extra-perms base.
async function seedBuiltInRoles(): Promise<void> {
  const [{ c }] = await db.select({ c: count() }).from(roles);
  if (c !== 0) return;
  await db.transaction(async (tx) => {
    const [adminRole] = await tx.insert(roles)
      .values({ name: 'Administrator', description: 'Every portal permission (does not grant admin account status)', built_in: true })
      .returning({ id: roles.id });
    await tx.insert(rolePermissions).values(PERMISSION_KEYS.map((key: string) => ({ role_id: adminRole.id, permission: key })));
    await tx.insert(roles).values({ name: 'User', description: 'Basic access — no extra permissions', built_in: true });
  });
}

// In-process monitors may be interrupted while their upstream Proxmox task
// continues. Move every such row into the reconciliation queue on startup.
// Rows without a saved UPID cannot be polled, but are still ambiguous, so they
// require explicit operator verification instead of being called failed.
async function reconcileInterruptedOperations(): Promise<void> {
  await db.update(provisionedVms)
    .set({
      status: 'needs_review',
      status_detail: sql`CASE WHEN TRIM(COALESCE(${provisionedVms.upid}, '')) != '' THEN 'Portal monitoring was interrupted by a restart — reconcile the saved Proxmox task from Admin → Operations' ELSE 'Provisioning was interrupted without a saved upstream task identifier — verify the VM manually in Admin → Operations' END`,
    })
    .where(inArray(provisionedVms.status, ['cloning', 'creating', 'configuring']));
  await db.update(vmMigrations)
    .set({
      status: 'needs_review',
      status_detail: sql`CASE WHEN TRIM(COALESCE(${vmMigrations.upid}, '')) != '' THEN 'Portal orchestration was interrupted — reconcile the saved Proxmox task from Admin → Operations' ELSE 'Migration orchestration was interrupted without a saved upstream task identifier — verify both clusters manually in Admin → Operations' END`,
    })
    .where(eq(vmMigrations.status, 'running'));
  await db.update(isos)
    .set({ status: 'error', status_detail: 'Download was interrupted by a server restart — remove it and add it again' })
    .where(eq(isos.status, 'downloading'));
}

// Create the default admin on first run.
async function bootstrapInitialAdmin(): Promise<void> {
  const [{ c }] = await db.select({ c: count() }).from(users);
  if (c !== 0) return;
  const INITIAL_ADMIN_USERNAME = process.env.INITIAL_ADMIN_USERNAME || '';
  const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || '';
  if (!INITIAL_ADMIN_USERNAME || !INITIAL_ADMIN_PASSWORD) {
    throw new Error(
      'No users exist in the database. Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD to bootstrap the first admin account.'
    );
  }
  const initialUsername = validateUsername(INITIAL_ADMIN_USERNAME);
  const initialPassword = validatePassword(INITIAL_ADMIN_PASSWORD, 'INITIAL_ADMIN_PASSWORD');
  const hash = await bcrypt.hash(initialPassword, 10);
  await db.insert(users).values({ username: initialUsername, password: hash, is_admin: true });
  log('info', 'initial_admin_created', { username: initialUsername, source: 'environment' });
}

// One-time automatic SQLite -> PostgreSQL import. On the first boot of a fresh
// PostgreSQL database, if a legacy db.sqlite is present (the db_data volume the
// old build wrote to), copy it in so an existing install upgrades with a plain
// `docker compose up -d --build` — no manual import step. Guarded three ways: a
// settings flag so it never runs twice, an emptiness check so it never writes
// over existing data, and AUTO_IMPORT_SQLITE=false to opt out entirely. The
// operator must keep the same SECRET_ENCRYPTION_KEY across the cutover — the
// encrypted columns are copied verbatim.
const IMPORT_DONE_KEY = 'sqlite_auto_import';

async function maybeAutoImportSqlite(): Promise<void> {
  if (String(process.env.AUTO_IMPORT_SQLITE || 'auto').toLowerCase() === 'false') return;
  const source = process.env.DB_PATH || '/app/data/db.sqlite';
  if (!existsSync(source)) return;                       // nothing to import
  if (await getSetting(IMPORT_DONE_KEY)) return;         // already handled once

  // Never import over a database that already holds data (e.g. a manual import
  // already ran). Record the decision so the check is skipped next time.
  const [{ c: userCount }] = await db.select({ c: count() }).from(users);
  const [{ c: roleCount }] = await db.select({ c: count() }).from(roles);
  if (userCount > 0 || roleCount > 0) {
    await setSetting(IMPORT_DONE_KEY, JSON.stringify({ at: new Date().toISOString(), skipped: 'target not empty' }));
    return;
  }

  const target = process.env.DATABASE_URL as string;
  log('info', 'sqlite_auto_import_started', { source });
  const result = await importDatabase({
    source,
    target,
    nullOrphans: true,
    log: (line) => log('info', 'sqlite_auto_import', { line }),
  });
  const rows = Object.values(result.copied).reduce((sum, n) => sum + n, 0);
  await setSetting(IMPORT_DONE_KEY, JSON.stringify({
    at: new Date().toISOString(), source, rows, orphanRefsNulled: result.orphanRefsNulled,
  }));
  log('info', 'sqlite_auto_import_complete', {
    tables: Object.keys(result.copied).length, rows, orphanRefsNulled: result.orphanRefsNulled,
  });
}

export async function initDatabase(): Promise<void> {
  await runMigrations();
  assertSecretEncryptionKey();
  await maybeAutoImportSqlite();
  await seedBuiltInRoles();

  const migratedSecrets = await migrateLegacySecrets();
  const migratedSecretCount = Object.values(migratedSecrets).reduce((sum, n) => sum + n, 0);
  if (migratedSecretCount > 0) {
    log('info', 'legacy_secrets_encrypted', { count: migratedSecretCount });
    await setSetting('secret_encryption_migration_last', JSON.stringify({ at: new Date().toISOString(), counts: migratedSecrets }));
  }

  await reconcileInterruptedOperations();
  await bootstrapInitialAdmin();
}
