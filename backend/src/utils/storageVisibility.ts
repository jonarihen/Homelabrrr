import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { storageVisibility } from '../db/schema/index.ts';
import { getHostIdForNode } from '../proxmox.ts';
import { httpError } from './httpError.ts';

// Storage pool exposure control.
//
// Admins decide which Proxmox storage pools regular users may pick when creating
// VMs or editing disks. Exposure is stored per (pve_host_id, storage) in the
// storage_visibility table. A pool with NO row is treated as EXPOSED — this is
// the default-open behavior that keeps existing deployments unchanged until an
// admin explicitly hides a pool.
//
// Admins always see and can use every pool; the guards below no-op for them.

function isAdminUser(user: unknown): boolean {
  // Accept either a users row (is_admin, a real boolean) or a session-shaped
  // flag (isAdmin), or a bare boolean for callers that already resolved admin
  // status.
  if (user === true) return true;
  if (!user || typeof user !== 'object') return false;
  const u = user as Record<string, unknown>;
  return u.is_admin === true || u.isAdmin === true;
}

// Is a given storage exposed for a host? Missing row ⇒ exposed (default-open).
export async function storageExposedForHost(hostId: number | null | undefined, storage: string | null | undefined): Promise<boolean> {
  if (!hostId || !storage) return true;
  const [row] = await db
    .select({ exposed: storageVisibility.exposed })
    .from(storageVisibility)
    .where(and(eq(storageVisibility.pve_host_id, hostId), eq(storageVisibility.storage, storage)))
    .limit(1);
  return row ? row.exposed !== false : true;
}

// Upsert a storage's exposure flag for a host.
export async function setStorageExposed(hostId: number, storage: string, exposed: unknown): Promise<void> {
  await db
    .insert(storageVisibility)
    .values({ pve_host_id: hostId, storage, exposed: Boolean(exposed) })
    .onConflictDoUpdate({
      target: [storageVisibility.pve_host_id, storageVisibility.storage],
      set: { exposed: Boolean(exposed) },
    });
}

// Map of storage → exposed(bool) for a host (only rows that exist).
export async function storageVisibilityMap(hostId: number): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ storage: storageVisibility.storage, exposed: storageVisibility.exposed })
    .from(storageVisibility)
    .where(eq(storageVisibility.pve_host_id, hostId));
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(r.storage, r.exposed !== false);
  return map;
}

// Filter a list of storage objects (from getStorages) down to those exposed to
// the given user. Admins get the full list unchanged. One visibility query for
// the whole list — missing entries default to exposed.
export async function filterExposedStorages(node: string, storages: Array<{ storage: string; [key: string]: any }>, user: unknown) {
  if (isAdminUser(user)) return storages;
  const hostId = await getHostIdForNode(node);
  if (!hostId) return storages;
  const visibility = await storageVisibilityMap(hostId);
  return storages.filter((s) => visibility.get(s.storage) ?? true);
}

// Shared server-side guard. Call this on EVERY create/edit path that names a
// storage pool — never trust the dropdown. Throws a 4xx-tagged error when a
// non-admin names an unexposed pool. Admins bypass the check.
export async function assertStorageExposed(node: string, storage: string | null | undefined, user: unknown): Promise<void> {
  if (isAdminUser(user)) return;
  if (!storage) return; // nothing named ⇒ nothing to check
  const hostId = await getHostIdForNode(node);
  if (!(await storageExposedForHost(hostId, storage))) {
    throw httpError(403, `Storage pool "${storage}" is not available for provisioning. Pick an exposed pool.`);
  }
}
