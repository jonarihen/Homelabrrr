import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmTemplates } from '../../db/schema/index.ts';
import { withFreshVmid, cloneVM, getVMConfigCurrent } from '../../proxmox.ts';
import { sendError, hasHttpStatus, tagStatus } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { recordBackgroundProvisionFailure } from '../../services/provisionFailure.ts';
import { checkVlanAssignment } from '../../utils/vlanAccess.ts';
import { assertStorageExposed } from '../../utils/storageVisibility.ts';
import { computeCpuTopology } from '../../utils/cpuTopology.ts';
import { assertNodeCapacity } from '../../utils/capacity.ts';
import { assertNodeAvailable } from '../../utils/nodeMaintenance.ts';
import { assertUserQuota, cloneDiskAllocation } from '../../utils/quota.ts';
import { toPveVmName } from '../../utils/vmName.ts';
import { startBackgroundWork } from '../../services/backgroundWork.ts';
import { submitProvision } from '../../services/provisionOwnership.ts';
import { serializeNodeIdentity, stepList, parseCloudInitOptions, loadProvisioner } from './shared.ts';
import { releaseCapacityAfter, pollAndConfigure } from './tasks.ts';

const router = Router();

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

  // Charged and sent to PVE as-is, so only plain positive integers: "0" would
  // be charged as 0 but built as 2 vCPUs, "+500" would become a relative resize.
  const finalCores = cores ?? template.default_cores;
  const finalDisk = diskGb ?? template.default_disk_gb;
  if (!/^[1-9]\d*$/.test(String(finalCores))) return res.status(400).json({ error: 'Cores must be a positive integer' });
  if (!/^[1-9]\d*$/.test(String(finalDisk))) return res.status(400).json({ error: 'Disk size must be a positive whole number of GB' });

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
  let cpuLayout;
  try {
    cpuLayout = await computeCpuTopology(template.node, finalCores);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  // Refuse requests the node can't fit. Storage is a hard limit; memory is
  // advisory by default (capacity policy — see utils/capacityPolicy.js) and
  // comes back as a note recorded on the deployment.
  const finalMem = memoryGb ? Math.round(parseFloat(memoryGb) * 1024) : template.default_memory;
  let capacityNote = '';
  let cloneDiskGb: number;
  let resizeDisk: string | null;
  // Held from the capacity check until the deploy job ends (#284).
  let releaseCapacity = () => {};
  try {
    const allocation = cloneDiskAllocation(await getVMConfigCurrent(template.node, template.vmid), Number(finalDisk));
    cloneDiskGb = allocation.diskGb;
    resizeDisk = allocation.resizeDisk;
    const capacity = await assertNodeCapacity(template.node, {
      memoryMb: finalMem,
      diskGb: cloneDiskGb,
      storage: storage || template.default_storage,
      reserve: true,
    });
    capacityNote = capacity.memoryWarning;
    releaseCapacity = capacity.release;
    // Per-user resource quota (skips admins / users without quotas)
    await assertUserQuota(req.session.userId, {
      addCores: cpuLayout.totalVcpus,
      addMemoryMb: finalMem,
      addDiskGb: cloneDiskGb,
    });
  } catch (err) {
    releaseCapacity();
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  try {
    // Allocate the VMID as late as possible and hold a reservation on it for
    // the duration of the clone submit, so a second deploy running right now
    // can't be handed the same id. withFreshVmid retries once if Proxmox says
    // the id is taken anyway, and releases the reservation if the clone fails.
    const submit = (onReserved: (vmid: number) => Promise<void>, marker: string) => withFreshVmid((vmid: number) => cloneVM(
      template.node,
      template.vmid,
      vmid,
      vmName,
      { storage: storage || template.default_storage, description: `${description || ''}\n${marker}` }
    ), { onReserved });

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
    const targetUser = user.is_admin ? (assignTo ? Number(assignTo) : null) : req.session.userId;
    const { provisionId, vmid: newVmid, upid } = await submitProvision({
      user_id: req.session.userId, node: template.node, vmid: 0, name: vmName,
      template_id: template.id, source_type: 'template', steps, status: 'cloning', request_id: req.requestId || '',
    }, {
      userId: targetUser, createdBy: req.session.username,
      cores: cpuLayout.totalVcpus, memoryMb: finalMem, diskGb: cloneDiskGb,
    }, submit);

    // Do config changes after clone finishes — poll in background
    startBackgroundWork(() => pollAndConfigure(provisionId, template.node, newVmid, upid, {
      cores: Number(finalCores),
      memory: finalMem,
      diskGb: Number(finalDisk),
      resizeDisk,
      cloudInit: template.cloud_init,
      ...cloudInitOpts,
      description,
      vlanTag: vlanTag ? parseInt(vlanTag) : null,
    }), { kind: 'provision', id: provisionId, requestId: req.requestId })
      .catch((err: any) => recordBackgroundProvisionFailure(provisionId, newVmid, 'provision_clone_background_failed', err))
      .finally(() => releaseCapacityAfter(template.node, upid, releaseCapacity));

    await logAudit(req, 'vm_clone', `${template.node}/${newVmid}`, `template:${template.name}`);
    res.json({
      id: provisionId,
      vmid: newVmid,
      ...serializeNodeIdentity(template.node),
      status: 'cloning',
      upid,
    });
  } catch (err: any) {
    releaseCapacity();
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

export default router;
