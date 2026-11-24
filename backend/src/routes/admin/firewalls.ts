import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { firewalls, firewallVlanSync, managedVips } from '../../db/schema/index.ts';
import { createClient } from '../../fortigate.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit } from '../../utils/audit.ts';
import { encryptSecret } from '../../utils/secrets.ts';
import { userHasPermission } from '../../utils/permissions.ts';
import { seedWorkflowsForFirewall } from '../../workflows/store.ts';
import { isValidUpstreamHost } from '../../utils/validation.ts';
import { ALLOW_INSECURE_UPSTREAM_TLS, pFirewalls } from './shared.ts';

const router = Router();

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
  if (!isValidUpstreamHost(host)) return res.status(400).json({ error: 'Host must be a valid IP address or DNS hostname' });
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
  if (!isValidUpstreamHost(host)) return res.status(400).json({ error: 'Host must be a valid IP address or DNS hostname' });
  const existing = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!existing) return res.status(404).json({ error: 'Firewall not found' });

  // A blank API key keeps the stored one only while the upstream target is unchanged.
  const verifyTlsEnabled = verifyTls === undefined ? existing.verify_tls !== false : !!verifyTls;
  if (!apiKey && (String(host) !== existing.host || Number(port) !== Number(existing.port) || (!verifyTlsEnabled && existing.verify_tls !== false))) {
    return res.status(400).json({ error: 'Re-enter the API key when changing the address', field: 'apiKey' });
  }
  const key = apiKey ? encryptSecret(apiKey) : existing.api_key;
  const rangeStart    = req.body.vlanRangeStart ?? existing.vlan_range_start;
  const rangeEnd      = req.body.vlanRangeEnd   ?? existing.vlan_range_end;
  const labLink       = req.body.labVdomLink    || existing.lab_vdom_link   || 'lab-root0';
  const rootVd        = req.body.rootVdom       || existing.root_vdom       || 'root';
  const rootLink      = req.body.rootVdomLink   || existing.root_vdom_link  || 'lab-root1';
  const routeGw       = req.body.routeGateway   || existing.route_gateway   || '10.255.254.2';
  const trunkSerial   = req.body.trunkSwitchSerial ?? existing.trunk_switch_serial ?? '';
  const trunkPort     = req.body.trunkSwitchPort   ?? existing.trunk_switch_port   ?? '';
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
  const firewallId = Number(req.params.id);
  // One transaction: lock the firewall row (creators take it FOR SHARE before
  // inserting tracking rows), check dependents, delete. The FK cascade would
  // otherwise drop records whose FortiGate objects stay live and unmanageable.
  const outcome = await db.transaction(async (tx) => {
    const [fw] = await tx.select({ name: firewalls.name }).from(firewalls).where(eq(firewalls.id, firewallId)).for('update');
    const [syncRow] = await tx.select({ id: firewallVlanSync.id }).from(firewallVlanSync)
      .where(eq(firewallVlanSync.firewall_id, firewallId)).limit(1);
    const [vipRow] = await tx.select({ id: managedVips.id }).from(managedVips)
      .where(eq(managedVips.firewall_id, firewallId)).limit(1);
    if (syncRow || vipRow) return { blocked: true };
    await tx.delete(firewalls).where(eq(firewalls.id, firewallId));
    return { blocked: false, fw };
  });
  if (outcome.blocked) {
    return res.status(409).json({ error: 'Firewall still has synced VLANs or port forwards; unsync and remove them first' });
  }
  const { fw } = outcome;
  await logAudit(req, 'admin_delete_firewall', fw?.name || req.params.id, '');
  res.json({ ok: true });
});

export default router;
