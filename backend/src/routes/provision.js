import { Router } from 'express';
import db from '../db.js';
import {
  withFreshVmid, cloneVM, createVM, updateVMConfig, resizeVMDisk, startVM,
  getStorages, getISOImages, getNetworks, getNodes, getTaskStatus,
  getAllVMs, getVMConfig,
} from '../proxmox.js';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/auth.js';
import { sendError, hasHttpStatus, tagStatus } from '../utils/httpError.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { notify, portalLink } from '../utils/notify.js';
import { decodeNodeRef } from '../utils/nodeRef.js';
import { imageDeployTargets, defaultStorageForHost } from '../utils/cloudImageTargets.js';
import { checkVlanAssignment } from '../utils/vlanAccess.js';
import { assertStorageExposed, filterExposedStorages } from '../utils/storageVisibility.js';
import { computeCpuTopology } from '../utils/cpuTopology.js';
import { assertNodeCapacity } from '../utils/capacity.js';
import { assertNodeAvailable } from '../utils/nodeMaintenance.js';
import { assertUserQuota, getUserQuota, getUserResourceUsage } from '../utils/quota.js';
import { syncVmTagsSafe } from '../utils/vmTags.js';
import { getRolePermissions } from '../utils/permissions.js';
import { createLeaseForVm } from '../utils/leases.js';
import { toPveVmName } from '../utils/vmName.js';
import { resolveSshKeys, unusableKeysError, assertLoginPossible } from '../utils/cloudInitCredentials.js';

const router = Router();
router.use(requireAuth);

function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

function serializeProvisionRow(row) {
  let steps = [];
  try { steps = row.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  return {
    ...row,
    steps,
    ...serializeNodeIdentity(row.node),
  };
}

// ─── Deployment progress (step tracking) ─────────────────────────────────────
// Each provisioning job carries a JSON array of steps on its provisioned_vms
// row so the UI can render a live stepper. A step is { key, label, status },
// status ∈ 'pending' | 'active' | 'done' | 'error' | 'skipped'. Steps that
// finish synchronously before the row exists are seeded 'done' at insert time;
// the background pollers advance the rest.

function stepList(steps) {
  return JSON.stringify(steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' })));
}

function setStep(provisionId, key, status, note) {
  const row = db.prepare('SELECT steps FROM provisioned_vms WHERE id = ?').get(provisionId);
  let steps = [];
  try { steps = row?.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  db.prepare('UPDATE provisioned_vms SET steps = ? WHERE id = ?').run(JSON.stringify(steps), provisionId);
}

// Fire a Discord notification for a deployment that has reached a terminal
// state. Reads the current row so it maps status → deployment.finished (ready /
// warning) or deployment.failed (error / timeout). Fire-and-forget: notify()
// never throws, so this can never break the provisioning flow.
function notifyDeployment(provisionId) {
  try {
    const row = db.prepare(
      'SELECT pv.*, u.username FROM provisioned_vms pv LEFT JOIN users u ON u.id = pv.user_id WHERE pv.id = ?'
    ).get(provisionId);
    if (!row) return;
    const failed = row.status === 'error' || row.status === 'timeout';
    const { nodeName } = decodeNodeRef(row.node);
    notify(failed ? 'deployment.failed' : 'deployment.finished', {
      vm: `${row.name} (#${row.vmid}${nodeName ? ` on ${nodeName}` : ''})`,
      owner: row.username || undefined,
      ownerUserId: row.user_id,
      status: row.status,
      detail: row.status_detail || undefined,
      url: portalLink(`/vm/${row.node}/${row.vmid}`),
    });
  } catch { /* notifications are best-effort */ }
}

// ─── Cloud-init option parsing (shared by clone + from-image) ────────────────
// Returns { opts } to hand to the config step, or { error: { status, message } }
// on a validation failure. SSH keys are always read from the requesting user's
// own stored keys.
//
// `cloudInitCapable` says the guest gets its credentials from cloud-init and
// nothing else (a cloud image, or a template flagged cloud_init). Those deploys
// must end up with a password or an installable key — see
// utils/cloudInitCredentials.js.

function parseCloudInitOptions({ ciUser, ciPassword, sshKeyIds, ipMode, ipAddress, ipGateway }, userId, cloudInitCapable = false) {
  const opts = {};
  if (ciUser) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(ciUser)) {
      return { error: { status: 400, message: 'Invalid cloud-init username (lowercase letters, digits, - and _)' } };
    }
    opts.ciUser = ciUser;
  }
  if (ciPassword) {
    if (String(ciPassword).length < 8) {
      return { error: { status: 400, message: 'Cloud-init password must be at least 8 characters' } };
    }
    opts.ciPassword = String(ciPassword);
  }
  if (Array.isArray(sshKeyIds) && sshKeyIds.length > 0) {
    // Load every requested row — including the ones with no stored public key —
    // so a key that can't be installed is named back to the user instead of
    // being filtered out and the deploy running on with no key at all.
    const numericIds = sshKeyIds.map(Number).filter(Number.isInteger);
    const placeholders = numericIds.map(() => '?').join(',');
    const rows = numericIds.length > 0
      ? db.prepare(
        `SELECT id, name, public_key FROM ssh_keys WHERE user_id = ? AND id IN (${placeholders})`
      ).all(userId, ...numericIds)
      : [];
    const { keys, unusable } = resolveSshKeys(sshKeyIds, rows);
    if (unusable.length > 0) {
      return { error: { status: 400, message: unusableKeysError(unusable) } };
    }
    if (keys.length > 0) opts.sshKeys = keys.join('\n');
  }
  // A cloud image has no default password and a locked default user, so a deploy
  // with neither credential boots into a VM nobody can log into.
  try {
    assertLoginPossible({ ciPassword: opts.ciPassword, sshKeys: opts.sshKeys, cloudInitCapable });
  } catch (err) {
    return { error: { status: err.status || 400, message: err.message } };
  }
  if (ipMode === 'static') {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(ipAddress || '')) {
      return { error: { status: 400, message: 'Static IP must be in CIDR form, e.g. 10.0.20.50/24' } };
    }
    if (ipGateway && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ipGateway)) {
      return { error: { status: 400, message: 'Gateway must be an IPv4 address' } };
    }
    opts.ipConfig = ipGateway ? `ip=${ipAddress},gw=${ipGateway}` : `ip=${ipAddress}`;
  } else if (ipMode === 'dhcp') {
    opts.ipConfig = 'ip=dhcp';
  }
  return { opts };
}

// A non-admin needs can_provision to reach clone / from-image / images.
// can_provision here is the effective value: role assigned → the role
// decides; no role → the per-user column.
function loadProvisioner(req) {
  const user = db.prepare('SELECT id, can_provision, is_admin, role_id FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return user;
  return {
    ...user,
    can_provision: user.role_id
      ? (getRolePermissions(user.role_id).has('can_provision') ? 1 : 0)
      : user.can_provision,
  };
}

// ─── Own quota + current usage (any authenticated user) ─────────────────────

router.get('/quota', async (req, res) => {
  try {
    const quota = getUserQuota(req.session.userId);
    if (!quota) return res.status(401).json({ error: 'Unauthorized' });
    const usage = await getUserResourceUsage(req.session.userId);
    res.json({
      usage,
      limits: quota.isAdmin
        ? { maxCores: null, maxMemoryGb: null, maxStorageGb: null }
        : { maxCores: quota.maxCores, maxMemoryGb: quota.maxMemoryGb, maxStorageGb: quota.maxStorageGb },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Templates (public, read-only for users) ────────────────────────────────

router.get('/templates', (req, res) => {
  const templates = db.prepare(
    'SELECT * FROM vm_templates WHERE enabled = 1 ORDER BY name'
  ).all();
  res.json(templates.map(t => ({
    ...t,
    nodeRef: t.node,
    node: decodeNodeRef(t.node).nodeName || t.node,
  })));
});

// ─── Cloud images available to provision directly (read-only, provisioners) ──

router.get('/images', async (req, res) => {
  const user = loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }
  // Only ready images stored as import content can be used as an import-from
  // disk source; iso-content rows (downloaded before the import switch) can't.
  const rows = db.prepare(
    "SELECT id, name, url, node, storage, default_storage, default_storage_map, volid, size FROM cloud_images WHERE status = 'ready' AND volid != '' AND volid NOT LIKE '%:iso/%' ORDER BY name"
  ).all();
  const hostNames = new Map(db.prepare('SELECT id, name FROM pve_hosts').all().map((h) => [h.id, h.name]));
  const out = [];
  for (const r of rows) {
    const { hostId, nodeName, nodeRef } = decodeNodeRef(r.node);
    // Every host this image can be deployed from — its own host plus any peer
    // sharing its storage. Each target carries the per-host default target pool
    // so the deploy form can pre-select it as the host is switched.
    const targets = (await imageDeployTargets(r)).map((t) => ({
      nodeRef: t.nodeRef, node: t.node, hostId: t.hostId, hostName: hostNames.get(t.hostId) || '',
      defaultStorage: defaultStorageForHost(r, t.hostId) || '',
    }));
    out.push({
      id: r.id, name: r.name, url: r.url, storage: r.storage, default_storage: r.default_storage || '', size: r.size,
      node: nodeName || r.node, nodeRef: nodeRef || r.node,
      hostName: (hostId && hostNames.get(hostId)) || '',
      deployTargets: targets,
    });
  }
  res.json(out);
});

// ─── Proxmox resources (for form dropdowns) ─────────────────────────────────

// can_create_vms holders need the node list to pick a deploy target for the
// from-scratch flow (same nodes the admin create form uses).
router.get('/nodes', requirePermission('can_manage_templates', 'can_create_vms'), async (req, res) => {
  try {
    res.json(await getNodes());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/storages', requirePermission('can_provision', 'can_manage_templates', 'can_create_vms'), async (req, res) => {
  try {
    const storages = await getStorages(req.params.node);
    // Non-admins only see storage pools an admin has exposed. Admins see all.
    const visible = await filterExposedStorages(req.params.node, storages, { isAdmin: req.session.isAdmin });
    res.json(visible);
  } catch (err) {
    sendError(res, err);
  }
});

// Open to can_create_vms so from-scratch users can pick a boot ISO. Non-admins
// may only list ISOs from storages an admin has exposed (mirrors the
// disk-storage picker).
router.get('/nodes/:node/isos/:storage', requirePermission('can_create_vms'), async (req, res) => {
  try {
    await assertStorageExposed(req.params.node, req.params.storage, { isAdmin: req.session.isAdmin });
    res.json(await getISOImages(req.params.node, req.params.storage));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/networks', requireAdmin, async (req, res) => {
  try {
    res.json(await getNetworks(req.params.node));
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Clone from template (user or admin) ─────────────────────────────────────

router.post('/clone', async (req, res) => {
  // Check permission
  const user = loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }

  const {
    templateId, name, cores, memoryGb, diskGb, storage, description, assignTo, vlanTag,
  } = req.body;
  if (!templateId || !name) {
    return res.status(400).json({ error: 'Template and name are required' });
  }

  // PVE VM names must be DNS-like — sanitize before reserving a VMID or running
  // the capacity/quota checks, so a bad name fails fast instead of coming back
  // as a raw upstream 400 from the clone call (utils/vmName.js).
  const vmName = toPveVmName(name);
  if (!vmName) {
    return res.status(400).json({ error: 'Name must contain letters or digits' });
  }

  const template = db.prepare('SELECT * FROM vm_templates WHERE id = ? AND enabled = 1').get(templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  // Cloud-init guest settings (only honored for cloud-init templates)
  let cloudInitOpts = {};
  if (template.cloud_init) {
    const parsed = parseCloudInitOptions(req.body, req.session.userId, true);
    if (parsed.error) return res.status(parsed.error.status).json({ error: parsed.error.message });
    cloudInitOpts = parsed.opts;
  }

  // Authorize the target VLAN. Non-admins must place the VM on a VLAN assigned
  // to them; the untagged/native network is admin-only (utils/vlanAccess.js).
  const vlanErr = checkVlanAssignment(db, { userId: req.session.userId, isAdmin: user.is_admin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  // Enforce storage exposure — never trust the dropdown. Non-admins can't clone
  // onto a pool an admin has hidden, even by naming it directly.
  try {
    await assertStorageExposed(template.node, storage || template.default_storage, user);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  // Refuse deployment to a node the admin has drained for maintenance
  try {
    assertNodeAvailable(template.node);
  } catch (err) {
    return sendError(res, err);
  }

  // Validate CPU count against node's physical cores before cloning
  const finalCores = cores || template.default_cores;
  try {
    await computeCpuTopology(template.node, finalCores);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    // Non-validation errors are fine — we'll fall back in pollAndConfigure
  }

  // Refuse requests the node can't fit. Storage is a hard limit; memory is
  // advisory by default (capacity policy — see utils/capacityPolicy.js) and
  // comes back as a note recorded on the deployment.
  const finalMem = memoryGb ? Math.round(parseFloat(memoryGb) * 1024) : template.default_memory;
  const finalDisk = diskGb || template.default_disk_gb;
  let capacityNote = '';
  try {
    const capacity = await assertNodeCapacity(template.node, {
      memoryMb: finalMem,
      diskGb: finalDisk,
      storage: storage || template.default_storage,
    });
    capacityNote = capacity?.memoryWarning || '';
    // Per-user resource quota (skips admins / users without quotas)
    await assertUserQuota(req.session.userId, {
      addCores: parseInt(finalCores, 10) || 0,
      addMemoryMb: finalMem,
      addDiskGb: parseFloat(finalDisk) || 0,
    });
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  try {
    // Allocate the VMID as late as possible and hold a reservation on it for
    // the duration of the clone submit, so a second deploy running right now
    // can't be handed the same id. withFreshVmid retries once if Proxmox says
    // the id is taken anyway, and releases the reservation if the clone fails.
    const { vmid: newVmid, result: upid } = await withFreshVmid((vmid) => cloneVM(
      template.node,
      template.vmid,
      vmid,
      vmName,
      { storage: storage || template.default_storage, description: description || '' }
    ));

    // Track the provisioned VM — the clone/capacity work above is already done,
    // so those steps are seeded complete and the clone task is left active.
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'clone', label: 'Cloning template', status: 'active' },
      { key: 'configure', label: 'Applying CPU / memory / cloud-init', status: 'pending' },
      { key: 'resize', label: 'Resizing disk', status: 'pending' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
    ]);
    const row = db.prepare(
      "INSERT INTO provisioned_vms (user_id, node, vmid, name, template_id, source_type, steps, status, upid) VALUES (?, ?, ?, ?, ?, 'template', ?, 'cloning', ?)"
    ).run(req.session.userId, template.node, newVmid, vmName, template.id, steps, upid || '');

    // Assignment + lease are written by the background poller once the clone
    // actually succeeds (recordVmOwnership) — writing them here would leave
    // rows pointing at a VM that was never created if the task fails.
    // Admins only get an assignment if they explicitly pick a target user.
    const targetUser = user.is_admin ? (assignTo || null) : req.session.userId;

    // Do config changes after clone finishes — poll in background
    pollAndConfigure(row.lastInsertRowid, template.node, newVmid, upid, {
      cores: finalCores,
      memory: finalMem,
      diskGb: finalDisk,
      cloudInit: template.cloud_init,
      ...cloudInitOpts,
      description,
      vlanTag: vlanTag ? parseInt(vlanTag) : null,
      owner: { userId: targetUser, createdBy: req.session.username },
    }).catch((err) => console.error(`Post-clone config failed for VM ${newVmid}:`, err.message));

    logAudit(req, 'vm_clone', `${template.node}/${newVmid}`, `template:${template.name}`);
    res.json({
      id: row.lastInsertRowid,
      vmid: newVmid,
      ...serializeNodeIdentity(template.node),
      status: 'cloning',
      upid,
    });
  } catch (err) {
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

// ─── Automatic placement for non-admin cloud-image deploys ───────────────────
// The same image (same download URL) may be present on several hosts. Rank
// candidate hosts by guest count (fewest first) and take the first one that
// actually has room: reachable, an images-capable storage with the most free
// space, and enough capacity (assertNodeCapacity). A nearly-full host is
// skipped even when it has fewer VMs — count never beats capacity.
//
// Every skipped host records *why* it was skipped, so a placement failure comes
// back as something the user (and the admin they escalate to) can act on rather
// than a dead end.

// Trim an upstream message down to something safe and readable in a 503 body.
// Our own pre-flight errors carry err.status and a user-facing message; anything
// else is an upstream failure and gets scrubbed of hosts/URLs first.
function placementSkipReason(err) {
  const raw = err?.status ? err.message : sanitizeError(err?.message);
  const text = String(raw || 'unavailable').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

async function autoPlaceImage(image, { memoryMb, diskGb }) {
  const rows = db.prepare(
    "SELECT * FROM cloud_images WHERE status = 'ready' AND volid != '' AND volid NOT LIKE '%:iso/%' AND url = ?"
  ).all(image.url);
  if (rows.length === 0) rows.push(image);

  // A host can be reachable via a per-host image row OR because it shares the
  // storage of a row's disk. Fold both into one candidate per host (first win),
  // carrying the volid as addressed on that host and that host's default pool.
  const byHost = new Map();
  for (const row of rows) {
    for (const t of await imageDeployTargets(row)) {
      if (!byHost.has(t.hostId)) {
        byHost.set(t.hostId, { node: t.nodeRef, volid: t.volid, default_storage: defaultStorageForHost(row, t.hostId) });
      }
    }
  }

  const vms = await getAllVMs();
  const countByHost = new Map();
  for (const vm of vms) countByHost.set(vm.hostId, (countByHost.get(vm.hostId) || 0) + 1);
  const ranked = [...byHost.entries()]
    .map(([hostId, info]) => ({ hostId, ...info }))
    .sort((a, b) => (countByHost.get(a.hostId) || 0) - (countByHost.get(b.hostId) || 0));

  const skipped = [];
  const skip = (nodeValue, reason) => {
    const label = decodeNodeRef(nodeValue).nodeName || String(nodeValue);
    skipped.push(`${label} — ${reason}`);
    console.warn(`[placement] skipping ${nodeValue}: ${reason}`);
  };

  for (const cand of ranked) {
    try {
      // Nodes drained for maintenance never receive auto-placed VMs
      assertNodeAvailable(cand.node);
      // getStorages doubles as the reachability gate — an offline host throws.
      // Users are placed only on storage pools an admin has exposed.
      const all = (await getStorages(cand.node)).filter((s) => s.content?.includes('images'));
      const exposed = await filterExposedStorages(cand.node, all, { isAdmin: false });
      exposed.sort((a, b) => (b.avail || 0) - (a.avail || 0));
      // The image's admin-set default storage wins when it's exposed here
      const preferred = exposed.find((s) => s.storage === cand.default_storage);
      const pick = preferred || exposed[0];
      if (!pick) {
        skip(cand.node, 'no VM storage pool is exposed to you on this host');
        continue;
      }
      await assertNodeCapacity(cand.node, { memoryMb, diskGb, storage: pick.storage });
      return { image: { ...image, node: cand.node, volid: cand.volid }, storage: pick.storage };
    } catch (err) {
      skip(cand.node, placementSkipReason(err));
    }
  }
  return {
    error: {
      status: 503,
      message: skipped.length > 0
        ? `No Proxmox host could take this VM: ${skipped.join('; ')}. Ask your admin on Discord to make room.`
        : 'No Proxmox host currently carries this image — contact your admin on Discord.',
    },
  };
}

// ─── Create a VM directly from a cloud image (no static template) ────────────
//
// Builds a new VM whose boot disk is imported straight from a downloaded cloud
// image (import-from, PVE 7.3+), attaches a cloud-init drive + serial console,
// grows the disk, applies the requested cloud-init user/network, stamps
// owner/VLAN tags, and optionally starts it. The cloud image — not a Proxmox
// template — is the source artifact.

router.post('/from-image', async (req, res) => {
  const user = loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }

  const {
    imageId, name, cores = 2, memoryGb = 2, diskGb = 20,
    storage, bridge = 'vmbr0', description = '', assignTo, vlanTag, start = false, targetNode,
  } = req.body;

  if (!imageId || !name) {
    return res.status(400).json({ error: 'Image and name are required' });
  }

  // PVE VM names must be DNS-like — sanitize before reserving a VMID or running
  // the capacity/quota checks, so a bad name fails fast (utils/vmName.js).
  const vmName = toPveVmName(name);
  if (!vmName) {
    return res.status(400).json({ error: 'Name must contain letters or digits' });
  }

  // `bridge` and the resolved target storage are concatenated into Proxmox
  // property strings, so both must be strict identifiers (storage is validated
  // below, once the image and its default are known). Non-admins can't pick a
  // bridge (the networks list is admin-only) — pinning them to vmbr0 also blocks
  // a `bridge=vmbr0,tag=N` injection that would put the NIC on a VLAN the user
  // has no access to, bypassing the VLAN check below.
  const safeBridge = user.is_admin ? String(bridge || 'vmbr0') : 'vmbr0';
  if (!/^[a-zA-Z0-9._-]+$/.test(safeBridge)) {
    return res.status(400).json({ error: 'Invalid network bridge' });
  }

  const image = db.prepare("SELECT * FROM cloud_images WHERE id = ?").get(imageId);
  if (!image) return res.status(404).json({ error: 'Cloud image not found' });
  if (image.status !== 'ready') {
    return res.status(400).json({ error: `Image is not ready (status: ${image.status})` });
  }
  if (!image.volid || image.volid.includes(':iso/')) {
    return res.status(400).json({ error: 'This image cannot be used as a disk source — remove it and add it again to re-download it as import content' });
  }

  // Resolve the disk target for admins: an explicit choice wins, else the
  // image's admin-set default. Validate here (the value is concatenated into
  // Proxmox property strings) now that the image — and thus its default — is
  // known. Non-admins get host AND storage from automatic placement below.
  let targetImage = image;
  let targetStorage = String(storage || image.default_storage || '').trim();
  if (user.is_admin) {
    if (!targetStorage) {
      return res.status(400).json({ error: 'Storage is required (this image has no default storage set)' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(targetStorage)) {
      return res.status(400).json({ error: 'Invalid storage' });
    }
    // Admins may deploy onto any host the image is reachable from (its own
    // host, or a peer sharing its storage). Resolve the volid as addressed on
    // the chosen host; a target the image can't reach is rejected.
    if (targetNode && targetNode !== image.node) {
      const targets = await imageDeployTargets(image);
      const chosen = targets.find((t) => t.nodeRef === targetNode);
      if (!chosen) {
        return res.status(400).json({ error: 'The selected host cannot reach this image — it is not on storage shared with that host' });
      }
      targetImage = { ...image, node: chosen.nodeRef, volid: chosen.volid };
    }
  }

  const baseDiskGb = parseInt(diskGb, 10);
  if (!Number.isInteger(baseDiskGb) || baseDiskGb < 5) {
    return res.status(400).json({ error: 'Disk size must be at least 5 GB' });
  }
  const memoryMb = Math.round(parseFloat(memoryGb) * 1024);

  // Placement: admins deploy onto the image's own host, or a shared-storage
  // peer they selected via targetNode (resolved above); non-admins land on the
  // least-loaded host that has room for the request.
  if (!user.is_admin) {
    const placed = await autoPlaceImage(image, { memoryMb, diskGb: baseDiskGb });
    if (placed.error) return res.status(placed.error.status).json({ error: placed.error.message });
    targetImage = placed.image;
    targetStorage = placed.storage;
  }

  // Cloud images are always cloud-init capable, so guest settings are honored —
  // and a login credential is mandatory (the image ships with none).
  const parsed = parseCloudInitOptions(req.body, req.session.userId, true);
  if (parsed.error) return res.status(parsed.error.status).json({ error: parsed.error.message });
  const cloudInitOpts = parsed.opts;

  // Authorize the target VLAN. Non-admins must place the VM on a VLAN assigned
  // to them; the untagged/native network is admin-only (utils/vlanAccess.js).
  const vlanErr = checkVlanAssignment(db, { userId: req.session.userId, isAdmin: user.is_admin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  // Enforce storage exposure — never trust the dropdown. Non-admins can't
  // deploy onto a pool an admin has hidden, even by naming it directly.
  try {
    await assertStorageExposed(targetImage.node, targetStorage, user);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  // Refuse deployment to a node the admin has drained for maintenance
  try {
    assertNodeAvailable(targetImage.node);
  } catch (err) {
    return sendError(res, err);
  }

  // CPU topology + node capacity checks run on the placed node (import-from
  // requires the disk source and target to share a host).
  let cpuLayout;
  try {
    cpuLayout = await computeCpuTopology(targetImage.node, cores);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    // Non-validation error — fall back to a plain socket/core split
    cpuLayout = { sockets: 1, cores: parseInt(cores, 10) || 2 };
  }

  let capacityNote = '';
  try {
    const capacity = await assertNodeCapacity(targetImage.node, { memoryMb, diskGb: baseDiskGb, storage: targetStorage });
    capacityNote = capacity?.memoryWarning || '';
    // Per-user resource quota (skips admins / users without quotas)
    await assertUserQuota(req.session.userId, {
      addCores: parseInt(cores, 10) || 0,
      addMemoryMb: memoryMb,
      addDiskGb: baseDiskGb,
    });
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  try {
    const tag = vlanTag ? parseInt(vlanTag) : null;

    // Late allocation + reservation (see /clone above): concurrent deploys can
    // no longer be handed the same id, and a failed create hands its id back.
    const { vmid, result: upid } = await withFreshVmid((id) => createVM(targetImage.node, id, {
      name: vmName,
      cpu: 'host',
      sockets: cpuLayout.sockets,
      cores: cpuLayout.cores,
      memory: memoryMb,
      ostype: 'l26',
      scsihw: 'virtio-scsi-single',
      scsi0: `${targetStorage}:0,import-from=${targetImage.volid}`,
      ide2: `${targetStorage}:cloudinit`,
      boot: 'order=scsi0',
      serial0: 'socket',
      vga: 'serial0',
      net0: tag ? `virtio,bridge=${safeBridge},tag=${tag}` : `virtio,bridge=${safeBridge}`,
      ...(description && { description }),
    }));

    const startNow = !!start;
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'create', label: 'Creating VM & importing cloud image', status: 'active' },
      { key: 'resize', label: 'Resizing disk', status: 'pending' },
      { key: 'cloudinit', label: 'Applying cloud-init config', status: 'pending' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
      { key: 'start', label: startNow ? 'Starting VM' : 'Finalizing', status: 'pending' },
    ]);
    const row = db.prepare(
      "INSERT INTO provisioned_vms (user_id, node, vmid, name, source_type, cloud_image_id, steps, status, upid) VALUES (?, ?, ?, ?, 'cloudimage', ?, ?, 'creating', ?)"
    ).run(req.session.userId, targetImage.node, vmid, vmName, targetImage.id, steps, upid || '');

    // Assignment + lease are written by the background poller once the create
    // actually succeeds (recordVmOwnership) — see /clone above.
    const targetUser = user.is_admin ? (assignTo || null) : req.session.userId;

    finishImageProvision(row.lastInsertRowid, targetImage.node, vmid, upid, {
      diskGb: baseDiskGb,
      ...cloudInitOpts,
      start: startNow,
      owner: { userId: targetUser, createdBy: req.session.username },
    }).catch((err) => console.error(`Cloud-image provision failed for VM ${vmid}:`, err.message));

    logAudit(req, 'vm_from_image', `${targetImage.node}/${vmid}`, `image:${targetImage.name}${user.is_admin ? '' : ' (auto-placed)'}`);
    res.json({
      id: row.lastInsertRowid,
      vmid,
      ...serializeNodeIdentity(targetImage.node),
      status: 'creating',
      upid,
    });
  } catch (err) {
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

// ─── Full VM creation from scratch / ISO (admin OR can_create_vms) ───────────
//
// Gated on can_create_vms so permission-holders can build a VM from an
// available ISO. Non-admin callers are constrained exactly like /from-image:
// the network bridge is pinned to the default (vmbr0) so they can't inject a
// `bridge=...,tag=N` NIC onto a VLAN they lack access to, assignTo is ignored
// (the VM is self-assigned to the creator), and owner/VLAN PVE tags are stamped
// as usual. Node capacity + per-user quota (#18) and storage exposure (#19)
// already run below.

router.post('/create', requirePermission('can_create_vms'), async (req, res) => {
  const isAdmin = !!req.session.isAdmin;
  const {
    node, name, cores = 2, memoryGb = 2,
    diskSize = '20G', storage = 'local-lvm',
    iso, ostype = 'l26',
    bios = 'seabios', scsihw = 'virtio-scsi-single',
    description = '',
    assignTo, vlanTag,
  } = req.body;

  if (!node || !name) {
    return res.status(400).json({ error: 'Node and name are required' });
  }

  // PVE VM names must be DNS-like — sanitize before reserving a VMID or running
  // the capacity/quota checks, so a bad name fails fast instead of coming back
  // as a raw upstream 400 from createVM (utils/vmName.js). The identifier
  // pattern below is the wrong shape for a VM name: it permits "_" and leading
  // or trailing dots, which Proxmox rejects, and caps nothing.
  const vmName = toPveVmName(name);
  if (!vmName) {
    return res.status(400).json({ error: 'Name must contain letters or digits' });
  }

  // Non-admins can't pick a bridge (the networks list is admin-only) — pin them
  // to vmbr0. This also blocks a `bridge=vmbr0,tag=N` injection that would put
  // the NIC on a VLAN the user has no access to, bypassing the VLAN check below.
  const bridge = isAdmin ? String(req.body.bridge || 'vmbr0') : 'vmbr0';

  // These land in PVE property strings — same strict identifier rule as
  // /from-image and /clone. (`name` is not one of them: it is a DNS label, not
  // an identifier, and is validated by toPveVmName above.)
  for (const [field, value] of Object.entries({ storage, bridge, ostype, bios, scsihw })) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(value))) {
      return res.status(400).json({ error: `Invalid ${field}` });
    }
  }
  if (iso && !/^[a-zA-Z0-9._/:-]+$/.test(String(iso))) {
    return res.status(400).json({ error: 'Invalid iso' });
  }

  // Authorize the target VLAN (same guard as /from-image and /clone). Non-admins
  // must place the VM on an assigned VLAN; the untagged/native network is
  // admin-only (utils/vlanAccess.js).
  const vlanErr = checkVlanAssignment(db, { userId: req.session.userId, isAdmin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  // Enforce storage exposure — never trust the dropdown. Non-admin
  // can_create_vms holders can't build onto a pool an admin has hidden,
  // even by naming it directly.
  try {
    await assertStorageExposed(node, storage, { isAdmin });
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  try {
    // Refuse deployment to a node the admin has drained for maintenance
    assertNodeAvailable(node);

    const cpuLayout = await computeCpuTopology(node, cores);

    // Refuse requests the node can't fit. Storage is a hard limit; memory is
    // advisory by default and comes back as a note on the deployment.
    const capacity = await assertNodeCapacity(node, {
      memoryMb: Math.round(parseFloat(memoryGb) * 1024),
      diskGb: String(diskSize).replace(/[^0-9]/g, ''),
      storage,
    });
    const capacityNote = capacity?.memoryWarning || '';
    // Per-user resource quota (skips admins / users without quotas). Now that
    // the route is open to can_create_vms holders, this rail actually bounds
    // non-admin from-scratch builds.
    await assertUserQuota(req.session.userId, {
      addCores: parseInt(cores, 10) || 0,
      addMemoryMb: Math.round(parseFloat(memoryGb) * 1024),
      addDiskGb: parseFloat(String(diskSize).replace(/[^0-9.]/g, '')) || 0,
    });

    const config = {
      name: vmName,
      cpu: 'host',
      sockets: cpuLayout.sockets,
      cores: cpuLayout.cores,
      memory: Math.round(parseFloat(memoryGb) * 1024),
      ostype,
      bios,
      scsihw,
      scsi0: `${storage}:${diskSize.toString().replace(/[^0-9]/g, '')}`,
      net0: vlanTag ? `virtio,bridge=${bridge},tag=${parseInt(vlanTag)}` : `virtio,bridge=${bridge}`,
      ...(iso && { ide2: `${iso},media=cdrom` }),
      ...(description && { description }),
    };

    // Allocate the VMID last, after the capacity/quota rails have passed, and
    // hold it only for the create call itself (see /clone above).
    const { vmid, result: upid } = await withFreshVmid((id) => createVM(node, id, config));

    // Track
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'create', label: 'Creating VM', status: upid ? 'active' : 'done' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
    ]);
    const row = db.prepare(
      "INSERT INTO provisioned_vms (user_id, node, vmid, name, source_type, steps, status, upid) VALUES (?, ?, ?, ?, 'create', ?, 'creating', ?)"
    ).run(req.session.userId, node, vmid, vmName, steps, upid || '');

    // Assign VM — admins only get an assignment if they explicitly pick a
    // target user; non-admins always self-assign (assignTo is ignored).
    const targetUser = isAdmin ? (assignTo || null) : req.session.userId;
    if (targetUser) {
      try {
        db.prepare('INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, ?)')
          .run(targetUser, node, vmid);
      } catch { /* already assigned */ }
    }

    // Start the VM's lease clock at provisioning (default duration from settings)
    createLeaseForVm(node, vmid, { createdBy: req.session.username });

    // Poll for completion, then stamp PVE owner/VLAN tags on the new VM
    if (upid) {
      pollTaskCompletion(row.lastInsertRowid, node, upid)
        .then(async (ok) => {
          setStep(row.lastInsertRowid, 'create', ok ? 'done' : 'error');
          if (!ok) return;
          setStep(row.lastInsertRowid, 'tags', 'active');
          await syncVmTagsSafe(node, vmid);
          setStep(row.lastInsertRowid, 'tags', 'done');
          db.prepare("UPDATE provisioned_vms SET status = 'ready', status_detail = '' WHERE id = ?").run(row.lastInsertRowid);
          notifyDeployment(row.lastInsertRowid);
        })
        .catch((err) => console.error(`Post-create polling failed for VM ${vmid}:`, err.message));
    } else {
      setStep(row.lastInsertRowid, 'tags', 'active');
      db.prepare("UPDATE provisioned_vms SET status = 'ready', status_detail = '' WHERE id = ?").run(row.lastInsertRowid);
      syncVmTagsSafe(node, vmid).finally(() => setStep(row.lastInsertRowid, 'tags', 'done'));
      notifyDeployment(row.lastInsertRowid);
    }

    logAudit(req, 'vm_create', `${node}/${vmid}`, vmName);
    res.json({ id: row.lastInsertRowid, vmid, ...serializeNodeIdentity(node), status: 'creating', upid });
  } catch (err) {
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

// ─── Provisioning status ─────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const where = req.session.isAdmin ? '' : 'WHERE pv.user_id = ?';
  const params = req.session.isAdmin ? [] : [req.session.userId];
  const rows = db.prepare(`
    SELECT pv.*, u.username, t.name as template_name, ci.name as image_name
    FROM provisioned_vms pv
    LEFT JOIN users u ON u.id = pv.user_id
    LEFT JOIN vm_templates t ON t.id = pv.template_id
    LEFT JOIN cloud_images ci ON ci.id = pv.cloud_image_id
    ${where}
    ORDER BY pv.created_at DESC
    LIMIT 50
  `).all(...params);
  res.json(rows.map(serializeProvisionRow));
});

router.get('/status/:id', async (req, res) => {
  const row = db.prepare(`
    SELECT pv.*, t.name as template_name, ci.name as image_name
    FROM provisioned_vms pv
    LEFT JOIN vm_templates t ON t.id = pv.template_id
    LEFT JOIN cloud_images ci ON ci.id = pv.cloud_image_id
    WHERE pv.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!req.session.isAdmin && row.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Resilience: surface a failed PVE task even if the in-process poller missed
  // it (e.g. the backend restarted mid-job). Success is finalized by the
  // background pollers, so we never flip to 'ready' here — that would race the
  // still-running configure/import steps.
  if (row.upid && (row.status === 'cloning' || row.status === 'creating' || row.status === 'configuring')) {
    try {
      const task = await getTaskStatus(row.node, row.upid);
      if (task.status === 'stopped' && task.exitstatus !== 'OK') {
        db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
          .run('error', task.exitstatus || 'Task failed', row.id);
        row.status = 'error';
        row.status_detail = task.exitstatus || 'Task failed';
      }
    } catch { /* ignore */ }
  }

  res.json(serializeProvisionRow(row));
});

// ─── Admin: template CRUD ────────────────────────────────────────────────────

router.get('/admin/templates', requirePermission('can_manage_templates'), (req, res) => {
  const rows = db.prepare('SELECT * FROM vm_templates ORDER BY name').all();
  res.json(rows.map(t => ({
    ...t,
    nodeRef: t.node,
    node: decodeNodeRef(t.node).nodeName || t.node,
  })));
});

router.get('/admin/pve-vms/:node', requirePermission('can_manage_templates'), async (req, res) => {
  // List all qemu VMs on a node — both templates and regular VMs — so admin can pick a source
  try {
    const vms = await getAllVMs();
    const requestedNodeRef = req.params.node;
    const requestedNodeName = decodeNodeRef(requestedNodeRef).nodeName || requestedNodeRef;
    const nodeVms = vms
      .filter(v => v.type === 'qemu' && (v.nodeRef === requestedNodeRef || v.node === requestedNodeName))
      .map(v => ({ vmid: v.vmid, name: v.name, status: v.status, template: !!v.template }))
      .sort((a, b) => (b.template ? 1 : 0) - (a.template ? 1 : 0) || a.vmid - b.vmid);
    res.json(nodeVms);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/admin/pve-vms/:node/:vmid/config', requirePermission('can_manage_templates'), async (req, res) => {
  // Fetch a VM's config so we can auto-populate template defaults
  try {
    const cfg = await getVMConfig(req.params.node, parseInt(req.params.vmid));
    const cores = (cfg.sockets || 1) * (cfg.cores || 1);
    const memoryMb = cfg.memory || 2048;
    // Find the primary disk — check common bus types in priority order
    let diskGb = 20;
    let storage = 'local-lvm';
    const diskBuses = ['scsi0', 'virtio0', 'sata0', 'ide0', 'scsi1', 'virtio1', 'sata1'];
    const diskKey = diskBuses.reduce((found, key) => {
      if (found) return found;
      const val = cfg[key];
      // Skip cloud-init and CD-ROM drives
      if (typeof val === 'string' && !val.includes('cloudinit') && !val.includes('media=cdrom')) return val;
      return found;
    }, '') || '';
    const sizeMatch = diskKey.match(/size=(\d+)G/);
    if (sizeMatch) diskGb = parseInt(sizeMatch[1]);
    const storageMatch = diskKey.match(/^([^:]+):/);
    if (storageMatch) storage = storageMatch[1];
    // Check for cloud-init drive
    const hasCloudInit = Object.keys(cfg).some(k => {
      const val = typeof cfg[k] === 'string' ? cfg[k] : '';
      return val.includes('cloudinit');
    });
    res.json({
      cores,
      memoryMb,
      diskGb,
      storage,
      cloudInit: hasCloudInit,
      name: cfg.name || '',
      description: cfg.description || '',
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/admin/templates', requirePermission('can_manage_templates'), (req, res) => {
  const { name, description, node, vmid, defaultCores, defaultMemory, defaultDiskGb, defaultStorage, cloudInit } = req.body;
  if (!name || !node || !vmid) {
    return res.status(400).json({ error: 'Name, node and VMID are required' });
  }
  try {
    const r = db.prepare(`
      INSERT INTO vm_templates (name, description, node, vmid, default_cores, default_memory, default_disk_gb, default_storage, cloud_init)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description || '', node, parseInt(vmid),
      parseInt(defaultCores) || 2, parseInt(defaultMemory) || 2048,
      parseInt(defaultDiskGb) || 20, defaultStorage || 'local-lvm',
      cloudInit ? 1 : 0);
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'This VM is already registered as a template' });
    }
    throw err;
  }
});

router.put('/admin/templates/:id', requirePermission('can_manage_templates'), (req, res) => {
  const { name, description, defaultCores, defaultMemory, defaultDiskGb, defaultStorage, cloudInit, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare(`
    UPDATE vm_templates SET name = ?, description = ?, default_cores = ?, default_memory = ?,
    default_disk_gb = ?, default_storage = ?, cloud_init = ?, enabled = ?
    WHERE id = ?
  `).run(name, description || '',
    parseInt(defaultCores) || 2, parseInt(defaultMemory) || 2048,
    parseInt(defaultDiskGb) || 20, defaultStorage || 'local-lvm',
    cloudInit ? 1 : 0, enabled !== false ? 1 : 0,
    req.params.id);
  res.json({ ok: true });
});

router.delete('/admin/templates/:id', requirePermission('can_manage_templates'), (req, res) => {
  db.prepare('DELETE FROM vm_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Background task polling ─────────────────────────────────────────────────

// Write the portal-side ownership rows (VM assignment + lease clock) for a VM
// that now really exists. /clone and /from-image used to write these the moment
// the create was *submitted*; when the Proxmox task then failed, the rows were
// left pointing at a VM that never existed and nothing cleaned them up (vms.js
// only deletes them on an explicit VM delete). Called from the pollers once the
// clone/create task reports OK, and always before the tags step — syncVmTagsSafe
// reads the assignment to stamp the owner tag.
function recordVmOwnership(node, vmid, owner) {
  if (!owner) return;
  if (owner.userId) {
    try {
      db.prepare('INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, ?)')
        .run(owner.userId, node, vmid);
    } catch { /* may already be assigned */ }
  }
  try {
    createLeaseForVm(node, vmid, { createdBy: owner.createdBy });
  } catch (err) {
    console.error(`Failed to start the lease clock for VM ${vmid}:`, err.message);
  }
}

// Polls a PVE task to completion. Returns true on success. On failure/timeout
// it writes a terminal status + detail so the error is visible; on success it
// leaves the status untouched so the caller can finalize after its own
// post-task work (configure, resize, tags, start).
async function pollTaskCompletion(provisionId, node, upid, { maxAttempts = 120 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const task = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        if (task.exitstatus === 'OK') return true;
        db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
          .run('error', task.exitstatus || 'Task failed', provisionId);
        notifyDeployment(provisionId);
        return false;
      }
    } catch { /* keep polling */ }
  }
  db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
    .run('timeout', 'Timed out while waiting for the Proxmox task to finish', provisionId);
  notifyDeployment(provisionId);
  return false;
}

async function pollAndConfigure(provisionId, node, vmid, upid, opts) {
  // Wait for clone task to finish
  if (upid) {
    const ok = await pollTaskCompletion(provisionId, node, upid);
    setStep(provisionId, 'clone', ok ? 'done' : 'error');
    if (!ok) return;
  } else {
    setStep(provisionId, 'clone', 'done');
  }

  // The VM exists now — claim it for its owner and start the lease clock
  recordVmOwnership(node, vmid, opts.owner);

  // Apply post-clone configuration
  db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
    .run('configuring', '', provisionId);
  setStep(provisionId, 'configure', 'active');

  try {
    const config = {};
    const warnings = [];
    if (opts.cores) {
      const cpuLayout = await computeCpuTopology(node, opts.cores);
      config.cpu = 'host';
      config.sockets = cpuLayout.sockets;
      config.cores = cpuLayout.cores;
    }
    if (opts.memory) config.memory = parseInt(opts.memory);
    if (opts.description) config.description = opts.description;

    // Cloud-init settings
    if (opts.cloudInit) {
      if (opts.ciUser) config.ciuser = opts.ciUser;
      if (opts.ciPassword) config.cipassword = opts.ciPassword;
      if (opts.sshKeys) config.sshkeys = encodeURIComponent(opts.sshKeys);
      if (opts.ipConfig) config.ipconfig0 = opts.ipConfig;
    }

    if (Object.keys(config).length > 0) {
      await updateVMConfig(node, vmid, config);
    }
    setStep(provisionId, 'configure', 'done');

    // Resize disk if needed
    setStep(provisionId, 'resize', 'active');
    if (opts.diskGb) {
      try {
        await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
        setStep(provisionId, 'resize', 'done');
      } catch {
        // Try virtio0 if scsi0 doesn't exist
        try {
          await resizeVMDisk(node, vmid, 'virtio0', `${opts.diskGb}G`);
          setStep(provisionId, 'resize', 'done');
        } catch {
          warnings.push(`Disk resize to ${opts.diskGb}G failed`);
          setStep(provisionId, 'resize', 'skipped', `resize to ${opts.diskGb}G failed`);
        }
      }
    } else {
      setStep(provisionId, 'resize', 'skipped');
    }

    // Apply VLAN tag to net0 if requested
    if (opts.vlanTag) {
      try {
        const vmCfg = await getVMConfig(node, vmid);
        const net0 = vmCfg.net0 || '';
        if (net0) {
          let parts = net0.split(',');
          parts = parts.filter(p => !p.startsWith('tag='));
          parts.push(`tag=${opts.vlanTag}`);
          await updateVMConfig(node, vmid, { net0: parts.join(',') });
        }
      } catch (err) {
        console.error(`Failed to set VLAN tag ${opts.vlanTag} on VM ${vmid}:`, err.message);
        warnings.push(`Failed to apply VLAN tag ${opts.vlanTag}`);
      }
    }

    // Stamp PVE owner/VLAN tags now that assignment + net config are final
    setStep(provisionId, 'tags', 'active');
    await syncVmTagsSafe(node, vmid);
    setStep(provisionId, 'tags', 'done');

    if (warnings.length > 0) {
      db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
        .run('warning', warnings.join('; '), provisionId);
    } else {
      db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
        .run('ready', '', provisionId);
    }
    notifyDeployment(provisionId);
  } catch (err) {
    console.error(`Post-clone config failed for VM ${vmid}:`, err.message);
    setStep(provisionId, 'configure', 'error', err.message);
    db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
      .run('warning', err.message || 'Post-clone configuration failed', provisionId);
    notifyDeployment(provisionId);
  }
}

// Background driver for the direct cloud-image flow: wait for the create+import
// task, grow the boot disk, apply cloud-init, stamp tags, optionally start.
async function finishImageProvision(provisionId, node, vmid, upid, opts) {
  const ok = await pollTaskCompletion(provisionId, node, upid, { maxAttempts: 240 });
  setStep(provisionId, 'create', ok ? 'done' : 'error');
  if (!ok) return; // status already error/timeout

  // The VM exists now — claim it for its owner and start the lease clock
  recordVmOwnership(node, vmid, opts.owner);

  db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
    .run('configuring', '', provisionId);
  const warnings = [];

  // Grow the imported boot disk
  setStep(provisionId, 'resize', 'active');
  if (opts.diskGb) {
    try {
      await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
      setStep(provisionId, 'resize', 'done');
    } catch (err) {
      warnings.push(`Disk resize to ${opts.diskGb}G failed`);
      setStep(provisionId, 'resize', 'skipped', `resize to ${opts.diskGb}G failed`);
    }
  } else {
    setStep(provisionId, 'resize', 'skipped');
  }

  // Apply cloud-init user / password / SSH keys / network
  setStep(provisionId, 'cloudinit', 'active');
  try {
    const config = {};
    if (opts.ciUser) config.ciuser = opts.ciUser;
    if (opts.ciPassword) config.cipassword = opts.ciPassword;
    if (opts.sshKeys) config.sshkeys = encodeURIComponent(opts.sshKeys);
    config.ipconfig0 = opts.ipConfig || 'ip=dhcp';
    await updateVMConfig(node, vmid, config);
    setStep(provisionId, 'cloudinit', 'done');
  } catch (err) {
    warnings.push('Cloud-init configuration failed');
    setStep(provisionId, 'cloudinit', 'error', err.message);
  }

  // Owner / VLAN tags (net0 was set with the VLAN tag at create time)
  setStep(provisionId, 'tags', 'active');
  await syncVmTagsSafe(node, vmid);
  setStep(provisionId, 'tags', 'done');

  // Optionally start the VM
  if (opts.start) {
    setStep(provisionId, 'start', 'active');
    try {
      await startVM(node, vmid);
      setStep(provisionId, 'start', 'done');
    } catch (err) {
      warnings.push('VM created but failed to start');
      setStep(provisionId, 'start', 'error', err.message);
    }
  } else {
    setStep(provisionId, 'start', 'done');
  }

  db.prepare('UPDATE provisioned_vms SET status = ?, status_detail = ? WHERE id = ?')
    .run(warnings.length ? 'warning' : 'ready', warnings.join('; '), provisionId);
  notifyDeployment(provisionId);
}

export default router;
