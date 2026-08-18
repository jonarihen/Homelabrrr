import { httpError } from './httpError.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getNodeStatus, getStorageStatus, getAllVMs } from '../proxmox.ts';
import { decodeNodeRef } from './nodeRef.ts';
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
// an advisory note on the deployment instead of failing it.
export async function assertNodeCapacity(node: string, { memoryMb, diskGb, storage }: { memoryMb?: unknown; diskGb?: unknown; storage?: string }): Promise<{ warnings: string[]; memoryWarning: string }> {
  const warnings: string[] = [];

  let nodeStatus = null;
  try {
    nodeStatus = await getNodeStatus(node);
  } catch (err: any) {
    console.warn(`[capacity] could not read node status for ${node}: ${err.message}`);
  }

  const requestedMb = Number(memoryMb);
  if (nodeStatus && Number.isFinite(requestedMb) && requestedMb > 0) {
    const { memoryMode, overcommitRatio } = await getCapacitySettings();
    if (memoryMode !== 'off') {
      const verdict = evaluateMemoryCapacity({
        requestedMb,
        nodeTotalBytes: nodeStatus.memory?.total,
        allocatedBytes: await allocatedMemoryOnNode(node),
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
  }

  const requestedDiskGb = parseFloat(diskGb as string);
  if (storage && Number.isFinite(requestedDiskGb) && requestedDiskGb > 0) {
    let storageStatus = null;
    try {
      storageStatus = await getStorageStatus(node, storage);
    } catch (err: any) {
      console.warn(`[capacity] could not read storage "${storage}" on ${node}: ${err.message}`);
    }
    const availBytes = storageStatus?.avail;
    if (Number.isFinite(availBytes) && requestedDiskGb * GB > availBytes) {
      throw validationError(
        `Not enough space on storage "${storage}": requested ${requestedDiskGb} GB, only ${fmtGb(availBytes)} GB available`,
      );
    }
  }

  return { warnings, memoryWarning: warnings[0] || '' };
}
