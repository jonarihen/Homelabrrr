// One-shot SQLite → PostgreSQL data import for the better-sqlite3 → Drizzle
// migration. Copies every application table from an old db.sqlite into a
// freshly migrated PostgreSQL database, transforming per column (0/1 → boolean,
// SQLite UTC text → timestamptz, JSON text → jsonb, BLOB → bytea) and refusing
// to guess whenever a value cannot be converted losslessly.
//
//   npm run import-sqlite -- --source /old/db.sqlite --target postgres://user:pw@host/db
//
// Flags:
//   --force             allow a non-empty target (counts are still verified)
//   --include-sessions  also copy the ephemeral `sessions` table
//   --null-orphans      NULL out references that PostgreSQL's new FKs reject
//
// The whole copy runs on one connection inside one transaction: any error —
// including a verification mismatch — rolls everything back.
//
// Reads the SQLite source through Node's built-in node:sqlite (zero extra
// dependencies), so it runs anywhere the backend runs — including inside the
// production image, which is what lets initDatabase() auto-import on first boot.

import { pathToFileURL } from 'node:url';
import { openSqliteReadonly, type SqliteReader } from './sqliteReader.ts';
import pg from 'pg';
import { is, getTableName } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema/index.ts';
import { runMigrations } from '../db/migrate.ts';

const BATCH_SIZE = 500;
const ENC_PREFIX_RE = /^enc:v(1|2):/;
// SQLite's datetime('now') form; always UTC. ISO-8601 strings (some rows carry
// them) fall through to plain Date parsing.
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

// The 8 app-encrypted columns copy byte-for-byte. A value that lost its enc:
// prefix would be silently re-encrypted at next boot and garbled forever, so a
// non-empty value without the prefix always aborts (--force does not override).
const ENCRYPTED_COLUMN_LIST: ReadonlyArray<readonly [string, string]> = [
  ['ssh_keys', 'private_key'],
  ['pve_hosts', 'token_secret'],
  ['pve_hosts', 'ssh_secret'],
  ['users', 'totp_secret'],
  ['firewalls', 'api_key'],
  ['notification_webhooks', 'url'],
  ['caddy_servers', 'auth_secret'],
  ['caddy_servers', 'ssh_secret'],
];

// Foreign keys that exist only in PostgreSQL — SQLite data may violate them
// (the old schema declared none of these), so they are pre-scanned. All of
// them reference an `id` column and all are nullable.
const NEW_FOREIGN_KEYS: ReadonlyArray<{ table: string; column: string; refTable: string }> = [
  { table: 'users', column: 'role_id', refTable: 'roles' },
  { table: 'node_maintenance', column: 'notice_id', refTable: 'portal_notices' },
  { table: 'provisioned_vms', column: 'cloud_image_id', refTable: 'cloud_images' },
  { table: 'firewall_vlan_sync', column: 'workflow_run_id', refTable: 'workflow_runs' },
  { table: 'managed_vips', column: 'workflow_run_id', refTable: 'workflow_runs' },
];

type ColumnKind = 'boolean' | 'timestamp' | 'jsonb' | 'bytea' | 'encrypted' | 'passthrough';

interface ColumnMeta {
  name: string;
  kind: ColumnKind;
  notNull: boolean;
  // Plain (non-SQL) default of a NOT NULL jsonb column, used when the source
  // value is empty — e.g. webauthn_credentials.transports '' → [].
  jsonbDefault?: unknown;
}

interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  identityColumn: string | null;
  dependsOn: string[];
}

interface OrphanScan {
  rowCount: number;
  missing: Set<unknown>;
}

export interface ImportOptions {
  source: string;
  target: string;
  force?: boolean;
  includeSessions?: boolean;
  nullOrphans?: boolean;
  log?: (line: string) => void;
}

export interface ImportResult {
  copied: Record<string, number>;
  skipped: Record<string, string>;
  orphanRefsNulled: number;
}

function isPlainJsonDefault(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

// The per-table transform map is derived from the Drizzle schema itself: the
// target column type decides the conversion. vm_schedules.last_off / .days are
// smallint there (not boolean), so the numeric exceptions fall out for free;
// the epoch columns are bigint and pass through as numbers the same way.
function buildTableMetas(): Map<string, TableMeta> {
  const encryptedByTable = new Map<string, Set<string>>();
  for (const [table, column] of ENCRYPTED_COLUMN_LIST) {
    const set = encryptedByTable.get(table) ?? new Set<string>();
    set.add(column);
    encryptedByTable.set(table, set);
  }

  const metas = new Map<string, TableMeta>();
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const cfg = getTableConfig(exported);
    const encrypted = encryptedByTable.get(cfg.name) ?? new Set<string>();
    const columns: ColumnMeta[] = cfg.columns.map((col) => {
      let kind: ColumnKind = 'passthrough';
      if (encrypted.has(col.name)) kind = 'encrypted';
      else if (col.columnType === 'PgBoolean') kind = 'boolean';
      else if (col.columnType === 'PgTimestamp') kind = 'timestamp';
      else if (col.columnType === 'PgJsonb') kind = 'jsonb';
      else if (col.columnType === 'PgCustomColumn') kind = 'bytea'; // only webauthn_credentials.public_key
      const meta: ColumnMeta = { name: col.name, kind, notNull: col.notNull };
      if (kind === 'jsonb' && isPlainJsonDefault(col.default)) meta.jsonbDefault = col.default;
      return meta;
    });
    const dependsOn = [...new Set(
      cfg.foreignKeys
        .map((fk) => getTableName(fk.reference().foreignTable))
        .filter((name) => name !== cfg.name)
    )];
    const identityColumn = cfg.columns.find((col) => col.generatedIdentity)?.name ?? null;
    metas.set(cfg.name, { name: cfg.name, columns, identityColumn, dependsOn });
  }
  return metas;
}

// FK-safe copy order (Kahn's algorithm over the Drizzle FK graph, alphabetical
// within each layer for determinism).
function topologicalOrder(metas: Map<string, TableMeta>): string[] {
  const names = [...metas.keys()].sort();
  const remaining = new Set(names);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = names.filter((name) => {
      if (!remaining.has(name)) return false;
      const meta = metas.get(name);
      return (meta?.dependsOn ?? []).every((dep) => !remaining.has(dep));
    });
    if (ready.length === 0) throw new Error('Cycle in the schema foreign-key graph — cannot derive a copy order');
    for (const name of ready) {
      remaining.delete(name);
      order.push(name);
    }
  }
  return order;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqliteTableNames(src: SqliteReader): Set<string> {
  const rows = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqliteColumnNames(src: SqliteReader, table: string): Set<string> {
  const rows = src.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqliteCount(src: SqliteReader, table: string): number {
  const row = src.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
  return Number(row.n);
}

async function pgCount(client: pg.PoolClient, table: string): Promise<number> {
  const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  return Number(rows[0].n);
}

// ─── Orphan pre-scan ─────────────────────────────────────────────────────────

function scanOrphans(
  src: SqliteReader,
  sourceTables: Set<string>,
  log: (line: string) => void
): Map<string, OrphanScan> {
  const results = new Map<string, OrphanScan>();
  log('Orphan pre-scan (foreign keys new in PostgreSQL):');
  for (const check of NEW_FOREIGN_KEYS) {
    const label = `${check.table}.${check.column} -> ${check.refTable}.id`;
    if (!sourceTables.has(check.table) || !sqliteColumnNames(src, check.table).has(check.column)) {
      log(`  ${label}: source table/column absent — nothing to check`);
      continue;
    }
    const t = quoteIdent(check.table);
    const col = quoteIdent(check.column);
    // A source missing the referenced table entirely means every non-NULL
    // reference is dangling.
    const orphanWhere = sourceTables.has(check.refTable)
      ? `${col} IS NOT NULL AND ${col} NOT IN (SELECT "id" FROM ${quoteIdent(check.refTable)})`
      : `${col} IS NOT NULL`;
    const missingRows = src.prepare(`SELECT DISTINCT ${col} AS v FROM ${t} WHERE ${orphanWhere}`).all() as Array<{ v: unknown }>;
    const rowCount = Number((src.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${orphanWhere}`).get() as { n: number }).n);
    if (rowCount === 0) {
      log(`  ${label}: ok`);
      continue;
    }
    const missing = new Set(missingRows.map((row) => row.v));
    const sample = [...missing].slice(0, 10).join(', ');
    log(`  ${label}: ${rowCount} row(s) referencing ${missing.size} missing id(s) [${sample}${missing.size > 10 ? ', …' : ''}]`);
    results.set(`${check.table}.${check.column}`, { rowCount, missing });
  }
  return results;
}

// ─── Per-value transforms ────────────────────────────────────────────────────

function transformValue(table: string, column: ColumnMeta, raw: unknown, rowRef: () => string): unknown {
  const fail = (reason: string): never => {
    throw new Error(`${table} ${rowRef()} column ${column.name}: ${reason}`);
  };
  if (column.kind === 'passthrough') return raw;

  if (column.kind === 'boolean') {
    if (raw === null) return null;
    if (typeof raw === 'number') return raw !== 0;
    return fail(`expected a 0/1 integer flag, got ${JSON.stringify(raw)}`);
  }

  if (column.kind === 'timestamp') {
    if (raw === null) return null;
    if (typeof raw !== 'string') return fail(`expected a timestamp string, got ${JSON.stringify(raw)}`);
    if (raw === '') return null; // '' is a sentinel (e.g. caddy_sites.probe_at)
    const parsed = SQLITE_UTC_RE.test(raw) ? new Date(raw.replace(' ', 'T') + 'Z') : new Date(raw);
    if (Number.isNaN(parsed.getTime())) return fail(`unparseable timestamp ${JSON.stringify(raw)}`);
    return parsed;
  }

  if (column.kind === 'jsonb') {
    if (raw === null || raw === '') {
      if (!column.notNull) return null;
      if (column.jsonbDefault !== undefined) return JSON.stringify(column.jsonbDefault);
      return fail('empty value in a NOT NULL jsonb column with no default');
    }
    if (typeof raw !== 'string') return fail(`expected JSON text, got ${JSON.stringify(raw)}`);
    try {
      JSON.parse(raw);
    } catch {
      // Lossless means refusing to guess: a non-empty value that is not valid
      // JSON cannot be imported as jsonb.
      return fail(`invalid JSON ${JSON.stringify(raw.slice(0, 80))}${raw.length > 80 ? '…' : ''}`);
    }
    return raw; // PostgreSQL parses the text as jsonb input
  }

  if (column.kind === 'encrypted') {
    if (raw === null) return null;
    if (typeof raw !== 'string') return fail(`expected an encrypted string, got ${JSON.stringify(raw)}`);
    if (raw !== '' && !ENC_PREFIX_RE.test(raw)) {
      return fail(
        `expected an enc:v1:/enc:v2: prefixed secret, got ${JSON.stringify(raw.slice(0, 24))}… — a secret without ` +
        'its prefix would be re-encrypted (and garbled forever) at next boot; refusing to import it'
      );
    }
    return raw;
  }

  // bytea — node:sqlite yields BLOBs as Uint8Array; pg wants a Buffer.
  if (raw === null) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return fail(`expected a BLOB, got ${JSON.stringify(raw)}`);
}

// ─── Copy ────────────────────────────────────────────────────────────────────

async function insertBatch(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  const columnList = columns.map(quoteIdent).join(', ');
  const tuples = rows
    .map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`)
    .join(', ');
  await client.query(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES ${tuples}`, rows.flat());
}

async function copyTable(
  client: pg.PoolClient,
  src: SqliteReader,
  meta: TableMeta,
  orphanSets: Map<string, OrphanScan>,
  log: (line: string) => void
): Promise<{ rows: number; orphanRefsNulled: number }> {
  const sourceColumns = sqliteColumnNames(src, meta.name);
  const copyColumns = meta.columns.filter((column) => sourceColumns.has(column.name));
  const extras = [...sourceColumns].filter((name) => !meta.columns.some((column) => column.name === name));
  if (extras.length > 0) {
    log(`  note: ${meta.name}: source column(s) not in the PostgreSQL schema, not copied: ${extras.join(', ')}`);
  }
  const columnNames = copyColumns.map((column) => column.name);
  const orphanByColumn = new Map<string, Set<unknown>>();
  for (const column of copyColumns) {
    const scan = orphanSets.get(`${meta.name}.${column.name}`);
    if (scan) orphanByColumn.set(column.name, scan.missing);
  }

  let copied = 0;
  let orphanRefsNulled = 0;
  let batch: unknown[][] = [];
  const rows = src.prepare(`SELECT * FROM ${quoteIdent(meta.name)}`).iterate() as IterableIterator<Record<string, unknown>>;
  for (const row of rows) {
    const rowRef = () => {
      const id = row.id ?? row.sid ?? row.key;
      return id === undefined || id === null ? `row ${copied + batch.length + 1}` : `id=${String(id)}`;
    };
    batch.push(copyColumns.map((column) => {
      const missing = orphanByColumn.get(column.name);
      if (missing !== undefined && row[column.name] !== null && missing.has(row[column.name])) {
        orphanRefsNulled += 1;
        return null;
      }
      return transformValue(meta.name, column, row[column.name], rowRef);
    }));
    if (batch.length === BATCH_SIZE) {
      await insertBatch(client, meta.name, columnNames, batch);
      copied += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(client, meta.name, columnNames, batch);
    copied += batch.length;
  }
  return { rows: copied, orphanRefsNulled };
}

// After explicit-id inserts every identity sequence must be moved past the
// imported MAX(id), or the first app INSERT would collide.
async function resetSequences(client: pg.PoolClient, metas: Map<string, TableMeta>, order: string[]): Promise<void> {
  for (const name of order) {
    const identityColumn = metas.get(name)?.identityColumn;
    if (!identityColumn) continue;
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quoteIdent(identityColumn)}) FROM ${quoteIdent(name)}), 0) + 1, false)`,
      [name, identityColumn]
    );
  }
}

// ─── Verification ────────────────────────────────────────────────────────────

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

async function verifyImport(
  client: pg.PoolClient,
  src: SqliteReader,
  sourceTables: Set<string>,
  order: string[],
  skipped: Record<string, string>,
  log: (line: string) => void
): Promise<string[]> {
  const mismatches: string[] = [];
  const countRows: string[][] = [];
  for (const name of order) {
    if (name === 'schema_migrations') continue;
    const pgN = await pgCount(client, name);
    if (name in skipped) {
      const sqliteN = sourceTables.has(name) ? String(sqliteCount(src, name)) : '—';
      countRows.push([name, sqliteN, String(pgN), `skipped (${skipped[name]})`]);
      continue;
    }
    const sqliteN = sqliteCount(src, name);
    const ok = sqliteN === pgN;
    countRows.push([name, String(sqliteN), String(pgN), ok ? 'ok' : 'MISMATCH']);
    if (!ok) mismatches.push(`${name}: ${sqliteN} rows in SQLite but ${pgN} in PostgreSQL`);
  }
  log('');
  log('Verification — row counts:');
  for (const line of renderTable(['table', 'sqlite', 'postgres', 'status'], countRows)) log(`  ${line}`);

  const encRows: string[][] = [];
  for (const [table, column] of ENCRYPTED_COLUMN_LIST) {
    const where = `${quoteIdent(column)} LIKE 'enc:%'`;
    const sqliteN = sourceTables.has(table)
      ? Number((src.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${where}`).get() as { n: number }).n)
      : 0;
    const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${where}`);
    const pgN = Number(rows[0].n);
    const ok = sqliteN === pgN;
    encRows.push([`${table}.${column}`, String(sqliteN), String(pgN), ok ? 'ok' : 'MISMATCH']);
    if (!ok) mismatches.push(`${table}.${column}: ${sqliteN} enc:-prefixed values in SQLite but ${pgN} in PostgreSQL`);
  }
  log('');
  log('Verification — encrypted values (enc: prefix):');
  for (const line of renderTable(['column', 'sqlite', 'postgres', 'status'], encRows)) log(`  ${line}`);

  const spotRows: string[][] = [];
  const spot = (label: string, sqliteV: number | null, pgV: number | null) => {
    const ok = sqliteV === pgV;
    const show = (v: number | null) => (v === null ? '—' : String(v));
    spotRows.push([label, show(sqliteV), show(pgV), ok ? 'ok' : 'MISMATCH']);
    if (!ok) mismatches.push(`${label}: ${show(sqliteV)} in SQLite but ${show(pgV)} in PostgreSQL`);
  };
  const bcryptWhere = `"password" LIKE '$2%'`;
  const sqliteBcrypt = sourceTables.has('users')
    ? Number((src.prepare(`SELECT COUNT(*) AS n FROM "users" WHERE ${bcryptWhere}`).get() as { n: number }).n)
    : 0;
  const pgBcrypt = Number((await client.query(`SELECT COUNT(*) AS n FROM "users" WHERE ${bcryptWhere}`)).rows[0].n);
  spot('users.password bcrypt ($2)', sqliteBcrypt, pgBcrypt);
  const sqliteAudit = sourceTables.has('audit_log')
    ? (src.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM "audit_log"').get() as { lo: number | null; hi: number | null })
    : { lo: null, hi: null };
  const pgAudit = (await client.query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM "audit_log"')).rows[0];
  spot('audit_log MIN(id)', sqliteAudit.lo === null ? null : Number(sqliteAudit.lo), pgAudit.lo === null ? null : Number(pgAudit.lo));
  spot('audit_log MAX(id)', sqliteAudit.hi === null ? null : Number(sqliteAudit.hi), pgAudit.hi === null ? null : Number(pgAudit.hi));
  log('');
  log('Verification — spot checks:');
  for (const line of renderTable(['check', 'sqlite', 'postgres', 'status'], spotRows)) log(`  ${line}`);

  return mismatches;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function importDatabase(options: ImportOptions): Promise<ImportResult> {
  const log = options.log ?? ((line: string) => { console.log(line); });
  const metas = buildTableMetas();
  const order = topologicalOrder(metas);

  const src = openSqliteReadonly(options.source);
  const pool = new pg.Pool({ connectionString: options.target, max: 1 });
  try {
    // 1. Source integrity gate.
    const integrity = src.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Source database failed PRAGMA quick_check: ${String(integrity)}`);

    // 2. Bring the target schema up to date, then insist it is empty.
    await runMigrations(pool);
    const sourceTables = sqliteTableNames(src);
    const unknownTables = [...sourceTables]
      .filter((name) => !metas.has(name) && !name.startsWith('sqlite_'))
      .sort();
    if (unknownTables.length > 0) {
      log(`note: source table(s) with no PostgreSQL counterpart, not copied: ${unknownTables.join(', ')}`);
    }

    const client = await pool.connect();
    try {
      const nonEmpty: string[] = [];
      for (const name of order) {
        if (name === 'schema_migrations') continue; // owned by the migration runner
        const n = await pgCount(client, name);
        if (n > 0) nonEmpty.push(`  ${name}: ${n}`);
      }
      if (nonEmpty.length > 0) {
        if (!options.force) {
          throw new Error(`Target database is not empty — refusing to import (use --force to override):\n${nonEmpty.join('\n')}`);
        }
        log(`--force: continuing into a non-empty target:\n${nonEmpty.join('\n')}`);
      }

      // 3. Orphan pre-scan for the FKs that are new in PostgreSQL.
      const orphanSets = scanOrphans(src, sourceTables, log);
      const totalOrphans = [...orphanSets.values()].reduce((sum, scan) => sum + scan.rowCount, 0);
      if (totalOrphans > 0 && !options.nullOrphans) {
        throw new Error(
          `${totalOrphans} row(s) carry orphaned references that PostgreSQL's new foreign keys reject — ` +
          'rerun with --null-orphans to import them with those references set to NULL.'
        );
      }

      // 4-8. Copy, sequence reset and verification in ONE transaction.
      await client.query('BEGIN');
      try {
        const copied: Record<string, number> = {};
        const skipped: Record<string, string> = {};
        let orphanRefsNulled = 0;
        log('');
        log('Copying tables in FK-safe order:');
        for (const name of order) {
          if (name === 'schema_migrations') {
            skipped[name] = 'owned by the migration runner';
            continue;
          }
          if (name === 'sessions' && !options.includeSessions) {
            skipped[name] = 'sessions are 24h-ephemeral; use --include-sessions to copy them';
            log(`  ${name}: skipped (${skipped[name]})`);
            continue;
          }
          if (!sourceTables.has(name)) {
            skipped[name] = 'not present in the source database (older install)';
            log(`  ${name}: skipped (${skipped[name]})`);
            continue;
          }
          const meta = metas.get(name);
          if (!meta) continue;
          const outcome = await copyTable(client, src, meta, orphanSets, log);
          copied[name] = outcome.rows;
          orphanRefsNulled += outcome.orphanRefsNulled;
          log(`  ${name}: ${outcome.rows} row(s)${outcome.orphanRefsNulled > 0 ? ` (${outcome.orphanRefsNulled} orphaned reference(s) set to NULL)` : ''}`);
        }

        // 7. Move every identity sequence past the imported ids.
        await resetSequences(client, metas, order);

        // 8. Verify inside the same transaction; any mismatch rolls back.
        const mismatches = await verifyImport(client, src, sourceTables, order, skipped, log);
        if (mismatches.length > 0) {
          throw new Error(`Verification failed — rolling back:\n${mismatches.map((m) => `  ${m}`).join('\n')}`);
        }

        await client.query('COMMIT');
        const totalRows = Object.values(copied).reduce((sum, n) => sum + n, 0);
        log('');
        log(`Import complete: ${Object.keys(copied).length} table(s), ${totalRows} row(s), ${orphanRefsNulled} orphaned reference(s) set to NULL.`);
        return { copied, skipped, orphanRefsNulled };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  } finally {
    src.close();
    await pool.end();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: npm run import-sqlite -- --source /old/db.sqlite --target postgres://... [--force] [--include-sessions] [--null-orphans]';

function parseCliArgs(argv: string[]): ImportOptions {
  let source: string | undefined;
  let target: string | undefined;
  let force = false;
  let includeSessions = false;
  let nullOrphans = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source':
        i += 1;
        source = argv[i];
        break;
      case '--target':
        i += 1;
        target = argv[i];
        break;
      case '--force':
        force = true;
        break;
      case '--include-sessions':
        includeSessions = true;
        break;
      case '--null-orphans':
        nullOrphans = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (!source || !target) throw new Error(`--source and --target are required.\n${USAGE}`);
  return { source, target, force, includeSessions, nullOrphans };
}

// Only run the CLI when executed directly — importing this module from the
// test must not trigger it.
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  try {
    await importDatabase(parseCliArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
