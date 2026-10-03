import { eq, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { users, roles, vmAssignments, provisionedVms } from '../db/schema/index.ts';
import { provisionAllocation } from './provisionIntent.ts';
import { getAllVMs } from '../proxmox.ts';
import { httpError } from './httpError.ts';

const GB = 1024 ** 3;

const quotaError = (message: string) => httpError(403, message);

export interface ResourceUsage {
  cores: number;
  memoryGb: number;
  diskGb: number;
  vmCount: number;
}

export interface UserQuota {
  isAdmin: boolean;
  maxCores: number | null;
  maxMemoryGb: number | null;
  maxStorageGb: number | null;
}

/**
 * Allocated resources of every VM assigned to the user, summed from the
 * cluster resource list (maxcpu / maxmem / maxdisk). VMIDs are globally
 * unique across connected clusters, so matching by vmid is safe. Note:
 * maxdisk covers the boot disk for qemu guests — an approximation that
 * mirrors what the PVE UI itself reports. Hosts that can't be reached are
 * skipped by getAllVMs (their VMs simply don't count until they're back).
 */
export async function getUserResourceUsage(userId: number, database: DbOrTx = db, liveVms?: any[]): Promise<ResourceUsage> {
  const assignments = await database.select({ vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.user_id, userId));
  const jobs = await database.select({ id: provisionedVms.id, vmid: provisionedVms.vmid, steps: provisionedVms.steps, status: provisionedVms.status })
    .from(provisionedVms).where(inArray(provisionedVms.status, ['submitting', 'creating', 'cloning', 'configuring', 'needs_review', 'timeout', 'ready', 'warning']));
  const vmids = new Set(assignments.map(a => Number(a.vmid)));
  const allocated = new Map<number, ResourceUsage>();
  const vms = vmids.size > 0 ? (liveVms ?? await getAllVMs()) : [];
  for (const vm of vms) {
    if (!vmids.has(Number(vm.vmid))) continue;
    allocated.set(Number(vm.vmid), {
      cores: vm.maxcpu || 0, memoryGb: (vm.maxmem || 0) / GB,
      diskGb: (vm.maxdisk || 0) / GB, vmCount: 1,
    });
  }
  for (const job of jobs) {
    const intent = provisionAllocation(job.steps);
    if (!intent || intent.userId !== userId || intent.state === 'released') continue;
    if (intent.state === 'owned' && !vmids.has(job.vmid)) continue;
    if (intent.state === 'owned' && allocated.has(job.vmid) && ['ready', 'warning'].includes(job.status!)
      && Date.now() - (intent.ownedAt ?? Date.now()) >= 5000) continue;
    const current = allocated.get(job.vmid);
    allocated.set(job.vmid || -job.id, {
      cores: Math.max(intent.cores, current?.cores || 0),
      memoryGb: Math.max(intent.memoryMb / 1024, current?.memoryGb || 0),
      diskGb: Math.max(intent.diskGb, current?.diskGb || 0), vmCount: 1,
    });
  }
  const usage: ResourceUsage = { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 };
  for (const resource of allocated.values()) {
    usage.cores += resource.cores;
    usage.memoryGb += resource.memoryGb;
    usage.diskGb += resource.diskGb;
    usage.vmCount += resource.vmCount;
  }
  return usage;
}

/**
 * The user's effective quota limits (null = unlimited), or null when the
 * user doesn't exist. Per metric: an explicit per-user value overrides the
 * role's default; otherwise the role's value applies (if any role is set).
 */
export async function getUserQuota(userId: number, database: DbOrTx = db): Promise<UserQuota | null> {
  const [user] = await database
    .select({
      is_admin: users.is_admin,
      max_cores: users.max_cores,
      max_memory_gb: users.max_memory_gb,
      max_storage_gb: users.max_storage_gb,
      role_max_cores: roles.max_cores,
      role_max_memory_gb: roles.max_memory_gb,
      role_max_storage_gb: roles.max_storage_gb,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return {
    isAdmin: !!user.is_admin,
    maxCores: user.max_cores ?? user.role_max_cores,
    maxMemoryGb: user.max_memory_gb ?? user.role_max_memory_gb,
    maxStorageGb: user.max_storage_gb ?? user.role_max_storage_gb,
  };
}

/**
 * Throws a 403-tagged error (utils/httpError.ts) when the requested additional
 * allocation would push the user over any of their quotas. Admins and users with no quotas
 * set pass straight through. Deltas are what the request ADDS on top of the
 * user's current allocation — pass only positive deltas for edits.
 */
export async function assertUserQuota(
  userId: number,
  { addCores = 0, addMemoryMb = 0, addDiskGb = 0 }: { addCores?: number; addMemoryMb?: number; addDiskGb?: number } = {},
  database: DbOrTx = db,
  liveVms?: any[],
): Promise<void> {
  const quota = await getUserQuota(userId, database);
  if (!quota || quota.isAdmin) return;
  if (quota.maxCores == null && quota.maxMemoryGb == null && quota.maxStorageGb == null) return;

  const usage = await getUserResourceUsage(userId, database, liveVms);
  const addMemoryGb = addMemoryMb / 1024;

  if (quota.maxCores != null && usage.cores + addCores > quota.maxCores) {
    throw quotaError(
      `CPU quota exceeded: ${usage.cores}/${quota.maxCores} cores allocated, request needs ${addCores} more`
    );
  }
  if (quota.maxMemoryGb != null && usage.memoryGb + addMemoryGb > quota.maxMemoryGb) {
    throw quotaError(
      `Memory quota exceeded: ${usage.memoryGb}/${quota.maxMemoryGb} GB allocated, request needs ${Math.round(addMemoryGb * 10) / 10} GB more`
    );
  }
  if (quota.maxStorageGb != null && usage.diskGb + addDiskGb > quota.maxStorageGb) {
    throw quotaError(
      `Storage quota exceeded: ${usage.diskGb}/${quota.maxStorageGb} GB allocated, request needs ${addDiskGb} GB more`
    );
  }
}

/** Parse a PVE disk size string ("32G", "512M", "1T") to GB. */
export function sizeToGb(value: unknown): number | null {
  const m = String(value ?? '').match(/^(\d+(?:\.\d+)?)([MGT])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'M') return n / 1024;
  if (unit === 'T') return n * 1024;
  return n;
}
