import { Router } from 'express';
import db from '../db.js';
import {
  getNextVmid, cloneVM, createVM, updateVMConfig, resizeVMDisk,
  getStorages, getISOImages, getNetworks, getNodes, getTaskStatus,
  getAllVMs,
} from '../proxmox.js';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';

const router = Router();
router.use(requireAuth);

// ─── Templates (public, read-only for users) ────────────────────────────────

router.get('/templates', (req, res) => {
  const templates = db.prepare(
    'SELECT * FROM vm_templates WHERE enabled = 1 ORDER BY name'
  ).all();
  res.json(templates);
});

// ─── Proxmox resources (for form dropdowns) ─────────────────────────────────

router.get('/nodes', async (req, res) => {
  try {
    res.json(await getNodes());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/nodes/:node/storages', async (req, res) => {
  try {
    const storages = await getStorages(req.params.node);
    res.json(storages);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/nodes/:node/isos/:storage', async (req, res) => {
  try {
    res.json(await getISOImages(req.params.node, req.params.storage));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/nodes/:node/networks', async (req, res) => {
  try {
    res.json(await getNetworks(req.params.node));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Clone from template (user or admin) ─────────────────────────────────────

router.post('/clone', async (req, res) => {
  // Check permission
  const user = db.prepare('SELECT can_provision, is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }

  const { templateId, name, cores, memory, diskGb, storage, description } = req.body;
  if (!templateId || !name) {
    return res.status(400).json({ error: 'Template and name are required' });
  }

  const template = db.prepare('SELECT * FROM vm_templates WHERE id = ? AND enabled = 1').get(templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  try {
    const newVmid = await getNextVmid();

    // Clone
    const upid = await cloneVM(
      template.node,
      template.vmid,
      newVmid,
      name,
      { storage: storage || template.default_storage, description: description || '' }
    );

    // Track the provisioned VM
    const row = db.prepare(
      'INSERT INTO provisioned_vms (user_id, node, vmid, name, template_id, status, upid) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.session.userId, template.node, newVmid, name, template.id, 'cloning', upid || '');

    // Auto-assign VM to user
    try {
      db.prepare('INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, ?)')
        .run(req.session.userId, template.node, newVmid);
    } catch { /* may already be assigned */ }

    // Queue post-clone config update (cores, memory, cloud-init)
    const finalCores = cores || template.default_cores;
    const finalMem = memory || template.default_memory;
    const finalDisk = diskGb || template.default_disk_gb;

    // Do config changes after clone finishes — poll in background
    pollAndConfigure(row.lastInsertRowid, template.node, newVmid, upid, {
      cores: finalCores,
      memory: finalMem,
      diskGb: finalDisk,
      cloudInit: template.cloud_init,
      description,
    });

    logAudit(req, 'vm_clone', `${template.node}/${newVmid}`, `template:${template.name}`);
    res.json({
      id: row.lastInsertRowid,
      vmid: newVmid,
      node: template.node,
      status: 'cloning',
      upid,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Full VM creation (admin only) ──────────────────────────────────────────

router.post('/create', requirePermission('can_create_vms'), async (req, res) => {
  const {
    node, name, cores = 2, memory = 2048,
    diskSize = '20G', storage = 'local-lvm',
    iso, bridge = 'vmbr0', ostype = 'l26',
    bios = 'seabios', scsihw = 'virtio-scsi-single',
    description = '',
    assignTo,
  } = req.body;

  if (!node || !name) {
    return res.status(400).json({ error: 'Node and name are required' });
  }

  try {
    const vmid = await getNextVmid();

    const config = {
      name,
      cores: parseInt(cores),
      memory: parseInt(memory),
      ostype,
      bios,
      scsihw,
      scsi0: `${storage}:${diskSize.toString().replace(/[^0-9]/g, '')}`,
      net0: `virtio,bridge=${bridge}`,
      ...(iso && { ide2: `${iso},media=cdrom` }),
      ...(description && { description }),
    };

    const upid = await createVM(node, vmid, config);

    // Track
    const row = db.prepare(
      'INSERT INTO provisioned_vms (user_id, node, vmid, name, status, upid) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.session.userId, node, vmid, name, 'creating', upid || '');

    // Assign to target user — only admins can assign to someone else
    const targetUser = (assignTo && req.session.isAdmin) ? assignTo : req.session.userId;
    try {
      db.prepare('INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, ?)')
        .run(targetUser, node, vmid);
    } catch { /* already assigned */ }

    // Poll for completion
    if (upid) {
      pollTaskCompletion(row.lastInsertRowid, node, upid);
    } else {
      db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run('ready', row.lastInsertRowid);
    }

    logAudit(req, 'vm_create', `${node}/${vmid}`, name);
    res.json({ id: row.lastInsertRowid, vmid, node, status: 'creating', upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Provisioning status ─────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const where = req.session.isAdmin ? '' : 'WHERE pv.user_id = ?';
  const params = req.session.isAdmin ? [] : [req.session.userId];
  const rows = db.prepare(`
    SELECT pv.*, u.username, t.name as template_name
    FROM provisioned_vms pv
    LEFT JOIN users u ON u.id = pv.user_id
    LEFT JOIN vm_templates t ON t.id = pv.template_id
    ${where}
    ORDER BY pv.created_at DESC
    LIMIT 50
  `).all(...params);
  res.json(rows);
});

router.get('/status/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM provisioned_vms WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!req.session.isAdmin && row.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // If still in progress, check task status
  if (row.upid && (row.status === 'cloning' || row.status === 'creating' || row.status === 'configuring')) {
    try {
      const task = await getTaskStatus(row.node, row.upid);
      if (task.status === 'stopped') {
        const newStatus = task.exitstatus === 'OK' ? 'ready' : 'error';
        db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run(newStatus, row.id);
        row.status = newStatus;
      }
    } catch { /* ignore */ }
  }

  res.json(row);
});

// ─── Admin: template CRUD ────────────────────────────────────────────────────

router.get('/admin/templates', requirePermission('can_manage_templates'), (req, res) => {
  res.json(db.prepare('SELECT * FROM vm_templates ORDER BY name').all());
});

router.get('/admin/pve-templates/:node', requirePermission('can_manage_templates'), async (req, res) => {
  // List VMs on a node that are marked as templates in Proxmox
  try {
    const vms = await getAllVMs();
    const templates = vms.filter(v => v.template && v.node === req.params.node);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
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

async function pollTaskCompletion(provisionId, node, upid, maxAttempts = 120) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const task = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        const newStatus = task.exitstatus === 'OK' ? 'ready' : 'error';
        db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run(newStatus, provisionId);
        return task.exitstatus === 'OK';
      }
    } catch { /* keep polling */ }
  }
  db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run('timeout', provisionId);
  return false;
}

async function pollAndConfigure(provisionId, node, vmid, upid, opts) {
  // Wait for clone task to finish
  if (upid) {
    const ok = await pollTaskCompletion(provisionId, node, upid);
    if (!ok) return;
  }

  // Apply post-clone configuration
  db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run('configuring', provisionId);

  try {
    const config = {};
    if (opts.cores) config.cores = parseInt(opts.cores);
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

    // Resize disk if needed
    if (opts.diskGb) {
      try {
        await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
      } catch {
        // Try virtio0 if scsi0 doesn't exist
        try { await resizeVMDisk(node, vmid, 'virtio0', `${opts.diskGb}G`); } catch { /* ignore */ }
      }
    }

    db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run('ready', provisionId);
  } catch (err) {
    console.error(`Post-clone config failed for VM ${vmid}:`, err.message);
    db.prepare('UPDATE provisioned_vms SET status = ? WHERE id = ?').run('ready', provisionId);
    // Still mark ready — the VM exists, just config may not have been fully applied
  }
}

export default router;
