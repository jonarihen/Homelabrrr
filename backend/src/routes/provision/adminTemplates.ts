import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmTemplates } from '../../db/schema/index.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { getAllVMs, getVMConfig } from '../../proxmox.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { sendError } from '../../utils/httpError.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';

const router = Router();

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
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Template not found' });
  await db.update(vmTemplates).set({
    name, description: description || '',
    default_cores: parseInt(defaultCores) || 2,
    default_memory: parseInt(defaultMemory) || 2048,
    default_disk_gb: parseInt(defaultDiskGb) || 20,
    default_storage: defaultStorage || 'local-lvm',
    cloud_init: !!cloudInit,
    enabled: enabled !== false,
  }).where(eq(vmTemplates.id, id));
  res.json({ ok: true });
});

router.delete('/admin/templates/:id', requirePermission('can_manage_templates'), async (req: any, res: any) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Template not found' });
  await db.delete(vmTemplates).where(eq(vmTemplates.id, id));
  res.json({ ok: true });
});

export default router;
