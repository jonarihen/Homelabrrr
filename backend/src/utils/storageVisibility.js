import db from '../db.js';
import { getHostIdForNode } from '../proxmox.js';
import { httpError } from './httpError.js';

// Storage pool exposure control.
//
// Admins decide which Proxmox storage pools regular users may pick when creating
// VMs or editing disks. Exposure is stored per (pve_host_id, storage) in the
// storage_visibility table. A pool with NO row is treated as EXPOSED — this is
// the default-open behavior that keeps existing deployments unchanged until an
// admin explicitly hides a pool.
//
// Admins always see and can use every pool; the guards below no-op for them.

function isAdminUser(user) {
  // Accept either a users row (is_admin) or a session-shaped flag (isAdmin),
  // or a bare boolean for callers that already resolved admin status.
  if (user === true) return true;
  if (!user || typeof user !== 'object') return false;
  return user.is_admin === 1 || user.is_admin === true || user.isAdmin === true;
}

// Is a given storage exposed for a host? Missing row ⇒ exposed (default-open).
export function storageExposedForHost(hostId, storage) {
  if (!hostId || !storage) return true;
  const row = db.prepare(
    'SELECT exposed FROM storage_visibility WHERE pve_host_id = ? AND storage = ?'
  ).get(hostId, storage);
  return row ? row.exposed !== 0 : true;
}

// Upsert a storage's exposure flag for a host.
export function setStorageExposed(hostId, storage, exposed) {
  db.prepare(`
    INSERT INTO storage_visibility (pve_host_id, storage, exposed)
    VALUES (?, ?, ?)
    ON CONFLICT(pve_host_id, storage) DO UPDATE SET exposed = excluded.exposed
  `).run(hostId, storage, exposed ? 1 : 0);
}

// Map of storage → exposed(bool) for a host (only rows that exist).
export function storageVisibilityMap(hostId) {
  const rows = db.prepare(
    'SELECT storage, exposed FROM storage_visibility WHERE pve_host_id = ?'
  ).all(hostId);
  const map = new Map();
  for (const r of rows) map.set(r.storage, r.exposed !== 0);
  return map;
}

// Filter a list of storage objects (from getStorages) down to those exposed to
// the given user. Admins get the full list unchanged.
export async function filterExposedStorages(node, storages, user) {
  if (isAdminUser(user)) return storages;
  const hostId = await getHostIdForNode(node);
  return storages.filter((s) => storageExposedForHost(hostId, s.storage));
}

// Shared server-side guard. Call this on EVERY create/edit path that names a
// storage pool — never trust the dropdown. Throws a 4xx-tagged error when a
// non-admin names an unexposed pool. Admins bypass the check.
export async function assertStorageExposed(node, storage, user) {
  if (isAdminUser(user)) return;
  if (!storage) return; // nothing named ⇒ nothing to check
  const hostId = await getHostIdForNode(node);
  if (!storageExposedForHost(hostId, storage)) {
    throw httpError(403, `Storage pool "${storage}" is not available for provisioning. Pick an exposed pool.`);
  }
}
