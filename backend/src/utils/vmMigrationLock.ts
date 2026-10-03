import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.ts';
import { db, pool, type DbOrTx } from '../db/client.ts';
import { vmMigrations, vmSchedules } from '../db/schema/index.ts';
import { httpError } from './httpError.ts';
import { decodeNodeRef, nodeLookupCandidates } from './nodeRef.ts';

export async function lockVmMigration(database: DbOrTx, vmid: number, shared = false) {
  await database.execute(shared
    ? sql`SELECT pg_advisory_xact_lock_shared(206, ${vmid})`
    : sql`SELECT pg_advisory_xact_lock(206, ${vmid})`);
}

export async function assertVmPolicyLocation(database: DbOrTx, node: unknown, vmid: number) {
  const [migration] = await database.select().from(vmMigrations)
    .where(and(eq(vmMigrations.vmid, vmid), inArray(vmMigrations.status, ['running', 'needs_review', 'ok'])))
    .orderBy(desc(vmMigrations.id)).limit(1);
  if (!migration) return String(node);
  if (['running', 'needs_review'].includes(migration.status || '')) {
    throw httpError(409, 'VM migration is awaiting completion or review; retry the policy change afterwards');
  }
  const requested = decodeNodeRef(node);
  const ambiguousBare = requested.hostId === null
    && migration.source_node !== migration.target_node
    && nodeLookupCandidates(migration.source_node).includes(requested.nodeRef);
  if (migration.status === 'ok' && (ambiguousBare || !nodeLookupCandidates(migration.target_node).includes(requested.nodeRef))) {
    throw httpError(409, 'VM has migrated; reload the VM at its current location before changing its policy');
  }
  return migration.target_node;
}

export async function withVmPolicyWrite<T>(node: unknown, vmid: number, write: (tx: DbOrTx, currentNode: string) => Promise<T>) {
  return db.transaction(async (tx) => {
    await lockVmMigration(tx, vmid, true);
    const currentNode = await assertVmPolicyLocation(tx, node, vmid);
    return write(tx, currentNode);
  });
}

export async function withMigrationSafeSchedule<T>(schedule: typeof vmSchedules.$inferSelect, action: (tx: DbOrTx) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('SELECT pg_advisory_lock_shared(206, $1)', [schedule.vmid]);
    const database = drizzle(connection, { schema });
    if (await vmMigrationPending(database, schedule.vmid)) return;
    const [current] = await database.select().from(vmSchedules).where(eq(vmSchedules.id, schedule.id));
    if (!current || !current.enabled || current.node !== schedule.node || current.vmid !== schedule.vmid
      || current.stop_time !== schedule.stop_time || current.start_time !== schedule.start_time
      || current.days !== schedule.days || current.timezone !== schedule.timezone
      || current.skip_until !== schedule.skip_until
      || current.last_off !== schedule.last_off || current.running_due_to_manual !== schedule.running_due_to_manual
      || current.stopped_this_window !== schedule.stopped_this_window
      || current.updated_at?.getTime() !== schedule.updated_at?.getTime()) return;
    return await action(database);
  } finally {
    try {
      await connection.query('SELECT pg_advisory_unlock_shared(206, $1)', [schedule.vmid]);
      connection.release();
    } catch (err) {
      connection.release(err as Error);
    }
  }
}

export async function vmMigrationPending(database: DbOrTx, vmid: number) {
  const [migration] = await database.select({ id: vmMigrations.id }).from(vmMigrations)
    .where(and(eq(vmMigrations.vmid, vmid), inArray(vmMigrations.status, ['running', 'needs_review'])))
    .limit(1);
  return Boolean(migration);
}
