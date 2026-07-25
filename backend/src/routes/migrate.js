import { Router } from 'express';
import db from '../db.js';
import {
  getAllVMs, getHost, getHosts, remoteMigrateVm, getTaskStatus,
  getVMConfig, getLXCConfig, updateVMConfig, createVM, getSnapshots,
  getStorageDefs, getStorageContent, moveVmDisk, waitForTask,
} from '../proxmox.js';
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
//    PVE has no way to make the source cluster forget a VM without destroying
//    its disks, so the source config is kept behind (protection=1) and its
//    removal is a one-line manual step shown after the migration.
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
  if (claimed.changes === 0 || !ok) return;
  const row = db.prepare('SELECT * FROM vm_migrations WHERE id = ?').get(id);
  repointVmRows(row.source_node, row.vmid, row.target_node);
  console.log(`[migrate] VM ${row.vmid} migrated ${row.source_node} → ${row.target_node} (${row.mode})`);
}

// ─── Step tracking (same shape as provisioned_vms.steps) ─────────────────────

function seedSteps(id, steps) {
  db.prepare('UPDATE vm_migrations SET steps = ? WHERE id = ?')
    .run(JSON.stringify(steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' }))), id);
}

function setStep(id, key, status, note) {
  const row = db.prepare('SELECT steps FROM vm_migrations WHERE id = ?').get(id);
  let steps = [];
  try { steps = row?.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  db.prepare('UPDATE vm_migrations SET steps = ? WHERE id = ?').run(JSON.stringify(steps), id);
}

// ─── Shared storage detection ────────────────────────────────────────────────

// A storage is "shared" between two hosts when both mount the same remote
// filesystem: NFS (server + export) or CIFS (server + share). Storage IDs may
// differ per host — the map goes source id → target id.
function sharedStorageKey(def) {
  if (def.disable) return null;
  if (def.type === 'nfs' && def.server && def.export) return `nfs:${def.server}:${def.export}`;
  if (def.type === 'cifs' && def.server && def.share) return `cifs:${def.server}:${def.share}`;
  return null;
}

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
      setStep(id, 'move-local', 'active', `${disk.key} → ${transferStorage}`);
      const upid = await moveVmDisk(sourceNode, vmid, disk.key, { storage: transferStorage, delete: 1 });
      await waitForTask(sourceNode, upid);
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
        setStep(id, 'move-back', 'active', `${key} → ${targetStorage}`);
        const upid = await moveVmDisk(targetNode, vmid, key, { storage: targetStorage, delete: 1 });
        await waitForTask(targetNode, upid);
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

    finalizeMigration(id, true,
      `Source VM config kept on ${sourceHostName} — its disks moved with the VM. Remove the leftover with: rm /etc/pve/qemu-server/${vmid}.conf${protectWarning}`,
      { keptSource: true });
  } catch (err) {
    console.error(`[migrate] adopt migration ${id} failed:`, err.message);
    finalizeMigration(id, false, err.message || 'Migration failed');
  }
}

// ─── remote_migrate background polling ───────────────────────────────────────

// Long-running: cross-host disk copies can take hours. Interval 5s, capped at
// ~6h; after that the lazy status check still finalizes whenever it sees the
// task finished.
async function pollMigration(id, sourceNode, upid, { maxAttempts = 4320 } = {}) {
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
    } catch { /* source unreachable — keep polling */ }
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
      }
    } catch { /* source unreachable — leave as running */ }
  }
}

function serializeMigration(row, hostNames) {
  const src = decodeNodeRef(row.source_node);
  const tgt = decodeNodeRef(row.target_node);
  let steps = [];
  try { steps = row.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  return {
    ...row,
    steps,
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
    if (mode === 'remote_migrate') {
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
      pollMigration(row.lastInsertRowid, sourceRef, upid)
        .catch((err) => console.error(`[migrate] polling failed for VM ${vmid}:`, err.message));
    }

    logAudit(req, 'vm_remote_migrate', `${vm.node}/${vmid}`,
      `mode=${mode} → ${targetHost.name}/${target.nodeName}${targetStorage ? ` storage=${targetStorage}` : ''} bridge=${targetBridge}${online ? ' online' : ''}${mode === 'adopt' || !deleteSource ? ' keep-source' : ''}`);
    res.json({ id: row.lastInsertRowid, vmid, upid, mode, status: 'running' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
