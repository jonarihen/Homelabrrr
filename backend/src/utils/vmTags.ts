import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, vlans, vmAssignments } from '../db/schema/index.ts';
import { setSetting, getSetting } from '../db/settings.ts';
import {
  getAllVMs, getVMConfig, updateVMConfig, getLXCConfig, updateLXCConfig,
} from '../proxmox.ts';

// Mirrors PVE's tag rules: first char [a-z0-9_], then [a-z0-9_\-\+\.]*
// (PVE lowercases tags by default, so we lowercase up front).
export function sanitizePveTag(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_+.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9_]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

// Every `netX: ...,tag=<n>` on the VM becomes a `vlan-<name>` tag (falling
// back to `vlan-<n>` when the portal doesn't know the VLAN). Untagged NICs
// get no tag.
async function vlanTagsFromConfig(config: Record<string, unknown>): Promise<string[]> {
  const vlanNumbers: number[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/.test(key) || typeof value !== 'string') continue;
    const m = value.match(/(?:^|,)tag=(\d+)/);
    if (!m) continue;
    const vlanNumber = Number(m[1]);
    if (!vlanNumbers.includes(vlanNumber)) vlanNumbers.push(vlanNumber);
  }
  if (vlanNumbers.length === 0) return [];

  // One batched lookup for all tagged NICs instead of a query per NIC.
  const rows = await db
    .select({ tag: vlans.tag, name: vlans.name })
    .from(vlans)
    .where(inArray(vlans.tag, vlanNumbers));
  const nameByTag = new Map(rows.map((r) => [r.tag, r.name]));

  const tags = new Set<string>();
  for (const vlanNumber of vlanNumbers) {
    const name = nameByTag.has(vlanNumber) ? sanitizePveTag(nameByTag.get(vlanNumber)) : '';
    tags.add(name ? `vlan-${name}` : `vlan-${vlanNumber}`);
  }
  return [...tags];
}

// Rewrites the PVE tags of one VM to <owner-username> + vlan-<...> based on
// the portal's assignment table and the VM's own net config. The portal owns
// two tag namespaces — tags equal to a portal username and tags starting with
// `vlan-` — and leaves every other (manually set) tag untouched.
// `retired` lists usernames that no longer exist in the users table (renamed
// or deleted) whose tags must still be stripped.
export async function syncVmTags(
  node: string,
  vmid: number | string,
  { retired = [] }: { retired?: string[] } = {},
): Promise<{ changed: boolean; tags: string[] }> {
  const numericVmid = Number(vmid);

  // VMIDs are globally unique across connected clusters, so the resource list
  // is enough to learn the guest type and canonical node ref.
  const vms = await getAllVMs();
  const vm = vms.find((v: any) => Number(v.vmid) === numericVmid);
  const isLxc = vm?.type === 'lxc';
  const ref = vm?.nodeRef || node;

  const config = isLxc ? await getLXCConfig(ref, numericVmid) : await getVMConfig(ref, numericVmid);

  const [owner] = await db
    .select({ username: users.username })
    .from(vmAssignments)
    .innerJoin(users, eq(users.id, vmAssignments.user_id))
    .where(eq(vmAssignments.vmid, numericVmid))
    .limit(1);
  const ownerTag = owner ? sanitizePveTag(owner.username) : '';

  const allUsers = await db.select({ username: users.username }).from(users);
  const usernameTags = new Set(allUsers.map((u) => sanitizePveTag(u.username)));
  for (const name of retired) usernameTags.add(sanitizePveTag(name));

  const existing = String(config.tags || '')
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const foreign = existing.filter((t) => !usernameTags.has(t) && !t.startsWith('vlan-'));

  const next = [...new Set([
    ...(ownerTag ? [ownerTag] : []),
    ...await vlanTagsFromConfig(config),
    ...foreign,
  ])];

  if (next.join(';') === existing.join(';')) return { changed: false, tags: next };

  const update = isLxc ? updateLXCConfig : updateVMConfig;
  await update(ref, numericVmid, { tags: next.join(';') });
  return { changed: true, tags: next };
}

// Tagging is bookkeeping — it must never fail the assignment or provisioning
// operation that triggered it.
export async function syncVmTagsSafe(
  node: string,
  vmid: number | string,
  opts?: { retired?: string[] },
): Promise<{ changed: boolean; tags?: string[]; error?: string }> {
  try {
    return await syncVmTags(node, vmid, opts);
  } catch (err: any) {
    console.warn(`[tags] failed to sync PVE tags for VM ${vmid}: ${err.message}`);
    return { changed: false, error: err.message };
  }
}

// ─── Full-fleet tag sync (shared by the manual endpoint + the scheduler) ──────

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_PACING_MS = 250;      // light pause between VMs so a big fleet
                                    // doesn't hammer the PVE API
const MAX_STORED_FAILURES = 100;    // cap the persisted failure list so the
                                    // settings row stays bounded

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function safeParse(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}

interface TagSyncSettings {
  paused: boolean;
  intervalHours: number;
  pausedBy: string | null;
  pausedAt: string | null;
  lastRun: any;
}

// Reads the persisted tag-sync configuration + last-run stats from `settings`.
// Paused state and interval survive backend restarts because they live in the DB.
// `settings.value` is text, so the last-run summary is still JSON-parsed here.
export async function getTagSyncSettings(): Promise<TagSyncSettings> {
  const [rawInterval, paused, pausedBy, pausedAt, lastRunRaw] = await Promise.all([
    getSetting('tag_sync_interval_hours'),
    getSetting('tag_sync_paused'),
    getSetting('tag_sync_paused_by'),
    getSetting('tag_sync_paused_at'),
    getSetting('tag_sync_last_run'),
  ]);
  const interval = Number(rawInterval);
  const intervalHours = Number.isFinite(interval) && interval > 0
    ? interval : DEFAULT_INTERVAL_HOURS;
  return {
    paused: paused === 'true',
    intervalHours,
    pausedBy: pausedBy || null,
    pausedAt: pausedAt || null,
    lastRun: lastRunRaw ? safeParse(lastRunRaw) : null,
  };
}

// Persist the pause switch together with who flipped it and when, so the UI can
// show provenance and the state outlives a restart.
export async function setTagSyncPaused(paused: boolean, username?: string): Promise<void> {
  await setSetting('tag_sync_paused', paused ? 'true' : 'false');
  if (paused) {
    await setSetting('tag_sync_paused_by', username || 'unknown');
    await setSetting('tag_sync_paused_at', new Date().toISOString());
  } else {
    await setSetting('tag_sync_paused_by', '');
    await setSetting('tag_sync_paused_at', '');
  }
}

export async function setTagSyncIntervalHours(hours: unknown): Promise<number> {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Interval must be a positive number of hours');
  }
  await setSetting('tag_sync_interval_hours', String(n));
  return n;
}

interface TagSyncProgress {
  trigger: string;
  startedAt: number;
  total: number;
  checked: number;
  updated: number;
  failed: number;
}

interface TagSyncFailure {
  vmid: number;
  node: string;
  name: string;
  error: string;
}

interface TagSyncSummary {
  time: string;
  durationMs: number;
  checked: number;
  updated: number;
  failed: number;
  failures: TagSyncFailure[];
  trigger: string;
}

// In-memory single-run lock + live progress. The backend is single-process, so a
// module-level flag is a sufficient mutex to block two concurrent fleet walks.
let tagSyncRunning = false;
let tagSyncProgress: TagSyncProgress | null = null;

export function isTagSyncRunning(): boolean { return tagSyncRunning; }
export function getTagSyncProgress(): TagSyncProgress | null { return tagSyncProgress; }

// Walks every VM the portal can see and re-stamps owner/VLAN tags, correcting
// drift. Sequential with light pacing between VMs. Returns
// { time, durationMs, checked, updated, failed, failures[], trigger } and also
// persists that summary as the last-run record. Throws a TAG_SYNC_BUSY error if
// a run is already in flight (the caller decides how to surface that).
export async function runFullTagSync(
  { trigger = 'manual', pacingMs = DEFAULT_PACING_MS }: { trigger?: string; pacingMs?: number } = {},
): Promise<TagSyncSummary> {
  if (tagSyncRunning) {
    const err = new Error('A tag sync is already running') as Error & { code: string };
    err.code = 'TAG_SYNC_BUSY';
    throw err;
  }
  tagSyncRunning = true;
  const startedAt = Date.now();
  const failures: TagSyncFailure[] = [];
  let checked = 0;
  let updated = 0;
  let failed = 0;
  tagSyncProgress = { trigger, startedAt, total: 0, checked, updated, failed };

  try {
    const vms = await getAllVMs();
    tagSyncProgress.total = vms.length;

    for (let i = 0; i < vms.length; i += 1) {
      const vm = vms[i];
      const result = await syncVmTagsSafe(vm.nodeRef, vm.vmid);
      checked += 1;
      if (result.error) {
        failed += 1;
        if (failures.length < MAX_STORED_FAILURES) {
          failures.push({ vmid: vm.vmid, node: vm.nodeRef, name: vm.name || '', error: result.error });
        }
      } else if (result.changed) {
        updated += 1;
      }
      tagSyncProgress.checked = checked;
      tagSyncProgress.updated = updated;
      tagSyncProgress.failed = failed;

      // Pace between VMs only — no need to wait after the last one.
      if (pacingMs > 0 && i < vms.length - 1) await delay(pacingMs);
    }

    const summary: TagSyncSummary = {
      time: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      checked,
      updated,
      failed,
      failures,
      trigger,
    };
    await setSetting('tag_sync_last_run', JSON.stringify(summary));
    return summary;
  } finally {
    tagSyncRunning = false;
    tagSyncProgress = null;
  }
}
