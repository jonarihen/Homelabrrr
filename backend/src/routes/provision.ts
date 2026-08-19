import { Router } from 'express';
import { and, eq, ne, desc, inArray, notLike, getTableColumns } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  provisionedVms, users, sshKeys, vmTemplates, cloudImages, pveHosts, vmAssignments,
} from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import {
  withFreshVmid, cloneVM, createVM, updateVMConfig, resizeVMDisk, startVM,
  getStorages, getISOImages, getNetworks, getNodes, getTaskStatus,
  getAllVMs, getVMConfig,
} from '../proxmox.ts';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/auth.ts';
import { sendError, hasHttpStatus, tagStatus } from '../utils/httpError.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { logAudit } from '../utils/audit.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { decodeNodeRef } from '../utils/nodeRef.ts';
import { imageDeployTargets, defaultStorageForHost } from '../utils/cloudImageTargets.ts';
import { checkVlanAssignment } from '../utils/vlanAccess.ts';
import { assertStorageExposed, filterExposedStorages } from '../utils/storageVisibility.ts';
import { computeCpuTopology } from '../utils/cpuTopology.ts';
import { assertNodeCapacity } from '../utils/capacity.ts';
import { assertNodeAvailable } from '../utils/nodeMaintenance.ts';
import { assertUserQuota, getUserQuota, getUserResourceUsage } from '../utils/quota.ts';
import { syncVmTagsSafe } from '../utils/vmTags.ts';
import { getRolePermissions } from '../utils/permissions.ts';
import { createLeaseForVm } from '../utils/leases.ts';
import { toPveVmName } from '../utils/vmName.ts';
import { resolveSshKeys, unusableKeysError, assertLoginPossible } from '../utils/cloudInitCredentials.ts';
import { validatePassword } from '../utils/validation.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';

const router = Router();
router.use(requireAuth);

function serializeNodeIdentity(nodeValue: any) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

function serializeProvisionRow(row: any) {
  // steps is a jsonb column — it arrives as an array already.
  const steps = Array.isArray(row.steps) ? row.steps : [];
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

// Normalize a step list into the jsonb-ready array stored on the row.
function stepList(steps: any[]) {
  return steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' }));
}

async function setStep(provisionId: number, key: string, status: string, note?: string) {
  const [row] = await db.select({ steps: provisionedVms.steps })
    .from(provisionedVms).where(eq(provisionedVms.id, provisionId)).limit(1);
  const steps: any[] = Array.isArray(row?.steps) ? (row!.steps as any[]) : [];
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  await db.update(provisionedVms).set({ steps }).where(eq(provisionedVms.id, provisionId));
}

// Fire a Discord notification for a deployment that has reached a terminal
// state. Reads the current row so it maps status → deployment.finished (ready /
// warning) or deployment.failed (error / timeout). Fire-and-forget: notify()
// never throws, so this can never break the provisioning flow.
async function notifyDeployment(provisionId: number) {
  try {
    const [row] = await db
      .select({ ...getTableColumns(provisionedVms), username: users.username })
      .from(provisionedVms)
      .leftJoin(users, eq(users.id, provisionedVms.user_id))
      .where(eq(provisionedVms.id, provisionId))
      .limit(1);
    if (!row) return;
    const failed = row.status === 'error' || row.status === 'timeout';
    const { nodeName } = decodeNodeRef(row.node);
    await notify(failed ? 'deployment.failed' : 'deployment.finished', {
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

async function parseCloudInitOptions(
  { ciUser, ciPassword, sshKeyIds, ipMode, ipAddress, ipGateway }: any,
  userId: number,
  cloudInitCapable = false,
): Promise<{ opts: any } | { error: { status: number; message: string } }> {
  const opts: any = {};
  if (ciUser) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(ciUser)) {
      return { error: { status: 400, message: 'Invalid cloud-init username (lowercase letters, digits, - and _)' } };
    }
    opts.ciUser = ciUser;
  }
  if (ciPassword) {
    try { opts.ciPassword = validatePassword(String(ciPassword), 'Cloud-init password'); }
    catch (err: any) { return { error: { status: 400, message: err.message } }; }
  }
  if (Array.isArray(sshKeyIds) && sshKeyIds.length > 0) {
    // Load every requested row — including the ones with no stored public key —
    // so a key that can't be installed is named back to the user instead of
    // being filtered out and the deploy running on with no key at all.
    const numericIds = sshKeyIds.map(Number).filter(Number.isInteger);
    const rows = numericIds.length > 0
      ? await db.select({ id: sshKeys.id, name: sshKeys.name, public_key: sshKeys.public_key })
        .from(sshKeys)
        .where(and(eq(sshKeys.user_id, userId), inArray(sshKeys.id, numericIds)))
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
  } catch (err: any) {
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
async function loadProvisioner(req: any) {
  const [user] = await db
    .select({
      id: users.id, can_provision: users.can_provision, is_admin: users.is_admin, role_id: users.role_id,
    })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1);
  if (!user) return user;
  return {
    ...user,
    can_provision: user.role_id
      ? (await getRolePermissions(user.role_id)).has('can_provision')
      : user.can_provision,
  };
}

// ─── Own quota + current usage (any authenticated user) ─────────────────────

router.get('/quota', async (req: any, res: any) => {
  try {
    const quota = await getUserQuota(req.session.userId);
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

router.get('/templates', async (req: any, res: any) => {
  const templates = await db.select().from(vmTemplates)
    .where(eq(vmTemplates.enabled, true))
    .orderBy(vmTemplates.name);
  res.json(templates.map((t: any) => ({
    ...t,
    nodeRef: t.node,
    node: decodeNodeRef(t.node).nodeName || t.node,
  })));
});

// ─── Cloud images available to provision directly (read-only, provisioners) ──

router.get('/images', async (req: any, res: any) => {
  const user = await loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }
  // Only ready images stored as import content can be used as an import-from
  // disk source; iso-content rows (downloaded before the import switch) can't.
  const rows = await db.select({
    id: cloudImages.id, name: cloudImages.name, url: cloudImages.url, node: cloudImages.node,
    storage: cloudImages.storage, default_storage: cloudImages.default_storage,
    default_storage_map: cloudImages.default_storage_map, volid: cloudImages.volid, size: cloudImages.size,
  }).from(cloudImages)
    .where(and(eq(cloudImages.status, 'ready'), ne(cloudImages.volid, ''), notLike(cloudImages.volid, '%:iso/%')))
    .orderBy(cloudImages.name);
  const hostRows = await db.select({ id: pveHosts.id, name: pveHosts.name }).from(pveHosts);
  const hostNames = new Map(hostRows.map((h) => [h.id, h.name]));
  const out = [];
  for (const r of rows) {
    const { hostId, nodeName, nodeRef } = decodeNodeRef(r.node);
    // Every host this image can be deployed from — its own host plus any peer
    // sharing its storage. Each target carries the per-host default target pool
    // so the deploy form can pre-select it as the host is switched.
    const targets = (await imageDeployTargets(r)).map((t: any) => ({
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
router.get('/nodes', requirePermission('can_manage_templates', 'can_create_vms'), async (req: any, res: any) => {
  try {
    res.json(await getNodes());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/storages', requirePermission('can_provision', 'can_manage_templates', 'can_create_vms'), async (req: any, res: any) => {
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
router.get('/nodes/:node/isos/:storage', requirePermission('can_create_vms'), async (req: any, res: any) => {
  try {
    await assertStorageExposed(req.params.node, req.params.storage, { isAdmin: req.session.isAdmin });
    res.json(await getISOImages(req.params.node, req.params.storage));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/networks', requireAdmin, async (req: any, res: any) => {
  try {
    res.json(await getNetworks(req.params.node));
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Clone from template (user or admin) ─────────────────────────────────────

router.post('/clone', async (req: any, res: any) => {
  // Check permission
  const user = await loadProvisioner(req);
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

  const numericTemplateId = Number(templateId);
  const [template] = Number.isInteger(numericTemplateId)
    ? await db.select().from(vmTemplates)
      .where(and(eq(vmTemplates.id, numericTemplateId), eq(vmTemplates.enabled, true))).limit(1)
    : [];
  if (!template) return res.status(404).json({ error: 'Template not found' });

  // Cloud-init guest settings (only honored for cloud-init templates)
  let cloudInitOpts: any = {};
  if (template.cloud_init) {
    const parsed = await parseCloudInitOptions(req.body, req.session.userId, true);
    if ('error' in parsed) return res.status(parsed.error.status).json({ error: parsed.error.message });
    cloudInitOpts = parsed.opts;
  }

  // Authorize the target VLAN. Non-admins must place the VM on a VLAN assigned
  // to them; the untagged/native network is admin-only (utils/vlanAccess.js).
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin: !!user.is_admin, vlanTag });
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
    await assertNodeAvailable(template.node);
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
    const { vmid: newVmid, result: upid } = await withFreshVmid((vmid: number) => cloneVM(
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
    const [inserted] = await db.insert(provisionedVms).values({
      user_id: req.session.userId, node: template.node, vmid: newVmid, name: vmName,
      template_id: template.id, source_type: 'template', steps, status: 'cloning',
      upid: upid || '', request_id: req.requestId || '',
    }).returning({ id: provisionedVms.id });
    const provisionId = inserted.id;

    // Assignment + lease are written by the background poller once the clone
    // actually succeeds (recordVmOwnership) — writing them here would leave
    // rows pointing at a VM that was never created if the task fails.
    // Admins only get an assignment if they explicitly pick a target user.
    const targetUser = user.is_admin ? (assignTo || null) : req.session.userId;

    // Do config changes after clone finishes — poll in background
    startBackgroundWork(() => pollAndConfigure(provisionId, template.node, newVmid, upid, {
      cores: finalCores,
      memory: finalMem,
      diskGb: finalDisk,
      cloudInit: template.cloud_init,
      ...cloudInitOpts,
      description,
      vlanTag: vlanTag ? parseInt(vlanTag) : null,
      owner: { userId: targetUser, createdBy: req.session.username },
    }), { kind: 'provision', id: provisionId, requestId: req.requestId })
      .catch((err: any) => console.error(`Post-clone config failed for VM ${newVmid}:`, err.message));

    await logAudit(req, 'vm_clone', `${template.node}/${newVmid}`, `template:${template.name}`);
    res.json({
      id: provisionId,
      vmid: newVmid,
      ...serializeNodeIdentity(template.node),
      status: 'cloning',
      upid,
    });
  } catch (err: any) {
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
function placementSkipReason(err: any) {
  const raw = err?.status ? err.message : sanitizeError(err?.message);
  const text = String(raw || 'unavailable').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

async function autoPlaceImage(image: any, { memoryMb, diskGb }: any) {
  const rows = await db.select().from(cloudImages)
    .where(and(
      eq(cloudImages.status, 'ready'),
      ne(cloudImages.volid, ''),
      notLike(cloudImages.volid, '%:iso/%'),
      eq(cloudImages.url, image.url),
    ));
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
    .map(([hostId, info]: any) => ({ hostId, ...info }))
    .sort((a: any, b: any) => (countByHost.get(a.hostId) || 0) - (countByHost.get(b.hostId) || 0));

  const skipped: string[] = [];
  const skip = (nodeValue: any, reason: string) => {
    const label = decodeNodeRef(nodeValue).nodeName || String(nodeValue);
    skipped.push(`${label} — ${reason}`);
    console.warn(`[placement] skipping ${nodeValue}: ${reason}`);
  };

  for (const cand of ranked) {
    try {
      // Nodes drained for maintenance never receive auto-placed VMs
      await assertNodeAvailable(cand.node);
      // getStorages doubles as the reachability gate — an offline host throws.
      // Users are placed only on storage pools an admin has exposed.
      const all = (await getStorages(cand.node)).filter((s: any) => s.content?.includes('images'));
      const exposed = await filterExposedStorages(cand.node, all, { isAdmin: false });
      exposed.sort((a: any, b: any) => (b.avail || 0) - (a.avail || 0));
      // The image's admin-set default storage wins when it's exposed here
      const preferred = exposed.find((s: any) => s.storage === cand.default_storage);
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

router.post('/from-image', async (req: any, res: any) => {
  const user = await loadProvisioner(req);
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

  const numericImageId = Number(imageId);
  const [image] = Number.isInteger(numericImageId)
    ? await db.select().from(cloudImages).where(eq(cloudImages.id, numericImageId)).limit(1)
    : [];
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
  let targetImage: any = image;
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
      const chosen = targets.find((t: any) => t.nodeRef === targetNode);
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
    if ('error' in placed) return res.status(placed.error.status).json({ error: placed.error.message });
    targetImage = placed.image;
    targetStorage = placed.storage;
  }

  // Cloud images are always cloud-init capable, so guest settings are honored —
  // and a login credential is mandatory (the image ships with none).
  const parsed = await parseCloudInitOptions(req.body, req.session.userId, true);
  if ('error' in parsed) return res.status(parsed.error.status).json({ error: parsed.error.message });
  const cloudInitOpts = parsed.opts;

  // Authorize the target VLAN. Non-admins must place the VM on a VLAN assigned
  // to them; the untagged/native network is admin-only (utils/vlanAccess.js).
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin: !!user.is_admin, vlanTag });
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
    await assertNodeAvailable(targetImage.node);
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
    const { vmid, result: upid } = await withFreshVmid((id: number) => createVM(targetImage.node, id, {
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
    const [inserted] = await db.insert(provisionedVms).values({
      user_id: req.session.userId, node: targetImage.node, vmid, name: vmName,
      source_type: 'cloudimage', cloud_image_id: targetImage.id, steps, status: 'creating',
      upid: upid || '', request_id: req.requestId || '',
    }).returning({ id: provisionedVms.id });
    const provisionId = inserted.id;

    // Assignment + lease are written by the background poller once the create
    // actually succeeds (recordVmOwnership) — see /clone above.
    const targetUser = user.is_admin ? (assignTo || null) : req.session.userId;

    startBackgroundWork(() => finishImageProvision(provisionId, targetImage.node, vmid, upid, {
      diskGb: baseDiskGb,
      ...cloudInitOpts,
      start: startNow,
      owner: { userId: targetUser, createdBy: req.session.username },
    }), { kind: 'provision', id: provisionId, requestId: req.requestId })
      .catch((err: any) => console.error(`Cloud-image provision failed for VM ${vmid}:`, err.message));

    await logAudit(req, 'vm_from_image', `${targetImage.node}/${vmid}`, `image:${targetImage.name}${user.is_admin ? '' : ' (auto-placed)'}`);
    res.json({
      id: provisionId,
      vmid,
      ...serializeNodeIdentity(targetImage.node),
      status: 'creating',
      upid,
    });
  } catch (err: any) {
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

router.post('/create', requirePermission('can_create_vms'), async (req: any, res: any) => {
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
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin, vlanTag });
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
    await assertNodeAvailable(node);

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
    const { vmid, result: upid } = await withFreshVmid((id: number) => createVM(node, id, config));

    // Track
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'create', label: 'Creating VM', status: upid ? 'active' : 'done' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
    ]);
    const [inserted] = await db.insert(provisionedVms).values({
      user_id: req.session.userId, node, vmid, name: vmName,
      source_type: 'create', steps, status: 'creating',
      upid: upid || '', request_id: req.requestId || '',
    }).returning({ id: provisionedVms.id });
    const provisionId = inserted.id;

    // Assign VM — admins only get an assignment if they explicitly pick a
    // target user; non-admins always self-assign (assignTo is ignored).
    const targetUser = isAdmin ? (assignTo || null) : req.session.userId;
    if (targetUser) {
      // ON CONFLICT DO NOTHING — a VM already assigned stays put.
      await db.insert(vmAssignments).values({ user_id: targetUser, node, vmid }).onConflictDoNothing();
    }

    // Start the VM's lease clock at provisioning (default duration from settings)
    await createLeaseForVm(node, vmid, { createdBy: req.session.username });

    // Poll for completion, then stamp PVE owner/VLAN tags on the new VM
    if (upid) {
      startBackgroundWork(() => pollTaskCompletion(provisionId, node, upid)
        .then(async (ok) => {
          await setStep(provisionId, 'create', ok ? 'done' : 'error');
          if (!ok) return;
          await setStep(provisionId, 'tags', 'active');
          await syncVmTagsSafe(node, vmid);
          await setStep(provisionId, 'tags', 'done');
          await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
          await notifyDeployment(provisionId);
        }), { kind: 'provision', id: provisionId, requestId: req.requestId })
        .catch((err: any) => console.error(`Post-create polling failed for VM ${vmid}:`, err.message));
    } else {
      await setStep(provisionId, 'tags', 'active');
      await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
      startBackgroundWork(
        () => syncVmTagsSafe(node, vmid).finally(() => setStep(provisionId, 'tags', 'done')),
        { kind: 'tag-sync', id: provisionId, requestId: req.requestId },
      ).catch((err: any) => console.error(`Post-create tag sync failed for VM ${vmid}:`, err.message));
      await notifyDeployment(provisionId);
    }

    await logAudit(req, 'vm_create', `${node}/${vmid}`, vmName);
    res.json({ id: provisionId, vmid, ...serializeNodeIdentity(node), status: 'creating', upid });
  } catch (err: any) {
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

// ─── Provisioning status ─────────────────────────────────────────────────────

router.get('/status', async (req: any, res: any) => {
  const rows = await db
    .select({
      ...getTableColumns(provisionedVms),
      username: users.username,
      template_name: vmTemplates.name,
      image_name: cloudImages.name,
    })
    .from(provisionedVms)
    .leftJoin(users, eq(users.id, provisionedVms.user_id))
    .leftJoin(vmTemplates, eq(vmTemplates.id, provisionedVms.template_id))
    .leftJoin(cloudImages, eq(cloudImages.id, provisionedVms.cloud_image_id))
    .where(req.session.isAdmin ? undefined : eq(provisionedVms.user_id, req.session.userId))
    .orderBy(desc(provisionedVms.created_at))
    .limit(50);
  res.json(rows.map(serializeProvisionRow));
});

router.get('/status/:id', async (req: any, res: any) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  const [row] = await db
    .select({
      ...getTableColumns(provisionedVms),
      template_name: vmTemplates.name,
      image_name: cloudImages.name,
    })
    .from(provisionedVms)
    .leftJoin(vmTemplates, eq(vmTemplates.id, provisionedVms.template_id))
    .leftJoin(cloudImages, eq(cloudImages.id, provisionedVms.cloud_image_id))
    .where(eq(provisionedVms.id, id))
    .limit(1);
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
        await db.update(provisionedVms)
          .set({ status: 'error', status_detail: task.exitstatus || 'Task failed' })
          .where(eq(provisionedVms.id, row.id));
        row.status = 'error';
        row.status_detail = task.exitstatus || 'Task failed';
      }
    } catch { /* ignore */ }
  }

  res.json(serializeProvisionRow(row));
});

// ─── Admin: template CRUD ────────────────────────────────────────────────────

router.get('/admin/templates', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  const rows = await db.select().from(vmTemplates).orderBy(vmTemplates.name);
  res.json(rows.map((t: any) => ({
    ...t,
    nodeRef: t.node,
    node: decodeNodeRef(t.node).nodeName || t.node,
  })));
});

router.get('/admin/pve-vms/:node', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  // List all qemu VMs on a node — both templates and regular VMs — so admin can pick a source
  try {
    const vms = await getAllVMs();
    const requestedNodeRef = req.params.node;
    const requestedNodeName = decodeNodeRef(requestedNodeRef).nodeName || requestedNodeRef;
    const nodeVms = vms
      .filter((v: any) => v.type === 'qemu' && (v.nodeRef === requestedNodeRef || v.node === requestedNodeName))
      .map((v: any) => ({ vmid: v.vmid, name: v.name, status: v.status, template: !!v.template }))
      .sort((a: any, b: any) => (b.template ? 1 : 0) - (a.template ? 1 : 0) || a.vmid - b.vmid);
    res.json(nodeVms);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/admin/pve-vms/:node/:vmid/config', requirePermission('can_manage_templates'), async (req: any, res: any) => {
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

router.post('/admin/templates', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  const { name, description, node, vmid, defaultCores, defaultMemory, defaultDiskGb, defaultStorage, cloudInit } = req.body;
  if (!name || !node || !vmid) {
    return res.status(400).json({ error: 'Name, node and VMID are required' });
  }
  try {
    const [r] = await db.insert(vmTemplates).values({
      name, description: description || '', node, vmid: parseInt(vmid),
      default_cores: parseInt(defaultCores) || 2,
      default_memory: parseInt(defaultMemory) || 2048,
      default_disk_gb: parseInt(defaultDiskGb) || 20,
      default_storage: defaultStorage || 'local-lvm',
      cloud_init: !!cloudInit,
    }).returning({ id: vmTemplates.id });
    res.json({ id: r.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'This VM is already registered as a template' });
    }
    throw err;
  }
});

router.put('/admin/templates/:id', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  const { name, description, defaultCores, defaultMemory, defaultDiskGb, defaultStorage, cloudInit, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  await db.update(vmTemplates).set({
    name, description: description || '',
    default_cores: parseInt(defaultCores) || 2,
    default_memory: parseInt(defaultMemory) || 2048,
    default_disk_gb: parseInt(defaultDiskGb) || 20,
    default_storage: defaultStorage || 'local-lvm',
    cloud_init: !!cloudInit,
    enabled: enabled !== false,
  }).where(eq(vmTemplates.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.delete('/admin/templates/:id', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  await db.delete(vmTemplates).where(eq(vmTemplates.id, Number(req.params.id)));
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
async function recordVmOwnership(node: string, vmid: number, owner: any) {
  if (!owner) return;
  if (owner.userId) {
    // ON CONFLICT DO NOTHING — the VM may already be assigned.
    await db.insert(vmAssignments).values({ user_id: owner.userId, node, vmid }).onConflictDoNothing();
  }
  try {
    await createLeaseForVm(node, vmid, { createdBy: owner.createdBy });
  } catch (err: any) {
    console.error(`Failed to start the lease clock for VM ${vmid}:`, err.message);
  }
}

// Polls a PVE task to completion. Returns true on success. On failure/timeout
// it writes a terminal status + detail so the error is visible; on success it
// leaves the status untouched so the caller can finalize after its own
// post-task work (configure, resize, tags, start).
async function pollTaskCompletion(provisionId: number, node: string, upid: string, { maxAttempts = 120 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const task = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        if (task.exitstatus === 'OK') return true;
        await db.update(provisionedVms)
          .set({ status: 'error', status_detail: task.exitstatus || 'Task failed' })
          .where(eq(provisionedVms.id, provisionId));
        await notifyDeployment(provisionId);
        return false;
      }
    } catch { /* keep polling */ }
  }
  await db.update(provisionedVms)
    .set({ status: 'timeout', status_detail: 'Timed out while waiting for the Proxmox task to finish' })
    .where(eq(provisionedVms.id, provisionId));
  await notifyDeployment(provisionId);
  return false;
}

async function pollAndConfigure(provisionId: number, node: string, vmid: number, upid: string, opts: any) {
  // Wait for clone task to finish
  if (upid) {
    const ok = await pollTaskCompletion(provisionId, node, upid);
    await setStep(provisionId, 'clone', ok ? 'done' : 'error');
    if (!ok) return;
  } else {
    await setStep(provisionId, 'clone', 'done');
  }

  // The VM exists now — claim it for its owner and start the lease clock
  await recordVmOwnership(node, vmid, opts.owner);

  // Apply post-clone configuration
  await db.update(provisionedVms).set({ status: 'configuring', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
  await setStep(provisionId, 'configure', 'active');

  try {
    const config: any = {};
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
    await setStep(provisionId, 'configure', 'done');

    // Resize disk if needed
    await setStep(provisionId, 'resize', 'active');
    if (opts.diskGb) {
      try {
        await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
        await setStep(provisionId, 'resize', 'done');
      } catch {
        // Try virtio0 if scsi0 doesn't exist
        try {
          await resizeVMDisk(node, vmid, 'virtio0', `${opts.diskGb}G`);
          await setStep(provisionId, 'resize', 'done');
        } catch {
          warnings.push(`Disk resize to ${opts.diskGb}G failed`);
          await setStep(provisionId, 'resize', 'skipped', `resize to ${opts.diskGb}G failed`);
        }
      }
    } else {
      await setStep(provisionId, 'resize', 'skipped');
    }

    // Apply VLAN tag to net0 if requested
    if (opts.vlanTag) {
      try {
        const vmCfg = await getVMConfig(node, vmid);
        const net0 = vmCfg.net0 || '';
        if (net0) {
          let parts = net0.split(',');
          parts = parts.filter((p: string) => !p.startsWith('tag='));
          parts.push(`tag=${opts.vlanTag}`);
          await updateVMConfig(node, vmid, { net0: parts.join(',') });
        }
      } catch (err: any) {
        console.error(`Failed to set VLAN tag ${opts.vlanTag} on VM ${vmid}:`, err.message);
        warnings.push(`Failed to apply VLAN tag ${opts.vlanTag}`);
      }
    }

    // Stamp PVE owner/VLAN tags now that assignment + net config are final
    await setStep(provisionId, 'tags', 'active');
    await syncVmTagsSafe(node, vmid);
    await setStep(provisionId, 'tags', 'done');

    if (warnings.length > 0) {
      await db.update(provisionedVms).set({ status: 'warning', status_detail: warnings.join('; ') }).where(eq(provisionedVms.id, provisionId));
    } else {
      await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
    }
    await notifyDeployment(provisionId);
  } catch (err: any) {
    console.error(`Post-clone config failed for VM ${vmid}:`, err.message);
    await setStep(provisionId, 'configure', 'error', err.message);
    await db.update(provisionedVms)
      .set({ status: 'warning', status_detail: err.message || 'Post-clone configuration failed' })
      .where(eq(provisionedVms.id, provisionId));
    await notifyDeployment(provisionId);
  }
}

// Background driver for the direct cloud-image flow: wait for the create+import
// task, grow the boot disk, apply cloud-init, stamp tags, optionally start.
async function finishImageProvision(provisionId: number, node: string, vmid: number, upid: string, opts: any) {
  const ok = await pollTaskCompletion(provisionId, node, upid, { maxAttempts: 240 });
  await setStep(provisionId, 'create', ok ? 'done' : 'error');
  if (!ok) return; // status already error/timeout

  // The VM exists now — claim it for its owner and start the lease clock
  await recordVmOwnership(node, vmid, opts.owner);

  await db.update(provisionedVms).set({ status: 'configuring', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
  const warnings = [];

  // Grow the imported boot disk
  await setStep(provisionId, 'resize', 'active');
  if (opts.diskGb) {
    try {
      await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
      await setStep(provisionId, 'resize', 'done');
    } catch (err) {
      warnings.push(`Disk resize to ${opts.diskGb}G failed`);
      await setStep(provisionId, 'resize', 'skipped', `resize to ${opts.diskGb}G failed`);
    }
  } else {
    await setStep(provisionId, 'resize', 'skipped');
  }

  // Apply cloud-init user / password / SSH keys / network
  await setStep(provisionId, 'cloudinit', 'active');
  try {
    const config: any = {};
    if (opts.ciUser) config.ciuser = opts.ciUser;
    if (opts.ciPassword) config.cipassword = opts.ciPassword;
    if (opts.sshKeys) config.sshkeys = encodeURIComponent(opts.sshKeys);
    config.ipconfig0 = opts.ipConfig || 'ip=dhcp';
    await updateVMConfig(node, vmid, config);
    await setStep(provisionId, 'cloudinit', 'done');
  } catch (err: any) {
    warnings.push('Cloud-init configuration failed');
    await setStep(provisionId, 'cloudinit', 'error', err.message);
  }

  // Owner / VLAN tags (net0 was set with the VLAN tag at create time)
  await setStep(provisionId, 'tags', 'active');
  await syncVmTagsSafe(node, vmid);
  await setStep(provisionId, 'tags', 'done');

  // Optionally start the VM
  if (opts.start) {
    await setStep(provisionId, 'start', 'active');
    try {
      await startVM(node, vmid);
      await setStep(provisionId, 'start', 'done');
    } catch (err: any) {
      warnings.push('VM created but failed to start');
      await setStep(provisionId, 'start', 'error', err.message);
    }
  } else {
    await setStep(provisionId, 'start', 'done');
  }

  await db.update(provisionedVms)
    .set({ status: warnings.length ? 'warning' : 'ready', status_detail: warnings.join('; ') })
    .where(eq(provisionedVms.id, provisionId));
  await notifyDeployment(provisionId);
}

export default router;
