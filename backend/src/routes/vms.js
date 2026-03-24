import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import {
  getVMStatus, vmAction, getVNCTicket, getVMConfig, updateVMConfig, getAllVMs, getVMRRD,
  getVMBackups, createVMBackup, deleteVMBackup, getBackupStorages,
  restoreVMBackup, listBackupFiles, downloadBackupFile,
  getLXCStatus, lxcAction, getLXCConfig, updateLXCConfig, getLXCRRD, getLXCVNCTicket,
  getSnapshots, createSnapshot, deleteSnapshot, rollbackSnapshot,
} from '../proxmox.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { userCanAccessVm } from '../utils/vmAccess.js';
import { decodeNodeRef } from '../utils/nodeRef.js';

const router = Router();
router.use(requireAuth);

// Short-lived VNC session store (token → {node, vmid, ticket, port, expires})
export const vncSessions = new Map();

function checkAccess(userId, node, vmid, isAdmin) {
  return userCanAccessVm(userId, node, vmid, isAdmin);
}

function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

// ─── User's assigned VMs ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const user = db.prepare('SELECT see_all_vms FROM users WHERE id = ?').get(req.session.userId);

  if (user?.see_all_vms) {
    try {
      const vms = await getAllVMs();
      return res.json(vms.map(vm => ({
        ...vm,
        ...serializeNodeIdentity(vm.nodeRef || vm.node),
      })));
    } catch (err) {
      return res.status(500).json({ error: sanitizeError(err.message) });
    }
  }

  const assignments = db.prepare('SELECT * FROM vm_assignments WHERE user_id = ?').all(req.session.userId);

  const results = await Promise.all(assignments.map(async (a) => {
    const nodeIdentity = serializeNodeIdentity(a.node);
    try {
      const status = await getVMStatus(a.node, a.vmid);
      return { ...status, ...nodeIdentity, assignmentId: a.id };
    } catch {
      return { vmid: a.vmid, ...nodeIdentity, name: `VM ${a.vmid}`, status: 'error', assignmentId: a.id };
    }
  }));

  res.json(results);
});

// ─── VM Status ────────────────────────────────────────────────────────────────

router.get('/:node/:vmid/status', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    try {
      res.json({ ...(await getVMStatus(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10), type: 'qemu' });
    } catch {
      res.json({ ...(await getLXCStatus(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10), type: 'lxc' });
    }
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Actions ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/action', async (req, res) => {
  const { node, vmid } = req.params;
  const { action } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!['start', 'stop', 'reboot', 'shutdown'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    let upid;
    try {
      upid = await vmAction(node, vmid, action);
    } catch {
      upid = await lxcAction(node, vmid, action);
    }
    logAudit(req, 'vm_action', `${node}/${vmid}`, action);
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM RRD data ──────────────────────────────────────────────────────────────

router.get('/:node/:vmid/rrddata', async (req, res) => {
  const { node, vmid } = req.params;
  const { timeframe = 'hour' } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Try qemu first, fall back to lxc
    let data;
    try {
      data = await getVMRRD(node, vmid, 'qemu', timeframe);
    } catch {
      data = await getVMRRD(node, vmid, 'lxc', timeframe);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VNC ticket ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/vnc-ticket', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    let vncData;
    let vmtype = 'qemu';
    try {
      vncData = await getVNCTicket(node, vmid);
    } catch {
      vncData = await getLXCVNCTicket(node, vmid);
      vmtype = 'lxc';
    }
    const token = uuidv4();

    // Purge expired sessions
    for (const [k, v] of vncSessions) {
      if (v.expires < Date.now()) vncSessions.delete(k);
    }

    vncSessions.set(token, {
      userId: req.session.userId,
      sessionId: req.sessionID,
      node, vmid, vmtype,
      ticket: vncData.ticket,
      port:   vncData.port,
      expires: Date.now() + 120_000, // 2 min to establish connection
    });

    // Return ticket so noVNC can use it as VNC password
    res.json({ token, ticket: vncData.ticket });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Config / VLAN ────────────────────────────────────────────────────────

router.get('/:node/:vmid/config', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    try {
      res.json({ ...(await getVMConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    } catch {
      res.json({ ...(await getLXCConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    }
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/:node/:vmid/vlan', async (req, res) => {
  const { node, vmid } = req.params;
  const { netInterface = 'net0', vlanTag } = req.body;

  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Non-admins: verify they have access to the requested VLAN
  if (!req.session.isAdmin && vlanTag !== null && vlanTag !== 0) {
    const allowed = db.prepare(`
      SELECT v.id FROM vlans v
      JOIN user_vlans uv ON uv.vlan_id = v.id
      WHERE uv.user_id = ? AND v.tag = ?
    `).get(req.session.userId, parseInt(vlanTag));

    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to that VLAN' });
    }
  }

  try {
    const config = await getVMConfig(node, vmid);
    const current = config[netInterface];
    if (!current) {
      return res.status(400).json({ error: `Interface ${netInterface} not found on this VM` });
    }

    // Parse "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=100,firewall=1" style string
    let parts = current.split(',');
    if (vlanTag === null || vlanTag === 0 || vlanTag === '') {
      parts = parts.filter(p => !p.startsWith('tag='));
    } else if (parts.some(p => p.startsWith('tag='))) {
      parts = parts.map(p => p.startsWith('tag=') ? `tag=${vlanTag}` : p);
    } else {
      parts.push(`tag=${vlanTag}`);
    }

    await updateVMConfig(node, vmid, { [netInterface]: parts.join(',') });
    logAudit(req, 'vlan_change', `${node}/${vmid}`, `${netInterface}=tag:${vlanTag}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Backups ──────────────────────────────────────────────────────────────

router.get('/:node/:vmid/backups', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await getVMBackups(node, vmid));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/:node/:vmid/backup-storages', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await getBackupStorages(node));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/:node/:vmid/backup', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { mode, compress, storage, notes } = req.body;
  try {
    const upid = await createVMBackup(node, vmid, { mode, compress, storage, notes });
    logAudit(req, 'backup_create', `${node}/${vmid}`, storage || '');
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/:node/:vmid/backups/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0];
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    await deleteVMBackup(node, storage, volid);
    logAudit(req, 'backup_delete', `${node}/${vmid}`, volid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Restore VM from backup ──────────────────────────────────────────────────

router.post('/:node/:vmid/restore', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { archive, storage } = req.body;
  if (!archive) return res.status(400).json({ error: 'archive (volid) is required' });
  try {
    const vmtype = archive.includes('vzdump-lxc-') ? 'lxc' : 'qemu';
    const upid = await restoreVMBackup(node, vmid, archive, storage, vmtype);
    logAudit(req, 'vm_restore', `${node}/${vmid}`, archive);
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── File-level restore (browse backup contents) ────────────────────────────

router.get('/:node/:vmid/backup-files/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0]; // everything after storage/
  const { filepath = '/' } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const files = await listBackupFiles(node, storage, volid, filepath);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/:node/:vmid/backup-download/:storage/*', async (req, res) => {
  const { node, vmid, storage } = req.params;
  const volid = req.params[0]; // everything after storage/
  const { filepath } = req.query;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!filepath) return res.status(400).json({ error: 'filepath is required' });
  try {
    const { stream, headers } = await downloadBackupFile(node, storage, volid, filepath);
    const contentType = headers['content-type'] || 'application/octet-stream';
    // filepath is base64-encoded by Proxmox — decode to get real path
    let realName = 'download';
    try {
      const decoded = Buffer.from(filepath, 'base64').toString('utf-8');
      realName = decoded.split('/').filter(Boolean).pop() || 'download';
    } catch { /* use default */ }
    // Proxmox returns directories as tar archives
    const isArchive = contentType.includes('tar') || contentType.includes('octet-stream');
    if (isArchive && !realName.includes('.')) {
      realName += '.tar.zst';
    }
    // Sanitize filename to prevent header injection
    const safeName = realName.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Snapshots ───────────────────────────────────────────────────────────

router.get('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    let snaps;
    try { snaps = await getSnapshots(node, vmid, 'qemu'); }
    catch { snaps = await getSnapshots(node, vmid, 'lxc'); }
    // Filter out 'current' pseudo-snapshot and sort by snaptime
    const filtered = (snaps || []).filter(s => s.name !== 'current');
    filtered.sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  const { name, description, vmstate } = req.body;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!name) return res.status(400).json({ error: 'Snapshot name is required' });
  try {
    let upid;
    try { upid = await createSnapshot(node, vmid, 'qemu', name, description, vmstate); }
    catch { upid = await createSnapshot(node, vmid, 'lxc', name, description, false); }
    logAudit(req, 'snapshot_create', `${node}/${vmid}`, name);
    res.json({ ok: true, upid });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/:node/:vmid/snapshots/:snapname', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    try { await deleteSnapshot(node, vmid, 'qemu', snapname); }
    catch { await deleteSnapshot(node, vmid, 'lxc', snapname); }
    logAudit(req, 'snapshot_delete', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/:node/:vmid/snapshots/:snapname/rollback', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!checkAccess(req.session.userId, node, vmid, req.session.isAdmin)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    try { await rollbackSnapshot(node, vmid, 'qemu', snapname); }
    catch { await rollbackSnapshot(node, vmid, 'lxc', snapname); }
    logAudit(req, 'snapshot_rollback', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── User's allowed VLANs ────────────────────────────────────────────────────

router.get('/my-vlans', (req, res) => {
  if (req.session.isAdmin) {
    return res.json(db.prepare('SELECT * FROM vlans ORDER BY tag').all());
  }
  const vlans = db.prepare(`
    SELECT v.* FROM vlans v
    JOIN user_vlans uv ON uv.vlan_id = v.id
    WHERE uv.user_id = ?
    ORDER BY v.tag
  `).all(req.session.userId);
  res.json(vlans);
});

export default router;
