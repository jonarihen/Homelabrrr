import db from '../db.js';
import { getAllVMs } from '../proxmox.js';
import { httpError } from './httpError.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const quotaError = (message) => httpError(403, message);

/**
 * Allocated resources of every VM assigned to the user, summed from the
 * cluster resource list (maxcpu / maxmem / maxdisk). VMIDs are globally
 * unique across connected clusters, so matching by vmid is safe. Note:
 * maxdisk covers the boot disk for qemu guests — an approximation that
 * mirrors what the PVE UI itself reports. Hosts that can't be reached are
 * skipped by getAllVMs (their VMs simply don't count until they're back).
 */
export async function getUserResourceUsage(userId) {
  const vmids = new Set(
    db.prepare('SELECT vmid FROM vm_assignments WHERE user_id = ?').all(userId)
      .map((a) => Number(a.vmid))
  );
  const usage = { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 };
  if (vmids.size === 0) return usage;

  const vms = await getAllVMs();
  for (const vm of vms) {
    if (!vmids.has(Number(vm.vmid))) continue;
    usage.vmCount += 1;
    usage.cores += vm.maxcpu || 0;
    usage.memoryGb += (vm.maxmem || 0) / GB;
    usage.diskGb += (vm.maxdisk || 0) / GB;
  }
  usage.memoryGb = Math.round(usage.memoryGb * 10) / 10;
  usage.diskGb = Math.round(usage.diskGb * 10) / 10;
  return usage;
}

/**
 * The user's effective quota limits (null = unlimited), or null when the
 * user doesn't exist. Per metric: an explicit per-user value overrides the
 * role's default; otherwise the role's value applies (if any role is set).
 */
export function getUserQuota(userId) {
  const user = db.prepare(`
    SELECT u.is_admin, u.max_cores, u.max_memory_gb, u.max_storage_gb,
           r.max_cores AS role_max_cores, r.max_memory_gb AS role_max_memory_gb,
           r.max_storage_gb AS role_max_storage_gb
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.id = ?
  `).get(userId);
  if (!user) return null;
  return {
    isAdmin: user.is_admin === 1,
    maxCores: user.max_cores ?? user.role_max_cores,
    maxMemoryGb: user.max_memory_gb ?? user.role_max_memory_gb,
    maxStorageGb: user.max_storage_gb ?? user.role_max_storage_gb,
  };
}

/**
 * Throws a 403-tagged error (utils/httpError.js) when the requested additional
 * allocation would push the user over any of their quotas. Admins and users with no quotas
 * set pass straight through. Deltas are what the request ADDS on top of the
 * user's current allocation — pass only positive deltas for edits.
 */
export async function assertUserQuota(userId, { addCores = 0, addMemoryMb = 0, addDiskGb = 0 } = {}) {
  const quota = getUserQuota(userId);
  if (!quota || quota.isAdmin) return;
  if (quota.maxCores == null && quota.maxMemoryGb == null && quota.maxStorageGb == null) return;

  const usage = await getUserResourceUsage(userId);
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
export function sizeToGb(value) {
  const m = String(value ?? '').match(/^(\d+(?:\.\d+)?)([MGT])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'M') return n / 1024;
  if (unit === 'T') return n * 1024;
  return n;
}
