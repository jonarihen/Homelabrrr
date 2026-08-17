import db from '../db.ts';
import {
  getAllVMs, getVMConfig, updateVMConfig, getLXCConfig, updateLXCConfig,
} from '../proxmox.ts';

// Mirrors PVE's tag rules: first char [a-z0-9_], then [a-z0-9_\-\+\.]*
// (PVE lowercases tags by default, so we lowercase up front).
export function sanitizePveTag(value) {
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
function vlanTagsFromConfig(config) {
  const tags = new Set();
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/.test(key) || typeof value !== 'string') continue;
    const m = value.match(/(?:^|,)tag=(\d+)/);
    if (!m) continue;
    const vlanNumber = Number(m[1]);
    const vlan = db.prepare('SELECT name FROM vlans WHERE tag = ?').get(vlanNumber);
    const name = vlan?.name ? sanitizePveTag(vlan.name) : '';
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
export async function syncVmTags(node, vmid, { retired = [] } = {}) {
  const numericVmid = Number(vmid);

  // VMIDs are globally unique across connected clusters, so the resource list
  // is enough to learn the guest type and canonical node ref.
  const vms = await getAllVMs();
  const vm = vms.find((v) => Number(v.vmid) === numericVmid);
  const isLxc = vm?.type === 'lxc';
  const ref = vm?.nodeRef || node;

  const config = isLxc ? await getLXCConfig(ref, numericVmid) : await getVMConfig(ref, numericVmid);

  const owner = db.prepare(`
    SELECT u.username FROM vm_assignments va
    JOIN users u ON u.id = va.user_id
    WHERE va.vmid = ?
  `).get(numericVmid);
  const ownerTag = owner ? sanitizePveTag(owner.username) : '';

  const usernameTags = new Set(
    db.prepare('SELECT username FROM users').all().map((u) => sanitizePveTag(u.username)),
  );
  for (const name of retired) usernameTags.add(sanitizePveTag(name));

  const existing = String(config.tags || '')
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const foreign = existing.filter((t) => !usernameTags.has(t) && !t.startsWith('vlan-'));

  const next = [...new Set([
    ...(ownerTag ? [ownerTag] : []),
    ...vlanTagsFromConfig(config),
    ...foreign,
  ])];

  if (next.join(';') === existing.join(';')) return { changed: false, tags: next };

  const update = isLxc ? updateLXCConfig : updateVMConfig;
  await update(ref, numericVmid, { tags: next.join(';') });
  return { changed: true, tags: next };
}

// Tagging is bookkeeping — it must never fail the assignment or provisioning
// operation that triggered it.
export async function syncVmTagsSafe(node, vmid, opts) {
  try {
    return await syncVmTags(node, vmid, opts);
  } catch (err) {
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Reads the persisted tag-sync configuration + last-run stats from `settings`.
// Paused state and interval survive backend restarts because they live in the DB.
export function getTagSyncSettings() {
  const rawInterval = Number(getSetting('tag_sync_interval_hours'));
  const intervalHours = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval : DEFAULT_INTERVAL_HOURS;
  const lastRunRaw = getSetting('tag_sync_last_run');
  return {
    paused: getSetting('tag_sync_paused') === 'true',
    intervalHours,
    pausedBy: getSetting('tag_sync_paused_by') || null,
    pausedAt: getSetting('tag_sync_paused_at') || null,
    lastRun: lastRunRaw ? safeParse(lastRunRaw) : null,
  };
}

// Persist the pause switch together with who flipped it and when, so the UI can
// show provenance and the state outlives a restart.
export function setTagSyncPaused(paused, username) {
  setSetting('tag_sync_paused', paused ? 'true' : 'false');
  if (paused) {
    setSetting('tag_sync_paused_by', username || 'unknown');
    setSetting('tag_sync_paused_at', new Date().toISOString());
  } else {
    setSetting('tag_sync_paused_by', '');
    setSetting('tag_sync_paused_at', '');
  }
}

export function setTagSyncIntervalHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Interval must be a positive number of hours');
  }
  setSetting('tag_sync_interval_hours', String(n));
  return n;
}

// In-memory single-run lock + live progress. The backend is single-process, so a
// module-level flag is a sufficient mutex to block two concurrent fleet walks.
let tagSyncRunning = false;
let tagSyncProgress = null;

export function isTagSyncRunning() { return tagSyncRunning; }
export function getTagSyncProgress() { return tagSyncProgress; }

// Walks every VM the portal can see and re-stamps owner/VLAN tags, correcting
// drift. Sequential with light pacing between VMs. Returns
// { time, durationMs, checked, updated, failed, failures[], trigger } and also
// persists that summary as the last-run record. Throws a TAG_SYNC_BUSY error if
// a run is already in flight (the caller decides how to surface that).
export async function runFullTagSync({ trigger = 'manual', pacingMs = DEFAULT_PACING_MS } = {}) {
  if (tagSyncRunning) {
    const err = new Error('A tag sync is already running');
    err.code = 'TAG_SYNC_BUSY';
    throw err;
  }
  tagSyncRunning = true;
  const startedAt = Date.now();
  const failures = [];
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

    const summary = {
      time: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      checked,
      updated,
      failed,
      failures,
      trigger,
    };
    setSetting('tag_sync_last_run', JSON.stringify(summary));
    return summary;
  } finally {
    tagSyncRunning = false;
    tagSyncProgress = null;
  }
}
