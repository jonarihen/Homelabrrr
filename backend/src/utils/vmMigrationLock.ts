import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { vmMigrations } from '../db/schema/index.ts';
import { httpError } from './httpError.ts';

export async function lockVmMigration(database: DbOrTx, vmid: number, shared = false) {
  await database.execute(shared
    ? sql`SELECT pg_advisory_xact_lock_shared(206, ${vmid})`
    : sql`SELECT pg_advisory_xact_lock(206, ${vmid})`);
}

export async function assertVmPolicyLocation(database: DbOrTx, node: unknown, vmid: number) {
  const [migration] = await database.select().from(vmMigrations)
    .where(and(eq(vmMigrations.vmid, vmid), inArray(vmMigrations.status, ['running', 'needs_review', 'ok'])))
    .orderBy(desc(vmMigrations.id)).limit(1);
  if (!migration) return;
  if (['running', 'needs_review'].includes(migration.status || '')) {
    throw httpError(409, 'VM migration is awaiting completion or review; retry the policy change afterwards');
  }
  if (migration.status === 'ok' && String(node) !== migration.target_node) {
    throw httpError(409, 'VM has migrated; reload the VM at its current location before changing its policy');
  }
}

export async function withVmPolicyWrite<T>(node: unknown, vmid: number, write: (tx: DbOrTx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await lockVmMigration(tx, vmid, true);
    await assertVmPolicyLocation(tx, node, vmid);
    return write(tx);
  });
}

export async function vmMigrationPending(database: DbOrTx, vmid: number) {
  const [migration] = await database.select({ id: vmMigrations.id }).from(vmMigrations)
    .where(and(eq(vmMigrations.vmid, vmid), inArray(vmMigrations.status, ['running', 'needs_review'])))
    .limit(1);
  return Boolean(migration);
}
