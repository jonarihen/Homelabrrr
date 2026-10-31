import { httpError } from './httpError.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getNodeStatus, getStorageStatus, getAllVMs, getHost, getStorageDefs } from '../proxmox.ts';
import { decodeNodeRef } from './nodeRef.ts';
import { sharedStorageKey } from './sharedStorage.ts';
import {
  DEFAULT_MEMORY_MODE, DEFAULT_OVERCOMMIT_RATIO,
  evaluateMemoryCapacity, guestsOnNode, normalizeMemoryMode,
  normalizeOvercommitRatio, sumAllocatedMemoryBytes,
} from './capacityPolicy.ts';

const GB = 1024 ** 3;

const fmtGb = (bytes: number) => (bytes / GB).toFixed(1);

const validationError = (message: string) => httpError(400, message);

// ─── Capacity policy settings ────────────────────────────────────────────────
// Admin-editable, stored in the key/value `settings` table via the shared
// getSetting/setSetting helpers (settings.value stays text — parse here).
// Memory is advisory by default: a homelab runs with configured guest RAM
// above physical, so a hard block on memory made normal topologies unusable
// through the portal.

const MEMORY_MODE_KEY = 'capacity_memory_mode';
const OVERCOMMIT_RATIO_KEY = 'capacity_memory_overcommit_ratio';

export interface CapacitySettings {
  memoryMode: string;
  overcommitRatio: number;
}

export async function getCapacitySettings(): Promise<CapacitySettings> {
  const [memoryMode, overcommitRatio] = await Promise.all([
    getSetting(MEMORY_MODE_KEY),
    getSetting(OVERCOMMIT_RATIO_KEY),
  ]);
  return {
    memoryMode: normalizeMemoryMode(memoryMode ?? DEFAULT_MEMORY_MODE),
    overcommitRatio: normalizeOvercommitRatio(overcommitRatio ?? DEFAULT_OVERCOMMIT_RATIO),
  };
}

export async function setCapacitySettings({ memoryMode, overcommitRatio }: { memoryMode?: unknown; overcommitRatio?: unknown } = {}): Promise<CapacitySettings> {
  if (memoryMode !== undefined && memoryMode !== null) {
    await setSetting(MEMORY_MODE_KEY, normalizeMemoryMode(memoryMode));
  }
  if (overcommitRatio !== undefined && overcommitRatio !== null) {
    await setSetting(OVERCOMMIT_RATIO_KEY, String(normalizeOvercommitRatio(overcommitRatio)));
  }
  return getCapacitySettings();
}

// Sum of configured RAM across the guests on a node. Best-effort: returns null
// when the cluster can't be enumerated so the policy can fall back instead of
// treating the node as empty.
async function allocatedMemoryOnNode(node: string): Promise<number | null> {
  try {
    const vms = await getAllVMs();
    return sumAllocatedMemoryBytes(guestsOnNode(vms, node)).bytes;
  } catch (err: any) {
    console.warn(`[capacity] could not enumerate guests for ${node}: ${err.message}`);
    return null;
  }
}

// ─── In-flight reservations (#284) ───────────────────────────────────────────
// A deploy's memory and disk only show up in Proxmox once its clone/create task
// has run, so two concurrent deploys could each pass the same free-space check.
// A passed check with `reserve: true` holds its request here until the caller
// releases it (when the background deploy job ends). In-memory is enough: the
// window is one deploy, and a restart reconciles interrupted deploys anyway.
// shortcut: per-process only, revisit if the backend ever runs more than one replica.

interface Reservation { node: string; diskKey: string; memoryBytes: number; diskBytes: number; expiresAt: number }

// Safety net for a path that forgets to release; a deploy job is far shorter.
const RESERVATION_TTL_MS = 60 * 60 * 1000;
const reservations = new Map<symbol, Reservation>();

// Disk is held against the backing pool, not the node: nodes that mount the
// same shared storage (Ceph/NFS/CIFS, even across registered hosts) draw on one
// pool, so their deploys must see each other. Anything else is node-local.
export const localDiskKey = (node: string, storage: string) => `local:${node}:${storage}`;

async function diskKeyFor(node: string, storage: string | undefined, sharedFlag: unknown): Promise<string> {
  if (!storage) return '';
  const { hostId } = decodeNodeRef(node);
  try {
    const host = hostId ? await getHost(hostId) : null;
    const def = host ? ((await getStorageDefs(host)) || []).find((d: any) => d.storage === storage) : null;
    const backend = sharedStorageKey(def);
    if (backend) return `shared:${backend}`;
    if (def?.shared || sharedFlag) return `shared:${hostId}:${storage}`;
  } catch { /* storage defs unreadable — treat as node-local */ }
  return sharedFlag ? `shared:${hostId}:${storage}` : localDiskKey(node, storage);
}

export function pendingReservations(node: string, diskKey?: string, now = Date.now()): { memoryBytes: number; diskBytes: number } {
  let memoryBytes = 0;
  let diskBytes = 0;
  for (const [key, r] of reservations) {
    if (r.expiresAt <= now) { reservations.delete(key); continue; }
    if (r.node === node) memoryBytes += r.memoryBytes;
    if (diskKey && r.diskKey === diskKey) diskBytes += r.diskBytes;
  }
  return { memoryBytes, diskBytes };
}

export function reserveCapacity(node: string, { memoryMb, diskGb, storage, diskKey }: { memoryMb?: unknown; diskGb?: unknown; storage?: string; diskKey?: string }, now = Date.now()): () => void {
  const key = Symbol(node);
  reservations.set(key, {
    node,
    diskKey: diskKey || (storage ? localDiskKey(node, storage) : ''),
    memoryBytes: Math.max(0, Number(memoryMb) || 0) * 1024 ** 2,
    diskBytes: Math.max(0, parseFloat(diskGb as string) || 0) * GB,
    expiresAt: now + RESERVATION_TTL_MS,
  });
  return () => { reservations.delete(key); };
}

// Pre-flight check for a provision/migration request against a target node.
//
// Memory is compared against physical RAM × the configured overcommit ratio
// (never against `memory.free`, which is near zero on a healthy node) and is
// advisory by default — see capacityPolicy.ts. Storage stays a hard block:
// `storage.avail` is a real limit.
//
// Throws (err.status = 400) only on a genuine capacity violation; if Proxmox
// can't be queried the check is skipped rather than blocking provisioning on a
// monitoring hiccup — the clone/create call will surface real API problems.
//
// Returns { warnings: string[], memoryWarning: string } so callers can record
// an advisory note on the deployment instead of failing it. Requests still in
// flight count against the node; with `reserve: true` a passing request joins
// them, and the caller must call the returned `release` once its deploy ends.
export async function assertNodeCapacity(node: string, { memoryMb, diskGb, storage, reserve = false }: { memoryMb?: unknown; diskGb?: unknown; storage?: string; reserve?: boolean }): Promise<{ warnings: string[]; memoryWarning: string; release: () => void }> {
  const warnings: string[] = [];

  let nodeStatus = null;
  try {
    nodeStatus = await getNodeStatus(node);
  } catch (err: any) {
    console.warn(`[capacity] could not read node status for ${node}: ${err.message}`);
  }

  const requestedMb = Number(memoryMb);
  const checkMemory = nodeStatus && Number.isFinite(requestedMb) && requestedMb > 0;
  const { memoryMode, overcommitRatio } = await getCapacitySettings();
  const allocatedBytes = checkMemory && memoryMode !== 'off' ? await allocatedMemoryOnNode(node) : null;

  const requestedDiskGb = parseFloat(diskGb as string);
  let storageStatus = null;
  let diskKey = storage ? localDiskKey(node, storage) : '';
  if (storage && Number.isFinite(requestedDiskGb) && requestedDiskGb > 0) {
    try {
      storageStatus = await getStorageStatus(node, storage);
    } catch (err: any) {
      console.warn(`[capacity] could not read storage "${storage}" on ${node}: ${err.message}`);
    }
    diskKey = await diskKeyFor(node, storage, storageStatus?.shared);
  }

  // No awaits from here on: reading the pending reservations, deciding and
  // reserving happen in one tick, so a concurrent deploy sees this one.
  const pending = pendingReservations(node, diskKey);

  if (checkMemory && memoryMode !== 'off') {
    const verdict = evaluateMemoryCapacity({
      requestedMb,
      nodeTotalBytes: nodeStatus.memory?.total,
      allocatedBytes,
      pendingBytes: pending.memoryBytes,
      freeBytes: nodeStatus.memory?.free,
      mode: memoryMode,
      ratio: overcommitRatio,
      nodeName: nodeStatus.nodeName || decodeNodeRef(node).nodeName,
    });
    if (verdict.decision === 'block') throw validationError(verdict.reason);
    if (verdict.decision === 'warn') {
      console.warn(`[capacity] ${verdict.reason}`);
      warnings.push(verdict.reason);
    }
  }

  const rawAvail = storageStatus?.avail;
  if (Number.isFinite(rawAvail)) {
    const availBytes = rawAvail - pending.diskBytes;
    if (requestedDiskGb * GB > availBytes) {
      const inFlight = pending.diskBytes > 0 ? ` after ${fmtGb(pending.diskBytes)} GB held by deploys in progress` : '';
      throw validationError(
        `Not enough space on storage "${storage}": requested ${requestedDiskGb} GB, only ${fmtGb(Math.max(0, availBytes))} GB available${inFlight}`,
      );
    }
  }

  const release = reserve ? reserveCapacity(node, { memoryMb, diskGb, storage, diskKey }) : () => {};
  return { warnings, memoryWarning: warnings[0] || '', release };
}

// A task whose monitoring gave up may still be running in Proxmox. Keep its
// reservation until the task is seen stopped, or the reservation's own TTL
// lapses, so the next deploy does not count the space as free.
export function releaseWhenTaskStops(release: () => void, isStopped: () => Promise<boolean>, { intervalMs = 30_000, maxMs = RESERVATION_TTL_MS } = {}): void {
  const deadline = Date.now() + maxMs;
  const tick = async () => {
    let stopped = false;
    try { stopped = await isStopped(); } catch { /* keep holding */ }
    if (stopped || Date.now() >= deadline) return release();
    setTimeout(tick, intervalMs).unref();
  };
  setTimeout(tick, intervalMs).unref();
}
