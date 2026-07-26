import { Router } from 'express';
import db from '../db.js';
import {
  getAllVMs, getHost, getHosts, remoteMigrateVm, getTaskStatus, getTaskLog,
  getVMConfig, getVMConfigCurrent, getLXCConfig, updateVMConfig, createVM, getSnapshots,
  getStorageDefs, getStorageContent, moveVmDisk, waitForTask, getVMStatus,
} from '../proxmox.js';
import { readTaskProgress } from '../utils/taskProgress.js';
import { hostHasSsh, runNodeCommands } from '../utils/pveSsh.js';
import { sharedStorageKey } from '../utils/sharedStorage.js';
import { requireAdmin } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { decodeNodeRef, nodeLookupCandidates, isValidNodeName } from '../utils/nodeRef.js';
import { assertNodeCapacity } from '../utils/capacity.js';

// Cross-host migration: move a guest between separate (non-clustered) Proxmox
// hosts. Two modes, decided per VM:
//
//  - remote_migrate: PVE's cross-cluster migration — copies every disk over
//    the network. Used for fully-local VMs (and always for LXC).
//  - adopt: for VMs with disks on storage BOTH hosts mount (same NFS export /
//    CIFS share, e.g. a TrueNAS share). Those disks are never copied — local
//    boot disks are first moved onto the shared storage, then a VM with the
//    same VMID is created on the target referencing the same volumes, then the
//    boot disks optionally move onto the target's local storage. Offline only.
//    PVE has no API to make the source cluster forget a VM without destroying
//    its disks. When the source host has SSH configured, the leftover config
//    file is archived off /etc/pve automatically (forgetSourceConfig);
//    otherwise it is kept behind (protection=1) and its removal is a one-line
//    manual step shown after the migration.
//
// Admin-only — this rewrites which host the portal considers authoritative.
const router = Router();
router.use(requireAdmin);

const GB = 1024 ** 3;

// Every table that keys rows on (node, vmid) — after a successful migration
// these must point at the target host's node ref or the portal loses track of
// assignments, SSH configs and templates for the moved guest.
const NODE_KEYED_TABLES = ['vm_assignments', 'vm_ssh_configs', 'vm_ssh_user_configs', 'vm_templates', 'provisioned_vms'];

const DISK_KEY_RE = /^(?:scsi|virtio|sata|ide)\d+$|^(?:efidisk|tpmstate)\d+$/;
const IDENT_RE = /^[a-zA-Z0-9._-]+$/;

function repointVmRows(sourceNode, vmid, targetNode) {
  const candidates = nodeLookupCandidates(sourceNode);
  if (candidates.length === 0) return;
  const placeholders = candidates.map(() => '?').join(',');
  for (const table of NODE_KEYED_TABLES) {
    try {
      db.prepare(`UPDATE ${table} SET node = ? WHERE vmid = ? AND node IN (${placeholders})`)
        .run(targetNode, Number(vmid), ...candidates);
    } catch (err) {
      console.warn(`[migrate] failed to re-point ${table} for VM ${vmid}: ${err.message}`);
    }
  }
}

// Idempotent: the status transition guard means only the first caller (the
// background job/poller or a lazy status check after a restart) finalizes.
function finalizeMigration(id, ok, detail = '', { keptSource = false } = {}) {
  const claimed = db.prepare(
    "UPDATE vm_migrations SET status = ?, status_detail = ?, kept_source = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'"
  ).run(ok ? 'ok' : 'error', detail, keptSource ? 1 : 0, id);
  if (claimed.changes === 0) return;
  const row = db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(id);
  // Adopt drives its own steps as it goes; remote_migrate only learns the
  // outcome here, so its seeded steps are resolved from the final status.
  if (row.mode !== 'adopt') closeSteps(id, ok, detail);
  if (!ok) return;
  repointVmRows(row.source_node, row.vmid, row.target_node);
  console.log(`[migrate] VM ${row.vmid} migrated ${row.source_node} → ${row.target_node} (${row.mode})`);
}

// ─── Step tracking (same shape as provisioned_vms.steps) ─────────────────────

function seedSteps(id, steps) {
  db.prepare('UPDATE vm_migrations SET steps = ? WHERE id = ?')
    .run(JSON.stringify(steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' }))), id);
}

function readSteps(id) {
  const row = db.prepare('SELECT steps FROM vm_migrations WHERE id = ?').get(id);
  try { return row?.steps ? JSON.parse(row.steps) : []; } catch { return []; }
}

function setStep(id, key, status, note) {
  const steps = readSteps(id);
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  db.prepare('UPDATE vm_migrations SET steps = ? WHERE id = ?').run(JSON.stringify(steps), id);
}

// Resolve every unfinished step when a migration ends: all done on success, the
// step that was running marked failed otherwise.
function closeSteps(id, ok, detail) {
  const steps = readSteps(id);
  if (steps.length === 0) return;
  for (const step of steps) {
    if (step.status === 'done' || step.status === 'skipped' || step.status === 'error') continue;
    if (ok) { step.status = 'done'; continue; }
    if (step.status === 'active') {
      step.status = 'error';
      if (detail) step.note = detail;
    }
  }
  db.prepare('UPDATE vm_migrations SET steps = ? WHERE id = ?').run(JSON.stringify(steps), id);
}

// ─── Transfer progress ───────────────────────────────────────────────────────

// PVE only exposes the disk-copy percentage in the task log, so progress is
// scraped from it: read the lines added since last time, keep the newest
// percentage, and store it on the row. Persisting it (rather than holding it in
// memory) is what makes the bar survive a page reload and a backend restart —
// refreshRunningMigrations resumes reading at the stored offset.
const LOG_BATCH = 512;
const LOG_MAX_BATCHES = 20; // bounds the catch-up read of a long-running task

function clearProgress(id) {
  db.prepare("UPDATE vm_migrations SET progress = NULL, progress_detail = '' WHERE id = ?").run(id);
}

// Returns a function that pulls the task log once and updates the row. Set
// `persistOffset` for the single task of a remote_migrate; adopt's per-disk
// moves are separate tasks whose line numbers each start over, so they keep
// their offset in the closure instead.
function progressReader(id, node, upid, { persistOffset = false, step = null, note = '' } = {}) {
  let offset = persistOffset
    ? Number(db.prepare('SELECT log_offset FROM vm_migrations WHERE id = ?').get(id)?.log_offset) || 0
    : 0;

  return async function readProgress() {
    if (!upid) return;
    const read = await readTaskProgress(
      (opts) => getTaskLog(node, upid, opts),
      { start: offset, batch: LOG_BATCH, maxBatches: LOG_MAX_BATCHES },
    );
    offset = read.offset;
    const latest = read.progress;
    // The migration can finish while this read is in flight — writing then
    // would resurrect a finished step as "active".
    if (!db.prepare("SELECT 1 FROM vm_migrations WHERE id = ? AND status = 'running'").get(id)) return;
    if (persistOffset) {
      db.prepare('UPDATE vm_migrations SET log_offset = ? WHERE id = ?').run(offset, id);
    }
    if (!latest) return;
    db.prepare('UPDATE vm_migrations SET progress = ?, progress_detail = ? WHERE id = ?')
      .run(latest.percent, latest.detail, id);
    if (step) setStep(id, step, 'active', note ? `${note} · ${latest.detail}` : latest.detail);
  };
}

// ─── Shared storage detection ────────────────────────────────────────────────

async function findSharedStorages(sourceHost, targetHost) {
  const [srcDefs, tgtDefs] = await Promise.all([getStorageDefs(sourceHost), getStorageDefs(targetHost)]);
  const tgtByKey = new Map();
  for (const def of tgtDefs || []) {
    const key = sharedStorageKey(def);
    if (key) tgtByKey.set(key, def);
  }
  const map = new Map(); // source storage id → { targetId, content }
  for (const def of srcDefs || []) {
    const key = sharedStorageKey(def);
    if (!key) continue;
    const tgt = tgtByKey.get(key);
    if (tgt) map.set(def.storage, { targetId: tgt.storage, content: String(def.content || '') });
  }
  return map;
}

// ─── Disk plan ───────────────────────────────────────────────────────────────

function parseSizeGb(value) {
  const m = String(value).match(/(?:^|,)size=(\d+(?:\.\d+)?)([MGT]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === 'T') return n * 1024;
  if (m[2] === 'M') return n / 1024;
  return n;
}

// qemu config → per-disk migration plan. LXC never plans (always full copy).
function buildDiskPlan(config, sharedMap) {
  const disks = [];
  for (const [key, value] of Object.entries(config)) {
    if (!DISK_KEY_RE.test(key) || typeof value !== 'string') continue;
    const volid = value.split(',')[0];
    const isCloudInit = volid.includes('cloudinit');
    const isCdrom = value.includes('media=cdrom') && !isCloudInit;
    if (volid === 'none') continue;
    const storage = volid.includes(':') ? volid.split(':')[0] : '';
    const shared = sharedMap.has(storage);
    disks.push({
      key,
      volid,
      storage,
      sizeGb: parseSizeGb(value),
      shared,
      action: isCloudInit ? 'recreate' : isCdrom ? 'detach' : shared ? 'remount' : 'copy',
      targetStorageId: shared ? sharedMap.get(storage).targetId : null,
    });
  }
  return disks;
}

async function resolveVm(requestedRef, vmid) {
  const requestedName = decodeNodeRef(requestedRef).nodeName || requestedRef;
  const vms = await getAllVMs();
  return vms.find((v) =>
    Number(v.vmid) === Number(vmid)
    && (v.nodeRef === requestedRef || (v.node === requestedName && decodeNodeRef(requestedRef).hostId === null))
  );
}

async function computePlan(vm, sourceHost, targetHost) {
  if (vm.type === 'lxc') {
    let disks = [];
    try {
      const cfg = await getLXCConfig(vm.nodeRef, vm.vmid);
      disks = Object.entries(cfg)
        .filter(([k, v]) => (/^(?:rootfs|mp\d+)$/.test(k)) && typeof v === 'string')
        .map(([k, v]) => ({ key: k, volid: v.split(',')[0], storage: v.split(':')[0], sizeGb: parseSizeGb(v), shared: false, action: 'copy' }));
    } catch { /* config unreadable — plan without disks */ }
    return {
      mode: 'remote_migrate',
      disks,
      sharedMap: new Map(),
      warnings: ['Containers always do a full copy — shared-storage adoption is QEMU-only.'],
    };
  }

  const sharedMap = await findSharedStorages(sourceHost, targetHost);
  const config = await getVMConfig(vm.nodeRef, vm.vmid);
  const disks = buildDiskPlan(config, sharedMap);
  const sharedDisks = disks.filter((d) => d.action === 'remount');
  const warnings = [];
  let mode = 'remote_migrate';
  let transferStorage = null;

  if (sharedDisks.length > 0) {
    mode = 'adopt';
    // Local boot disks travel via a shared storage the VM already uses
    transferStorage = sharedDisks[0].storage;
  }
  if (disks.some((d) => d.action === 'detach')) {
    warnings.push('CD-ROM ISO references are detached on the target (ISO files are not migrated).');
  }
  if (mode === 'adopt' && config.cipassword) {
    warnings.push('Cloud-init password cannot be carried over (Proxmox masks it) — set it again on the target if you used one.');
  }
  return { mode, disks, sharedMap, transferStorage, config, warnings };
}

// ─── Adopt-mode background job ───────────────────────────────────────────────

// Config keys never copied to the target VM: node-/runtime-specific state,
// snapshot bookkeeping, and cipassword (the API only ever returns it masked).
const ADOPT_EXCLUDE_KEYS = new Set([
  'digest', 'parent', 'pending', 'snapshots', 'snaptime', 'vmstate', 'vmgenid',
  'meta', 'protection', 'lock', 'runningmachine', 'runningcpu', 'cipassword',
]);

function rewriteBridge(netValue, targetBridge) {
  return netValue.replace(/(^|,)bridge=[^,]*/, `$1bridge=${targetBridge}`);
}

// A VM's boot order can list devices that no longer exist — e.g. a disk was
// removed or moved to a different bus (sata0 → scsi0) but the boot list kept
// the stale key. A running source node tolerates the dangling entry (it just
// boots the next valid device), but applying the config on the target host
// validates the boot order strictly and aborts with "invalid bootorder:
// device 'X' does not exist". Drop boot entries whose device key is absent
// from the config. Returns the corrected `order=...` string, or null when
// nothing needs changing (or no valid device would be left to boot from).
function sanitizeBootOrder(config) {
  if (typeof config.boot !== 'string') return null;
  const m = config.boot.match(/^order=(.*)$/);
  if (!m) return null; // legacy (c/d/n) format — Proxmox handles it on its own
  const tokens = m[1].split(';').filter(Boolean);
  const kept = tokens.filter((dev) => Object.prototype.hasOwnProperty.call(config, dev));
  if (kept.length === 0 || kept.length === tokens.length) return null;
  return `order=${kept.join(';')}`;
}

// Remove the leftover source config over SSH after a successful adopt
// migration. Never touches volumes: the .conf is archived under /root/ on the
// node — the only way PVE can forget a VM while its disks live on (qm destroy
// would erase the shared volumes the migrated VM now uses). Every failure is
// non-fatal; the caller falls back to showing the manual one-liner.
async function forgetSourceConfig({ id, vmid, sourceNode }) {
  const { hostId, nodeName } = decodeNodeRef(sourceNode);
  const host = hostId != null ? getHost(hostId) : null;
  if (!hostHasSsh(host)) {
    setStep(id, 'cleanup', 'skipped', 'no SSH configured for the source host');
    return { ok: false, reason: 'Configure SSH on the source host (Admin → PVE Hosts) to remove it automatically next time.' };
  }
  setStep(id, 'cleanup', 'active');
  try {
    if (!isValidNodeName(nodeName)) throw new Error(`invalid source node name "${nodeName}"`);
    const status = await getVMStatus(sourceNode, vmid);
    if (status?.status !== 'stopped') throw new Error(`source VM is ${status?.status || 'unknown'}, expected stopped`);
    const confPath = `/etc/pve/nodes/${nodeName}/qemu-server/${Number(vmid)}.conf`;
    const backupPath = `/root/homelabrrr-migrated-${Number(vmid)}-${Date.now()}.conf`;
    const results = await runNodeCommands(host, [
      `test -f '${confPath}'`,
      `mv '${confPath}' '${backupPath}'`,
    ]);
    const failed = results.find((r) => r.code !== 0);
    if (failed) {
      throw new Error(results[0].code !== 0
        ? `${confPath} not found on the node`
        : (failed.output || `mv exited with code ${failed.code}`));
    }
    setStep(id, 'cleanup', 'done', `archived at ${backupPath}`);
    return { ok: true, backupPath };
  } catch (err) {
    setStep(id, 'cleanup', 'error', err.message);
    return { ok: false, reason: `Automatic removal failed: ${err.message}.` };
  }
}

async function runAdoptMigration(ctx) {
  const {
    id, vmid, sourceNode, targetNode, targetBridge, targetStorage,
    sharedMap, transferStorage, sourceHostName, targetHostName,
  } = ctx;
  try {
    // 1. Move local disks (incl. EFI/TPM) onto the shared transfer storage
    let plan = buildDiskPlan(await getVMConfig(sourceNode, vmid), sharedMap);
    const movedKeys = [];
    setStep(id, 'move-local', 'active');
    for (const disk of plan.filter((d) => d.action === 'copy')) {
      const note = `${disk.key} → ${transferStorage}`;
      setStep(id, 'move-local', 'active', note);
      const upid = await moveVmDisk(sourceNode, vmid, disk.key, { storage: transferStorage, delete: 1 });
      await waitForTask(sourceNode, upid, {
        onPoll: progressReader(id, sourceNode, upid, { step: 'move-local', note }),
      });
      clearProgress(id);
      movedKeys.push(disk.key);
    }
    setStep(id, 'move-local', movedKeys.length ? 'done' : 'skipped', movedKeys.length ? `${movedKeys.length} disk(s) moved` : 'all disks already on shared storage');

    // 2. Build the target config — every disk now lives on shared storage
    setStep(id, 'create', 'active');
    const config = await getVMConfig(sourceNode, vmid);
    const targetCfg = {};
    for (const [key, value] of Object.entries(config)) {
      if (ADOPT_EXCLUDE_KEYS.has(key) || /^unused\d+$/.test(key)) continue;
      if (/^net\d+$/.test(key) && typeof value === 'string') {
        targetCfg[key] = rewriteBridge(value, targetBridge);
        continue;
      }
      if (DISK_KEY_RE.test(key) && typeof value === 'string') {
        const volid = value.split(',')[0];
        if (volid === 'none') { targetCfg[key] = value; continue; }
        if (volid.includes('cloudinit')) {
          targetCfg[key] = `${sharedMap.get(transferStorage)?.targetId || transferStorage}:cloudinit,media=cdrom`;
          continue;
        }
        if (value.includes('media=cdrom')) { targetCfg[key] = 'none,media=cdrom'; continue; }
        const storage = volid.split(':')[0];
        const mapping = sharedMap.get(storage);
        if (!mapping) throw new Error(`Disk ${key} is still on non-shared storage "${storage}" after the move step`);
        // Same volume, addressed through the target host's storage id
        targetCfg[key] = mapping.targetId === storage ? value : `${mapping.targetId}:${value.slice(storage.length + 1)}`;
      } else {
        targetCfg[key] = value;
      }
    }
    // Drop boot-order entries for devices that don't exist — the target host
    // validates the boot order on create and would otherwise abort.
    const fixedBoot = sanitizeBootOrder(targetCfg);
    if (fixedBoot) {
      setStep(id, 'create', 'active', `fixed boot order (was "${targetCfg.boot}")`);
      targetCfg.boot = fixedBoot;
    }
    const createUpid = await createVM(targetNode, vmid, targetCfg);
    if (createUpid) await waitForTask(targetNode, createUpid);
    setStep(id, 'create', 'done');

    // 3. Verify every adopted volume is actually visible on the target
    setStep(id, 'verify', 'active');
    const toVerify = Object.entries(targetCfg)
      .filter(([k, v]) => DISK_KEY_RE.test(k) && typeof v === 'string' && !v.startsWith('none') && !v.includes('cloudinit'))
      .map(([, v]) => v.split(',')[0]);
    const contentCache = new Map();
    for (const volid of toVerify) {
      const storage = volid.split(':')[0];
      if (!contentCache.has(storage)) {
        contentCache.set(storage, await getStorageContent(targetNode, storage, 'images'));
      }
      if (!contentCache.get(storage).some((c) => c.volid === volid)) {
        throw new Error(`Volume ${volid} is not visible on the target host — is the shared storage mounted there?`);
      }
    }
    setStep(id, 'verify', 'done');

    // 4. Optionally land the previously-local disks on target-local storage
    const sharedTargetIds = new Set([...sharedMap.values()].map((m) => m.targetId));
    if (targetStorage && !sharedTargetIds.has(targetStorage) && movedKeys.length > 0) {
      setStep(id, 'move-back', 'active');
      for (const key of movedKeys) {
        const note = `${key} → ${targetStorage}`;
        setStep(id, 'move-back', 'active', note);
        const upid = await moveVmDisk(targetNode, vmid, key, { storage: targetStorage, delete: 1 });
        await waitForTask(targetNode, upid, {
          onPoll: progressReader(id, targetNode, upid, { step: 'move-back', note }),
        });
        clearProgress(id);
      }
      setStep(id, 'move-back', 'done', `${movedKeys.length} disk(s) moved to ${targetStorage}`);
    } else {
      setStep(id, 'move-back', 'skipped');
    }

    // 5. Protect the leftover source config so nothing can destroy the shared
    // volumes through it (PVE refuses destroy while protection is set)
    setStep(id, 'protect', 'active');
    let protectWarning = '';
    try {
      const marker = `[Migrated to ${targetHostName} by Homelabrrr — this config is kept only because its disks moved with the VM. Remove it on the source host shell with: rm /etc/pve/qemu-server/${vmid}.conf]`;
      await updateVMConfig(sourceNode, vmid, {
        protection: 1,
        description: `${marker}\n\n${config.description || ''}`.trim(),
      });
      setStep(id, 'protect', 'done');
    } catch (err) {
      protectWarning = ` (could not set the protection flag on the source: ${err.message})`;
      setStep(id, 'protect', 'error', err.message);
    }

    // 6. If the source host has SSH configured, remove the leftover config for
    // real. The API cannot do this (qm destroy erases the referenced disks —
    // which the migrated VM now uses), but moving the .conf out of /etc/pve
    // makes the node forget the VM without touching a single volume. The file
    // is archived under /root/ rather than deleted, so it stays recoverable.
    const removed = await forgetSourceConfig(ctx);
    if (removed.ok) {
      finalizeMigration(id, true,
        `Source config removed from ${sourceHostName} automatically (archived at ${removed.backupPath})${protectWarning}`,
        { keptSource: false });
      return;
    }

    finalizeMigration(id, true,
      `Source VM config kept on ${sourceHostName} — its disks moved with the VM. ${removed.reason} Remove the leftover with: rm /etc/pve/qemu-server/${vmid}.conf${protectWarning}`,
      { keptSource: true });
  } catch (err) {
    console.error(`[migrate] adopt migration ${id} failed:`, err.message);
    finalizeMigration(id, false, err.message || 'Migration failed');
  }
}

// ─── remote_migrate background polling ───────────────────────────────────────

// Migrations with a live in-process poller. Status requests skip their own task
// log read for these — the poller already keeps the row's progress current.
const polledInProcess = new Set();

// Long-running: cross-host disk copies can take hours. Interval 5s, capped at
// ~6h; after that the lazy status check still finalizes whenever it sees the
// task finished.
async function pollMigration(id, sourceNode, upid, { maxAttempts = 4320 } = {}) {
  const readProgress = progressReader(id, sourceNode, upid, { persistOffset: true, step: 'transfer' });
  polledInProcess.add(id);
  try {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const row = db.prepare('SELECT status FROM vm_migrations WHERE id = ?').get(id);
      if (!row || row.status !== 'running') return;
      try {
        const task = await getTaskStatus(sourceNode, upid);
        if (task.status === 'stopped') {
          finalizeMigration(id, task.exitstatus === 'OK', task.exitstatus === 'OK' ? '' : task.exitstatus || 'Migration task failed');
          return;
        }
        await readProgress();
      } catch { /* source unreachable — keep polling */ }
    }
  } finally {
    polledInProcess.delete(id);
  }
  finalizeMigration(id, false, 'Timed out while waiting for the migration task — check the task log in Proxmox');
}

// Re-check still-'running' remote_migrate rows against the source task.
// Survives backend restarts (the PVE task keeps running server-side while our
// poller is gone). Adopt rows are driven in-process and are marked interrupted
// at startup instead (see db.js).
async function refreshRunningMigrations(rows) {
  for (const row of rows) {
    if (row.status !== 'running' || !row.upid || row.mode === 'adopt') continue;
    try {
      const task = await getTaskStatus(row.source_node, row.upid);
      if (task.status === 'stopped') {
        finalizeMigration(row.id, task.exitstatus === 'OK', task.exitstatus === 'OK' ? '' : task.exitstatus || 'Migration task failed');
        Object.assign(row, db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(row.id));
        continue;
      }
      // Nothing polls in-process after a restart — re-derive the bar from the
      // task log so a reopened modal picks it back up mid-transfer.
      if (!polledInProcess.has(row.id)) {
        await progressReader(row.id, row.source_node, row.upid, { persistOffset: true, step: 'transfer' })();
        Object.assign(row, db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(row.id));
      }
    } catch { /* source unreachable — leave as running */ }
  }
}

function serializeMigration(row, hostNames) {
  const src = decodeNodeRef(row.source_node);
  const tgt = decodeNodeRef(row.target_node);
  let steps = [];
  try { steps = row.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  const { log_offset, ...rest } = row; // internal bookkeeping, not for the UI
  return {
    ...rest,
    steps,
    // null whenever the task log carries no percentage yet (LXC rsync, early
    // phase) — the UI falls back to the plain running indicator.
    progress: Number.isFinite(row.progress) ? row.progress : null,
    progress_detail: row.progress_detail || '',
    sourceNodeName: src.nodeName || row.source_node,
    targetNodeName: tgt.nodeName || row.target_node,
    sourceHostName: (src.hostId && hostNames.get(src.hostId)) || '',
    targetHostName: (tgt.hostId && hostNames.get(tgt.hostId)) || '',
  };
}

function hostNameMap() {
  return new Map(getHosts().map((h) => [h.id, h.name]));
}

// ─── Status ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const rows = db.prepare('SELECT * FROM vm_migrations ORDER BY id DESC LIMIT 20').all();
  await refreshRunningMigrations(rows);
  const hostNames = hostNameMap();
  res.json(rows.map((row) => serializeMigration(row, hostNames)));
});

// ─── Migration plan (dry inspection for the modal) ───────────────────────────

router.get('/plan/:node/:vmid', async (req, res) => {
  try {
    const target = decodeNodeRef(req.query.target);
    if (!target.hostId || !target.nodeName || !isValidNodeName(target.nodeName)) {
      return res.status(400).json({ error: 'target must be a host-qualified node reference' });
    }
    const targetHost = getHost(target.hostId);
    if (!targetHost) return res.status(404).json({ error: 'Target Proxmox host not found' });

    const vm = await resolveVm(req.params.node, req.params.vmid);
    if (!vm) return res.status(404).json({ error: 'VM not found on the requested node' });
    const sourceHost = getHost(vm.hostId);
    if (!sourceHost) return res.status(404).json({ error: 'Source Proxmox host not found' });
    if (vm.hostId === target.hostId) {
      return res.status(400).json({ error: 'Target host must be different from the source host' });
    }

    const plan = await computePlan(vm, sourceHost, targetHost);
    res.json({
      vmtype: vm.type === 'lxc' ? 'lxc' : 'qemu',
      running: vm.status === 'running',
      mode: plan.mode,
      requiresStop: plan.mode === 'adopt',
      transferStorage: plan.transferStorage || null,
      disks: plan.disks.map(({ key, volid, storage, sizeGb, shared, action, targetStorageId }) =>
        ({ key, volid, storage, sizeGb, shared, action, targetStorageId })),
      sharedStorages: [...plan.sharedMap.entries()].map(([sourceId, m]) => ({ sourceId, targetId: m.targetId })),
      warnings: plan.warnings,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Migration not found' });
  await refreshRunningMigrations([row]);
  res.json(serializeMigration(row, hostNameMap()));
});

// Retroactive leftover removal: a finished adopt migration whose source config
// was kept (no SSH configured at the time, or the cleanup failed) can be
// cleaned up later, once the source host has SSH set up.
router.post('/:id/cleanup-source', async (req, res) => {
  const row = db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Migration not found' });
  if (row.status !== 'ok' || row.mode !== 'adopt' || !row.kept_source) {
    return res.status(400).json({ error: 'This migration has no leftover source config to remove' });
  }
  const { hostId } = decodeNodeRef(row.source_node);
  const host = hostId != null ? getHost(hostId) : null;
  if (!hostHasSsh(host)) {
    return res.status(400).json({ error: 'Configure SSH for the source host first (Admin → PVE Hosts)' });
  }
  try {
    const removed = await forgetSourceConfig({ id: row.id, vmid: row.vmid, sourceNode: row.source_node });
    if (!removed.ok) return res.status(500).json({ error: sanitizeError(removed.reason) });
    db.prepare('UPDATE vm_migrations SET kept_source = 0, status_detail = ? WHERE id = ?')
      .run(`Source config removed (archived at ${removed.backupPath})`, row.id);
    logAudit(req, 'vm_migrate_cleanup_source', `${row.source_node}/${row.vmid}`, `archived at ${removed.backupPath}`);
    res.json({ ok: true, backupPath: removed.backupPath });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Start a migration ───────────────────────────────────────────────────────

router.post('/:node/:vmid', async (req, res) => {
  const vmid = Number.parseInt(req.params.vmid, 10);
  if (!Number.isInteger(vmid) || vmid < 100) {
    return res.status(400).json({ error: 'Invalid VMID' });
  }

  const { targetNode, targetStorage, targetBridge, online = false, deleteSource = true, fullCopy = false } = req.body;
  if (!targetNode || !targetBridge) {
    return res.status(400).json({ error: 'targetNode and targetBridge are required' });
  }
  // These land in PVE parameters (`target-storage` / `target-bridge` are
  // mapping lists, so a stray comma would smuggle extra mappings in).
  if (targetStorage && !IDENT_RE.test(String(targetStorage))) {
    return res.status(400).json({ error: 'Invalid target storage' });
  }
  if (!IDENT_RE.test(String(targetBridge))) {
    return res.status(400).json({ error: 'Invalid target bridge' });
  }

  const target = decodeNodeRef(targetNode);
  if (!target.hostId || !target.nodeName || !isValidNodeName(target.nodeName)) {
    return res.status(400).json({ error: 'Target node must be a host-qualified node reference' });
  }
  const targetHost = getHost(target.hostId);
  if (!targetHost) return res.status(404).json({ error: 'Target Proxmox host not found' });

  try {
    const vm = await resolveVm(req.params.node, vmid);
    if (!vm) return res.status(404).json({ error: 'VM not found on the requested node' });
    if (vm.hostId === target.hostId) {
      return res.status(400).json({ error: 'Target host must be different from the source host' });
    }
    const sourceHost = getHost(vm.hostId);
    if (!sourceHost) return res.status(404).json({ error: 'Source Proxmox host not found' });

    const active = db.prepare("SELECT id FROM vm_migrations WHERE vmid = ? AND status = 'running'").get(vmid);
    if (active) return res.status(409).json({ error: 'A migration for this VM is already running' });

    const running = vm.status === 'running';
    const vmtype = vm.type === 'lxc' ? 'lxc' : 'qemu';
    const plan = await computePlan(vm, sourceHost, targetHost);
    const mode = fullCopy ? 'remote_migrate' : plan.mode;
    const sourceRef = vm.nodeRef || req.params.node;

    if (mode === 'adopt') {
      if (running) {
        return res.status(400).json({ error: 'Shared-storage migration is offline only — stop the VM first' });
      }
      const snapshots = (await getSnapshots(sourceRef, vmid, 'qemu').catch(() => []))
        .filter((s) => s.name !== 'current');
      if (snapshots.length > 0) {
        return res.status(400).json({ error: 'This VM has snapshots — remove them before a shared-storage migration' });
      }
      // Capacity: only the previously-local disks land on target-local storage
      const localGb = plan.disks.filter((d) => d.action === 'copy').reduce((sum, d) => sum + (d.sizeGb || 0), 0);
      await assertNodeCapacity(targetNode, {
        memoryMb: 0, // offline — memory is only needed at next start
        diskGb: targetStorage ? localGb : 0,
        storage: targetStorage || null,
      });
    } else {
      if (vmtype === 'qemu' && running && !online) {
        return res.status(400).json({ error: 'VM is running — enable live migration or stop it first' });
      }
      if (!targetStorage) {
        return res.status(400).json({ error: 'targetStorage is required for a full-copy migration' });
      }
      // Pre-flight: skip silently if the target can't be queried (same policy
      // as provisioning), but refuse when it clearly doesn't fit.
      await assertNodeCapacity(targetNode, {
        memoryMb: vm.maxmem ? Math.round(vm.maxmem / (1024 * 1024)) : 0,
        diskGb: vm.maxdisk ? vm.maxdisk / GB : 0,
        storage: targetStorage,
      });
    }

    let upid = '';
    let bootFix = '';
    if (mode === 'remote_migrate') {
      // Proxmox ships the ACTIVE (on-disk) source config for a cross-host
      // migration, so a stale boot-order entry (device removed/rebused but
      // still listed) makes the target reject the config. Validate against the
      // active config — NOT the default endpoint, which merges pending changes
      // and would hide a fix that has only been staged. Only qemu has an
      // `order=` boot list; LXC has none.
      if (vmtype === 'qemu') {
        const activeCfg = await getVMConfigCurrent(sourceRef, vmid);
        const fixedBoot = sanitizeBootOrder(activeCfg);
        if (fixedBoot) {
          // A boot-order change on a RUNNING VM is deferred to pending by
          // Proxmox — it never reaches the active config the migration ships,
          // so the migration would still fail. Refuse early with guidance
          // instead of letting Proxmox abort three seconds in.
          if (running) {
            return res.status(409).json({
              code: 'stale_boot_order',
              boot: activeCfg.boot,
              fixedBoot,
              error: `VM ${vmid} has a stale boot-order entry (${activeCfg.boot}) naming a device that no longer exists, which the target host rejects. It can't be corrected while the VM is running — Proxmox defers boot-order changes until the next start. Reboot the VM once to apply the fix, then migrate live; or stop it and migrate offline.`,
            });
          }
          // Stopped: the change lands in the active config immediately.
          await updateVMConfig(sourceRef, vmid, { boot: fixedBoot });
          bootFix = ` (corrected stale boot order "${activeCfg.boot}" → "${fixedBoot}")`;
          console.log(`[migrate] VM ${vmid}: ${bootFix.trim()}`);
        }
      }
      upid = await remoteMigrateVm(sourceRef, vmid, vmtype, targetHost, {
        targetStorage,
        targetBridge,
        online: vmtype === 'qemu' && running && !!online,
        restart: vmtype === 'lxc' && running,
        deleteSource: !!deleteSource,
      });
    }

    const row = db.prepare(`
      INSERT INTO vm_migrations (user_id, vmid, name, vmtype, source_node, target_node, target_storage, target_bridge, online, delete_source, status, upid, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      req.session.userId, vmid, vm.name || '', vmtype,
      sourceRef, targetNode, targetStorage || '', targetBridge,
      mode === 'remote_migrate' && vmtype === 'qemu' && running && online ? 1 : 0,
      mode === 'adopt' ? 0 : (deleteSource ? 1 : 0), upid || '', mode
    );

    if (mode === 'adopt') {
      seedSteps(row.lastInsertRowid, [
        { key: 'move-local', label: 'Moving local disks to shared storage' },
        { key: 'create', label: 'Creating VM on target (adopting shared disks)' },
        { key: 'verify', label: 'Verifying volumes on target' },
        { key: 'move-back', label: 'Moving boot disks to target storage' },
        { key: 'protect', label: 'Protecting leftover source config' },
        { key: 'cleanup', label: 'Removing leftover source config' },
      ]);
      runAdoptMigration({
        id: row.lastInsertRowid, vmid,
        sourceNode: sourceRef, targetNode, targetBridge,
        targetStorage: targetStorage || '',
        sharedMap: plan.sharedMap, transferStorage: plan.transferStorage,
        sourceHostName: sourceHost.name, targetHostName: targetHost.name,
      }).catch((err) => {
        console.error(`[migrate] adopt job crashed for VM ${vmid}:`, err.message);
        finalizeMigration(row.lastInsertRowid, false, err.message || 'Migration failed');
      });
    } else {
      // The API call already returned a UPID, so the source-side preparation is
      // behind us — seeding gives the transfer a step to hang its progress bar
      // on instead of leaving this path a blank panel.
      seedSteps(row.lastInsertRowid, [
        { key: 'prepare', label: 'Preparing migration on the source host', status: 'done' },
        { key: 'transfer', label: `Transferring ${vmtype === 'lxc' ? 'the container' : 'disks'} to ${targetHost.name}`, status: 'active' },
        { key: 'finalize', label: 'Finalizing on the target host' },
      ]);
      pollMigration(row.lastInsertRowid, sourceRef, upid)
        .catch((err) => console.error(`[migrate] polling failed for VM ${vmid}:`, err.message));
    }

    logAudit(req, 'vm_remote_migrate', `${vm.node}/${vmid}`,
      `mode=${mode} → ${targetHost.name}/${target.nodeName}${targetStorage ? ` storage=${targetStorage}` : ''} bridge=${targetBridge}${online ? ' online' : ''}${mode === 'adopt' || !deleteSource ? ' keep-source' : ''}${bootFix}`);
    res.json({ id: row.lastInsertRowid, vmid, upid, mode, status: 'running', bootFix: bootFix.trim() || undefined });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
