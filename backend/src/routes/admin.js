import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { getAllVMs, getHostStatus, getHosts, getHost, getVMConfig } from '../proxmox.js';
import { createClient, vlanTagToSubnet } from '../fortigate.js';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { encryptSecret } from '../utils/secrets.js';
import { decodeNodeRef } from '../utils/nodeRef.js';
import { userCanAccessVm } from '../utils/vmAccess.js';
import { syncVmTagsSafe } from '../utils/vmTags.js';

const router = Router();
// All admin routes require at least authentication
router.use(requireAuth);

// Permission middleware shortcuts
const pUsers       = requirePermission('can_manage_users');
const pAssignments = requirePermission('can_manage_assignments', 'can_manage_users');
const pHosts       = requirePermission('can_manage_hosts');
const pFirewalls   = requirePermission('can_manage_firewalls');
const pPortForwards = requirePermission('can_manage_firewalls', 'can_manage_port_forwards');
const pVlans       = requirePermission('can_manage_vlans');
const pPolicies    = requirePermission('can_manage_policies');
const pTemplates   = requirePermission('can_manage_templates');
const pAudit       = requirePermission('can_view_audit_log');
const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// Check if a non-admin user has access to a VLAN via user_vlans
function userOwnsVlan(userId, vlanId) {
  return !!db.prepare('SELECT 1 FROM user_vlans WHERE user_id = ? AND vlan_id = ?').get(userId, vlanId);
}

function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

function canManageAllPortForwards(req) {
  if (req.session.isAdmin) return true;
  const user = db.prepare('SELECT can_manage_firewalls FROM users WHERE id = ?').get(req.session.userId);
  return user?.can_manage_firewalls === 1;
}

function getScopedFirewallSyncs(userId, firewallId, unrestricted = false) {
  if (unrestricted) {
    return db.prepare(`
      SELECT fvs.interface_name, v.id as vlan_id, v.name as vlan_name, v.tag as vlan_tag
      FROM firewall_vlan_sync fvs
      JOIN vlans v ON v.id = fvs.vlan_id
      WHERE fvs.firewall_id = ?
    `).all(firewallId);
  }

  return db.prepare(`
    SELECT fvs.interface_name, v.id as vlan_id, v.name as vlan_name, v.tag as vlan_tag
    FROM firewall_vlan_sync fvs
    JOIN vlans v ON v.id = fvs.vlan_id
    JOIN user_vlans uv ON uv.vlan_id = v.id AND uv.user_id = ?
    WHERE fvs.firewall_id = ?
  `).all(userId, firewallId);
}

async function getScopedPortForwardTargets(req, fw) {
  const unrestricted = canManageAllPortForwards(req);
  const scopedSyncs = getScopedFirewallSyncs(req.session.userId, fw.id, unrestricted);
  const tagToInterface = new Map(scopedSyncs.map(sync => [sync.vlan_tag, sync.interface_name]));

  const vms = await getAllVMs();
  const sshConfigs = db.prepare('SELECT node, vmid, host, port FROM vm_ssh_configs').all();
  const sshMap = new Map(sshConfigs.map(config => [`${config.node}/${config.vmid}`, config]));
  const rawVmCounts = new Map();
  vms.forEach(vm => {
    const key = `${vm.node}/${vm.vmid}`;
    rawVmCounts.set(key, (rawVmCounts.get(key) || 0) + 1);
  });

  const vmList = vms.filter(vm => {
    if (vm.type !== 'qemu' && vm.type !== 'lxc') return false;
    const hasSshConfig = sshMap.has(`${vm.nodeRef || vm.node}/${vm.vmid}`)
      || (rawVmCounts.get(`${vm.node}/${vm.vmid}`) === 1 && sshMap.has(`${vm.node}/${vm.vmid}`));
    if (!hasSshConfig) return false;
    if (unrestricted) return true;
    return userCanAccessVm(req.session.userId, vm.nodeRef || vm.node, vm.vmid, req.session.isAdmin);
  });

  const configResults = await Promise.allSettled(
    vmList.map(async vm => {
      const routeNode = vm.nodeRef || vm.node;
      try {
        const cfg = await getVMConfig(routeNode, vm.vmid);
        const net0 = cfg.net0 || '';
        const tagMatch = net0.match(/tag=(\d+)/);
        return { key: `${routeNode}/${vm.vmid}`, vlanTag: tagMatch ? parseInt(tagMatch[1], 10) : null };
      } catch {
        return { key: `${routeNode}/${vm.vmid}`, vlanTag: null };
      }
    })
  );

  const vlanTagMap = new Map();
  for (const result of configResults) {
    if (result.status === 'fulfilled') vlanTagMap.set(result.value.key, result.value.vlanTag);
  }

  const rootDstInterface = fw.root_vdom_link || 'lab-root1';

  return vmList
    .map(vm => {
      const routeNode = vm.nodeRef || vm.node;
      const rawKey = `${vm.node}/${vm.vmid}`;
      const ssh = sshMap.get(`${routeNode}/${vm.vmid}`)
        || (rawVmCounts.get(rawKey) === 1 ? sshMap.get(rawKey) : null);
      const vlanTag = vlanTagMap.get(`${routeNode}/${vm.vmid}`) || null;
      const vlanInterface = vlanTag ? (tagToInterface.get(vlanTag) || '') : '';
      return {
        node: vm.node,
        nodeRef: routeNode,
        vmid: vm.vmid,
        name: vm.name || `VM ${vm.vmid}`,
        status: vm.status,
        type: vm.type,
        ip: ssh?.host || '',
        sshPort: ssh?.port || 22,
        vlanTag,
        dstInterface: vlanInterface ? rootDstInterface : '',
        vlanInterface,
      };
    })
    .filter(target => unrestricted || !!target.vlanInterface)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Users ────────────────────────────────────────────────────────────────────

const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MAX = 10;

function ensureCanManageTargetUser(req, res, userId) {
  if (req.session.isAdmin) return true;

  const target = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return false;
  }
  if (target.is_admin) {
    res.status(403).json({ error: 'Only admins can modify admin accounts' });
    return false;
  }
  return true;
}

router.get('/users', pUsers, (req, res) => {
  const windowStart = Date.now() - LOCKOUT_WINDOW_MS;
  const users = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.see_all_vms, u.can_provision, u.can_create_vms, u.totp_enabled, u.require_2fa,
      u.can_manage_hosts, u.can_manage_firewalls, u.can_manage_port_forwards, u.can_manage_vlans, u.can_manage_policies,
      u.can_manage_templates, u.can_manage_users, u.can_manage_assignments, u.can_view_audit_log, u.can_edit_vm_hardware,
      u.created_at,
      (SELECT COUNT(*) FROM vm_assignments WHERE user_id = u.id) as vm_count,
      (SELECT COUNT(*) FROM login_attempts WHERE username = u.username AND attempted_at > ?) as recent_failures,
      (SELECT COALESCE(MAX(ip_count), 0) FROM (
        SELECT COUNT(*) AS ip_count FROM login_attempts
        WHERE username = u.username AND attempted_at > ? GROUP BY ip
      )) as max_ip_failures
    FROM users u
    ORDER BY u.username
  `).all(windowStart, windowStart);
  // Lockout is per (username, ip) — a user counts as locked when any single
  // address has hit the limit
  res.json(users.map(u => ({ ...u, locked: u.max_ip_failures >= LOCKOUT_MAX, twoFactorEnabled: !!u.totp_enabled, require2fa: !!u.require_2fa, canProvision: !!u.can_provision, canCreateVms: !!u.can_create_vms })));
});

router.post('/users', pUsers, (req, res) => {
  const { username, password, isAdmin } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (isAdmin && !req.session.isAdmin) {
    return res.status(403).json({ error: 'Only admins can create admin accounts' });
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = db.prepare(
      'INSERT INTO users (username, password, is_admin) VALUES (?, ?, ?)'
    ).run(username, hash, isAdmin ? 1 : 0);
    logAudit(req, 'admin_create_user', username, '');
    res.json({ id: r.lastInsertRowid, username, isAdmin: !!isAdmin });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

router.post('/users/:id/reset-2fa', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.params.id);
  logAudit(req, 'admin_reset_2fa', req.params.id, '');
  res.json({ ok: true });
});

router.post('/users/:id/unlock', pUsers, (req, res) => {
  if (!ensureCanManageTargetUser(req, res, req.params.id)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM login_attempts WHERE username = ?').run(user.username);
  logAudit(req, 'admin_unlock_user', req.params.id, '');
  res.json({ ok: true });
});

router.put('/users/:id/username', pUsers, (req, res) => {
  if (!ensureCanManageTargetUser(req, res, req.params.id)) return;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const previous = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.params.id);
    retagUserVms(req.params.id, previous?.username);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    throw err;
  }
});

// Re-stamp the PVE owner tag on a user's VMs after a rename; the old
// username no longer exists in the users table, so pass it as retired.
function retagUserVms(userId, previousUsername) {
  const vms = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(userId);
  for (const vm of vms) {
    syncVmTagsSafe(vm.node, vm.vmid, { retired: [previousUsername].filter(Boolean) });
  }
}

router.put('/users/:id/password', pUsers, (req, res) => {
  if (!ensureCanManageTargetUser(req, res, req.params.id)) return;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
  logAudit(req, 'admin_reset_password', req.params.id, '');
  res.json({ ok: true });
});

router.put('/users/:id/require-2fa', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  db.prepare('UPDATE users SET require_2fa = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.put('/users/:id/see-all-vms', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  db.prepare('UPDATE users SET see_all_vms = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.put('/users/:id/can-provision', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  db.prepare('UPDATE users SET can_provision = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Permission toggle endpoint for all granular permissions
router.put('/users/:id/permission', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { permission, enabled } = req.body;
  const validPerms = ['can_manage_hosts', 'can_manage_firewalls', 'can_manage_port_forwards', 'can_manage_vlans', 'can_manage_policies', 'can_manage_templates', 'can_manage_users', 'can_manage_assignments', 'can_view_audit_log', 'can_edit_vm_hardware'];
  if (!validPerms.includes(permission)) {
    return res.status(400).json({ error: `Invalid permission: ${permission}` });
  }
  db.prepare(`UPDATE users SET ${permission} = ? WHERE id = ?`).run(enabled ? 1 : 0, req.params.id);
  logAudit(req, 'admin_toggle_permission', req.params.id, `${permission}=${enabled ? 1 : 0}`);
  res.json({ ok: true });
});

router.delete('/users/:id', pUsers, async (req, res) => {
  if (!ensureCanManageTargetUser(req, res, req.params.id)) return;
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  // Assignments cascade away with the user — capture them (and the username,
  // which won't exist anymore) so the owner tags get cleared from PVE.
  const target = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  const orphanedVms = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logAudit(req, 'admin_delete_user', req.params.id, '');
  for (const vm of orphanedVms) {
    syncVmTagsSafe(vm.node, vm.vmid, { retired: [target?.username].filter(Boolean) });
  }
  res.json({ ok: true });
});

// ─── VMs (from Proxmox) ───────────────────────────────────────────────────────

router.get('/vms', pAssignments, async (req, res) => {
  try {
    const vms = await getAllVMs();
    const assignments = db.prepare(`
      SELECT va.*, u.username FROM vm_assignments va
      JOIN users u ON u.id = va.user_id
    `).all();
    const rawVmCounts = new Map();
    vms.forEach(vm => {
      const key = `${vm.node}-${vm.vmid}`;
      rawVmCounts.set(key, (rawVmCounts.get(key) || 0) + 1);
    });

    const assignedMap = new Map(assignments.map(a => [`${a.node}-${a.vmid}`, a]));

    const enriched = vms.map(vm => {
      const exactKey = `${vm.nodeRef || vm.node}-${vm.vmid}`;
      const rawKey = `${vm.node}-${vm.vmid}`;
      const assignment = assignedMap.get(exactKey)
        || (rawVmCounts.get(rawKey) === 1 ? assignedMap.get(rawKey) : null)
        || null;
      return {
        ...vm,
        assignment,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Assignments ───────────────────────────────────────────────────────────

router.get('/assignments', pAssignments, (req, res) => {
  const rows = db.prepare(`
    SELECT va.*, u.username FROM vm_assignments va
    JOIN users u ON u.id = va.user_id
    ORDER BY u.username
  `).all();
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

router.post('/assignments', pAssignments, async (req, res) => {
  const { userId, node, vmid } = req.body;
  if (!userId || !node || !vmid) {
    return res.status(400).json({ error: 'userId, node and vmid required' });
  }
  try {
    const r = db.prepare(
      'INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, ?)'
    ).run(userId, node, parseInt(vmid));
    await syncVmTagsSafe(node, vmid);
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'VM already assigned to a user' });
    }
    throw err;
  }
});

router.delete('/assignments/:id', pAssignments, async (req, res) => {
  const assignment = db.prepare('SELECT node, vmid FROM vm_assignments WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM vm_assignments WHERE id = ?').run(req.params.id);
  if (assignment) await syncVmTagsSafe(assignment.node, assignment.vmid);
  res.json({ ok: true });
});

// Re-stamp owner/VLAN tags on every VM the portal can see — for the first
// rollout, or after NIC/VLAN changes made outside the portal
router.post('/sync-vm-tags', pAssignments, async (req, res) => {
  try {
    const vms = await getAllVMs();
    let updated = 0;
    let failed = 0;
    for (const vm of vms) {
      const result = await syncVmTagsSafe(vm.nodeRef, vm.vmid);
      if (result.error) failed += 1;
      else if (result.changed) updated += 1;
    }
    logAudit(req, 'vm_tags_sync', 'all', `${vms.length} checked, ${updated} updated, ${failed} failed`);
    res.json({ checked: vms.length, updated, failed });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VLANs ───────────────────────────────────────────────────────────────────

function findNextAvailableVlanTag() {
  const usedTags = new Set(
    db.prepare('SELECT tag FROM vlans ORDER BY tag').all()
      .map(row => parseInt(row.tag, 10))
      .filter(Number.isInteger)
  );

  const ranges = db.prepare('SELECT vlan_range_start, vlan_range_end FROM firewalls ORDER BY vlan_range_start, vlan_range_end').all()
    .map(row => ({
      start: row.vlan_range_start || 1001,
      end: row.vlan_range_end || 1999,
    }));

  const pools = ranges.length > 0 ? ranges : [{ start: 1001, end: 1999 }];

  for (const pool of pools) {
    for (let tag = pool.start; tag <= pool.end; tag += 1) {
      if (!usedTags.has(tag)) return tag;
    }
  }

  return null;
}

function isValidCidr(cidr = '') {
  const trimmed = String(cidr).trim();
  if (!trimmed) return true;
  const match = trimmed.match(/^(\d{1,3})(?:\.(\d{1,3})){3}\/(\d{1,2})$/);
  if (!match) return false;
  const [ip, prefix] = trimmed.split('/');
  const octets = ip.split('.').map(Number);
  const prefixNum = Number(prefix);
  return octets.length === 4
    && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && Number.isInteger(prefixNum)
    && prefixNum >= 0
    && prefixNum <= 32;
}

function serializeVlanSubnet(vlan) {
  if (vlan.mode === 'tagged_only') {
    if (!vlan.subnet_cidr) return null;
    return {
      network: vlan.subnet_cidr,
      gateway: '',
      dhcp: '',
      custom: true,
    };
  }
  return vlanTagToSubnet(vlan.tag);
}

// VLANs read also needed by policies page and assignments page
// Non-admins only see VLANs assigned to them via user_vlans
router.get('/vlans', requirePermission('can_manage_vlans', 'can_manage_policies', 'can_manage_assignments'), (req, res) => {
  const isAdmin = req.session.isAdmin;
  const vlans = isAdmin
    ? db.prepare('SELECT * FROM vlans ORDER BY tag').all()
    : db.prepare(`
        SELECT v.* FROM vlans v
        JOIN user_vlans uv ON uv.vlan_id = v.id
        WHERE uv.user_id = ?
        ORDER BY v.tag
      `).all(req.session.userId);
  const syncs = db.prepare(`
    SELECT fvs.vlan_id, fvs.firewall_id, fvs.interface_name, f.name as firewall_name
    FROM firewall_vlan_sync fvs
    JOIN firewalls f ON f.id = fvs.firewall_id
  `).all();
  const syncMap = {};
  syncs.forEach(s => {
    if (!syncMap[s.vlan_id]) syncMap[s.vlan_id] = [];
    syncMap[s.vlan_id].push({ firewallId: s.firewall_id, firewallName: s.firewall_name, interfaceName: s.interface_name });
  });
  const fwRanges = db.prepare('SELECT id, name, vlan_range_start, vlan_range_end FROM firewalls').all();
  res.json(vlans.map(v => ({ ...v, firewallSync: syncMap[v.id] || [], subnet: serializeVlanSubnet(v), firewallRanges: fwRanges })));
});

router.post('/vlans', pVlans, (req, res) => {
  const { name, tag, description, mode = 'managed', subnetCidr = '' } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!['managed', 'tagged_only'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid VLAN mode' });
  }
  if (!req.session.isAdmin && mode !== 'managed') {
    return res.status(403).json({ error: 'Only admins can create tagged-only VLANs' });
  }

  const trimmedSubnetCidr = String(subnetCidr || '').trim();
  if (mode === 'tagged_only' && !trimmedSubnetCidr) {
    return res.status(400).json({ error: 'Subnet CIDR is required for tagged-only VLANs' });
  }
  if (mode === 'tagged_only' && !isValidCidr(trimmedSubnetCidr)) {
    return res.status(400).json({ error: 'Invalid subnet CIDR' });
  }

  let vlanTag;
  if (req.session.isAdmin) {
    if (tag === undefined) {
      return res.status(400).json({ error: 'Tag required' });
    }
    vlanTag = parseInt(tag, 10);
  } else {
    vlanTag = findNextAvailableVlanTag();
    if (!vlanTag) {
      return res.status(409).json({ error: 'No VLAN tags are available in the configured firewall pools' });
    }
  }

  try {
    const r = db.prepare(
      'INSERT INTO vlans (name, tag, mode, subnet_cidr, description) VALUES (?, ?, ?, ?, ?)'
    ).run(name, vlanTag, mode, mode === 'tagged_only' ? trimmedSubnetCidr : '', description || '');

    // Auto-assign to creating non-admin so they can immediately see and manage it
    if (!req.session.isAdmin) {
      try {
        db.prepare('INSERT INTO user_vlans (user_id, vlan_id) VALUES (?, ?)').run(req.session.userId, r.lastInsertRowid);
      } catch { /* ignore duplicate */ }
    }

    res.json({ id: r.lastInsertRowid, name, tag: vlanTag, mode, subnet_cidr: mode === 'tagged_only' ? trimmedSubnetCidr : '', description: description || '' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});

router.put('/vlans/:id', pVlans, (req, res) => {
  const { name, tag, description, mode, subnetCidr } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const existing = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !userOwnsVlan(req.session.userId, existing.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const nextMode = mode || existing.mode || 'managed';
  if (!['managed', 'tagged_only'].includes(nextMode)) {
    return res.status(400).json({ error: 'Invalid VLAN mode' });
  }
  if (!req.session.isAdmin && nextMode !== existing.mode) {
    return res.status(403).json({ error: 'Only admins can change VLAN type' });
  }

  const requestedTag = tag === undefined ? existing.tag : parseInt(tag, 10);
  if (!req.session.isAdmin && requestedTag !== existing.tag) {
    return res.status(403).json({ error: 'Only admins can change VLAN tags' });
  }
  if (!req.session.isAdmin && subnetCidr !== undefined && String(subnetCidr || '').trim() !== (existing.subnet_cidr || '')) {
    return res.status(403).json({ error: 'Only admins can change VLAN subnets' });
  }

  const syncCount = db.prepare('SELECT COUNT(*) as count FROM firewall_vlan_sync WHERE vlan_id = ?').get(req.params.id).count;
  if (syncCount > 0 && nextMode !== existing.mode) {
    return res.status(400).json({ error: 'Unsync this VLAN from firewalls before changing its type' });
  }

  const nextSubnetCidr = nextMode === 'tagged_only'
    ? String(subnetCidr ?? existing.subnet_cidr ?? '').trim()
    : '';
  if (nextMode === 'tagged_only' && !nextSubnetCidr) {
    return res.status(400).json({ error: 'Subnet CIDR is required for tagged-only VLANs' });
  }
  if (nextMode === 'tagged_only' && !isValidCidr(nextSubnetCidr)) {
    return res.status(400).json({ error: 'Invalid subnet CIDR' });
  }

  try {
    db.prepare(
      'UPDATE vlans SET name = ?, tag = ?, mode = ?, subnet_cidr = ?, description = ? WHERE id = ?'
    ).run(name, requestedTag, nextMode, nextSubnetCidr, description || '', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});

router.delete('/vlans/:id', pVlans, async (req, res) => {
  const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !userOwnsVlan(req.session.userId, vlan.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const syncs = db.prepare(`
    SELECT fvs.*, f.id as fw_id, f.name as fw_name, f.host, f.port, f.api_key, f.vdom, f.verify_tls,
           f.root_vdom, f.root_wan_zone, f.root_vdom_link, f.trunk_switch_serial, f.trunk_switch_port
    FROM firewall_vlan_sync fvs
    JOIN firewalls f ON f.id = fvs.firewall_id
    WHERE fvs.vlan_id = ?
  `).all(req.params.id);

  const fwResults = [];

  // 1. Clean up port forwards that target this VLAN's interface
  for (const sync of syncs) {
    const vlanIfaceName = sync.interface_name; // e.g. vlan1008
    const portForwards = db.prepare(
      'SELECT * FROM managed_vips WHERE firewall_id = ? AND vlan_interface = ?'
    ).all(sync.fw_id, vlanIfaceName);

    if (portForwards.length > 0) {
      console.log(`[delete-vlan] Cleaning up ${portForwards.length} port forward(s) on ${sync.fw_name} for ${vlanIfaceName}`);
      const client = createClient(sync);
      const rootVdom = sync.root_vdom || 'root';

      for (const pf of portForwards) {
        try {
          // Delete root VDOM policy
          if (pf.policy_id) {
            try { await client.deletePolicy(pf.policy_id, rootVdom); }
            catch (e) { console.warn(`[delete-vlan] Root policy ${pf.policy_id} cleanup:`, e.message); }
          }
          if (pf.lab_policy_id) {
            const labVdom = sync.vdom || 'lab';
            try { await client.deletePolicy(pf.lab_policy_id, labVdom); }
            catch (e) { console.warn(`[delete-vlan] Lab policy ${pf.lab_policy_id} cleanup:`, e.message); }
          }
          // Delete VIP from root VDOM
          try { await client.deleteVip(pf.vip_name, rootVdom); }
          catch (e) { console.warn(`[delete-vlan] VIP ${pf.vip_name} cleanup:`, e.message); }
          // Delete service object from root VDOM
          if (pf.service_name) {
            try { await client.deleteServiceObject(pf.service_name, rootVdom); }
            catch (e) { console.warn(`[delete-vlan] Service ${pf.service_name} cleanup:`, e.message); }
            const labVdom = sync.vdom || 'lab';
            try { await client.deleteServiceObject(pf.service_name, labVdom); }
            catch (e) { console.warn(`[delete-vlan] Lab service ${pf.service_name} cleanup:`, e.message); }
          }
          if (pf.vlan_interface) {
            const labVdom = sync.vdom || 'lab';
            const labAddressName = buildManagedVipAddressName(pf.vip_name, pf.mapped_ip);
            try { await client.deleteAddressObject(labAddressName, labVdom); }
            catch (e) { console.warn(`[delete-vlan] Lab address ${labAddressName} cleanup:`, e.message); }
          }
          // Remove DB record
          db.prepare('DELETE FROM managed_vips WHERE id = ?').run(pf.id);
          console.log(`[delete-vlan] Cleaned up port forward "${pf.vip_name}"`);
        } catch (e) {
          console.warn(`[delete-vlan] Failed to fully clean port forward "${pf.vip_name}":`, e.message);
          // Still remove from DB — the FortiGate objects are best-effort
          db.prepare('DELETE FROM managed_vips WHERE id = ?').run(pf.id);
        }
      }
    }
  }

  // 2. Deprovision VLAN from each synced firewall (interface, address obj, DHCP, routes, policies, switch)
  for (const sync of syncs) {
    console.log(`[delete-vlan] Deprovisioning VLAN ${vlan.tag} (${sync.interface_name}) from ${sync.fw_name}`);
    try {
      const client = createClient(sync);
      const policyIds = JSON.parse(sync.policy_ids || '[]');
      const { errors } = await client.deprovisionVlan(sync.interface_name, policyIds, sync.dhcp_server_id, {
        rootVdom: sync.root_vdom || 'root',
        trunkSwitchSerial: sync.trunk_switch_serial || '',
        trunkSwitchPort:   sync.trunk_switch_port   || '',
      });
      if (errors.length > 0) {
        console.warn(`[delete-vlan] Partial cleanup on ${sync.fw_name}:`, errors);
        fwResults.push({ firewall: sync.fw_name, status: 'partial', errors });
      } else {
        console.log(`[delete-vlan] Successfully removed from ${sync.fw_name}`);
        db.prepare('DELETE FROM firewall_vlan_sync WHERE firewall_id = ? AND vlan_id = ?').run(sync.firewall_id, vlan.id);
        fwResults.push({ firewall: sync.fw_name, status: 'ok' });
      }
    } catch (err) {
      console.error(`[delete-vlan] Failed to deprovision from ${sync.fw_name}:`, err.message);
      fwResults.push({ firewall: sync.fw_name, status: 'error', error: err.message });
    }
  }

  const failedCleanup = fwResults.filter(result => result.status !== 'ok');
  if (failedCleanup.length > 0) {
    logAudit(
      req,
      'admin_delete_vlan_blocked',
      `VLAN ${vlan.tag}`,
      `Firewall cleanup incomplete: ${failedCleanup.map(r => `${r.firewall}=${r.status}`).join(', ')}`
    );
    return res.status(409).json({
      error: 'VLAN cleanup did not complete on all synced firewalls. The VLAN was kept in the portal so you can retry safely.',
      firewallCleanup: fwResults,
    });
  }

  // 3. Delete the VLAN from DB (CASCADE removes user_vlans and firewall_vlan_sync)
  db.prepare('DELETE FROM vlans WHERE id = ?').run(req.params.id);
  logAudit(req, 'admin_delete_vlan', `VLAN ${vlan.tag}`, fwResults.length ? `FW cleanup: ${fwResults.map(r => `${r.firewall}=${r.status}`).join(', ')}` : '');
  res.json({ ok: true, firewallCleanup: fwResults });
});

// ─── User VLAN assignments ────────────────────────────────────────────────────

router.get('/users/:id/vlans', pAssignments, (req, res) => {
  const vlans = db.prepare(`
    SELECT v.* FROM vlans v
    JOIN user_vlans uv ON uv.vlan_id = v.id
    WHERE uv.user_id = ?
    ORDER BY v.tag
  `).all(req.params.id);
  res.json(vlans);
});

router.post('/users/:id/vlans', pAssignments, (req, res) => {
  const { vlanId } = req.body;
  if (!vlanId) return res.status(400).json({ error: 'vlanId required' });
  try {
    db.prepare('INSERT INTO user_vlans (user_id, vlan_id) VALUES (?, ?)').run(req.params.id, vlanId);
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'VLAN already assigned to this user' });
    }
    throw err;
  }
});

router.delete('/users/:id/vlans/:vlanId', pAssignments, (req, res) => {
  db.prepare('DELETE FROM user_vlans WHERE user_id = ? AND vlan_id = ?').run(req.params.id, req.params.vlanId);
  res.json({ ok: true });
});

// ─── User VM assignments ──────────────────────────────────────────────────────

router.get('/users/:id/vms', pAssignments, (req, res) => {
  const rows = db.prepare('SELECT * FROM vm_assignments WHERE user_id = ? ORDER BY vmid').all(req.params.id);
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

// ─── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

router.put('/settings/:key', requireAdmin, (req, res) => {
  const { value } = req.body;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(req.params.key, String(value), String(value));
  res.json({ ok: true });
});

// ─── PVE Hosts ──────────────────────────────────────────────────────────────

router.get('/pve-hosts', pHosts, (req, res) => {
  const hosts = getHosts().map(h => ({
    id: h.id, name: h.name, host: h.host, port: h.port,
    token_id: h.token_id, verify_tls: h.verify_tls, created_at: h.created_at,
    // Don't send token_secret to frontend
  }));
  res.json(hosts);
});

router.get('/pve-hosts/:id/status', pHosts, async (req, res) => {
  const host = getHost(parseInt(req.params.id));
  if (!host) return res.status(404).json({ error: 'Host not found' });
  const status = await getHostStatus(host);
  res.json(status);
});

router.post('/pve-hosts', pHosts, (req, res) => {
  const { name, host, port = 8006, tokenId, tokenSecret, verifyTls = true } = req.body;
  if (!name || !host || !tokenId || !tokenSecret) {
    return res.status(400).json({ error: 'Name, host, tokenId and tokenSecret are required' });
  }
  if (!verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling Proxmox TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  try {
    const r = db.prepare(
      'INSERT INTO pve_hosts (name, host, port, token_id, token_secret, verify_tls) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, host, port, tokenId, encryptSecret(tokenSecret), verifyTls ? 1 : 0);
    res.json({ id: r.lastInsertRowid, name, host, port });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/pve-hosts/:id', pHosts, (req, res) => {
  const { name, host, port = 8006, tokenId, tokenSecret, verifyTls } = req.body;
  if (!name || !host || !tokenId) {
    return res.status(400).json({ error: 'Name, host and tokenId are required' });
  }
  const existing = getHost(parseInt(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Host not found' });

  // If tokenSecret is empty, keep the existing one
  const secret = tokenSecret ? encryptSecret(tokenSecret) : existing.token_secret;
  const verifyTlsEnabled = verifyTls === undefined ? existing.verify_tls !== 0 : !!verifyTls;
  if (!verifyTlsEnabled && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling Proxmox TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  db.prepare(
    'UPDATE pve_hosts SET name = ?, host = ?, port = ?, token_id = ?, token_secret = ?, verify_tls = ? WHERE id = ?'
  ).run(name, host, port, tokenId, secret, verifyTlsEnabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/pve-hosts/:id', pHosts, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as count FROM pve_hosts').get();
  if (count.count <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last host' });
  }
  db.prepare('DELETE FROM pve_hosts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Firewalls ─────────────────────────────────────────────────────────────

// Firewalls read also needed by policies page and vlans page
router.get('/firewalls', requirePermission('can_manage_firewalls', 'can_manage_port_forwards', 'can_manage_policies', 'can_manage_vlans'), (req, res) => {
  const firewalls = db.prepare('SELECT * FROM firewalls ORDER BY name').all();
  const user = db.prepare('SELECT can_manage_firewalls FROM users WHERE id = ?').get(req.session.userId);
  const canSeeSensitiveFields = req.session.isAdmin || user?.can_manage_firewalls === 1;
  // Don't expose api_key to frontend
  res.json(firewalls.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    vlan_range_start: f.vlan_range_start,
    vlan_range_end: f.vlan_range_end,
    created_at: f.created_at,
    external_ip: f.external_ip || '',
    root_wan_zone: f.root_wan_zone || 'underlay',
    ...(canSeeSensitiveFields ? {
      host: f.host,
      port: f.port,
      vdom: f.vdom,
      parent_interface: f.parent_interface,
      wan_interface: f.wan_interface,
      lab_vdom_link: f.lab_vdom_link,
      root_vdom: f.root_vdom,
      root_vdom_link: f.root_vdom_link,
      route_gateway: f.route_gateway,
      trunk_switch_serial: f.trunk_switch_serial,
      trunk_switch_port: f.trunk_switch_port,
      verify_tls: f.verify_tls,
    } : {}),
  })));
});

router.get('/firewalls/:id/status', pFirewalls, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const status = await client.getSystemStatus();
    const interfaces = await client.getInterfaces();
    const vlanIfaces = interfaces.filter(i => i.type === 'vlan');
    res.json({
      online: true,
      version: status?.results?.version || status?.version || 'Unknown',
      hostname: status?.results?.hostname || status?.hostname || fw.name,
      serial: status?.results?.serial || status?.serial || '',
      vdom: fw.vdom,
      vlanCount: vlanIfaces.length,
    });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

router.get('/firewalls/:id/switches', pFirewalls, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const switches = await client.getManagedSwitches(fw.root_vdom || 'root');
    const result = switches.map(sw => ({
      serial: sw.sn || sw['switch-id'] || '',
      name: sw['switch-id'] || sw.name || sw.sn || '',
      ports: (sw.ports || []).map(p => ({
        name: p['port-name'],
        vlan: p.vlan || '',
        type: p.type || 'physical',
        members: p.members || '',
      })),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/firewalls', pFirewalls, (req, res) => {
  const { name, type = 'fortigate', host, port = 443, apiKey, vdom = 'root', parentInterface = 'fortilink', wanInterface = 'wan1', vlanRangeStart = 1001, vlanRangeEnd = 1999, labVdomLink = 'lab-root0', rootVdom = 'root', rootVdomLink = 'lab-root1', routeGateway = '10.255.254.2', trunkSwitchSerial = '', trunkSwitchPort = '', verifyTls = true, externalIp = '', rootWanZone = 'underlay' } = req.body;
  if (!name || !host || !apiKey) {
    return res.status(400).json({ error: 'Name, host, and API key are required' });
  }
  if (!verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling firewall TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  if (vlanRangeStart >= vlanRangeEnd || vlanRangeStart < 1 || vlanRangeEnd > 4094) {
    return res.status(400).json({ error: 'Invalid VLAN range (must be 1–4094, start < end)' });
  }
  try {
    const r = db.prepare(
      'INSERT INTO firewalls (name, type, host, port, api_key, vdom, parent_interface, wan_interface, vlan_range_start, vlan_range_end, lab_vdom_link, root_vdom, root_vdom_link, route_gateway, trunk_switch_serial, trunk_switch_port, verify_tls, external_ip, root_wan_zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, type, host, port, encryptSecret(apiKey), vdom, parentInterface, wanInterface, vlanRangeStart, vlanRangeEnd, labVdomLink, rootVdom, rootVdomLink, routeGateway, trunkSwitchSerial, trunkSwitchPort, verifyTls ? 1 : 0, externalIp, rootWanZone);
    logAudit(req, 'admin_create_firewall', name, `${host}:${port} vdom=${vdom}`);
    res.json({ id: r.lastInsertRowid, name, host, port });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/firewalls/:id', pFirewalls, (req, res) => {
  const { name, host, port = 443, apiKey, vdom, parentInterface, wanInterface, verifyTls } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: 'Name and host are required' });
  }
  const existing = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Firewall not found' });

  const key = apiKey ? encryptSecret(apiKey) : existing.api_key;
  const rangeStart    = req.body.vlanRangeStart ?? existing.vlan_range_start;
  const rangeEnd      = req.body.vlanRangeEnd   ?? existing.vlan_range_end;
  const labLink       = req.body.labVdomLink    || existing.lab_vdom_link   || 'lab-root0';
  const rootVd        = req.body.rootVdom       || existing.root_vdom       || 'root';
  const rootLink      = req.body.rootVdomLink   || existing.root_vdom_link  || 'lab-root1';
  const routeGw       = req.body.routeGateway   || existing.route_gateway   || '10.255.254.2';
  const trunkSerial   = req.body.trunkSwitchSerial ?? existing.trunk_switch_serial ?? '';
  const trunkPort     = req.body.trunkSwitchPort   ?? existing.trunk_switch_port   ?? '';
  const verifyTlsEnabled = verifyTls === undefined ? existing.verify_tls !== 0 : !!verifyTls;
  const extIp       = req.body.externalIp   ?? existing.external_ip   ?? '';
  const wanZone     = req.body.rootWanZone  ?? existing.root_wan_zone ?? 'underlay';
  if (!verifyTlsEnabled && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling firewall TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  if (rangeStart >= rangeEnd || rangeStart < 1 || rangeEnd > 4094) {
    return res.status(400).json({ error: 'Invalid VLAN range (must be 1–4094, start < end)' });
  }
  db.prepare(
    'UPDATE firewalls SET name = ?, host = ?, port = ?, api_key = ?, vdom = ?, parent_interface = ?, wan_interface = ?, vlan_range_start = ?, vlan_range_end = ?, lab_vdom_link = ?, root_vdom = ?, root_vdom_link = ?, route_gateway = ?, trunk_switch_serial = ?, trunk_switch_port = ?, verify_tls = ?, external_ip = ?, root_wan_zone = ? WHERE id = ?'
  ).run(name, host, port, key, vdom || existing.vdom, parentInterface || existing.parent_interface, wanInterface || existing.wan_interface, rangeStart, rangeEnd, labLink, rootVd, rootLink, routeGw, trunkSerial, trunkPort, verifyTlsEnabled ? 1 : 0, extIp, wanZone, req.params.id);
  logAudit(req, 'admin_update_firewall', name, `${host}:${port}`);
  res.json({ ok: true });
});

router.delete('/firewalls/:id', pFirewalls, (req, res) => {
  const fw = db.prepare('SELECT name FROM firewalls WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM firewalls WHERE id = ?').run(req.params.id);
  logAudit(req, 'admin_delete_firewall', fw?.name || req.params.id, '');
  res.json({ ok: true });
});

// ─── VLAN ↔ Firewall Sync ─────────────────────────────────────────────────

router.get('/vlans/:id/sync', pVlans, (req, res) => {
  if (!req.session.isAdmin && !userOwnsVlan(req.session.userId, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const syncs = db.prepare(`
    SELECT fvs.*, f.name as firewall_name, f.host as firewall_host
    FROM firewall_vlan_sync fvs
    JOIN firewalls f ON f.id = fvs.firewall_id
    WHERE fvs.vlan_id = ?
  `).all(req.params.id);
  res.json(syncs);
});

router.post('/vlans/:id/sync', pVlans, async (req, res) => {
  try {
    const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
    if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
    if (!req.session.isAdmin && !userOwnsVlan(req.session.userId, vlan.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (vlan.mode === 'tagged_only') {
      return res.status(400).json({ error: 'Tagged-only VLANs cannot be pushed to firewalls' });
    }

    const { firewallId, allowInternet = true, enableDhcp = true } = req.body;
    const fwRows = firewallId
      ? [db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId)]
      : db.prepare('SELECT * FROM firewalls').all();

    console.log(`[sync] VLAN ${vlan.tag} → ${fwRows.length} firewall(s), allowInternet=${allowInternet}, enableDhcp=${enableDhcp}`);

    const results = [];
    for (const fw of fwRows) {
      if (!fw) continue;
      // Skip if already synced
      const existing = db.prepare('SELECT id FROM firewall_vlan_sync WHERE firewall_id = ? AND vlan_id = ?').get(fw.id, vlan.id);
      if (existing) { results.push({ firewall: fw.name, status: 'already_synced' }); continue; }

      // Validate VLAN tag is within this firewall's allowed range
      if (vlan.tag < fw.vlan_range_start || vlan.tag > fw.vlan_range_end) {
        results.push({ firewall: fw.name, status: 'error', error: `VLAN tag ${vlan.tag} is outside allowed range ${fw.vlan_range_start}–${fw.vlan_range_end}` });
        continue;
      }

      try {
        console.log(`[sync] Provisioning VLAN ${vlan.tag} on ${fw.name} (${fw.host}:${fw.port} vdom=${fw.vdom})`);
        const client = createClient(fw);
        const result = await client.provisionVlan(
          vlan.tag, vlan.name, fw.parent_interface,
          {
            allowInternet, enableDhcp,
            labVdomLink:  fw.lab_vdom_link  || 'lab-root0',
            rootVdom:     fw.root_vdom      || 'root',
            rootVdomLink: fw.root_vdom_link || 'lab-root1',
            routeGateway: fw.route_gateway  || '10.255.254.2',
            trunkSwitchSerial: fw.trunk_switch_serial || '',
            trunkSwitchPort:   fw.trunk_switch_port   || '',
          }
        );
        console.log(`[sync] Success:`, JSON.stringify(result));
        db.prepare(
          'INSERT INTO firewall_vlan_sync (firewall_id, vlan_id, interface_name, policy_ids, dhcp_server_id) VALUES (?, ?, ?, ?, ?)'
        ).run(fw.id, vlan.id, result.interfaceName, JSON.stringify(result.policyIds), result.dhcpServerId || null);
        logAudit(req, 'admin_sync_vlan_firewall', `VLAN ${vlan.tag}`, `${fw.name}: ${result.interfaceName} (${result.subnet.network})`);
        results.push({ firewall: fw.name, status: 'ok', ...result });
      } catch (err) {
        console.error(`[sync] Error provisioning VLAN ${vlan.tag} on ${fw.name}:`, err.message);
        results.push({ firewall: fw.name, status: 'error', error: err.message });
      }
    }
    res.json(results);
  } catch (err) {
    console.error('[sync] Unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vlans/:id/sync/:firewallId', pVlans, async (req, res) => {
  if (!req.session.isAdmin && !userOwnsVlan(req.session.userId, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const sync = db.prepare(
    'SELECT fvs.*, f.* FROM firewall_vlan_sync fvs JOIN firewalls f ON f.id = fvs.firewall_id WHERE fvs.vlan_id = ? AND fvs.firewall_id = ?'
  ).get(req.params.id, req.params.firewallId);
  if (!sync) return res.status(404).json({ error: 'Sync record not found' });

  try {
    const client = createClient(sync);
    const policyIds = JSON.parse(sync.policy_ids || '[]');
    await client.deprovisionVlan(sync.interface_name, policyIds, sync.dhcp_server_id, {
      rootVdom: sync.root_vdom || 'root',
      trunkSwitchSerial: sync.trunk_switch_serial || '',
      trunkSwitchPort:   sync.trunk_switch_port   || '',
    });
  } catch (err) {
    console.error('Deprovision warning:', err.message);
  }

  db.prepare('DELETE FROM firewall_vlan_sync WHERE vlan_id = ? AND firewall_id = ?').run(req.params.id, req.params.firewallId);
  logAudit(req, 'admin_unsync_vlan_firewall', `VLAN ${req.params.id}`, `Firewall ${req.params.firewallId}`);
  res.json({ ok: true });
});

// ─── Policy Engine ──────────────────────────────────────────────────────────

router.get('/policies', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);
    const allPolicies = await client.getPolicies();

    // Get synced VLANs for this firewall (non-admins only see their assigned VLANs)
    const isAdmin = req.session.isAdmin;
    const syncs = isAdmin
      ? db.prepare(`
          SELECT fvs.interface_name, v.id as vlan_id, v.name as vlan_name, v.tag as vlan_tag
          FROM firewall_vlan_sync fvs
          JOIN vlans v ON v.id = fvs.vlan_id
          WHERE fvs.firewall_id = ?
        `).all(firewallId)
      : db.prepare(`
          SELECT fvs.interface_name, v.id as vlan_id, v.name as vlan_name, v.tag as vlan_tag
          FROM firewall_vlan_sync fvs
          JOIN vlans v ON v.id = fvs.vlan_id
          JOIN user_vlans uv ON uv.vlan_id = v.id AND uv.user_id = ?
          WHERE fvs.firewall_id = ?
        `).all(req.session.userId, firewallId);
    const vlanInterfaces = new Set(syncs.map(s => s.interface_name));
    const vlanMap = {};
    syncs.forEach(s => { vlanMap[s.interface_name] = s; });

    // Filter to policies involving synced VLANs
    const policies = allPolicies
      .filter(p => {
        const srcs = (p.srcintf || []).map(i => i.name);
        return srcs.some(s => vlanInterfaces.has(s));
      })
      .map(p => {
        const srcName = (p.srcintf || [])[0]?.name || '';
        const dstName = (p.dstintf || [])[0]?.name || '';
        const srcVlan = vlanMap[srcName] || null;
        const dstVlan = vlanMap[dstName] || null;
        const isInternet = dstName === (fw.lab_vdom_link || 'lab-root0');
        return {
          policyid: p.policyid,
          name: p.name,
          srcintf: srcName,
          dstintf: dstName,
          srcaddr: (p.srcaddr || []).map(a => a.name),
          dstaddr: (p.dstaddr || []).map(a => a.name),
          service: (p.service || []).map(s => s.name),
          action: p.action,
          logtraffic: p.logtraffic,
          globalLabel: p['global-label'] || '',
          comments: p.comments || '',
          isInternet,
          srcVlan: srcVlan ? { id: srcVlan.vlan_id, name: srcVlan.vlan_name, tag: srcVlan.vlan_tag } : null,
          dstVlan: dstVlan ? { id: dstVlan.vlan_id, name: dstVlan.vlan_name, tag: dstVlan.vlan_tag } : null,
        };
      });

    res.json(policies);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/policies', pPolicies, async (req, res) => {
  const { firewallId, srcVlanTag, dstVlanTag, services = ['ALL'], action = 'accept', bidirectional = false } = req.body;
  if (!firewallId || !srcVlanTag || !dstVlanTag) {
    return res.status(400).json({ error: 'firewallId, srcVlanTag, and dstVlanTag are required' });
  }
  if (srcVlanTag === dstVlanTag) {
    return res.status(400).json({ error: 'Source and destination VLANs must be different' });
  }

  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  // Resolve VLANs
  const srcVlan = db.prepare('SELECT v.*, fvs.interface_name FROM vlans v JOIN firewall_vlan_sync fvs ON fvs.vlan_id = v.id WHERE v.tag = ? AND fvs.firewall_id = ?').get(srcVlanTag, firewallId);
  const dstVlan = db.prepare('SELECT v.*, fvs.interface_name FROM vlans v JOIN firewall_vlan_sync fvs ON fvs.vlan_id = v.id WHERE v.tag = ? AND fvs.firewall_id = ?').get(dstVlanTag, firewallId);
  if (!srcVlan) return res.status(400).json({ error: `Source VLAN ${srcVlanTag} not synced to this firewall` });
  if (!dstVlan) return res.status(400).json({ error: `Destination VLAN ${dstVlanTag} not synced to this firewall` });

  // Non-admins must have both VLANs assigned to them
  if (!req.session.isAdmin) {
    const hasSrc = db.prepare('SELECT 1 FROM user_vlans WHERE user_id = ? AND vlan_id = ?').get(req.session.userId, srcVlan.id);
    const hasDst = db.prepare('SELECT 1 FROM user_vlans WHERE user_id = ? AND vlan_id = ?').get(req.session.userId, dstVlan.id);
    if (!hasSrc) return res.status(403).json({ error: `You do not have access to source VLAN ${srcVlanTag}` });
    if (!hasDst) return res.status(403).json({ error: `You do not have access to destination VLAN ${dstVlanTag}` });
  }

  const srcSubnet = vlanTagToSubnet(srcVlanTag);
  const dstSubnet = vlanTagToSubnet(dstVlanTag);
  if (!srcSubnet || !dstSubnet) return res.status(400).json({ error: 'Cannot derive subnets from VLAN tags' });

  const srcAddrName = `NET-${srcSubnet.networkIp}_24`;
  const dstAddrName = `NET-${dstSubnet.networkIp}_24`;

  try {
    const client = createClient(fw);

    // Ensure address objects exist
    for (const [name, subnet] of [[srcAddrName, srcSubnet], [dstAddrName, dstSubnet]]) {
      if (!await client.getAddressObject(name)) {
        await client.createAddressObject(name, `${subnet.networkIp} ${subnet.netmask}`);
      }
    }

    // Check for duplicate policy
    const existing = await client.getPolicies();
    const dup = existing.find(p =>
      (p.srcintf || []).some(i => i.name === srcVlan.interface_name) &&
      (p.dstintf || []).some(i => i.name === dstVlan.interface_name)
    );
    if (dup) return res.status(409).json({ error: `Policy from ${srcVlan.interface_name} to ${dstVlan.interface_name} already exists (id: ${dup.policyid})` });

    const policyIds = [];

    // Forward policy
    const fwdRes = await client.createPolicy({
      name: `${srcVlan.interface_name}-to-${dstVlan.interface_name}`,
      srcintf: [{ name: srcVlan.interface_name }],
      dstintf: [{ name: dstVlan.interface_name }],
      srcaddr: [{ name: srcAddrName }],
      dstaddr: [{ name: dstAddrName }],
      action,
      schedule: 'always',
      service: services.map(s => ({ name: s })),
      logtraffic: 'all',
      'global-label': `${srcVlan.name} (${srcVlan.interface_name})`,
      comments: `Inter-VLAN policy created via VM Manager`,
    });
    if (fwdRes?.mkey) policyIds.push(fwdRes.mkey);

    // Reverse policy if bidirectional
    if (bidirectional) {
      const revDup = existing.find(p =>
        (p.srcintf || []).some(i => i.name === dstVlan.interface_name) &&
        (p.dstintf || []).some(i => i.name === srcVlan.interface_name)
      );
      if (!revDup) {
        const revRes = await client.createPolicy({
          name: `${dstVlan.interface_name}-to-${srcVlan.interface_name}`,
          srcintf: [{ name: dstVlan.interface_name }],
          dstintf: [{ name: srcVlan.interface_name }],
          srcaddr: [{ name: dstAddrName }],
          dstaddr: [{ name: srcAddrName }],
          action,
          schedule: 'always',
          service: services.map(s => ({ name: s })),
          logtraffic: 'all',
          'global-label': `${dstVlan.name} (${dstVlan.interface_name})`,
          comments: `Inter-VLAN policy created via VM Manager`,
        });
        if (revRes?.mkey) policyIds.push(revRes.mkey);
      }
    }

    logAudit(req, 'admin_create_policy', `${srcVlan.interface_name} → ${dstVlan.interface_name}`, `services: ${services.join(',')} action: ${action}${bidirectional ? ' (bidirectional)' : ''}`);
    res.json({ policyIds });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/policies/:policyId', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);

    // Non-admins can only delete policies involving their assigned VLANs
    if (!req.session.isAdmin) {
      const policy = await client.getPolicy(req.params.policyId);
      if (policy) {
        const policyIntfs = [
          ...((policy.srcintf || []).map(i => i.name)),
          ...((policy.dstintf || []).map(i => i.name)),
        ];
        // Get user's VLAN interfaces on this firewall
        const userSyncs = db.prepare(`
          SELECT fvs.interface_name FROM firewall_vlan_sync fvs
          JOIN user_vlans uv ON uv.vlan_id = fvs.vlan_id AND uv.user_id = ?
          WHERE fvs.firewall_id = ?
        `).all(req.session.userId, firewallId);
        const userIntfs = new Set(userSyncs.map(s => s.interface_name));
        const hasAccess = policyIntfs.some(i => userIntfs.has(i));
        if (!hasAccess) {
          return res.status(403).json({ error: 'You do not have access to the VLANs in this policy' });
        }
      }
    }

    await client.deletePolicy(req.params.policyId);
    logAudit(req, 'admin_delete_policy', `Policy ${req.params.policyId}`, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Address & Service Objects ──────────────────────────────────────────────

router.get('/objects/addresses', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const objects = await client.getAddressObjects();
    res.json(objects.map(o => ({
      name: o.name,
      type: o.type,
      subnet: o.subnet,
      fqdn: o.fqdn || '',
      comment: o.comment || '',
      color: o.color || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/objects/addresses', requireAdmin, async (req, res) => {
  const { firewallId, name, type = 'ipmask', subnet, fqdn, comment } = req.body;
  if (!firewallId || !name) return res.status(400).json({ error: 'firewallId and name required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, type };
    if (type === 'ipmask' && subnet) data.subnet = subnet;
    if (type === 'fqdn' && fqdn) data.fqdn = fqdn;
    if (comment) data.comment = comment;
    await client.createAddressObject(data);
    logAudit(req, 'admin_create_address_object', name, `type=${type} ${subnet || fqdn || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId, subnet, fqdn, comment } = req.body;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = {};
    if (subnet) data.subnet = subnet;
    if (fqdn) data.fqdn = fqdn;
    if (comment !== undefined) data.comment = comment;
    await client.updateAddressObject(req.params.name, data);
    logAudit(req, 'admin_update_address_object', req.params.name, JSON.stringify(data));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteAddressObject(req.params.name);
    logAudit(req, 'admin_delete_address_object', req.params.name, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/objects/services', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const objects = await client.getServiceObjects();
    res.json(objects.map(o => ({
      name: o.name,
      protocol: o.protocol,
      tcpPortrange: o['tcp-portrange'] || '',
      udpPortrange: o['udp-portrange'] || '',
      comment: o.comment || '',
      color: o.color || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/objects/services', requireAdmin, async (req, res) => {
  const { firewallId, name, protocol = 'TCP/UDP/SCTP', tcpPortrange, udpPortrange, comment } = req.body;
  if (!firewallId || !name) return res.status(400).json({ error: 'firewallId and name required' });
  if (!tcpPortrange && !udpPortrange) return res.status(400).json({ error: 'At least one port range required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, protocol };
    if (tcpPortrange) data['tcp-portrange'] = tcpPortrange;
    if (udpPortrange) data['udp-portrange'] = udpPortrange;
    if (comment) data.comment = comment;
    await client.createServiceObject(data);
    logAudit(req, 'admin_create_service_object', name, `tcp=${tcpPortrange || ''} udp=${udpPortrange || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/services/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteServiceObject(req.params.name);
    logAudit(req, 'admin_delete_service_object', req.params.name, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Port Forwarding (VIPs in root VDOM) ─────────────────────────────────

// Quick helper to get firewall + client for root VDOM ops
function getRootClient(fw) {
  const client = createClient(fw);
  return { client, rootVdom: fw.root_vdom || 'root' };
}

function buildManagedVipServiceName(vipName, protocol, extPort) {
  const safeName = String(vipName || 'vip')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'vip';
  return `VMM-PF-${protocol.toUpperCase()}-${extPort}-${safeName}`;
}

function managedVipServiceMatches(service, protocol, portNumber) {
  const port = String(portNumber);
  const tcpRange = String(service?.['tcp-portrange'] || '').trim();
  const udpRange = String(service?.['udp-portrange'] || '').trim();

  if (protocol === 'udp') {
    return udpRange === port && !tcpRange;
  }
  return tcpRange === port && !udpRange;
}

function buildManagedVipAddressName(vipName, mappedIp) {
  const safeName = String(vipName || 'vip')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'vip';
  const safeIp = String(mappedIp || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'host';
  return `VMM-PF-HOST-${safeIp}-${safeName}`;
}

function managedVipAddressMatches(address, mappedIp) {
  const subnet = String(address?.subnet || '').trim();
  return String(address?.type || 'ipmask') === 'ipmask' && subnet === `${mappedIp} 255.255.255.255`;
}

function normalizePortForwardProtocol(protocol) {
  const normalized = String(protocol || 'tcp').toLowerCase();
  return ['tcp', 'udp'].includes(normalized) ? normalized : null;
}

function parsePortForwardPort(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function buildPortSpecificCustomVipName(vipName, protocol, port) {
  const trimmedName = String(vipName || '').trim();
  if (!trimmedName) return '';
  if (/\b\d{1,5}\/(?:tcp|udp)$/i.test(trimmedName)) return trimmedName;
  if (/\bcustom$/i.test(trimmedName)) return `${trimmedName} ${port}/${protocol}`;
  return trimmedName;
}

// Update WAN config (external IP + WAN zone) from the port forwarding page
router.put('/firewalls/:id/wan-config', pFirewalls, (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  const { externalIp, rootWanZone } = req.body;
  db.prepare('UPDATE firewalls SET external_ip = ?, root_wan_zone = ? WHERE id = ?')
    .run(externalIp ?? fw.external_ip ?? '', rootWanZone ?? fw.root_wan_zone ?? 'underlay', req.params.id);
  logAudit(req, 'admin_update_wan_config', fw.name, `extIp=${externalIp} wanZone=${rootWanZone}`);
  res.json({ ok: true });
});

// List all VIPs from root VDOM with managed/unmanaged status
router.get('/firewalls/:id/vips', pPortForwards, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const allVips = await client.getVips(rootVdom);
    const unrestricted = canManageAllPortForwards(req);
    const managedRows = db.prepare('SELECT vip_name, vlan_interface FROM managed_vips WHERE firewall_id = ?').all(fw.id);
    const managedMap = new Map(managedRows.map(row => [row.vip_name, row]));
    const allowedInterfaces = unrestricted
      ? null
      : new Set(getScopedFirewallSyncs(req.session.userId, fw.id, false).map(sync => sync.interface_name));

    const vips = allVips
      .filter(v => {
        if (v.portforward !== 'enable') return false;
        if (unrestricted) return true;
        const managed = managedMap.get(v.name);
        return !!(managed?.vlan_interface && allowedInterfaces.has(managed.vlan_interface));
      })
      .map(v => {
        const managed = managedMap.get(v.name);
        const mappedIp = (v.mappedip || []).map(m => {
          const r = m.range || '';
          return r.includes('-') ? r.split('-')[0] : r;
        }).join(', ');
        return {
          name: v.name,
          extip: v.extip || '',
          extport: v.extport || '',
          mappedip: mappedIp,
          mappedport: v.mappedport || '',
          protocol: v.protocol || 'tcp',
          extintf: v.extintf || 'any',
          managed: !!managed,
        };
      });
    res.json(vips);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Root VDOM interfaces for destination zone dropdown
router.get('/firewalls/:id/root-interfaces', pFirewalls, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const interfaces = await client.getInterfaces(rootVdom);
    const wanZone = fw.root_wan_zone || 'underlay';
    const skipTypes = ['tunnel', 'loopback'];
    const skipNames = ['npu', 'ha', 'mgmt', 'modem', 'ssl.', 'fortilink'];

    const filtered = interfaces
      .filter(i => {
        if (i.name === wanZone) return false; // exclude the WAN interface itself
        if (skipTypes.some(t => (i.type || '').includes(t))) return false;
        if (skipNames.some(s => (i.name || '').toLowerCase().startsWith(s))) return false;
        return true;
      })
      .map(i => ({
        name: i.name,
        type: i.type || '',
        ip: i.ip || '',
        vdom: i.vdom || '',
        description: i.description || i.alias || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Root VDOM address objects + groups for source restriction dropdown
router.get('/firewalls/:id/root-addresses', pFirewalls, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const [addresses, groups] = await Promise.all([
      client.getAddressObjects(rootVdom),
      client.getAddressGroups(rootVdom),
    ]);
    res.json({
      addresses: addresses.map(a => ({ name: a.name, type: a.type, subnet: a.subnet || '' })),
      groups: groups.map(g => ({ name: g.name, members: (g.member || []).map(m => m.name) })),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// VM targets for port forwarding — returns VMs with their SSH IPs, VLAN tags, and resolved interfaces
router.get('/firewalls/:id/vm-targets', pPortForwards, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const targets = await getScopedPortForwardTargets(req, fw);
    res.json({ targets });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Create a new port forward (VIP + firewall policy in root VDOM)
router.post('/firewalls/:id/vips', pPortForwards, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  let { name, protocol = 'tcp', extPort, mappedIp, mappedPort, dstInterface, vlanInterface, srcAddresses = ['all'], node, vmid } = req.body;
  const unrestricted = canManageAllPortForwards(req);
  protocol = normalizePortForwardProtocol(protocol);
  extPort = parsePortForwardPort(extPort);
  mappedPort = parsePortForwardPort(mappedPort);
  name = String(name || '').trim();

  if (!protocol) {
    return res.status(400).json({ error: 'protocol must be tcp or udp' });
  }
  if (!name || !extPort || !mappedPort) {
    return res.status(400).json({ error: 'name, extPort, and mappedPort are required; ports must be between 1 and 65535' });
  }
  name = buildPortSpecificCustomVipName(name, protocol, mappedPort);

  const serviceName = buildManagedVipServiceName(name, protocol, mappedPort);
  let createdRootService = false;
  let createdLabService = false;
  let createdLabAddress = false;
  let vipCreated = false;
  let policyId = null;
  let labPolicyId = null;
  let labAddressName = '';

  try {
    if (!unrestricted) {
      if (!node || !vmid) {
        return res.status(400).json({ error: 'node and vmid are required for scoped port forwards' });
      }

      const targets = await getScopedPortForwardTargets(req, fw);
      const target = targets.find(t => (t.nodeRef || t.node) === node && String(t.vmid) === String(vmid));
      if (!target) {
        return res.status(403).json({ error: 'You can only create port forwards for your own VMs on VLANs assigned to you' });
      }
      if (!target.ip || !target.vlanInterface || !target.dstInterface) {
        return res.status(400).json({ error: 'This VM is not on a VLAN you can publish through this firewall' });
      }

      mappedIp = target.ip;
      dstInterface = target.dstInterface;
      vlanInterface = target.vlanInterface;
      srcAddresses = ['all'];
    }

    if (!mappedIp || !dstInterface) {
      return res.status(400).json({ error: 'mappedIp and dstInterface are required' });
    }

    const duplicateMappedPort = db.prepare(
      'SELECT vip_name FROM managed_vips WHERE firewall_id = ? AND mapped_ip = ? AND mapped_port = ? AND protocol = ?'
    ).get(fw.id, mappedIp, mappedPort, protocol);
    if (duplicateMappedPort) {
      return res.status(409).json({
        error: `Internal port ${mappedIp}:${mappedPort}/${protocol.toUpperCase()} is already published by "${duplicateMappedPort.vip_name}"`
      });
    }

    const externalIp = fw.external_ip || '';
    if (!externalIp) {
      return res.status(400).json({ error: 'Firewall has no external IP configured. Set it in WAN config first.' });
    }

    labAddressName = vlanInterface ? buildManagedVipAddressName(name, mappedIp) : '';
    const { client, rootVdom } = getRootClient(fw);
    const wanZone = fw.root_wan_zone || 'underlay';
    const labVdom = fw.vdom || 'lab';

    // Check for port conflict across ALL existing VIPs
    const allVips = await client.getVips(rootVdom);
    const conflict = allVips.find(v =>
      v.portforward === 'enable' &&
      String(v.extport) === String(extPort) &&
      (v.protocol || 'tcp') === protocol
    );
    if (conflict) {
      return res.status(409).json({
        error: `External port ${extPort}/${protocol.toUpperCase()} is already in use by "${conflict.name}"`
      });
    }

    // Check for duplicate VIP name
    const existingVip = await client.getVip(name, rootVdom);
    if (existingVip) {
      return res.status(409).json({ error: `A VIP named "${name}" already exists` });
    }

    const existingService = await client.getServiceObject(serviceName, rootVdom);
    if (existingService && !managedVipServiceMatches(existingService, protocol, mappedPort)) {
      return res.status(409).json({ error: `A managed service object named "${serviceName}" already exists with different port settings` });
    }
    if (!existingService) {
      await client.createServiceObject({
        name: serviceName,
        comment: `Managed port forward service for ${name}`,
        ...(protocol === 'udp' ? { 'udp-portrange': String(mappedPort) } : { 'tcp-portrange': String(mappedPort) }),
      }, rootVdom);
      createdRootService = true;
    }

    if (vlanInterface) {
      const existingLabService = await client.getServiceObject(serviceName, labVdom);
      if (existingLabService && !managedVipServiceMatches(existingLabService, protocol, mappedPort)) {
        return res.status(409).json({ error: `A lab VDOM service object named "${serviceName}" already exists with different port settings` });
      }
      if (!existingLabService) {
        await client.createServiceObject({
          name: serviceName,
          comment: `Managed port forward service for ${name}`,
          ...(protocol === 'udp' ? { 'udp-portrange': String(mappedPort) } : { 'tcp-portrange': String(mappedPort) }),
        }, labVdom);
        createdLabService = true;
      }

      const existingLabAddress = await client.getAddressObject(labAddressName, labVdom);
      if (existingLabAddress && !managedVipAddressMatches(existingLabAddress, mappedIp)) {
        return res.status(409).json({ error: `A lab VDOM address object named "${labAddressName}" already exists with a different IP` });
      }
      if (!existingLabAddress) {
        await client.createAddressObject({
          name: labAddressName,
          type: 'ipmask',
          subnet: `${mappedIp} 255.255.255.255`,
          comment: `Managed port forward destination for ${name}`,
        }, '', labVdom);
        createdLabAddress = true;
      }
    }

    // 1. Create the VIP
    const vipPayload = {
      name,
      extip: externalIp,
      mappedip: [{ range: mappedIp }],
      extintf: 'any',
      portforward: 'enable',
      extport: String(extPort),
      mappedport: String(mappedPort),
    };
    // Only set protocol if UDP (FortiGate defaults to tcp)
    if (protocol === 'udp') vipPayload.protocol = 'udp';

    await client.createVip(vipPayload, rootVdom);
    vipCreated = true;

    // 2. Create the firewall policy in root VDOM (WAN → inter-VDOM link)
    const policyRes = await client.createPolicy({
      name: `PF: ${name}`,
      srcintf: [{ name: wanZone }],
      dstintf: [{ name: dstInterface }],
      srcaddr: srcAddresses.map(a => ({ name: a })),
      dstaddr: [{ name }],
      action: 'accept',
      schedule: 'always',
      service: [{ name: serviceName }],
      logtraffic: 'all',
      'global-label': 'Port Forwarding (VM Manager)',
      comments: `Auto-created by VM Manager for ${name}`,
    }, rootVdom);
    policyId = policyRes?.mkey || null;

    // 3. Create the lab VDOM policy (inter-VDOM link → VLAN interface)
    if (vlanInterface) {
      const labSrcInterface = fw.lab_vdom_link || 'lab-root0';

      // Find the VLAN's global-label for sequence grouping
      const labPolicies = await client.getPolicies(labVdom);
      const vlanGroupLabel = `Port Forwarding (${vlanInterface})`;

      // Create the lab policy
      const labPolicyRes = await client.createPolicy({
        name: `PF: ${name}`,
        srcintf: [{ name: labSrcInterface }],
        dstintf: [{ name: vlanInterface }],
        srcaddr: [{ name: 'all' }],
        dstaddr: [{ name: labAddressName }],
        action: 'accept',
        schedule: 'always',
        service: [{ name: serviceName }],
        logtraffic: 'all',
        'global-label': vlanGroupLabel,
        comments: `Auto-created by VM Manager for ${name}`,
      }, labVdom);
      labPolicyId = labPolicyRes?.mkey || null;

      // Move the new policy next to other policies in the same VLAN group
      if (labPolicyId) {
        const existingGroupPolicy = labPolicies.find(p =>
          (p['global-label'] || '') === vlanGroupLabel && String(p.policyid) !== String(labPolicyId)
        );
        if (existingGroupPolicy) {
          try { await client.movePolicy(labPolicyId, 'after', existingGroupPolicy.policyid, labVdom); } catch { /* best effort */ }
        }
      }
    }

    // 4. Track in DB
    db.prepare(
      'INSERT INTO managed_vips (firewall_id, vip_name, policy_id, service_name, protocol, ext_port, mapped_ip, mapped_port, dst_interface, lab_policy_id, vlan_interface) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(fw.id, name, policyId, serviceName, protocol, extPort, mappedIp, mappedPort, dstInterface, labPolicyId, vlanInterface || '');

    logAudit(req, 'admin_create_port_forward', name, `${protocol}/${extPort} → ${mappedIp}:${mappedPort} via ${dstInterface}/${vlanInterface}`);
    res.json({ ok: true, vipName: name, policyId, labPolicyId, serviceName });
  } catch (err) {
    const { client, rootVdom } = getRootClient(fw);
    try {
      const labVdom = fw.vdom || 'lab';
      if (labPolicyId) {
        try { await client.deletePolicy(labPolicyId, labVdom); } catch {}
      }

      if (policyId) {
        try { await client.deletePolicy(policyId, rootVdom); } catch {}
      }
      if (vipCreated) {
        try { await client.deleteVip(name, rootVdom); } catch {}
      }
      if (createdLabAddress && labAddressName) {
        try { await client.deleteAddressObject(labAddressName, labVdom); } catch {}
      }
      if (createdLabService && serviceName) {
        try { await client.deleteServiceObject(serviceName, labVdom); } catch {}
      }
      if (createdRootService && serviceName) {
        try { await client.deleteServiceObject(serviceName, rootVdom); } catch {}
      }
    } catch {
      // Best-effort rollback only.
    }
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Delete a managed port forward (VIP + policy)
router.delete('/firewalls/:id/vips/:name', pPortForwards, async (req, res) => {
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  const vipName = req.params.name;
  const managed = db.prepare('SELECT * FROM managed_vips WHERE firewall_id = ? AND vip_name = ?').get(fw.id, vipName);
  if (!managed) {
    return res.status(403).json({ error: 'Cannot delete unmanaged VIPs. This was not created through VM Manager.' });
  }
  if (!canManageAllPortForwards(req)) {
    const allowedInterfaces = new Set(getScopedFirewallSyncs(req.session.userId, fw.id, false).map(sync => sync.interface_name));
    if (!managed.vlan_interface || !allowedInterfaces.has(managed.vlan_interface)) {
      return res.status(403).json({ error: 'You do not have access to this port forward' });
    }
  }

  try {
    const { client, rootVdom } = getRootClient(fw);

    // Delete lab VDOM policy first
    if (managed.lab_policy_id) {
      const labVdom = fw.vdom || 'lab';
      try { await client.deletePolicy(managed.lab_policy_id, labVdom); }
      catch (e) { console.warn(`[vip-delete] Lab policy ${managed.lab_policy_id} delete warning:`, e.message); }
    }

    // Delete root VDOM policy (VIP can't be deleted while referenced by a policy)
    if (managed.policy_id) {
      try { await client.deletePolicy(managed.policy_id, rootVdom); }
      catch (e) { console.warn(`[vip-delete] Policy ${managed.policy_id} delete warning:`, e.message); }
    }

    // Also search for any other policies referencing this VIP (stale ID safety)
    try {
      const policies = await client.getPolicies(rootVdom);
      const refs = policies.filter(p =>
        (p.dstaddr || []).some(a => a.name === vipName) &&
        String(p.policyid) !== String(managed.policy_id)
      );
      for (const p of refs) {
        try { await client.deletePolicy(p.policyid, rootVdom); }
        catch (e) { console.warn(`[vip-delete] Extra policy ${p.policyid} warning:`, e.message); }
      }
    } catch (e) { console.warn(`[vip-delete] Policy search warning:`, e.message); }

    // Delete VIP
    await client.deleteVip(vipName, rootVdom);

    if (managed.service_name) {
      try {
        await client.deleteServiceObject(managed.service_name, rootVdom);
      } catch (e) {
        console.warn(`[vip-delete] Service ${managed.service_name} warning:`, e.message);
      }
      if (managed.vlan_interface) {
        const labVdom = fw.vdom || 'lab';
        try {
          await client.deleteServiceObject(managed.service_name, labVdom);
        } catch (e) {
          console.warn(`[vip-delete] Lab service ${managed.service_name} warning:`, e.message);
        }
      }
    }

    if (managed.vlan_interface) {
      const labVdom = fw.vdom || 'lab';
      const labAddressName = buildManagedVipAddressName(managed.vip_name, managed.mapped_ip);
      try {
        await client.deleteAddressObject(labAddressName, labVdom);
      } catch (e) {
        console.warn(`[vip-delete] Lab address ${labAddressName} warning:`, e.message);
      }
    }

    // Remove from DB
    db.prepare('DELETE FROM managed_vips WHERE firewall_id = ? AND vip_name = ?').run(fw.id, vipName);

    logAudit(req, 'admin_delete_port_forward', vipName, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Helper: compute subnet for a VLAN tag
router.get('/vlans/subnet/:tag', pVlans, (req, res) => {
  const subnet = vlanTagToSubnet(parseInt(req.params.tag));
  if (!subnet) return res.status(400).json({ error: 'Invalid tag for auto IP scheme' });
  res.json(subnet);
});

// ─── Audit Log ──────────────────────────────────────────────────────────────

router.get('/audit-log', pAudit, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(Math.min(parseInt(req.query.limit, 10) || 50, 200), 1);
  const offset = (page - 1) * limit;
  const action = req.query.action || '';

  const where = action ? 'WHERE action = ?' : '';
  const params = action ? [action] : [];

  const { count } = db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params);
  const rows = db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ rows, total: count, page, limit });
});

export default router;
