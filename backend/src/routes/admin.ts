import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  and, eq, ne, desc, inArray, sql, count, getTableColumns,
} from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  users, roles, rolePermissions, invites, apiTokens,
  vmAssignments, vmSshConfigs,
  vlans, userVlans, firewalls, pveHosts,
  firewallVlanSync, managedVips, publicIps, publicIpPools, publicIpAssignments,
  caddyServers, caddySites, notificationWebhooks, vmTemplates, cloudImages,
  vmLeases, auditLog, settings, loginAttempts,
} from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { setSetting } from '../db/settings.ts';
import { getAllVMs, getHostStatus, getHosts, getHost, getVMConfig, getHostStoragePools } from '../proxmox.ts';
import { setStorageExposed, storageVisibilityMap } from '../utils/storageVisibility.ts';
import { createClient, vlanTagToSubnet } from '../fortigate.ts';
import {
  requireAuth, requireAdmin, requirePermission, requireInteractiveSession, requireRecentReauthentication,
} from '../middleware/auth.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { sendError } from '../utils/httpError.ts';
import { logAudit } from '../utils/audit.ts';
import { encryptSecret } from '../utils/secrets.ts';
import { decodeNodeRef, encodeNodeRef, nodeLookupCandidates } from '../utils/nodeRef.ts';
import { shortenVipName, PORT_FORWARD_NAME_MAX } from '../utils/vipName.ts';
import { findPortConflict, portConflictMessage } from '../utils/portEndpoints.ts';
import { normalizeIpv4 } from '../utils/publicIpPools.ts';
import { checkPublicIpUsage, describeAssignmentProvisioning } from '../utils/publicIpAccess.ts';
import { listMaintenance, enterMaintenance, exitMaintenanceById } from '../utils/nodeMaintenance.ts';
import { userCanAccessVm } from '../utils/vmAccess.ts';
import {
  syncVmTagsSafe, runFullTagSync, isTagSyncRunning, getTagSyncProgress,
  getTagSyncSettings, setTagSyncPaused, setTagSyncIntervalHours,
} from '../utils/vmTags.ts';
import { PERMISSION_KEYS, userHasPermission, effectivePermissions } from '../utils/permissions.ts';
import { buildPortForwardTargets, blockedErrorText, blockedStatus } from '../utils/portForwardTargets.ts';
import { evaluateReadiness, summarizeReadiness } from '../utils/readiness.ts';
import { generateInviteToken, hashInviteToken, normalizeInvitePreset, summarizeInvitePreset, inviteStatus } from '../utils/invites.ts';
import {
  getLeaseSettings, setLeaseSettings, computeLeaseView, updateLease, renewLease,
  runLeaseSweep, backfillLeases,
} from '../utils/leases.ts';
import { getCapacitySettings, setCapacitySettings } from '../utils/capacity.ts';
import { MEMORY_MODES } from '../utils/capacityPolicy.ts';
import { getWorkflowBundle, workflowSettings, seedWorkflowsForFirewall } from '../workflows/store.ts';
import { runBundle, buildFirewallContext, teardownArtifacts } from '../workflows/runner.ts';
import { deriveSubnet } from '../workflows/subnet.ts';
import { deletePveHost, pveHostDependencies } from '../services/pveHostLifecycle.ts';
import { boundedString, validateHost, validateObject, validatePassword, validatePort, validateUsername } from '../utils/validation.ts';

const router = Router();
// All admin routes require at least authentication
router.use(requireAuth);

// User, role, invite, and credential administration is intentionally browser
// session only. A broadly scoped automation token must not become an identity
// provider if it is leaked.
router.use(['/users', '/roles', '/invites', '/tokens'], requireInteractiveSession);
router.use(['/users', '/roles', '/invites', '/tokens'], (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return requireRecentReauthentication(req, res, next);
});

// Permission middleware shortcuts
const pUsers       = requirePermission('can_manage_users');
const pAssignments = requirePermission('can_manage_assignments', 'can_manage_users');
const pHosts       = requirePermission('can_manage_hosts');
const pFirewalls   = requirePermission('can_manage_firewalls');
const pPortForwards = requirePermission('can_manage_firewalls', 'can_manage_port_forwards');
const pVlans       = requirePermission('can_manage_vlans');
const pPolicies    = requirePermission('can_manage_policies');
const pAudit       = requirePermission('can_view_audit_log');
const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// Check if a non-admin user has access to a VLAN via user_vlans
async function userOwnsVlan(userId, vlanId) {
  const [row] = await db.select({ one: sql`1` }).from(userVlans)
    .where(and(eq(userVlans.user_id, userId), eq(userVlans.vlan_id, vlanId))).limit(1);
  return !!row;
}

function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

// Effective check — a role that grants can_manage_firewalls counts, so never
// read the legacy users.can_manage_firewalls column here.
async function canManageAllPortForwards(req) {
  return !!req.session.isAdmin || await userHasPermission(req.session.userId, 'can_manage_firewalls');
}

async function getScopedFirewallSyncs(userId, firewallId, unrestricted = false) {
  const cols = {
    interface_name: firewallVlanSync.interface_name,
    vlan_id: vlans.id,
    vlan_name: vlans.name,
    vlan_tag: vlans.tag,
  };
  if (unrestricted) {
    return db.select(cols).from(firewallVlanSync)
      .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
      .where(eq(firewallVlanSync.firewall_id, firewallId));
  }

  return db.select(cols).from(firewallVlanSync)
    .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
    .innerJoin(userVlans, and(eq(userVlans.vlan_id, vlans.id), eq(userVlans.user_id, userId)))
    .where(eq(firewallVlanSync.firewall_id, firewallId));
}

// Every VM the user can see, annotated with whether it can be published through
// `fw` and — when it cannot — a structured reason. Nothing is filtered out:
// silently dropping VMs is exactly what made this screen impossible to debug.
// The classification itself lives in utils/portForwardTargets.js so it is pure
// and unit-testable; this function only gathers the rows it needs.
async function getScopedPortForwardTargets(req, fw) {
  const unrestricted = await canManageAllPortForwards(req);
  const canManageVlans = req.session.isAdmin || await userHasPermission(req.session.userId, 'can_manage_vlans');

  const vms = await getAllVMs();
  const sshConfigs = await db.select({
    node: vmSshConfigs.node, vmid: vmSshConfigs.vmid, host: vmSshConfigs.host, port: vmSshConfigs.port,
  }).from(vmSshConfigs);
  const vlanRows = await db.select({ id: vlans.id, name: vlans.name, tag: vlans.tag }).from(vlans);
  const vlanSyncs = await db.select({
    interface_name: firewallVlanSync.interface_name, vlan_tag: vlans.tag,
  }).from(firewallVlanSync)
    .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
    .where(eq(firewallVlanSync.firewall_id, fw.id));
  const userVlanTags = (await db.select({ tag: vlans.tag }).from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, req.session.userId))).map(r => r.tag);

  const accessChecks = await Promise.all(vms.map(async (vm) => {
    if (vm.type !== 'qemu' && vm.type !== 'lxc') return false;
    if (unrestricted) return true;
    return userCanAccessVm(req.session.userId, vm.nodeRef || vm.node, vm.vmid, req.session.isAdmin);
  }));
  const accessibleVms = vms.filter((_vm, i) => accessChecks[i]);
  const accessibleKeys = accessibleVms.map(vm => `${vm.nodeRef || vm.node}/${vm.vmid}`);

  // Only VMs that already have an IP need a config fetch: a VM without one is
  // blocked by `no_ip` regardless of its VLAN tag, and that reason outranks the
  // VLAN ones. Keeps the Proxmox call count identical to before this change.
  const sshKeys = new Set(sshConfigs.filter(c => c.host).map(c => `${c.node}/${c.vmid}`));
  const rawVmCounts = new Map();
  for (const vm of vms) {
    const raw = `${vm.node}/${vm.vmid}`;
    rawVmCounts.set(raw, (rawVmCounts.get(raw) || 0) + 1);
  }
  const configTargets = accessibleVms.filter(vm => {
    const raw = `${vm.node}/${vm.vmid}`;
    return sshKeys.has(`${vm.nodeRef || vm.node}/${vm.vmid}`)
      || (rawVmCounts.get(raw) === 1 && sshKeys.has(raw));
  });

  const configResults = await Promise.allSettled(
    configTargets.map(async vm => {
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

  return buildPortForwardTargets({
    vms,
    accessibleKeys,
    sshConfigs,
    vlanTags: vlanTagMap,
    vlans: vlanRows,
    vlanSyncs,
    userVlanTags,
    unrestricted,
    canManageVlans,
    rootDstInterface: fw.root_vdom_link || 'lab-root1',
    firewallName: fw.name || '',
  });
}

// ─── Setup readiness / prerequisites ──────────────────────────────────────────
// Collects the plain data every prerequisite check needs, then hands it to the
// pure evaluator in utils/readiness.js. Each upstream round-trip is wrapped
// individually: one unreachable Proxmox host must degrade its own rows, never
// fail the whole endpoint.

async function collectHostReadiness(hosts) {
  const hostStatuses = await Promise.all(hosts.map(async (h) => {
    try {
      const s = await getHostStatus(h); // already swallows its own errors
      return { hostId: h.id, online: !!s.online, error: s.error || '' };
    } catch (err) {
      return { hostId: h.id, online: false, error: err.message };
    }
  }));

  const hostStorages = await Promise.all(hosts.map(async (h) => {
    // Don't spend another 15s timeout on a host we already know is down.
    const status = hostStatuses.find((s) => s.hostId === h.id);
    if (!status?.online) return { hostId: h.id, total: 0, exposed: 0, error: 'Host unreachable' };
    try {
      const pools = await getHostStoragePools(h);
      const visibility = await storageVisibilityMap(h.id);
      // Missing visibility row ⇒ exposed (default-open), same as the picker.
      const exposed = pools.filter((p) => (visibility.has(p.storage) ? visibility.get(p.storage) : true)).length;
      return { hostId: h.id, total: pools.length, exposed };
    } catch (err) {
      return { hostId: h.id, total: 0, exposed: 0, error: err.message };
    }
  }));

  return { hostStatuses, hostStorages };
}

// Users who can actually reach the New VM page — role grants and the legacy
// per-user column both count, so this goes through effectivePermissions.
async function countProvisioners() {
  const userRows = await db.select().from(users);
  const perms = await Promise.all(userRows.map((u) => effectivePermissions(u)));
  return userRows.filter((u, i) => u.is_admin || perms[i].can_provision).length;
}

router.get('/readiness', requireAdmin, async (req, res) => {
  try {
    const hosts = await getHosts();
    const { hostStatuses, hostStorages } = await collectHostReadiness(hosts);

    // Mirrors websites.js effectiveWanIp(): the manual value wins, otherwise
    // the linked FortiGate's external IP stands in.
    const caddyServerRows = (await db.select({
      id: caddyServers.id, name: caddyServers.name, wan_ip: caddyServers.wan_ip, external_ip: firewalls.external_ip,
    }).from(caddyServers)
      .leftJoin(firewalls, eq(firewalls.id, caddyServers.fortigate_id))
      .orderBy(caddyServers.name)).map((s) => ({
      id: s.id,
      name: s.name,
      wanIp: s.wan_ip || s.external_ip || '',
    }));

    const firewallRows = (await db.select({
      id: firewalls.id, name: firewalls.name, external_ip: firewalls.external_ip,
    }).from(firewalls).orderBy(firewalls.name))
      .map((f) => ({ id: f.id, name: f.name, externalIp: f.external_ip || '' }));
    const vlanSyncCounts = await db.select({
      firewallId: firewallVlanSync.firewall_id, count: count(),
    }).from(firewallVlanSync).groupBy(firewallVlanSync.firewall_id);
    const [{ c: templateCount }] = await db.select({ c: count() }).from(vmTemplates).where(eq(vmTemplates.enabled, true));
    // Same predicate provision.js /images uses: only a ready, import-content
    // volume can be an import-from disk source on PVE 9.
    const [{ c: cloudImageCount }] = await db.select({ c: count() }).from(cloudImages)
      .where(and(eq(cloudImages.status, 'ready'), ne(cloudImages.volid, ''), sql`${cloudImages.volid} NOT LIKE '%:iso/%'`));
    const provisionUserCount = await countProvisioners();
    const [{ c: siteCount }] = await db.select({ c: count() }).from(caddySites);
    const [{ c: webhookCount }] = await db.select({ c: count() }).from(notificationWebhooks).where(eq(notificationWebhooks.enabled, true));

    const checks = evaluateReadiness({
      hosts: hosts.map((h) => ({ id: h.id, name: h.name })),
      hostStatuses,
      hostStorages,
      firewalls: firewallRows,
      vlanSyncCounts,
      templateCount,
      cloudImageCount,
      provisionUserCount,
      caddyServers: caddyServerRows,
      siteCount,
      webhookCount,
      env: {
        secretEncryptionKey: !!process.env.SECRET_ENCRYPTION_KEY,
        sessionSecret: !!process.env.SESSION_SECRET,
        allowedOrigin: process.env.ALLOWED_ORIGIN || '',
        portalBaseUrl: process.env.PORTAL_BASE_URL || '',
        trustProxy: process.env.TRUST_PROXY || '',
      },
    });

    res.json({ checks, summary: summarizeReadiness(checks) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────

const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MAX = 10;

async function ensureCanManageTargetUser(req, res, userId) {
  if (req.session.isAdmin) return true;

  const [target] = await db.select({ is_admin: users.is_admin }).from(users).where(eq(users.id, Number(userId))).limit(1);
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

router.get('/users', pUsers, async (req, res) => {
  const windowStart = Date.now() - LOCKOUT_WINDOW_MS;
  // Correlated per-user aggregates (VM count, recent failures, worst per-IP
  // failure streak). Computed as subquery scalars so the row shape is unchanged.
  const la = loginAttempts;
  const vmCountSq = sql<number>`(SELECT COUNT(*) FROM ${vmAssignments} WHERE ${vmAssignments.user_id} = ${users.id})`;
  const recentFailuresSq = sql<number>`(SELECT COUNT(*) FROM ${la} WHERE ${la.username} = ${users.username} AND ${la.attempted_at} > ${windowStart})`;
  const maxIpFailuresSq = sql<number>`(SELECT COALESCE(MAX(ip_count), 0) FROM (
        SELECT COUNT(*) AS ip_count FROM ${la}
        WHERE ${la.username} = ${users.username} AND ${la.attempted_at} > ${windowStart} GROUP BY ${la.ip}
      ) AS s)`;
  const rows = await db.select({
    id: users.id, username: users.username, is_admin: users.is_admin, see_all_vms: users.see_all_vms,
    can_operate_all_vms: users.can_operate_all_vms, can_provision: users.can_provision, can_create_vms: users.can_create_vms,
    totp_enabled: users.totp_enabled, require_2fa: users.require_2fa,
    can_manage_hosts: users.can_manage_hosts, can_manage_firewalls: users.can_manage_firewalls,
    can_manage_port_forwards: users.can_manage_port_forwards, can_manage_vlans: users.can_manage_vlans,
    can_manage_policies: users.can_manage_policies, can_manage_templates: users.can_manage_templates,
    can_manage_users: users.can_manage_users, can_manage_assignments: users.can_manage_assignments,
    can_view_audit_log: users.can_view_audit_log, can_edit_vm_hardware: users.can_edit_vm_hardware,
    can_manage_websites: users.can_manage_websites, can_manage_public_ips: users.can_manage_public_ips,
    created_at: users.created_at, role_id: users.role_id, role_name: roles.name,
    max_cores: users.max_cores, max_memory_gb: users.max_memory_gb, max_storage_gb: users.max_storage_gb,
    vm_count: vmCountSq,
    recent_failures: recentFailuresSq,
    max_ip_failures: maxIpFailuresSq,
  }).from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .orderBy(users.username);
  // Lockout is per (username, ip) — a user counts as locked when any single
  // address has hit the limit
  res.json(rows.map(u => ({ ...u, locked: u.max_ip_failures >= LOCKOUT_MAX, twoFactorEnabled: !!u.totp_enabled, require2fa: !!u.require_2fa, canProvision: !!u.can_provision, canCreateVms: !!u.can_create_vms })));
});

router.post('/users', pUsers, async (req, res) => {
  let username;
  let password;
  let isAdmin;
  try {
    validateObject(req.body, { fields: ['username', 'password', 'isAdmin'], required: ['username', 'password'] });
    ({ isAdmin } = req.body);
    username = validateUsername(req.body?.username);
    password = validatePassword(req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (isAdmin && !req.session.isAdmin) {
    return res.status(403).json({ error: 'Only admins can create admin accounts' });
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const [r] = await db.insert(users).values({ username, password: hash, is_admin: !!isAdmin }).returning({ id: users.id });
    await logAudit(req, 'admin_create_user', username, '');
    res.json({ id: r.id, username, isAdmin: !!isAdmin });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

router.post('/users/:id/reset-2fa', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.update(users).set({ totp_enabled: false, totp_secret: null }).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_reset_2fa', req.params.id, '');
  res.json({ ok: true });
});

// ─── API tokens (admin oversight) ─────────────────────────────────────────────
// Admins (or can_manage_users delegates) can list and revoke any user's personal
// API tokens. Token secrets/hashes are never exposed. Interactive-session only.

router.get('/users/:id/tokens', requireInteractiveSession, pUsers, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rows = await db.select({
    id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes,
    created_at: apiTokens.created_at, expires_at: apiTokens.expires_at, last_used_at: apiTokens.last_used_at,
  }).from(apiTokens).where(eq(apiTokens.user_id, Number(req.params.id))).orderBy(desc(apiTokens.created_at));
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    scopes: String(r.scopes || 'read').split(',').filter(Boolean),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    expired: !!r.expires_at && r.expires_at.getTime() < Date.now(),
  })));
});

router.delete('/tokens/:id', requireInteractiveSession, pUsers, async (req, res) => {
  const [token] = await db.select({ id: apiTokens.id, name: apiTokens.name, username: users.username })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.user_id))
    .where(eq(apiTokens.id, Number(req.params.id))).limit(1);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
  await logAudit(req, 'admin_revoke_api_token', token.name, `owner: ${token.username}`);
  res.json({ ok: true });
});

router.post('/users/:id/unlock', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  const [user] = await db.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.delete(loginAttempts).where(eq(loginAttempts.username, user.username));
  await logAudit(req, 'admin_unlock_user', req.params.id, '');
  res.json({ ok: true });
});

router.put('/users/:id/username', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  let username;
  try { username = validateUsername(req.body?.username); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const [previous] = await db.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  try {
    await db.update(users).set({ username }).where(eq(users.id, Number(req.params.id)));
    await retagUserVms(req.params.id, previous?.username);
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    throw err;
  }
});

// Re-stamp the PVE owner tag on a user's VMs after a rename; the old
// username no longer exists in the users table, so pass it as retired.
async function retagUserVms(userId, previousUsername) {
  const vms = await db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.user_id, Number(userId)));
  for (const vm of vms) {
    await syncVmTagsSafe(vm.node, vm.vmid, { retired: [previousUsername].filter(Boolean) });
  }
}

router.put('/users/:id/password', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  let password;
  try { password = validatePassword(req.body?.password); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const hash = bcrypt.hashSync(password, 10);
  await db.update(users).set({ password: hash }).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_reset_password', req.params.id, '');
  res.json({ ok: true });
});

router.put('/users/:id/require-2fa', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ require_2fa: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/see-all-vms', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ see_all_vms: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/can-provision', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ can_provision: !!enabled }).where(eq(users.id, Number(req.params.id)));
  res.json({ ok: true });
});

router.put('/users/:id/can-create-vms', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { enabled } = req.body;
  await db.update(users).set({ can_create_vms: !!enabled }).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_toggle_permission', req.params.id, `can_create_vms=${enabled ? 1 : 0}`);
  res.json({ ok: true });
});

// Permission toggle endpoint for all granular permissions
const TOGGLEABLE_PERMISSIONS = ['can_operate_all_vms', 'can_manage_hosts', 'can_manage_firewalls', 'can_manage_port_forwards', 'can_manage_vlans', 'can_manage_policies', 'can_manage_templates', 'can_manage_users', 'can_manage_assignments', 'can_view_audit_log', 'can_edit_vm_hardware', 'can_manage_websites', 'can_manage_public_ips'] as const;

router.put('/users/:id/permission', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { permission, enabled } = req.body;
  if (!TOGGLEABLE_PERMISSIONS.includes(permission)) {
    return res.status(400).json({ error: `Invalid permission: ${permission}` });
  }
  // `permission` is whitelisted above and the schema property keys equal the
  // column names, so a computed-key set targets exactly that boolean column —
  // no raw identifier is ever interpolated into SQL text.
  await db.update(users).set({ [permission]: !!enabled } as any).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_toggle_permission', req.params.id, `${permission}=${enabled ? 1 : 0}`);
  res.json({ ok: true });
});

// ─── Quotas ───────────────────────────────────────────────────────────────────

function parseQuotaValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined; // undefined = invalid
}

router.put('/users/:id/quotas', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const maxCores = parseQuotaValue(req.body.maxCores);
  const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
  }

  await db.update(users).set({ max_cores: maxCores, max_memory_gb: maxMemoryGb, max_storage_gb: maxStorageGb })
    .where(eq(users.id, user.id));
  await logAudit(req, 'admin_set_quotas', user.username,
    `cores=${maxCores ?? '∞'} memory=${maxMemoryGb ?? '∞'}GB storage=${maxStorageGb ?? '∞'}GB`);
  res.json({ ok: true });
});

// Per-user allocated usage for the Users page — one resource-list call
// covers every user, so this stays cheap even with many accounts.
router.get('/user-usage', pUsers, async (req, res) => {
  try {
    const assignments = await db.select({ user_id: vmAssignments.user_id, vmid: vmAssignments.vmid }).from(vmAssignments);
    const byUser = new Map();
    for (const a of assignments) {
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, new Set());
      byUser.get(a.user_id).add(Number(a.vmid));
    }
    const vms = await getAllVMs();
    const vmByVmid = new Map(vms.map((v) => [Number(v.vmid), v]));
    const GB = 1024 ** 3;

    const usage = {};
    for (const [userId, vmids] of byUser) {
      const u = { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 };
      for (const vmid of vmids) {
        const vm = vmByVmid.get(vmid);
        if (!vm) continue;
        u.vmCount += 1;
        u.cores += vm.maxcpu || 0;
        u.memoryGb += (vm.maxmem || 0) / GB;
        u.diskGb += (vm.maxdisk || 0) / GB;
      }
      u.memoryGb = Math.round(u.memoryGb * 10) / 10;
      u.diskGb = Math.round(u.diskGb * 10) / 10;
      usage[userId] = u;
    }
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Roles (RBAC) ─────────────────────────────────────────────────────────────
// Mutations are requireAdmin (editing a role changes live permissions of every
// holder, same weight class as the per-user permission toggles). Reading is
// pUsers so the Users page can render role names.

async function serializeRole(role) {
  const perms = await db.select({ permission: rolePermissions.permission }).from(rolePermissions)
    .where(eq(rolePermissions.role_id, role.id));
  const [uc] = await db.select({ c: count() }).from(users).where(eq(users.role_id, role.id));
  return {
    ...role,
    builtIn: role.built_in === true,
    permissions: perms.map((r) => r.permission),
    userCount: uc.c,
  };
}

function validatePermissionList(permissions) {
  if (!Array.isArray(permissions)) return null;
  const unique = [...new Set(permissions)];
  if (unique.some((p) => !PERMISSION_KEYS.includes(p))) return null;
  return unique;
}

async function setRolePermissions(roleId, permissions) {
  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.role_id, roleId));
    if (permissions.length > 0) {
      await tx.insert(rolePermissions).values(permissions.map((p) => ({ role_id: roleId, permission: p })));
    }
  });
}

router.get('/roles', pUsers, async (req, res) => {
  const roleRows = await db.select().from(roles).orderBy(desc(roles.built_in), roles.name);
  res.json({ roles: await Promise.all(roleRows.map(serializeRole)), permissionKeys: PERMISSION_KEYS });
});

router.post('/roles', requireAdmin, async (req, res) => {
  const { name, description = '', permissions = [] } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Role name required' });
  const perms = validatePermissionList(permissions);
  if (!perms) return res.status(400).json({ error: 'Invalid permission list' });
  const maxCores = parseQuotaValue(req.body.maxCores);
  const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
  const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
  if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
    return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
  }
  try {
    const [r] = await db.insert(roles).values({
      name: String(name).trim(), description: String(description),
      max_cores: maxCores, max_memory_gb: maxMemoryGb, max_storage_gb: maxStorageGb,
    }).returning({ id: roles.id });
    await setRolePermissions(r.id, perms);
    await logAudit(req, 'admin_create_role', String(name).trim(), perms.join(','));
    const [created] = await db.select().from(roles).where(eq(roles.id, r.id)).limit(1);
    res.json(await serializeRole(created));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'Role name already exists' });
    throw err;
  }
});

router.put('/roles/:id', requireAdmin, async (req, res) => {
  const [role] = await db.select().from(roles).where(eq(roles.id, Number(req.params.id))).limit(1);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const { name, description, permissions } = req.body;
  // Built-in roles keep their name/description; their permissions stay editable
  if (!role.built_in && name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Role name required' });
    try {
      await db.update(roles).set({ name: String(name).trim() }).where(eq(roles.id, role.id));
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(400).json({ error: 'Role name already exists' });
      throw err;
    }
  }
  if (!role.built_in && description !== undefined) {
    await db.update(roles).set({ description: String(description) }).where(eq(roles.id, role.id));
  }
  if (permissions !== undefined) {
    const perms = validatePermissionList(permissions);
    if (!perms) return res.status(400).json({ error: 'Invalid permission list' });
    await setRolePermissions(role.id, perms);
  }
  // Quotas are editable on every role, including built-ins (like permissions)
  if ('maxCores' in req.body || 'maxMemoryGb' in req.body || 'maxStorageGb' in req.body) {
    const maxCores = parseQuotaValue(req.body.maxCores);
    const maxMemoryGb = parseQuotaValue(req.body.maxMemoryGb);
    const maxStorageGb = parseQuotaValue(req.body.maxStorageGb);
    if (maxCores === undefined || maxMemoryGb === undefined || maxStorageGb === undefined) {
      return res.status(400).json({ error: 'Quota values must be non-negative integers (empty = unlimited)' });
    }
    await db.update(roles).set({ max_cores: maxCores, max_memory_gb: maxMemoryGb, max_storage_gb: maxStorageGb })
      .where(eq(roles.id, role.id));
  }
  await logAudit(req, 'admin_update_role', role.name, Array.isArray(permissions) ? permissions.join(',') : '');
  const [updated] = await db.select().from(roles).where(eq(roles.id, role.id)).limit(1);
  res.json(await serializeRole(updated));
});

router.delete('/roles/:id', requireAdmin, async (req, res) => {
  const [role] = await db.select().from(roles).where(eq(roles.id, Number(req.params.id))).limit(1);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.built_in) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  // Unassign holders first, then delete (role_permissions cascade away)
  await db.update(users).set({ role_id: null }).where(eq(users.role_id, role.id));
  await db.delete(roles).where(eq(roles.id, role.id));
  await logAudit(req, 'admin_delete_role', role.name, '');
  res.json({ ok: true });
});

router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const [user] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { roleId } = req.body;
  if (roleId === null || roleId === undefined || roleId === '') {
    await db.update(users).set({ role_id: null }).where(eq(users.id, user.id));
    await logAudit(req, 'admin_assign_role', user.username, 'none');
    return res.json({ ok: true });
  }
  const [role] = await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.id, Number(roleId))).limit(1);
  if (!role) return res.status(400).json({ error: 'Role not found' });
  await db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  await logAudit(req, 'admin_assign_role', user.username, role.name);
  res.json({ ok: true });
});

// ─── Invites (one-time self-registration links) ──────────────────────────────
// Managed by can_manage_users. Generate returns the raw token exactly once (the
// DB only ever holds its hash); the admin UI turns it into a shareable URL.

router.get('/invites', pUsers, async (req, res) => {
  const rows = await db.select().from(invites).orderBy(desc(invites.created_at));
  res.json(await Promise.all(rows.map(async (row) => {
    // preset is a jsonb column — already an object.
    const preset = row.preset || {};
    return {
      id: row.id,
      status: inviteStatus(row),
      createdBy: row.created_by_username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedBy: row.used_by_username,
      revokedAt: row.revoked_at,
      requires2fa: !!row.require_2fa,
      preset: await summarizeInvitePreset(preset),
    };
  })));
});

router.post('/invites', pUsers, async (req, res) => {
  const result = await normalizeInvitePreset(req.body, {
    allowAdmin: !!req.session.isAdmin,
    allowPrivileges: !!req.session.isAdmin,
  });
  if ('error' in result) return res.status(400).json({ error: result.error });
  const { preset } = result;

  // Expiry: positive number of days, or empty/omitted for "never expires".
  let expiresAt: Date | null = null;
  const rawExpiry = req.body.expiresInDays;
  if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
    const days = parseInt(rawExpiry, 10);
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ error: 'Expiry must be a positive number of days (empty = never)' });
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const require2fa = req.body.require2fa ? 1 : 0;
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);

  // preset is a jsonb column — pass the object directly.
  const [r] = await db.insert(invites).values({
    token_hash: tokenHash, created_by: req.session.userId, created_by_username: req.session.username,
    preset, require_2fa: !!require2fa, expires_at: expiresAt,
  }).returning({ id: invites.id });

  await logAudit(req, 'admin_create_invite', `invite #${r.id}`, `role=${(preset as any).roleId ?? 'none'} require2fa=${require2fa}`);

  // Raw token returned ONCE — never persisted, never retrievable again.
  res.json({
    id: r.id,
    token,
    expiresAt,
    requires2fa: !!require2fa,
    preset: await summarizeInvitePreset(preset),
  });
});

router.delete('/invites/:id', pUsers, async (req, res) => {
  const [invite] = await db.select().from(invites).where(eq(invites.id, Number(req.params.id))).limit(1);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.used_at) return res.status(400).json({ error: 'Invite has already been used' });
  if (invite.revoked_at) return res.status(400).json({ error: 'Invite is already revoked' });
  await db.update(invites).set({ revoked_at: new Date() }).where(eq(invites.id, invite.id));
  await logAudit(req, 'admin_revoke_invite', `invite #${invite.id}`, '');
  res.json({ ok: true });
});

router.delete('/users/:id', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  // Assignments cascade away with the user — capture them (and the username,
  // which won't exist anymore) so the owner tags get cleared from PVE.
  const [target] = await db.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
  const orphanedVms = await db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.user_id, Number(req.params.id)));
  await db.delete(users).where(eq(users.id, Number(req.params.id)));
  await logAudit(req, 'admin_delete_user', req.params.id, '');
  for (const vm of orphanedVms) {
    await syncVmTagsSafe(vm.node, vm.vmid, { retired: [target?.username].filter(Boolean) });
  }
  res.json({ ok: true });
});

// ─── VMs (from Proxmox) ───────────────────────────────────────────────────────

router.get('/vms', pAssignments, async (req, res) => {
  try {
    const vms = await getAllVMs();
    const assignments = await db.select({
      id: vmAssignments.id, user_id: vmAssignments.user_id, node: vmAssignments.node, vmid: vmAssignments.vmid,
      username: users.username,
    }).from(vmAssignments).innerJoin(users, eq(users.id, vmAssignments.user_id));
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

router.get('/assignments', pAssignments, async (req, res) => {
  const rows = await db.select({
    id: vmAssignments.id, user_id: vmAssignments.user_id, node: vmAssignments.node, vmid: vmAssignments.vmid,
    username: users.username,
  }).from(vmAssignments).innerJoin(users, eq(users.id, vmAssignments.user_id)).orderBy(users.username);
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

router.post('/assignments', pAssignments, async (req, res) => {
  const { userId, node, vmid } = req.body;
  if (!userId || !node || !vmid) {
    return res.status(400).json({ error: 'userId, node and vmid required' });
  }
  try {
    const [r] = await db.insert(vmAssignments).values({ user_id: userId, node, vmid: parseInt(vmid) })
      .returning({ id: vmAssignments.id });
    await syncVmTagsSafe(node, vmid);
    res.json({ id: r.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VM already assigned to a user' });
    }
    throw err;
  }
});

router.delete('/assignments/:id', pAssignments, async (req, res) => {
  const [assignment] = await db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.id, Number(req.params.id))).limit(1);
  await db.delete(vmAssignments).where(eq(vmAssignments.id, Number(req.params.id)));
  if (assignment) await syncVmTagsSafe(assignment.node, assignment.vmid);
  res.json({ ok: true });
});

// ─── PVE tag auto-sync (background scheduler + manual force-sync) ─────────────

// Snapshot of the auto-sync state for the Assignments status card: whether
// auto-sync is armed or paused (and by whom/when), the interval, whether a run
// is in flight right now (with live progress), and last-run stats/failures.
router.get('/tag-sync/status', pAssignments, async (req, res) => {
  try {
    const settings = await getTagSyncSettings();
    res.json({
      ...settings,
      running: isTagSyncRunning(),
      progress: getTagSyncProgress(),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Pause the background scheduler. Persisted to `settings`, so it survives a
// backend restart; records who paused it and when for provenance.
router.post('/tag-sync/pause', pAssignments, async (req, res) => {
  try {
    await setTagSyncPaused(true, req.session?.username);
    await logAudit(req, 'vm_tags_sync_pause', 'all', 'auto-sync paused');
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Re-arm the background scheduler.
router.post('/tag-sync/resume', pAssignments, async (req, res) => {
  try {
    await setTagSyncPaused(false, req.session?.username);
    await logAudit(req, 'vm_tags_sync_resume', 'all', 'auto-sync resumed');
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Change the auto-sync interval (hours).
router.post('/tag-sync/interval', pAssignments, async (req, res) => {
  try {
    const hours = await setTagSyncIntervalHours(req.body?.intervalHours);
    await logAudit(req, 'vm_tags_sync_interval', 'all', `interval set to ${hours}h`);
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Re-stamp owner/VLAN tags on every VM the portal can see — for the first
// rollout, or after NIC/VLAN changes made outside the portal. Shares the fleet
// loop with the background scheduler via runFullTagSync(). Only one run may be
// in flight at a time (409 if the scheduler or another operator is mid-run).
router.post('/sync-vm-tags', pAssignments, async (req, res) => {
  if (isTagSyncRunning()) {
    return res.status(409).json({ error: 'A tag sync is already running', running: true, progress: getTagSyncProgress() });
  }
  try {
    const summary = await runFullTagSync({ trigger: 'manual' });
    await logAudit(req, 'vm_tags_sync', 'all', `${summary.checked} checked, ${summary.updated} updated, ${summary.failed} failed`);
    res.json({ checked: summary.checked, updated: summary.updated, failed: summary.failed, failures: summary.failures });
  } catch (err) {
    if (err.code === 'TAG_SYNC_BUSY') {
      return res.status(409).json({ error: 'A tag sync is already running', running: true, progress: getTagSyncProgress() });
    }
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VLANs ───────────────────────────────────────────────────────────────────

async function findNextAvailableVlanTag() {
  const usedTags = new Set(
    (await db.select({ tag: vlans.tag }).from(vlans).orderBy(vlans.tag))
      .map(row => parseInt(row.tag, 10))
      .filter(Number.isInteger)
  );

  const ranges = (await db.select({ vlan_range_start: firewalls.vlan_range_start, vlan_range_end: firewalls.vlan_range_end })
    .from(firewalls).orderBy(firewalls.vlan_range_start, firewalls.vlan_range_end))
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
router.get('/vlans', requirePermission('can_manage_vlans', 'can_manage_policies', 'can_manage_assignments'), async (req, res) => {
  const isAdmin = req.session.isAdmin;
  const vlanRows = isAdmin
    ? await db.select().from(vlans).orderBy(vlans.tag)
    : await db.select({
        id: vlans.id, name: vlans.name, tag: vlans.tag, mode: vlans.mode,
        subnet_cidr: vlans.subnet_cidr, description: vlans.description, created_at: vlans.created_at,
      }).from(vlans)
        .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
        .where(eq(userVlans.user_id, req.session.userId))
        .orderBy(vlans.tag);
  const syncs = await db.select({
    vlan_id: firewallVlanSync.vlan_id, firewall_id: firewallVlanSync.firewall_id,
    interface_name: firewallVlanSync.interface_name, firewall_name: firewalls.name,
  }).from(firewallVlanSync).innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id));
  const syncMap = {};
  syncs.forEach(s => {
    if (!syncMap[s.vlan_id]) syncMap[s.vlan_id] = [];
    syncMap[s.vlan_id].push({ firewallId: s.firewall_id, firewallName: s.firewall_name, interfaceName: s.interface_name });
  });
  const fwRanges = await db.select({
    id: firewalls.id, name: firewalls.name, vlan_range_start: firewalls.vlan_range_start, vlan_range_end: firewalls.vlan_range_end,
  }).from(firewalls);
  res.json(vlanRows.map(v => ({ ...v, firewallSync: syncMap[v.id] || [], subnet: serializeVlanSubnet(v), firewallRanges: fwRanges })));
});

router.post('/vlans', pVlans, async (req, res) => {
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
    vlanTag = await findNextAvailableVlanTag();
    if (!vlanTag) {
      return res.status(409).json({ error: 'No VLAN tags are available in the configured firewall pools' });
    }
  }

  try {
    const [r] = await db.insert(vlans).values({
      name, tag: vlanTag, mode, subnet_cidr: mode === 'tagged_only' ? trimmedSubnetCidr : '', description: description || '',
    }).returning({ id: vlans.id });

    // Auto-assign to creating non-admin so they can immediately see and manage it
    if (!req.session.isAdmin) {
      await db.insert(userVlans).values({ user_id: req.session.userId, vlan_id: r.id }).onConflictDoNothing();
    }

    res.json({ id: r.id, name, tag: vlanTag, mode, subnet_cidr: mode === 'tagged_only' ? trimmedSubnetCidr : '', description: description || '' });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});

router.put('/vlans/:id', pVlans, async (req, res) => {
  const { name, tag, description, mode, subnetCidr } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const [existing] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
  if (!existing) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, existing.id)) {
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

  const [{ count: syncCount }] = await db.select({ count: count() }).from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));
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
    await db.update(vlans).set({
      name, tag: requestedTag, mode: nextMode, subnet_cidr: nextSubnetCidr, description: description || '',
    }).where(eq(vlans.id, Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});

router.delete('/vlans/:id', pVlans, async (req, res) => {
  const [vlan] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, vlan.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const syncs = await db.select({
    // firewall_vlan_sync columns (was fvs.*)
    id: firewallVlanSync.id, firewall_id: firewallVlanSync.firewall_id, vlan_id: firewallVlanSync.vlan_id,
    interface_name: firewallVlanSync.interface_name, policy_ids: firewallVlanSync.policy_ids,
    dhcp_server_id: firewallVlanSync.dhcp_server_id, synced_at: firewallVlanSync.synced_at,
    artifacts: firewallVlanSync.artifacts, workflow_run_id: firewallVlanSync.workflow_run_id,
    // firewall fields the FortiGate client needs
    fw_id: firewalls.id, fw_name: firewalls.name, host: firewalls.host, port: firewalls.port,
    api_key: firewalls.api_key, vdom: firewalls.vdom, verify_tls: firewalls.verify_tls,
    root_vdom: firewalls.root_vdom, root_wan_zone: firewalls.root_wan_zone, root_vdom_link: firewalls.root_vdom_link,
    trunk_switch_serial: firewalls.trunk_switch_serial, trunk_switch_port: firewalls.trunk_switch_port,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));

  const fwResults = [];

  // 1. Clean up port forwards that target this VLAN's interface
  for (const sync of syncs) {
    const vlanIfaceName = sync.interface_name; // e.g. vlan1008
    const portForwards = await db.select().from(managedVips)
      .where(and(eq(managedVips.firewall_id, sync.fw_id), eq(managedVips.vlan_interface, vlanIfaceName)));

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
          await db.delete(managedVips).where(eq(managedVips.id, pf.id));
          console.log(`[delete-vlan] Cleaned up port forward "${pf.vip_name}"`);
        } catch (e) {
          console.warn(`[delete-vlan] Failed to fully clean port forward "${pf.vip_name}":`, e.message);
          // Still remove from DB — the FortiGate objects are best-effort
          await db.delete(managedVips).where(eq(managedVips.id, pf.id));
        }
      }
    }
  }

  // 2. Deprovision VLAN from each synced firewall (interface, address obj, DHCP, routes, policies, switch)
  for (const sync of syncs) {
    console.log(`[delete-vlan] Deprovisioning VLAN ${vlan.tag} (${sync.interface_name}) from ${sync.fw_name}`);
    try {
      const client = createClient(sync);
      let errors;
      if (sync.artifacts) {
        // Artifact-based teardown of exactly what the sync run created.
        // artifacts is a jsonb column — already an object.
        ({ errors } = await teardownArtifacts(client, sync.artifacts));
      } else {
        // Legacy row — original live-query deprovision path.
        // policy_ids is a jsonb column — already an array.
        const policyIds = sync.policy_ids || [];
        ({ errors } = await client.deprovisionVlan(sync.interface_name, policyIds, sync.dhcp_server_id, {
          rootVdom: sync.root_vdom || 'root',
          trunkSwitchSerial: sync.trunk_switch_serial || '',
          trunkSwitchPort:   sync.trunk_switch_port   || '',
        }));
      }
      if (errors.length > 0) {
        console.warn(`[delete-vlan] Partial cleanup on ${sync.fw_name}:`, errors);
        fwResults.push({ firewall: sync.fw_name, status: 'partial', errors });
      } else {
        console.log(`[delete-vlan] Successfully removed from ${sync.fw_name}`);
        await db.delete(firewallVlanSync).where(and(eq(firewallVlanSync.firewall_id, sync.firewall_id), eq(firewallVlanSync.vlan_id, vlan.id)));
        fwResults.push({ firewall: sync.fw_name, status: 'ok' });
      }
    } catch (err) {
      console.error(`[delete-vlan] Failed to deprovision from ${sync.fw_name}:`, err.message);
      fwResults.push({ firewall: sync.fw_name, status: 'error', error: err.message });
    }
  }

  const failedCleanup = fwResults.filter(result => result.status !== 'ok');
  if (failedCleanup.length > 0) {
    await logAudit(
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
  await db.delete(vlans).where(eq(vlans.id, Number(req.params.id)));
  await logAudit(req, 'admin_delete_vlan', `VLAN ${vlan.tag}`, fwResults.length ? `FW cleanup: ${fwResults.map(r => `${r.firewall}=${r.status}`).join(', ')}` : '');
  res.json({ ok: true, firewallCleanup: fwResults });
});

// ─── User VLAN assignments ────────────────────────────────────────────────────

router.get('/users/:id/vlans', pAssignments, async (req, res) => {
  const rows = await db.select({
    id: vlans.id, name: vlans.name, tag: vlans.tag, mode: vlans.mode,
    subnet_cidr: vlans.subnet_cidr, description: vlans.description, created_at: vlans.created_at,
  }).from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, Number(req.params.id)))
    .orderBy(vlans.tag);
  res.json(rows);
});

router.post('/users/:id/vlans', pAssignments, async (req, res) => {
  const { vlanId } = req.body;
  if (!vlanId) return res.status(400).json({ error: 'vlanId required' });
  try {
    await db.insert(userVlans).values({ user_id: Number(req.params.id), vlan_id: vlanId });
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN already assigned to this user' });
    }
    throw err;
  }
});

router.delete('/users/:id/vlans/:vlanId', pAssignments, async (req, res) => {
  await db.delete(userVlans).where(and(eq(userVlans.user_id, Number(req.params.id)), eq(userVlans.vlan_id, Number(req.params.vlanId))));
  res.json({ ok: true });
});

// ─── User VM assignments ──────────────────────────────────────────────────────

router.get('/users/:id/vms', pAssignments, async (req, res) => {
  const rows = await db.select().from(vmAssignments).where(eq(vmAssignments.user_id, Number(req.params.id))).orderBy(vmAssignments.vmid);
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

// ─── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, async (req, res) => {
  const rows = await db.select().from(settings);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  res.json(result);
});

router.put('/settings/:key', requireAdmin, async (req, res) => {
  const { value } = req.body;
  await setSetting(req.params.key, String(value));
  res.json({ ok: true });
});

// ─── Capacity policy (node memory pre-check) ────────────────────────────────
// How the provisioning pre-flight treats memory: off / warn (default) / block,
// compared against physical RAM × the overcommit ratio. Storage is not
// configurable — `storage.avail` is a real limit and always blocks.

router.get('/capacity-settings', requireAdmin, async (req, res) => {
  res.json({ ...(await getCapacitySettings()), memoryModes: MEMORY_MODES });
});

router.put('/capacity-settings', requireAdmin, async (req, res) => {
  const { memoryMode, overcommitRatio } = req.body || {};
  if (memoryMode !== undefined && memoryMode !== null && !MEMORY_MODES.includes(String(memoryMode))) {
    return res.status(400).json({ error: `Memory mode must be one of: ${MEMORY_MODES.join(', ')}` });
  }
  if (overcommitRatio !== undefined && overcommitRatio !== null) {
    const ratio = Number.parseFloat(overcommitRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return res.status(400).json({ error: 'Overcommit ratio must be a number greater than 0' });
    }
  }
  const capacity = await setCapacitySettings({ memoryMode, overcommitRatio });
  await logAudit(req, 'capacity_settings_update', '', `memory=${capacity.memoryMode} ratio=${capacity.overcommitRatio}`);
  res.json({ ...capacity, memoryModes: MEMORY_MODES });
});

// ─── VM Leases (expiry / reclaim) ────────────────────────────────────────────
// Admin-only: default lease duration + grace period, the full lease roster with
// live VM state and owner, exempt/adjust/extend/renew any lease, a reclaimable
// view, a manual sweep, and a backfill for pre-feature VMs.

router.get('/lease-settings', requireAdmin, async (req, res) => {
  res.json(await getLeaseSettings());
});

router.put('/lease-settings', requireAdmin, async (req, res) => {
  const { defaultDays, graceDays } = req.body || {};
  const leaseSettings = await setLeaseSettings({ defaultDays, graceDays });
  await logAudit(req, 'lease_settings_update', '', `default=${leaseSettings.defaultDays}d grace=${leaseSettings.graceDays}d`);
  res.json(leaseSettings);
});

router.get('/leases', requireAdmin, async (req, res) => {
  try {
    const leaseSettings = await getLeaseSettings();
    const graceDays = leaseSettings.graceDays;
    const rows = await db.select().from(vmLeases)
      .orderBy(sql`(${vmLeases.expires_at} IS NULL), ${vmLeases.expires_at} ASC`);

    // Live VM name/status/type + owner from assignments (best-effort — the
    // cluster may be briefly unreachable, in which case we still return leases).
    let vms = [];
    try { vms = await getAllVMs(); } catch { vms = []; }
    const vmByKey = new Map();
    for (const v of vms) {
      if (v.nodeRef) vmByKey.set(`${v.nodeRef}#${v.vmid}`, v);
      if (v.node) vmByKey.set(`${v.node}#${v.vmid}`, v);
    }

    const leases = await Promise.all(rows.map(async (row) => {
      const view = await computeLeaseView(row, graceDays);
      const identity = serializeNodeIdentity(row.node);
      const live = vmByKey.get(`${row.node}#${row.vmid}`)
        || vmByKey.get(`${identity.node}#${row.vmid}`)
        || null;
      const ownerCandidates = nodeLookupCandidates(row.node);
      const [owner] = ownerCandidates.length === 0 ? [] : await db.select({ username: users.username })
        .from(vmAssignments)
        .innerJoin(users, eq(users.id, vmAssignments.user_id))
        .where(and(eq(vmAssignments.vmid, row.vmid), inArray(vmAssignments.node, ownerCandidates)))
        .limit(1);

      return {
        ...view,
        node: identity.node,
        nodeRef: identity.nodeRef,
        vmid: row.vmid,
        name: live?.name || `VM ${row.vmid}`,
        type: live?.type || null,
        vmStatus: live?.status || 'unknown',
        owner: owner?.username || null,
        createdBy: row.created_by || '',
      };
    }));

    res.json({ settings: leaseSettings, leases });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/leases/:node/:vmid', requireAdmin, async (req, res) => {
  const { node, vmid } = req.params;
  const { exempt, leaseDays, extendDays } = req.body || {};
  try {
    const lease = await updateLease(node, vmid, { exempt, leaseDays, extendDays, createdBy: req.session.username });
    if (!lease) return res.status(400).json({ error: 'Could not update lease' });
    const detail = [
      exempt !== undefined ? `exempt=${exempt ? 1 : 0}` : null,
      leaseDays !== undefined && leaseDays !== null ? `leaseDays=${leaseDays}` : null,
      extendDays !== undefined && extendDays !== null ? `extendDays=${extendDays}` : null,
    ].filter(Boolean).join(' ');
    await logAudit(req, 'lease_adjust', `${node}/${vmid}`, detail);
    res.json({ ok: true, lease: await computeLeaseView(lease) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/leases/:node/:vmid/renew', requireAdmin, async (req, res) => {
  const { node, vmid } = req.params;
  try {
    const lease = await renewLease(node, vmid, { createdBy: req.session.username });
    if (!lease) return res.status(404).json({ error: 'This VM has no lease to renew' });
    await logAudit(req, 'lease_renew', `${node}/${vmid}`, `admin renewal #${lease.renewal_count}`);
    res.json({ ok: true, lease: await computeLeaseView(lease) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/leases/sweep', requireAdmin, async (req, res) => {
  try {
    const result = await runLeaseSweep();
    await logAudit(req, 'lease_sweep', 'all', `checked=${result.checked} stopped=${result.stopped}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/leases/backfill', requireAdmin, async (req, res) => {
  try {
    const created = await backfillLeases({ createdBy: req.session.username });
    await logAudit(req, 'lease_backfill', 'all', `created=${created}`);
    res.json({ ok: true, created });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── PVE Hosts ──────────────────────────────────────────────────────────────

router.get('/pve-hosts', pHosts, async (req, res) => {
  const hosts = (await getHosts()).map(h => ({
    id: h.id, name: h.name, host: h.host, port: h.port,
    token_id: h.token_id, verify_tls: h.verify_tls, created_at: h.created_at,
    // Don't send token_secret / ssh_secret to frontend
    ssh_host: h.ssh_host || '', ssh_port: h.ssh_port || 22,
    ssh_user: h.ssh_user || 'root', ssh_auth_type: h.ssh_auth_type || 'key',
    has_ssh: !!(h.ssh_host && h.ssh_secret),
  }));
  res.json(hosts);
});

router.get('/pve-hosts/:id/status', pHosts, async (req, res) => {
  const host = await getHost(parseInt(req.params.id));
  if (!host) return res.status(404).json({ error: 'Host not found' });
  const status = await getHostStatus(host);
  // Annotate each node with its maintenance state (amber, not down) so the
  // PVE Hosts page can render the drain and offer the per-node toggle.
  const maint = await listMaintenance();
  if (Array.isArray(status.nodes)) {
    status.nodes = status.nodes.map((n) => {
      const nodeRef = encodeNodeRef(host.id, n.node);
      const m = maint.find((x) => x.nodeRef === nodeRef || (x.hostId == null && x.node === n.node));
      return { ...n, nodeRef, maintenance: m ? { id: m.id, reason: m.reason, until: m.until, untilLabel: m.untilLabel } : null };
    });
  }
  res.json(status);
});

router.post('/pve-hosts', pHosts, async (req, res) => {
  let name, host, port;
  const { tokenId, tokenSecret, verifyTls = true } = req.body;
  try {
    name = boundedString(req.body?.name, { field: 'name', min: 1, max: 80 });
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (!name || !host || !tokenId || !tokenSecret) {
    return res.status(400).json({ error: 'Name, host, tokenId and tokenSecret are required' });
  }
  if (!verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling Proxmox TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  try {
    const [r] = await db.insert(pveHosts).values({
      name, host, port, token_id: tokenId, token_secret: encryptSecret(tokenSecret), verify_tls: !!verifyTls,
    }).returning({ id: pveHosts.id });
    const { sshHost, sshPort, sshUser, sshAuthType, sshSecret } = req.body;
    if (String(sshHost || '').trim() && sshSecret) {
      await db.update(pveHosts).set({
        ssh_host: String(sshHost).trim(), ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: String(sshUser || 'root').trim() || 'root',
        ssh_auth_type: sshAuthType === 'password' ? 'password' : 'key', ssh_secret: encryptSecret(sshSecret),
      }).where(eq(pveHosts.id, r.id));
    }
    await logAudit(req, 'pve_host_created', String(r.id), `name=${name}; host=${host}; port=${port}; tls=${verifyTls ? 'verify' : 'insecure'}`);
    res.json({ id: r.id, name, host, port });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/pve-hosts/:id', pHosts, async (req, res) => {
  let name, host, port;
  const { tokenId, tokenSecret, verifyTls, sshHost, sshPort, sshUser, sshAuthType, sshSecret } = req.body;
  try {
    name = boundedString(req.body?.name, { field: 'name', min: 1, max: 80 });
    host = validateHost(req.body?.host);
    port = validatePort(req.body?.port ?? 8006);
    if (sshHost) validateHost(sshHost);
    if (sshPort !== undefined) validatePort(sshPort);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }
  if (!name || !host || !tokenId) {
    return res.status(400).json({ error: 'Name, host and tokenId are required' });
  }
  const existing = await getHost(parseInt(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Host not found' });

  // If tokenSecret is empty, keep the existing one
  const secret = tokenSecret ? encryptSecret(tokenSecret) : existing.token_secret;
  const verifyTlsEnabled = verifyTls === undefined ? !!existing.verify_tls : !!verifyTls;
  if (!verifyTlsEnabled && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling Proxmox TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  await db.update(pveHosts).set({
    name, host, port, token_id: tokenId, token_secret: secret, verify_tls: verifyTlsEnabled,
  }).where(eq(pveHosts.id, Number(req.params.id)));

  // Optional root SSH (used only for post-migration source-config cleanup).
  // Empty sshHost clears the whole SSH config; an empty sshSecret keeps the
  // stored one. Changing the SSH host re-pins the host key on next connect.
  if (sshHost !== undefined) {
    const newSshHost = String(sshHost || '').trim();
    if (!newSshHost) {
      await db.update(pveHosts).set({ ssh_host: '', ssh_secret: '', ssh_host_key: '' }).where(eq(pveHosts.id, Number(req.params.id)));
    } else {
      const sshSecretStored = sshSecret ? encryptSecret(sshSecret) : (existing.ssh_secret || '');
      const hostKey = newSshHost === (existing.ssh_host || '') ? (existing.ssh_host_key || '') : '';
      await db.update(pveHosts).set({
        ssh_host: newSshHost, ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: String(sshUser || 'root').trim() || 'root',
        ssh_auth_type: sshAuthType === 'password' ? 'password' : 'key', ssh_secret: sshSecretStored, ssh_host_key: hostKey,
      }).where(eq(pveHosts.id, Number(req.params.id)));
    }
  }
  await logAudit(req, 'pve_host_updated', String(req.params.id), `name=${name}; host=${host}; port=${port}; tls=${verifyTlsEnabled ? 'verify' : 'insecure'}`);
  res.json({ ok: true });
});

router.get('/pve-hosts/:id/dependencies', pHosts, async (req, res) => {
  if (!await getHost(Number.parseInt(req.params.id, 10))) return res.status(404).json({ error: 'Host not found' });
  res.json(await pveHostDependencies(req.params.id));
});

router.delete('/pve-hosts/:id', pHosts, async (req, res) => {
  const [{ count: hostCount }] = await db.select({ count: count() }).from(pveHosts);
  if (hostCount <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last host' });
  }
  const host = await getHost(Number.parseInt(req.params.id, 10));
  if (!host) return res.status(404).json({ error: 'Host not found' });
  try {
    await deletePveHost(req.params.id);
    await logAudit(req, 'pve_host_deleted', String(req.params.id), `name=${host.name}; host=${host.host}`);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'PVE_HOST_HAS_DEPENDENCIES') {
      return res.status(409).json({ error: err.message, code: err.code, ...err.report });
    }
    throw err;
  }
});

// ─── Storage pool exposure ───────────────────────────────────────────────────
// Admins choose which Proxmox storage pools regular users may pick when creating
// VMs / editing disks. A pool with no stored row is exposed by default, so there
// is zero behavior change until an admin hides a pool.

router.get('/pve-hosts/:id/storages', pHosts, async (req, res) => {
  const hostId = parseInt(req.params.id, 10);
  const host = await getHost(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  try {
    const pools = await getHostStoragePools(host);
    const visibility = await storageVisibilityMap(hostId);
    const rows = pools
      .map((p) => ({
        storage: p.storage,
        type: p.type || '',
        content: p.content || '',
        // Missing row ⇒ exposed by default.
        exposed: visibility.has(p.storage) ? visibility.get(p.storage) : true,
      }))
      .sort((a, b) => a.storage.localeCompare(b.storage));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/pve-hosts/:id/storages/:storage', pHosts, async (req, res) => {
  const hostId = parseInt(req.params.id, 10);
  const host = await getHost(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  const storage = String(req.params.storage || '').trim();
  if (!storage || !/^[a-zA-Z0-9._-]+$/.test(storage)) {
    return res.status(400).json({ error: 'Invalid storage identifier' });
  }
  const exposed = req.body?.exposed !== false && req.body?.exposed !== 0;
  await setStorageExposed(hostId, storage, exposed);
  await logAudit(req, 'storage_visibility_change', `${host.name}/${storage}`, exposed ? 'exposed' : 'hidden');
  res.json({ ok: true, storage, exposed });
});

// ─── Node maintenance (soft drain) ───────────────────────────────────────────
// Toggle per-node maintenance. While active, provisioning to the node is
// blocked, a notice is auto-published, and Overview health renders it amber.
// Running VMs are untouched.

router.get('/node-maintenance', pHosts, async (req, res) => {
  try {
    res.json(await listMaintenance());
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/node-maintenance', pHosts, async (req, res) => {
  const { node, reason = '', until = null } = req.body;
  if (!node) return res.status(400).json({ error: 'A node is required' });
  try {
    const row = await enterMaintenance({ node, reason, until, req });
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/node-maintenance/:id', pHosts, async (req, res) => {
  try {
    const ok = await exitMaintenanceById(parseInt(req.params.id, 10), req);
    if (!ok) return res.status(404).json({ error: 'Maintenance entry not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Firewalls ─────────────────────────────────────────────────────────────

// Firewalls read also needed by policies page and vlans page
router.get('/firewalls', requirePermission('can_manage_firewalls', 'can_manage_port_forwards', 'can_manage_policies', 'can_manage_vlans'), async (req, res) => {
  const firewallRows = await db.select().from(firewalls).orderBy(firewalls.name);
  const canSeeSensitiveFields = req.session.isAdmin
    || await userHasPermission(req.session.userId, 'can_manage_firewalls');
  // Don't expose api_key to frontend
  res.json(firewallRows.map(f => ({
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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

router.post('/firewalls', pFirewalls, async (req, res) => {
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
    const [r] = await db.insert(firewalls).values({
      name, type, host, port, api_key: encryptSecret(apiKey), vdom, parent_interface: parentInterface,
      wan_interface: wanInterface, vlan_range_start: vlanRangeStart, vlan_range_end: vlanRangeEnd,
      lab_vdom_link: labVdomLink, root_vdom: rootVdom, root_vdom_link: rootVdomLink, route_gateway: routeGateway,
      trunk_switch_serial: trunkSwitchSerial, trunk_switch_port: trunkSwitchPort, verify_tls: !!verifyTls,
      external_ip: externalIp, root_wan_zone: rootWanZone,
    }).returning({ id: firewalls.id });
    // Seed the built-in default provisioning workflows for the new firewall so
    // it works out of the box; admins can then customize per trigger.
    try { await seedWorkflowsForFirewall(r.id); } catch (e) { console.warn('[workflows] seed on firewall create failed:', e.message); }
    await logAudit(req, 'admin_create_firewall', name, `${host}:${port} vdom=${vdom}`);
    res.json({ id: r.id, name, host, port });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/firewalls/:id', pFirewalls, async (req, res) => {
  const { name, host, port = 443, apiKey, vdom, parentInterface, wanInterface, verifyTls } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: 'Name and host are required' });
  }
  const existing = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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
  const verifyTlsEnabled = verifyTls === undefined ? !!existing.verify_tls : !!verifyTls;
  const extIp       = req.body.externalIp   ?? existing.external_ip   ?? '';
  const wanZone     = req.body.rootWanZone  ?? existing.root_wan_zone ?? 'underlay';
  if (!verifyTlsEnabled && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return res.status(400).json({ error: 'Disabling firewall TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set' });
  }
  if (rangeStart >= rangeEnd || rangeStart < 1 || rangeEnd > 4094) {
    return res.status(400).json({ error: 'Invalid VLAN range (must be 1–4094, start < end)' });
  }
  await db.update(firewalls).set({
    name, host, port, api_key: key, vdom: vdom || existing.vdom,
    parent_interface: parentInterface || existing.parent_interface, wan_interface: wanInterface || existing.wan_interface,
    vlan_range_start: rangeStart, vlan_range_end: rangeEnd, lab_vdom_link: labLink, root_vdom: rootVd,
    root_vdom_link: rootLink, route_gateway: routeGw, trunk_switch_serial: trunkSerial, trunk_switch_port: trunkPort,
    verify_tls: verifyTlsEnabled, external_ip: extIp, root_wan_zone: wanZone,
  }).where(eq(firewalls.id, Number(req.params.id)));
  await logAudit(req, 'admin_update_firewall', name, `${host}:${port}`);
  res.json({ ok: true });
});

router.delete('/firewalls/:id', pFirewalls, async (req, res) => {
  const [fw] = await db.select({ name: firewalls.name }).from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1);
  await db.delete(firewalls).where(eq(firewalls.id, Number(req.params.id)));
  await logAudit(req, 'admin_delete_firewall', fw?.name || req.params.id, '');
  res.json({ ok: true });
});

// ─── VLAN ↔ Firewall Sync ─────────────────────────────────────────────────

router.get('/vlans/:id/sync', pVlans, async (req, res) => {
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const syncs = await db.select({
    ...getTableColumns(firewallVlanSync),
    firewall_name: firewalls.name,
    firewall_host: firewalls.host,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));
  res.json(syncs);
});

router.post('/vlans/:id/sync', pVlans, async (req, res) => {
  try {
    const [vlan] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
    if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
    if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, vlan.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (vlan.mode === 'tagged_only') {
      return res.status(400).json({ error: 'Tagged-only VLANs cannot be pushed to firewalls' });
    }

    const { firewallId, allowInternet = true, enableDhcp = true } = req.body;
    const fwRows = firewallId
      ? [(await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0]]
      : await db.select().from(firewalls);

    console.log(`[sync] VLAN ${vlan.tag} → ${fwRows.length} firewall(s), allowInternet=${allowInternet}, enableDhcp=${enableDhcp}`);

    const results = [];
    for (const fw of fwRows) {
      if (!fw) continue;
      // Skip if already synced
      const [existing] = await db.select({ id: firewallVlanSync.id }).from(firewallVlanSync)
        .where(and(eq(firewallVlanSync.firewall_id, fw.id), eq(firewallVlanSync.vlan_id, vlan.id))).limit(1);
      if (existing) { results.push({ firewall: fw.name, status: 'already_synced' }); continue; }

      // Validate VLAN tag is within this firewall's allowed range
      if (vlan.tag < fw.vlan_range_start || vlan.tag > fw.vlan_range_end) {
        results.push({ firewall: fw.name, status: 'error', error: `VLAN tag ${vlan.tag} is outside allowed range ${fw.vlan_range_start}–${fw.vlan_range_end}` });
        continue;
      }

      try {
        console.log(`[sync] Provisioning VLAN ${vlan.tag} on ${fw.name} (${fw.host}:${fw.port} vdom=${fw.vdom})`);
        const client = createClient(fw);

        // Provisioning now runs through the configurable workflow engine. The
        // seeded default `vlan_provision` workflow reproduces the historical
        // hardcoded sequence exactly; edits to it change what the next sync does.
        const bundle = getWorkflowBundle(fw.id, 'vlan_provision');
        const settings = workflowSettings(bundle.workflow);
        const subnet = deriveSubnet(vlan.tag, settings);
        if (!subnet) throw new Error(`Cannot derive subnet from VLAN tag ${vlan.tag}`);
        const context = {
          tag: vlan.tag,
          name: vlan.name,
          subnet,
          allowInternet: allowInternet !== false,
          enableDhcp: enableDhcp !== false,
          trunkConfigured: !!(fw.trunk_switch_serial && fw.trunk_switch_port),
          firewall: buildFirewallContext(fw),
        };
        const { runId, outputs, artifacts } = await runBundle({
          bundle, context, client, firewall: fw,
          subjectType: 'vlan', subjectId: vlan.id, subjectLabel: `VLAN ${vlan.tag} (${vlan.name})`,
          requestId: req.requestId || '',
        });
        // Derive the legacy sync columns from step outputs generically so a
        // renamed/reordered workflow still populates them. Artifacts (stored
        // below) are the source of truth for teardown.
        const outVals = Object.values(outputs);
        const interfaceName = outVals.find((o) => o?.interfaceName)?.interfaceName || `vlan${vlan.tag}`;
        const policyIds = outVals.map((o) => o?.policyId).filter((v) => v !== undefined && v !== null);
        const dhcpServerId = outVals.find((o) => o?.dhcpServerId)?.dhcpServerId ?? null;
        const staticRouteId = outVals.find((o) => o?.routeId)?.routeId ?? null;
        const result = { interfaceName, policyIds, dhcpServerId, staticRouteId, subnet };
        console.log(`[sync] Success:`, JSON.stringify(result));
        // policy_ids and artifacts are jsonb columns — pass objects directly.
        await db.insert(firewallVlanSync).values({
          firewall_id: fw.id, vlan_id: vlan.id, interface_name: interfaceName,
          policy_ids: policyIds, dhcp_server_id: dhcpServerId, artifacts, workflow_run_id: runId,
        });
        await logAudit(req, 'admin_sync_vlan_firewall', `VLAN ${vlan.tag}`, `${fw.name}: ${interfaceName} (${subnet.network})`);
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
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  // Mirrors the old `fvs.*, f.*` shape: firewall columns win on name collisions
  // (id becomes the firewall id), plus the firewall_vlan_sync fields the
  // teardown path needs.
  const [sync] = await db.select({
    ...getTableColumns(firewalls),
    interface_name: firewallVlanSync.interface_name,
    policy_ids: firewallVlanSync.policy_ids,
    dhcp_server_id: firewallVlanSync.dhcp_server_id,
    artifacts: firewallVlanSync.artifacts,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(and(eq(firewallVlanSync.vlan_id, Number(req.params.id)), eq(firewallVlanSync.firewall_id, Number(req.params.firewallId))))
    .limit(1);
  if (!sync) return res.status(404).json({ error: 'Sync record not found' });

  try {
    const client = createClient(sync);
    if (sync.artifacts) {
      // Artifact-based teardown: delete exactly what this run created (reverse order).
      // artifacts is a jsonb column — already an object.
      await teardownArtifacts(client, sync.artifacts);
    } else {
      // Legacy row (synced before the workflow engine) — original live-query path.
      // policy_ids is a jsonb column — already an array.
      const policyIds = sync.policy_ids || [];
      await client.deprovisionVlan(sync.interface_name, policyIds, sync.dhcp_server_id, {
        rootVdom: sync.root_vdom || 'root',
        trunkSwitchSerial: sync.trunk_switch_serial || '',
        trunkSwitchPort:   sync.trunk_switch_port   || '',
      });
    }
  } catch (err) {
    console.error('Deprovision warning:', err.message);
  }

  await db.delete(firewallVlanSync).where(and(eq(firewallVlanSync.vlan_id, Number(req.params.id)), eq(firewallVlanSync.firewall_id, Number(req.params.firewallId))));
  await logAudit(req, 'admin_unsync_vlan_firewall', `VLAN ${req.params.id}`, `Firewall ${req.params.firewallId}`);
  res.json({ ok: true });
});

// ─── Policy Engine ──────────────────────────────────────────────────────────

router.get('/policies', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);
    const allPolicies = await client.getPolicies();

    // Get synced VLANs for this firewall (non-admins only see their assigned VLANs)
    const isAdmin = req.session.isAdmin;
    const syncCols = {
      interface_name: firewallVlanSync.interface_name,
      vlan_id: vlans.id, vlan_name: vlans.name, vlan_tag: vlans.tag,
    };
    const syncs = isAdmin
      ? await db.select(syncCols).from(firewallVlanSync)
          .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)))
      : await db.select(syncCols).from(firewallVlanSync)
          .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
          .innerJoin(userVlans, and(eq(userVlans.vlan_id, vlans.id), eq(userVlans.user_id, req.session.userId)))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)));
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

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  // Resolve VLANs
  const vlanWithIfaceCols = { ...getTableColumns(vlans), interface_name: firewallVlanSync.interface_name };
  const [srcVlan] = await db.select(vlanWithIfaceCols).from(vlans)
    .innerJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(and(eq(vlans.tag, Number(srcVlanTag)), eq(firewallVlanSync.firewall_id, Number(firewallId)))).limit(1);
  const [dstVlan] = await db.select(vlanWithIfaceCols).from(vlans)
    .innerJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(and(eq(vlans.tag, Number(dstVlanTag)), eq(firewallVlanSync.firewall_id, Number(firewallId)))).limit(1);
  if (!srcVlan) return res.status(400).json({ error: `Source VLAN ${srcVlanTag} not synced to this firewall` });
  if (!dstVlan) return res.status(400).json({ error: `Destination VLAN ${dstVlanTag} not synced to this firewall` });

  // Non-admins must have both VLANs assigned to them
  if (!req.session.isAdmin) {
    const hasSrc = await userOwnsVlan(req.session.userId, srcVlan.id);
    const hasDst = await userOwnsVlan(req.session.userId, dstVlan.id);
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

    // The reverse policy is only created when bidirectional AND it doesn't
    // already exist — decide here, then let the workflow's conditional step run.
    let doReverse = false;
    if (bidirectional) {
      const revDup = existing.find(p =>
        (p.srcintf || []).some(i => i.name === dstVlan.interface_name) &&
        (p.dstintf || []).some(i => i.name === srcVlan.interface_name)
      );
      doReverse = !revDup;
    }

    // Policy creation runs through the configurable workflow engine. The seeded
    // default `policy_create` workflow reproduces the forward/reverse policy
    // shapes exactly; the engine rolls back the forward policy if the reverse
    // one fails.
    const bundle = getWorkflowBundle(fw.id, 'policy_create');
    const context = {
      action,
      bidirectional: doReverse,
      services,
      srcVlan: { interface_name: srcVlan.interface_name, name: srcVlan.name, tag: srcVlan.tag },
      dstVlan: { interface_name: dstVlan.interface_name, name: dstVlan.name, tag: dstVlan.tag },
      srcAddrName,
      dstAddrName,
      firewall: buildFirewallContext(fw),
    };
    const { outputs } = await runBundle({
      bundle, context, client, firewall: fw,
      subjectType: 'policy', subjectId: `${srcVlan.interface_name}->${dstVlan.interface_name}`,
      subjectLabel: `${srcVlan.interface_name} → ${dstVlan.interface_name}`,
      requestId: req.requestId || '',
    });
    const policyIds = [outputs.forward?.policyId, outputs.reverse?.policyId].filter((v) => v !== undefined && v !== null);

    // Keep every policy inside its source VLAN's sequence group — the workflow
    // appends new policies at the bottom, which fragments the GUI grouping
    await joinSequenceGroup(client, outputs.forward?.policyId, `${srcVlan.name} (${srcVlan.interface_name})`);
    await joinSequenceGroup(client, outputs.reverse?.policyId, `${dstVlan.name} (${dstVlan.interface_name})`);

    await logAudit(req, 'admin_create_policy', `${srcVlan.interface_name} → ${dstVlan.interface_name}`, `services: ${services.join(',')} action: ${action}${bidirectional ? ' (bidirectional)' : ''}`);
    res.json({ policyIds });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/policies/:policyId', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
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
        const userSyncs = await db.select({ interface_name: firewallVlanSync.interface_name }).from(firewallVlanSync)
          .innerJoin(userVlans, and(eq(userVlans.vlan_id, firewallVlanSync.vlan_id), eq(userVlans.user_id, req.session.userId)))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)));
        const userIntfs = new Set(userSyncs.map(s => s.interface_name));
        const hasAccess = policyIntfs.some(i => userIntfs.has(i));
        if (!hasAccess) {
          return res.status(403).json({ error: 'You do not have access to the VLANs in this policy' });
        }
      }
    }

    await client.deletePolicy(req.params.policyId);
    await logAudit(req, 'admin_delete_policy', `Policy ${req.params.policyId}`, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Address & Service Objects ──────────────────────────────────────────────

router.get('/objects/addresses', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, type };
    if (type === 'ipmask' && subnet) data.subnet = subnet;
    if (type === 'fqdn' && fqdn) data.fqdn = fqdn;
    if (comment) data.comment = comment;
    await client.createAddressObject(data);
    await logAudit(req, 'admin_create_address_object', name, `type=${type} ${subnet || fqdn || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId, subnet, fqdn, comment } = req.body;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = {};
    if (subnet) data.subnet = subnet;
    if (fqdn) data.fqdn = fqdn;
    if (comment !== undefined) data.comment = comment;
    await client.updateAddressObject(req.params.name, data);
    await logAudit(req, 'admin_update_address_object', req.params.name, JSON.stringify(data));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteAddressObject(req.params.name);
    await logAudit(req, 'admin_delete_address_object', req.params.name, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/objects/services', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, protocol };
    if (tcpPortrange) data['tcp-portrange'] = tcpPortrange;
    if (udpPortrange) data['udp-portrange'] = udpPortrange;
    if (comment) data.comment = comment;
    await client.createServiceObject(data);
    await logAudit(req, 'admin_create_service_object', name, `tcp=${tcpPortrange || ''} udp=${udpPortrange || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/services/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteServiceObject(req.params.name);
    await logAudit(req, 'admin_delete_service_object', req.params.name, `Firewall: ${fw.name}`);
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

// Sequence-group label for a port forward's root-VDOM policy: one group per
// owning user, so it's obvious who has what open. FortiGate's GUI shows one
// group only when same-label policies are also adjacent — creation and the
// regroup endpoint both keep them contiguous.
async function portForwardOwnerUsername(vmid, mappedIp) {
  if (vmid) {
    const [byVmid] = await db.select({ username: users.username }).from(vmAssignments)
      .innerJoin(users, eq(users.id, vmAssignments.user_id))
      .where(eq(vmAssignments.vmid, parseInt(vmid, 10))).limit(1);
    if (byVmid) return byVmid.username;
  }
  if (mappedIp) {
    const [byIp] = await db.select({ username: users.username }).from(vmSshConfigs)
      .innerJoin(vmAssignments, eq(vmAssignments.vmid, vmSshConfigs.vmid))
      .innerJoin(users, eq(users.id, vmAssignments.user_id))
      .where(eq(vmSshConfigs.host, mappedIp)).limit(1);
    if (byIp) return byIp.username;
  }
  return '';
}

async function portForwardGroupLabel(vmid, mappedIp) {
  const username = await portForwardOwnerUsername(vmid, mappedIp);
  return username ? `Port Forwarding - ${username}` : 'Port Forwarding (VM Manager)';
}

// FortiGate's GUI derives sequence sections from global-label markers: a
// non-empty label STARTS a new section, which then runs until the next
// labeled policy. Only the group's first policy (the anchor) may carry the
// label — stamping it on every member renders each one as its own "(#N)"
// section. Park `policyId` at the end of the `label` section, or make it the
// anchor if the section doesn't exist yet. Best effort: grouping is cosmetic
// and must never fail the operation that created the policy.
async function joinSequenceGroup(client, policyId, label, vdom = null) {
  if (!policyId || !label) return;
  try {
    const policies = await client.getPolicies(vdom);
    const self = policies.find((p) => String(p.policyid) === String(policyId));
    const anchorIdx = policies.findIndex((p) =>
      (p['global-label'] || '') === label && String(p.policyid) !== String(policyId));
    if (anchorIdx === -1) {
      if ((self?.['global-label'] || '') !== label) {
        await client.updatePolicy(policyId, { 'global-label': label }, vdom);
      }
      return;
    }
    // The section's tail is the last consecutive unlabeled policy after the anchor
    let tailId = policies[anchorIdx].policyid;
    for (let i = anchorIdx + 1; i < policies.length; i++) {
      if (String(policies[i].policyid) === String(policyId)) continue;
      if ((policies[i]['global-label'] || '') !== '') break;
      tailId = policies[i].policyid;
    }
    if ((self?.['global-label'] || '') !== '') {
      await client.updatePolicy(policyId, { 'global-label': '' }, vdom);
    }
    await client.movePolicy(policyId, 'after', tailId, vdom);
  } catch { /* best effort */ }
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

// Walk the policy list top-to-bottom; the first policy of each label is the
// group anchor and keeps its position. Every later policy with the same label
// is moved directly after the group's current tail, so each label ends up as
// one contiguous block. Labels follow FortiGate's section semantics (see
// joinSequenceGroup): the anchor carries the group's global-label, every
// other member gets it CLEARED — a non-empty label starts a new "(#N)"
// section in the GUI. Policies without a portal label are never touched.
async function regroupAdjacent(client, vdom, labelFor, warnings) {
  let moved = 0;
  let relabeled = 0;
  const policies = await client.getPolicies(vdom);
  const tails = new Map(); // label → policyid of the group's current bottom
  for (const p of policies) {
    const label = labelFor(p);
    if (!label) continue;
    const tail = tails.get(label);
    const wantLabel = tail === undefined ? label : '';
    if ((p['global-label'] || '') !== wantLabel) {
      try {
        await client.updatePolicy(p.policyid, { 'global-label': wantLabel }, vdom);
        relabeled += 1;
      } catch (err) {
        warnings.push(`${vdom} policy ${p.policyid} label: ${err.message}`);
      }
    }
    if (tail !== undefined) {
      try {
        await client.movePolicy(p.policyid, 'after', tail, vdom);
        moved += 1;
      } catch (err) {
        warnings.push(`${vdom} policy ${p.policyid} move: ${err.message}`);
      }
    }
    tails.set(label, p.policyid);
  }
  return { moved, relabeled };
}

// One-shot cleanup to the current grouping scheme, then make each group
// contiguous. Root VDOM: only portal-managed port-forward policies, grouped
// per owning user. Lab VDOM: EVERY policy whose source is a synced VLAN
// interface joins that VLAN's group (manual ones included — grouping by
// source interface is the whole point); port-forward legs (srcintf = the
// inter-VDOM link) group per destination VLAN. Relative order WITHIN a group
// is preserved; a policy outside any group can end up crossed by group
// members consolidating past it — review custom deny rules after running.
router.post('/firewalls/:id/regroup-policies', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);
    const rootVdom = fw.root_vdom || 'root';
    const labVdom = fw.vdom || 'lab';
    const summary = { rootRelabeled: 0, rootMoved: 0, labRelabeled: 0, labMoved: 0, warnings: [] };

    // ── Root VDOM: port forwards grouped per owning user ─────────────────────
    const managed = await db.select().from(managedVips).where(eq(managedVips.firewall_id, fw.id));
    const desiredRootLabels = new Map(); // policyid → label
    for (const vip of managed) {
      if (!vip.policy_id) continue;
      desiredRootLabels.set(String(vip.policy_id), await portForwardGroupLabel(null, vip.mapped_ip));
    }
    const rootLabelFor = (p) => desiredRootLabels.get(String(p.policyid)) || null;

    const rootResult = await regroupAdjacent(client, rootVdom, rootLabelFor, summary.warnings);
    summary.rootRelabeled = rootResult.relabeled;
    summary.rootMoved = rootResult.moved;

    // ── Lab VDOM: VLAN policies grouped per source interface ─────────────────
    const syncs = await db.select({
      interface_name: firewallVlanSync.interface_name, vlan_name: vlans.name,
    }).from(firewallVlanSync)
      .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
      .where(eq(firewallVlanSync.firewall_id, fw.id));
    const ifaceLabels = new Map(syncs.map((s) => [s.interface_name, `${s.vlan_name} (${s.interface_name})`]));
    const labLabelFor = (p) => {
      const src = (p.srcintf || [])[0]?.name || '';
      const dst = (p.dstintf || [])[0]?.name || '';
      if (ifaceLabels.has(src)) return ifaceLabels.get(src);
      // Port-forward legs enter through the inter-VDOM link — group per target VLAN
      if (ifaceLabels.has(dst) && String(p.name || '').startsWith('PF: ')) return `Port Forwarding (${dst})`;
      return null;
    };

    const labResult = await regroupAdjacent(client, labVdom, labLabelFor, summary.warnings);
    summary.labRelabeled = labResult.relabeled;
    summary.labMoved = labResult.moved;

    await logAudit(req, 'admin_regroup_policies', fw.name,
      `root: ${summary.rootRelabeled} relabeled/${summary.rootMoved} moved; lab: ${summary.labRelabeled} relabeled/${summary.labMoved} moved${summary.warnings.length ? `; ${summary.warnings.length} warnings` : ''}`);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Update WAN config (external IP + WAN zone) from the port forwarding page
router.put('/firewalls/:id/wan-config', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  const { externalIp, rootWanZone } = req.body;
  await db.update(firewalls).set({
    external_ip: externalIp ?? fw.external_ip ?? '', root_wan_zone: rootWanZone ?? fw.root_wan_zone ?? 'underlay',
  }).where(eq(firewalls.id, Number(req.params.id)));
  await logAudit(req, 'admin_update_wan_config', fw.name, `extIp=${externalIp} wanZone=${rootWanZone}`);
  res.json({ ok: true });
});

// List all VIPs from root VDOM with managed/unmanaged status
router.get('/firewalls/:id/vips', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const allVips = await client.getVips(rootVdom);
    const unrestricted = await canManageAllPortForwards(req);
    const managedRows = await db.select({ vip_name: managedVips.vip_name, vlan_interface: managedVips.vlan_interface })
      .from(managedVips).where(eq(managedVips.firewall_id, fw.id));
    const managedMap = new Map(managedRows.map(row => [row.vip_name, row]));
    const allowedInterfaces = unrestricted
      ? null
      : new Set((await getScopedFirewallSyncs(req.session.userId, fw.id, false)).map(sync => sync.interface_name));

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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
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
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  let { name, protocol = 'tcp', extPort, mappedIp, mappedPort, dstInterface, vlanInterface, srcAddresses = ['all'], node, vmid } = req.body;
  // Which public endpoint to publish on. Omitted / null keeps the historical
  // behavior: the firewall's default WAN address. Only the *id* is accepted —
  // the address, interface and gateway are always resolved server-side from the
  // stored pool, never taken from the client.
  const publicIpId = req.body.publicIpId ?? req.body.public_ip_id ?? null;
  const unrestricted = await canManageAllPortForwards(req);
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
  // Enforce FortiGate's object-name limit server-side, even if a client submits
  // an overlong name. Bounded to PORT_FORWARD_NAME_MAX (not 35) so the derived
  // "PF: <name>" policy name also stays within the 35-char cap. Matches the
  // frontend preview (frontend/src/utils/vipName.js) exactly.
  name = shortenVipName(name, PORT_FORWARD_NAME_MAX);

  const serviceName = buildManagedVipServiceName(name, protocol, mappedPort);
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
        return res.status(403).json({ error: 'You can only create port forwards for VMs assigned to you' });
      }
      // Report the specific missing prerequisite rather than a generic "not on a
      // VLAN you can publish through" — the user cannot act on the generic one.
      if (!target.eligible) {
        const blocked = target.blocked;
        return res.status(blockedStatus(blocked)).json({
          error: blockedErrorText(blocked) || 'This VM is not on a VLAN you can publish through this firewall',
          blocked: blocked || null,
        });
      }

      mappedIp = target.ip;
      dstInterface = target.dstInterface;
      vlanInterface = target.vlanInterface;
      srcAddresses = ['all'];
    }

    if (!mappedIp || !dstInterface) {
      return res.status(400).json({ error: 'mappedIp and dstInterface are required' });
    }

    const [duplicateMappedPort] = await db.select({ vip_name: managedVips.vip_name }).from(managedVips)
      .where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.mapped_ip, mappedIp),
        eq(managedVips.mapped_port, mappedPort), eq(managedVips.protocol, protocol))).limit(1);
    if (duplicateMappedPort) {
      return res.status(409).json({
        error: `Internal port ${mappedIp}:${mappedPort}/${protocol.toUpperCase()} is already published by "${duplicateMappedPort.vip_name}"`
      });
    }

    // Resolve the public endpoint. Everything the firewall needs — the external
    // address and the interface it arrives on — comes out of the stored pool;
    // the request only ever names an id, so a non-admin cannot publish onto an
    // address (or an interface) that was not handed to them.
    let publicIp = null;
    let publicPool = null;
    let publicAssignment = null;
    if (publicIpId !== null && publicIpId !== undefined && publicIpId !== '') {
      publicIp = (await db.select().from(publicIps)
        .where(and(eq(publicIps.id, Number(publicIpId)), eq(publicIps.firewall_id, fw.id))).limit(1))[0] || null;
      publicPool = publicIp ? (await db.select().from(publicIpPools).where(eq(publicIpPools.id, publicIp.pool_id)).limit(1))[0] || null : null;
      publicAssignment = publicIp
        ? (await db.select().from(publicIpAssignments).where(eq(publicIpAssignments.public_ip_id, publicIp.id)).limit(1))[0] || null
        : null;
      const denial = checkPublicIpUsage({
        isAdmin: req.session.isAdmin,
        unrestricted,
        userId: req.session.userId,
        publicIp,
        pool: publicPool,
        assignment: publicAssignment,
        target: { mappedIp, vmid },
      });
      if (denial) return res.status(denial.status).json({ error: denial.error });
    }

    const externalIp = publicIp ? publicIp.address : (fw.external_ip || '');
    if (!externalIp) {
      return res.status(400).json({ error: 'Firewall has no external IP configured. Set it in WAN config first.' });
    }

    labAddressName = vlanInterface ? buildManagedVipAddressName(name, mappedIp) : '';
    const { client, rootVdom } = getRootClient(fw);
    // Inbound traffic for a dedicated address arrives on the pool's transit
    // interface, not on the shared WAN zone.
    const wanZone = publicPool?.external_interface || fw.root_wan_zone || 'underlay';
    const labVdom = fw.vdom || 'lab';

    // Endpoint-aware external-port conflict check. The boundary is
    // firewall + public endpoint + protocol + overlapping port range, so two
    // users may both publish 443/tcp as long as they sit on different public
    // addresses — while two forwards on the SAME address still collide.
    const candidateEndpoint = {
      firewallId: fw.id,
      publicIpId: publicIp?.id ?? null,
      address: externalIp,
      protocol,
      port: extPort,
      label: name,
    };

    // Managed forwards first: the portal's own records give the friendliest
    // error and stay correct even when FortiGate is temporarily unreachable.
    const managedEndpoints = (await db.select({
      vip_name: managedVips.vip_name, protocol: managedVips.protocol, ext_port: managedVips.ext_port,
      public_ip_id: managedVips.public_ip_id, public_address: publicIps.address,
    }).from(managedVips)
      .leftJoin(publicIps, eq(publicIps.id, managedVips.public_ip_id))
      .where(eq(managedVips.firewall_id, fw.id))).map(row => ({
      firewallId: fw.id,
      publicIpId: row.public_ip_id,
      // A NULL public_ip_id still means the default WAN endpoint.
      address: row.public_address || (row.public_ip_id ? '' : (fw.external_ip || '')),
      protocol: row.protocol,
      port: row.ext_port,
      label: row.vip_name,
    }));
    const managedConflict = findPortConflict(managedEndpoints, candidateEndpoint);
    if (managedConflict) {
      return res.status(409).json({ error: portConflictMessage(managedConflict) });
    }

    // Then everything live on the box, including VIPs nobody here created.
    // A VIP whose extip cannot be read as an address (or is the catch-all
    // 0.0.0.0) is attributed to the default WAN endpoint, which is where such a
    // rule actually listens — that keeps the legacy check as strict as it was.
    const allVips = await client.getVips(rootVdom);
    const liveEndpoints = allVips
      .filter(v => v.portforward === 'enable')
      .map(v => {
        const extip = normalizeIpv4(v.extip);
        return {
          firewallId: fw.id,
          address: !extip || extip === '0.0.0.0' ? (fw.external_ip || '') : extip,
          protocol: v.protocol || 'tcp',
          port: v.extport,
          label: v.name,
        };
      });
    const liveConflict = findPortConflict(liveEndpoints, candidateEndpoint);
    if (liveConflict) {
      return res.status(409).json({ error: portConflictMessage(liveConflict) });
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

    if (vlanInterface) {
      const existingLabService = await client.getServiceObject(serviceName, labVdom);
      if (existingLabService && !managedVipServiceMatches(existingLabService, protocol, mappedPort)) {
        return res.status(409).json({ error: `A lab VDOM service object named "${serviceName}" already exists with different port settings` });
      }

      const existingLabAddress = await client.getAddressObject(labAddressName, labVdom);
      if (existingLabAddress && !managedVipAddressMatches(existingLabAddress, mappedIp)) {
        return res.status(409).json({ error: `A lab VDOM address object named "${labAddressName}" already exists with a different IP` });
      }
    }

    // Object creation (service objects, VIP, and the inbound policy chain) runs
    // through the configurable workflow engine. The seeded default
    // `port_forward_create` workflow reproduces the historical sequence exactly;
    // the engine records each created object and rolls back in reverse on failure.
    const bundle = getWorkflowBundle(fw.id, 'port_forward_create');
    const context = {
      name,
      protocol,
      externalPort: extPort,
      internalIp: mappedIp,
      internalPort: mappedPort,
      dstInterface,
      vlanInterface: vlanInterface || '',
      srcAddresses,
      serviceName,
      labAddressName,
      externalIp,
      wanZone,
      rootVdom,
      labVdom,
      labSrcInterface: fw.lab_vdom_link || 'lab-root0',
      firewall: buildFirewallContext(fw),
    };
    const { runId, outputs, artifacts } = await runBundle({
      bundle, context, client, firewall: fw,
      subjectType: 'port_forward', subjectId: name, subjectLabel: name,
      requestId: req.requestId || '',
    });
    policyId = outputs.policy_root?.policyId ?? null;
    labPolicyId = outputs.policy_lab?.policyId ?? null;

    // Grouping: one sequence group per owning user in the root VDOM, and the
    // target VLAN's port-forward group in the lab VDOM. The workflow engine
    // appends policies at the bottom with a default label, so park them
    // afterwards — cosmetic, never fails the port forward.
    await joinSequenceGroup(client, policyId, await portForwardGroupLabel(vmid, mappedIp), rootVdom);
    if (vlanInterface) {
      await joinSequenceGroup(client, labPolicyId, `Port Forwarding (${vlanInterface})`, labVdom);
    }

    // Track in DB (with recorded artifacts for artifact-based teardown on delete).
    // artifacts is a jsonb column — pass the object directly.
    await db.insert(managedVips).values({
      firewall_id: fw.id, vip_name: name, policy_id: policyId, service_name: serviceName, protocol,
      ext_port: extPort, mapped_ip: mappedIp, mapped_port: mappedPort, dst_interface: dstInterface,
      lab_policy_id: labPolicyId, vlan_interface: vlanInterface || '', artifacts, workflow_run_id: runId,
      public_ip_id: publicIp?.id ?? null,
    });

    await logAudit(req, 'admin_create_port_forward', name, `${protocol}/${externalIp}:${extPort} → ${mappedIp}:${mappedPort} via ${dstInterface}/${vlanInterface}`);
    res.json({
      ok: true, vipName: name, policyId, labPolicyId, serviceName, externalIp,
      publicIpId: publicIp?.id ?? null,
      // A dedicated address only has its inbound VIP built here. The egress
      // path that makes replies leave through the same transit interface is
      // provisioned by a workflow that does not exist yet — say so instead of
      // letting the caller assume the forward is complete.
      publicIpProvisioning: publicAssignment
        ? describeAssignmentProvisioning(publicAssignment.status)
        : null,
    });
  } catch (err) {
    // The engine already rolled back anything it created on failure.
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Delete a managed port forward (VIP + policy)
router.delete('/firewalls/:id/vips/:name', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  const vipName = req.params.name;
  const [managed] = await db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.vip_name, vipName))).limit(1);
  if (!managed) {
    return res.status(403).json({ error: 'Cannot delete unmanaged VIPs. This was not created through VM Manager.' });
  }
  if (!await canManageAllPortForwards(req)) {
    const allowedInterfaces = new Set((await getScopedFirewallSyncs(req.session.userId, fw.id, false)).map(sync => sync.interface_name));
    if (!managed.vlan_interface || !allowedInterfaces.has(managed.vlan_interface)) {
      return res.status(403).json({ error: 'You do not have access to this port forward' });
    }
  }

  try {
    const { client, rootVdom } = getRootClient(fw);

    if (managed.artifacts) {
      // Artifact-based teardown: delete exactly what the create run recorded,
      // in reverse order (lab policy → root policy → VIP → lab address → services).
      // artifacts is a jsonb column — already an object.
      await teardownArtifacts(client, managed.artifacts);
    } else {
      // Legacy row (created before the workflow engine) — original delete path.
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
    }

    // Remove from DB
    await db.delete(managedVips).where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.vip_name, vipName)));

    await logAudit(req, 'admin_delete_port_forward', vipName, `Firewall: ${fw.name}`);
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

router.get('/audit-log', pAudit, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(Math.min(parseInt(req.query.limit, 10) || 50, 200), 1);
  const offset = (page - 1) * limit;
  const action = req.query.action || '';

  // Optional action filter, then a stable created_at DESC page. User input
  // (action/limit/offset) is bound as parameters, never interpolated into SQL.
  const whereClause = action ? eq(auditLog.action, action) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(auditLog).where(whereClause);
  const rows = await db.select().from(auditLog).where(whereClause)
    .orderBy(desc(auditLog.created_at)).limit(limit).offset(offset);
  res.json({ rows, total, page, limit });
});

export default router;
