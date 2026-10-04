import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.ts';
import { pool, type DbOrTx } from '../db/client.ts';
import { vmMigrations, vmSchedules, users, vmAssignments } from '../db/schema/index.ts';
import { guestPresence } from '../proxmox.ts';
import { httpError } from './httpError.ts';
import { decodeNodeRef, nodeLookupCandidates } from './nodeRef.ts';

export async function lockVmMigration(database: DbOrTx, vmid: number, shared = false) {
  const result = await database.execute(shared
    ? sql`SELECT pg_try_advisory_xact_lock_shared(206, ${vmid}) AS locked`
    : sql`SELECT pg_try_advisory_xact_lock(206, ${vmid}) AS locked`);
  if (!(result as any).rows[0]?.locked) throw httpError(409, 'VM operation is busy; retry after it completes');
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

export type PolicyActor = { userId: number };

export async function withVmPolicyWrite<T>(node: unknown, vmid: number, write: (tx: DbOrTx, currentNode: string) => Promise<T>, actor?: PolicyActor) {
  return withVmMigrationLock(vmid, (database) => database.transaction(async (tx) => {
    const currentNode = await assertVmPolicyLocation(tx, node, vmid);
    if (actor) {
      const [user] = await tx.select({ is_admin: users.is_admin }).from(users).where(eq(users.id, actor.userId));
      const candidates = nodeLookupCandidates(currentNode);
      const [assignment] = candidates.length === 0 ? [] : await tx.select({ id: vmAssignments.id }).from(vmAssignments)
        .where(and(eq(vmAssignments.user_id, actor.userId), eq(vmAssignments.vmid, vmid), inArray(vmAssignments.node, candidates)));
      if (!user || (!user.is_admin && !assignment)) throw httpError(403, 'VM policy access has changed; reload before retrying');
      if (!await guestPresence(currentNode, vmid, tx)) throw httpError(404, 'VM no longer exists');
    }
    return write(tx, currentNode);
  }), true);
}

const admittedVms = new Map<number, { shared: boolean; count: number }>();
let admittedOperations = 0;

export async function withVmMigrationLock<T>(vmid: number, action: (database: DbOrTx) => Promise<T>, shared = false) {
  const admitted = admittedVms.get(vmid);
  if ((admitted && (!shared || !admitted.shared)) || admittedOperations >= pool.options.max - 1) {
    throw httpError(409, 'VM operation is busy; retry after it completes');
  }
  const state = admitted || { shared, count: 0 };
  state.count++;
  admittedVms.set(vmid, state);
  admittedOperations++;
  let connection;
  let locked = false;
  try {
    connection = await pool.connect();
    const result = await connection.query(shared
      ? 'SELECT pg_try_advisory_lock_shared(206, $1) AS locked'
      : 'SELECT pg_try_advisory_lock(206, $1) AS locked', [vmid]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw httpError(409, 'VM operation is busy; retry after it completes');
    return await action(drizzle(connection, { schema }));
  } finally {
    if (connection) {
      try {
        if (locked) await connection.query(shared ? 'SELECT pg_advisory_unlock_shared(206, $1)' : 'SELECT pg_advisory_unlock(206, $1)', [vmid]);
        connection.release();
      } catch (err) { connection.release(err as Error); }
    }
    state.count--;
    if (state.count === 0) admittedVms.delete(vmid);
    admittedOperations--;
  }
}

export async function withMigrationSafeSchedule<T>(schedule: typeof vmSchedules.$inferSelect, action: (tx: DbOrTx) => Promise<T>) {
  return withVmMigrationLock(schedule.vmid, async (database) => {
    if (await vmMigrationPending(database, schedule.vmid)) return;
    try {
      await assertVmPolicyLocation(database, schedule.node, schedule.vmid);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 409) return;
      throw err;
    }
    const [current] = await database.select().from(vmSchedules).where(eq(vmSchedules.id, schedule.id));
    if (!current || !current.enabled || current.node !== schedule.node || current.vmid !== schedule.vmid
      || current.stop_time !== schedule.stop_time || current.start_time !== schedule.start_time
      || current.days !== schedule.days || current.timezone !== schedule.timezone
      || current.skip_until !== schedule.skip_until
      || current.last_off !== schedule.last_off || current.running_due_to_manual !== schedule.running_due_to_manual
      || current.stopped_this_window !== schedule.stopped_this_window
      || current.updated_at?.getTime() !== schedule.updated_at?.getTime()) return;
    return await action(database);
  }, true);
}

export async function vmMigrationPending(database: DbOrTx, vmid: number) {
  const [migration] = await database.select({ id: vmMigrations.id }).from(vmMigrations)
    .where(and(eq(vmMigrations.vmid, vmid), inArray(vmMigrations.status, ['running', 'needs_review'])))
    .limit(1);
  return Boolean(migration);
}
