import https from 'https';
import http from 'http';
import { decryptSecret } from './utils/secrets.js';

const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

/**
 * Convert a 4-digit VLAN tag to subnet info.
 * Tag 1126 → 10.11.26.0/24 (split into 2-digit pairs for octets 2 and 3)
 */
export function vlanTagToSubnet(tag) {
  const s = String(tag).padStart(4, '0');
  if (s.length !== 4) return null;
  const oct2 = parseInt(s.substring(0, 2), 10);
  const oct3 = parseInt(s.substring(2, 4), 10);
  if (oct2 > 255 || oct3 > 255) return null;
  return {
    ip: `10.${oct2}.${oct3}.1`,
    netmask: '255.255.255.0',
    network: `10.${oct2}.${oct3}.0/24`,
    networkIp: `10.${oct2}.${oct3}.0`,
    dhcpStart: `10.${oct2}.${oct3}.10`,
    dhcpEnd: `10.${oct2}.${oct3}.254`,
    gateway: `10.${oct2}.${oct3}.1`,
  };
}

/**
 * FortiGate REST API client for FortiOS 7.x
 */
export class FortiGateAPI {
  constructor(host, port, apiKey, vdom = 'root', verifyTls = true) {
    this.host = host;
    this.port = port || 443;
    this.apiKey = apiKey;
    this.vdom = vdom;
    this.verifyTls = verifyTls;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object|null} data
   * @param {string|null} vdomOverride - VDOM name, or 'global' for ?global=1
   */
  async request(method, path, data = null, vdomOverride = null) {
    if (!this.verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
      throw new Error('FortiGate TLS verification is disabled. Re-enable TLS verification or set ALLOW_INSECURE_UPSTREAM_TLS=true as a temporary exception.');
    }

    let scopeParam;
    if (vdomOverride === 'global') {
      scopeParam = 'global=1';
    } else {
      const vdom = vdomOverride || this.vdom;
      scopeParam = `vdom=${encodeURIComponent(vdom)}`;
    }
    const sep = path.includes('?') ? '&' : '?';
    const url = `/api/v2/${path}${sep}${scopeParam}`;

    const agent = new https.Agent({ rejectUnauthorized: this.verifyTls });
    const body = data ? JSON.stringify(data) : null;

    const options = {
      hostname: this.host,
      port: this.port,
      path: url,
      method,
      agent,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    return new Promise((resolve, reject) => {
      const lib = this.port === 80 ? http : https;
      const req = lib.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errMsg = parsed?.results?.[0]?.error || parsed?.cli_error || parsed?.http_status || `HTTP ${res.statusCode}`;
            reject(new Error(`FortiGate API error: ${errMsg}`));
          }
        });
      });
      req.on('error', (err) => reject(new Error(`FortiGate connection error: ${err.message}`)));
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('FortiGate request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  // ─── System ──────────────────────────────────────────────────────────────────

  async getSystemStatus() {
    return this.request('GET', 'monitor/system/status');
  }

  // ─── Interfaces ──────────────────────────────────────────────────────────────

  async getInterfaces(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/system/interface', null, vdomOverride);
    return res.results || [];
  }

  async getInterface(name) {
    try {
      const res = await this.request('GET', `cmdb/system/interface/${encodeURIComponent(name)}`);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  /**
   * Create VLAN interface at global scope, assigned to this.vdom.
   * Guide step 1: scope=global, role=undefined
   */
  async createVlanInterface(name, vlanId, parentInterface, ip, netmask, opts = {}) {
    return this.request('POST', 'cmdb/system/interface', {
      name,
      vdom: this.vdom,
      type: 'vlan',
      vlanid: vlanId,
      interface: parentInterface,
      ip: `${ip} ${netmask}`,
      allowaccess: 'ping',
      role: 'undefined',
      ...(opts.description ? { description: opts.description } : {}),
    }, 'global');
  }

  async deleteInterface(name) {
    return this.request('DELETE', `cmdb/system/interface/${encodeURIComponent(name)}`, null, 'global');
  }

  // ─── Firewall Policies ───────────────────────────────────────────────────────

  async getPolicies(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/firewall/policy', null, vdomOverride);
    return res.results || [];
  }

  async getPolicy(policyId, vdomOverride = null) {
    const res = await this.request('GET', `cmdb/firewall/policy/${policyId}`, null, vdomOverride);
    return res.results?.[0] || res || null;
  }

  async createPolicy(policy, vdomOverride = null) {
    return this.request('POST', 'cmdb/firewall/policy', policy, vdomOverride);
  }

  async deletePolicy(policyId, vdomOverride = null) {
    return this.request('DELETE', `cmdb/firewall/policy/${policyId}`, null, vdomOverride);
  }

  async movePolicy(policyId, position, refPolicyId, vdomOverride = null) {
    // position: 'before' or 'after'
    return this.request('PUT', `cmdb/firewall/policy/${policyId}?action=move&${position}=${refPolicyId}`, null, vdomOverride);
  }

  // ─── Static Routes ─────────────────────────────────────────────────────────

  async getStaticRoutes(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/router/static', null, vdomOverride);
    return res.results || [];
  }

  async createStaticRoute(dst, netmask, gateway, device, vdomOverride = null) {
    return this.request('POST', 'cmdb/router/static', {
      dst: `${dst} ${netmask}`,
      gateway,
      device,
    }, vdomOverride);
  }

  async deleteStaticRoute(routeId, vdomOverride = null) {
    return this.request('DELETE', `cmdb/router/static/${routeId}`, null, vdomOverride);
  }

  // ─── DHCP Server ─────────────────────────────────────────────────────────────

  async getDhcpServers() {
    const res = await this.request('GET', 'cmdb/system.dhcp/server');
    return res.results || [];
  }

  async getDhcpServer(serverId) {
    const res = await this.request('GET', `cmdb/system.dhcp/server/${serverId}`);
    return res.results?.[0] || res || null;
  }

  async createDhcpServer(interfaceName, gateway, netmask, startIp, endIp, dns = ['1.1.1.1', '8.8.8.8']) {
    const config = {
      'default-gateway': gateway,
      netmask,
      interface: interfaceName,
      'ip-range': [{ 'start-ip': startIp, 'end-ip': endIp }],
      'lease-time': 86400,
      'dns-service': 'specify',
    };
    if (dns[0]) config['dns-server1'] = dns[0];
    if (dns[1]) config['dns-server2'] = dns[1];
    return this.request('POST', 'cmdb/system.dhcp/server', config);
  }

  async deleteDhcpServer(serverId) {
    return this.request('DELETE', `cmdb/system.dhcp/server/${serverId}`);
  }

  async updateDhcpServer(serverId, data) {
    return this.request('PUT', `cmdb/system.dhcp/server/${serverId}`, data);
  }

  async getDhcpLeases() {
    const res = await this.request('GET', 'monitor/system/dhcp');
    return res.results || [];
  }

  // ─── Firewall Address Objects ────────────────────────────────────────────────

  async getAddressObjects(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/firewall/address', null, vdomOverride);
    return res.results || [];
  }

  async getAddressObject(name, vdomOverride = null) {
    try {
      const res = await this.request('GET', `cmdb/firewall/address/${encodeURIComponent(name)}`, null, vdomOverride);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  async createAddressObject(nameOrData, subnet = '', vdomOverride = null) {
    const payload = typeof nameOrData === 'object'
      ? nameOrData
      : {
          name: nameOrData,
          type: 'ipmask',
          subnet,
        };
    return this.request('POST', 'cmdb/firewall/address', payload, vdomOverride);
  }

  async updateAddressObject(name, data, vdomOverride = null) {
    return this.request('PUT', `cmdb/firewall/address/${encodeURIComponent(name)}`, data, vdomOverride);
  }

  async deleteAddressObject(name, vdomOverride = null) {
    return this.request('DELETE', `cmdb/firewall/address/${encodeURIComponent(name)}`, null, vdomOverride);
  }

  // ─── Firewall Service Objects ─────────────────────────────────────────────

  async getServiceObjects(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/firewall.service/custom', null, vdomOverride);
    return res.results || [];
  }

  async getServiceObject(name, vdomOverride = null) {
    try {
      const res = await this.request('GET', `cmdb/firewall.service/custom/${encodeURIComponent(name)}`, null, vdomOverride);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  async createServiceObject(data, vdomOverride = null) {
    return this.request('POST', 'cmdb/firewall.service/custom', data, vdomOverride);
  }

  async updateServiceObject(name, data, vdomOverride = null) {
    return this.request('PUT', `cmdb/firewall.service/custom/${encodeURIComponent(name)}`, data, vdomOverride);
  }

  async deleteServiceObject(name, vdomOverride = null) {
    return this.request('DELETE', `cmdb/firewall.service/custom/${encodeURIComponent(name)}`, null, vdomOverride);
  }

  // ─── Virtual IPs (Port Forwarding) ──────────────────────────────────────────

  async getVips(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/firewall/vip', null, vdomOverride);
    return res.results || [];
  }

  async getVip(name, vdomOverride = null) {
    try {
      const res = await this.request('GET', `cmdb/firewall/vip/${encodeURIComponent(name)}`, null, vdomOverride);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  async createVip(data, vdomOverride = null) {
    return this.request('POST', 'cmdb/firewall/vip', data, vdomOverride);
  }

  async deleteVip(name, vdomOverride = null) {
    return this.request('DELETE', `cmdb/firewall/vip/${encodeURIComponent(name)}`, null, vdomOverride);
  }

  // ─── Address Groups ─────────────────────────────────────────────────────────

  async getAddressGroups(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/firewall/addrgrp', null, vdomOverride);
    return res.results || [];
  }

  // ─── Switch-controller managed-switch ──────────────────────────────────────

  /**
   * List all managed switches in root VDOM.
   */
  async getManagedSwitches(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/switch-controller/managed-switch', null, vdomOverride);
    return res.results || [];
  }

  /**
   * Get a specific managed switch by serial number.
   */
  async getManagedSwitch(serial, vdomOverride = null) {
    try {
      const res = await this.request('GET', `cmdb/switch-controller/managed-switch/${encodeURIComponent(serial)}`, null, vdomOverride);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  /**
   * Update a managed switch port's VLAN config.
   * For access ports: sets untagged vlan.
   * For trunk ports: adds to allowed-vlans.
   */
  async updateManagedSwitchPort(serial, portName, vlanName, trunk = false, vdomOverride = null) {
    const sw = await this.getManagedSwitch(serial, vdomOverride);
    if (!sw) throw new Error(`Managed switch ${serial} not found`);

    const ports = sw.ports || [];
    const port = ports.find(p => p['port-name'] === portName);
    if (!port) throw new Error(`Port ${portName} not found on switch ${serial}`);

    if (trunk) {
      // Add to allowed-vlans list
      const existing = (port['allowed-vlans'] || []).map(v => v.name || v['vlan-name']);
      if (!existing.includes(vlanName)) {
        existing.push(vlanName);
        port['allowed-vlans'] = existing.map(name => ({ 'vlan-name': name }));
      }
    } else {
      // Set as access VLAN
      port.vlan = vlanName;
    }

    port['export-to'] = 'root';

    return this.request('PUT', `cmdb/switch-controller/managed-switch/${encodeURIComponent(serial)}`, {
      ports: [port],
    }, vdomOverride);
  }

  /**
   * Remove a VLAN from a managed switch port's allowed-vlans list.
   */
  async removeManagedSwitchPortVlan(serial, portName, vlanName, vdomOverride = null) {
    const sw = await this.getManagedSwitch(serial, vdomOverride);
    if (!sw) throw new Error(`Managed switch ${serial} not found`);

    const ports = sw.ports || [];
    const port = ports.find(p => p['port-name'] === portName);
    if (!port) throw new Error(`Port ${portName} not found on switch ${serial}`);

    const existing = (port['allowed-vlans'] || []).map(v => v.name || v['vlan-name']);
    const filtered = existing.filter(n => n !== vlanName);
    if (filtered.length === existing.length) {
      console.log(`[switch] VLAN ${vlanName} not in allowed-vlans on ${serial}/${portName}, skipping`);
      return;
    }
    port['allowed-vlans'] = filtered.map(name => ({ 'vlan-name': name }));

    return this.request('PUT', `cmdb/switch-controller/managed-switch/${encodeURIComponent(serial)}`, {
      ports: [port],
    }, vdomOverride);
  }

  // ─── Switch-controller VLAN registration ────────────────────────────────────

  /**
   * Register a VLAN with the root VDOM switch-controller so it appears
   * in the switch-controller view. This does NOT modify port membership —
   * ports with allowed-vlans-all already pass all VLANs, but the switch-controller
   * needs an explicit entry to surface the VLAN in its UI/API.
   */
  async getSwitchControllerVlans(vdomOverride = null) {
    const res = await this.request('GET', 'cmdb/switch-controller/vlan', null, vdomOverride);
    return res.results || [];
  }

  async getSwitchControllerVlan(name, vdomOverride = null) {
    try {
      const res = await this.request('GET', `cmdb/switch-controller/vlan/${encodeURIComponent(name)}`, null, vdomOverride);
      return res.results?.[0] || null;
    } catch { return null; }
  }

  async createSwitchControllerVlan(name, vlanId, description = '', vdomOverride = null) {
    return this.request('POST', 'cmdb/switch-controller/vlan', {
      name,
      vdom: vdomOverride || 'root',
      'vlan-id': vlanId,
      ...(description ? { description } : {}),
    }, vdomOverride);
  }

  async deleteSwitchControllerVlan(name, vdomOverride = null) {
    return this.request('DELETE', `cmdb/switch-controller/vlan/${encodeURIComponent(name)}`, null, vdomOverride);
  }

  // ─── High-level: Full VLAN provisioning ──────────────────────────────────────

  /**
   * Provision a complete VLAN following the guide:
   * 1. VLAN interface at global scope, assigned to lab VDOM
   * 2. Firewall policy in lab VDOM (srcintf=vlan, dstintf=lab-root0)
   * 3. Static route in root VDOM (dst=subnet, gw=10.255.254.2, dev=lab-root1)
   * 4. DHCP server (optional)
   * 5. Add VLAN to trunk switch port's allowed-vlans (if configured)
   * 6. Register VLAN in root switch-controller for visibility
   *
   * Sequence grouping is achieved via global-label on the policy.
   */
  async provisionVlan(tag, name, parentInterface, opts = {}) {
    const subnet = vlanTagToSubnet(tag);
    if (!subnet) throw new Error(`Cannot derive subnet from VLAN tag ${tag}`);

    const ifaceName = `vlan${tag}`;
    const labVdomLink  = opts.labVdomLink  || 'lab-root0';
    const rootVdom     = opts.rootVdom     || 'root';
    const rootVdomLink = opts.rootVdomLink || 'lab-root1';
    const routeGateway = opts.routeGateway || '10.255.254.2';

    // Track what we created (not what already existed) so we can roll back on failure
    let createdInterface = false;
    let createdAddrObj = false;
    const addrObjName = `NET-${subnet.networkIp}_24`;
    const policyIds = [];
    let createdPolicyId = null;
    let dhcpServerId = null;
    let createdDhcpId = null;
    let staticRouteId = null;
    let createdRouteId = null;

    const rollback = async (reason) => {
      console.error(`[provision] Rolling back ${ifaceName} due to: ${reason}`);
      const warnings = [];
      if (createdDhcpId) {
        try { await this.deleteDhcpServer(createdDhcpId); } catch (e) { warnings.push(`dhcp: ${e.message}`); }
      }
      if (createdRouteId) {
        try { await this.deleteStaticRoute(createdRouteId, rootVdom); } catch (e) { warnings.push(`route: ${e.message}`); }
      }
      if (createdPolicyId) {
        try { await this.deletePolicy(createdPolicyId); } catch (e) { warnings.push(`policy: ${e.message}`); }
      }
      if (createdAddrObj) {
        try { await this.deleteAddressObject(addrObjName); } catch (e) { warnings.push(`addr: ${e.message}`); }
      }
      if (createdInterface) {
        try { await this.deleteInterface(ifaceName); } catch (e) { warnings.push(`iface: ${e.message}`); }
      }
      if (warnings.length > 0) console.warn(`[provision] Rollback warnings for ${ifaceName}:`, warnings);
    };

    try {
      // ── Step 1: VLAN interface at global scope, assigned to lab VDOM ─────────
      const existing = await this.getInterface(ifaceName);
      if (existing) {
        console.log(`[provision] Interface ${ifaceName} already exists, skipping`);
      } else {
        await this.createVlanInterface(
          ifaceName, tag, parentInterface,
          subnet.ip, subnet.netmask,
          { description: name }
        );
        createdInterface = true;
        console.log(`[provision] Created interface ${ifaceName} (global scope, vdom=${this.vdom})`);
      }

      // ── Step 2: Address object for the VLAN subnet ───────────────────────────
      const existingAddr = await this.getAddressObject(addrObjName);
      if (existingAddr) {
        console.log(`[provision] Address object ${addrObjName} already exists, skipping`);
      } else {
        await this.createAddressObject(addrObjName, `${subnet.networkIp} ${subnet.netmask}`);
        createdAddrObj = true;
        console.log(`[provision] Created address object ${addrObjName}`);
      }

      // ── Step 3: Firewall policy in lab (VLAN → lab-root0) ─────────────────────
      if (opts.allowInternet !== false) {
        const allPolicies = await this.getPolicies();
        const existingPolicy = allPolicies.find(p =>
          (p.srcintf || []).some(i => i.name === ifaceName)
        );
        if (existingPolicy) {
          policyIds.push(existingPolicy.policyid);
          console.log(`[provision] Policy for ${ifaceName} already exists (id: ${existingPolicy.policyid}), skipping`);
        } else {
          const policyRes = await this.createPolicy({
            name: `${ifaceName}-internet`,
            srcintf: [{ name: ifaceName }],
            dstintf: [{ name: labVdomLink }],
            srcaddr: [{ name: addrObjName }],
            dstaddr: [{ name: 'all' }],
            action: 'accept',
            schedule: 'always',
            service: [{ name: 'ALL' }],
            logtraffic: 'all',
            'global-label': `${name} (${ifaceName})`,
            comments: `Auto-created for ${name} (${ifaceName})`,
          });
          if (policyRes?.mkey) {
            createdPolicyId = policyRes.mkey;
            policyIds.push(policyRes.mkey);
          }
          console.log(`[provision] Created policy id=${policyRes?.mkey} with sequence group "${name} (${ifaceName})"`);
        }
      }

      // ── Step 4: Static route in root VDOM ─────────────────────────────────────
      const rootRoutes = await this.getStaticRoutes(rootVdom);
      const existingRoute = rootRoutes.find(r => r.dst === `${subnet.networkIp} ${subnet.netmask}`);
      if (existingRoute) {
        staticRouteId = existingRoute['seq-num'] || existingRoute.seq_num;
        console.log(`[provision] Static route for ${subnet.network} already exists in ${rootVdom} (seq-num: ${staticRouteId}), skipping`);
      } else {
        const routeRes = await this.createStaticRoute(
          subnet.networkIp, subnet.netmask,
          routeGateway, rootVdomLink,
          rootVdom
        );
        if (routeRes?.mkey) {
          createdRouteId = routeRes.mkey;
          staticRouteId = routeRes.mkey;
        }
        console.log(`[provision] Created static route in ${rootVdom}: ${subnet.network} via ${routeGateway} dev ${rootVdomLink}`);
      }

      // ── Optional: DHCP server ────────────────────────────────────────────────
      if (opts.enableDhcp !== false) {
        const allDhcp = await this.getDhcpServers();
        const existingDhcp = allDhcp.find(d => d.interface === ifaceName);
        if (existingDhcp) {
          dhcpServerId = existingDhcp.id;
          console.log(`[provision] DHCP server for ${ifaceName} already exists (id: ${dhcpServerId}), skipping`);
        } else {
          const dhcpRes = await this.createDhcpServer(
            ifaceName, subnet.gateway, subnet.netmask,
            subnet.dhcpStart, subnet.dhcpEnd
          );
          if (dhcpRes?.mkey) {
            createdDhcpId = dhcpRes.mkey;
            dhcpServerId = dhcpRes.mkey;
          }
          console.log(`[provision] Created DHCP server id=${dhcpServerId}`);
        }
      }
    } catch (err) {
      await rollback(err.message);
      throw err;
    }

    // ── Non-critical steps (no rollback on failure) ──────────────────────────

    // Add VLAN to trunk switch port's allowed-vlans
    if (opts.trunkSwitchSerial && opts.trunkSwitchPort) {
      try {
        await this.updateManagedSwitchPort(
          opts.trunkSwitchSerial, opts.trunkSwitchPort,
          ifaceName, true, rootVdom
        );
        console.log(`[provision] Added ${ifaceName} to allowed-vlans on ${opts.trunkSwitchSerial}/${opts.trunkSwitchPort}`);
      } catch (e) {
        console.warn(`[provision] Switch port VLAN add warning:`, e.message);
      }
    }

    // Switch-controller VLAN registration in root
    // FortiLink automatically creates an internal switch-controller entry when
    // a VLAN interface is created under the fortilink parent. These implicit
    // entries do NOT appear in the cmdb/switch-controller/vlan GET response,
    // but a POST will fail with -15 "duplicate switch-vlan interface".
    // We attempt to create an explicit entry; -15 duplicate = already tracked.
    try {
      await this.createSwitchControllerVlan(ifaceName, tag, name, rootVdom);
      console.log(`[provision] Created switch-controller VLAN ${ifaceName} in ${rootVdom}`);
    } catch (e) {
      if (e.message.includes('-15') || e.message.includes('duplicate')) {
        console.log(`[provision] Switch-controller VLAN ${ifaceName} already exists in ${rootVdom} (FortiLink auto-created)`);
      } else {
        console.warn(`[provision] Switch-controller VLAN registration warning:`, e.message);
      }
    }

    return { interfaceName: ifaceName, policyIds, dhcpServerId, staticRouteId, subnet };
  }

  /**
   * Remove a complete VLAN setup — queries FortiGate live for all references.
   */
  async deprovisionVlan(interfaceName, policyIds = [], dhcpServerId = null, opts = {}) {
    const errors = [];
    const rootVdom     = opts.rootVdom     || 'root';
    const tag = parseInt(interfaceName.replace('vlan', ''));
    const subnet = vlanTagToSubnet(tag);

    // 1. Remove all policies in lab that reference this interface
    try {
      const allPolicies = await this.getPolicies();
      const refs = allPolicies.filter(p => {
        const srcs = (p.srcintf || []).map(i => i.name);
        const dsts = (p.dstintf || []).map(i => i.name);
        return srcs.includes(interfaceName) || dsts.includes(interfaceName);
      });
      const allIds = new Set([...refs.map(p => String(p.policyid)), ...policyIds.map(String)]);
      for (const pid of allIds) {
        try { await this.deletePolicy(pid); console.log(`[deprovision] Deleted policy ${pid}`); }
        catch (e) { errors.push(`policy ${pid}: ${e.message}`); }
      }
    } catch (e) { errors.push(`policy lookup: ${e.message}`); }

    // 2. Remove address object (may not exist if provisioned before address objects were added)
    if (subnet) {
      const addrObjName = `NET-${subnet.networkIp}_24`;
      const existing = await this.getAddressObject(addrObjName);
      if (existing) {
        try { await this.deleteAddressObject(addrObjName); console.log(`[deprovision] Deleted address object ${addrObjName}`); }
        catch (e) { errors.push(`address object ${addrObjName}: ${e.message}`); }
      }
    }

    // 3. Remove all DHCP servers bound to this interface
    try {
      const allDhcp = await this.getDhcpServers();
      const matching = allDhcp.filter(d => d.interface === interfaceName);
      const allIds = new Set([...matching.map(d => String(d.id)), ...(dhcpServerId ? [String(dhcpServerId)] : [])]);
      for (const did of allIds) {
        try { await this.deleteDhcpServer(did); console.log(`[deprovision] Deleted DHCP ${did}`); }
        catch (e) { errors.push(`dhcp ${did}: ${e.message}`); }
      }
    } catch (e) { errors.push(`dhcp lookup: ${e.message}`); }

    // 3. Remove static route in root VDOM
    if (subnet) {
      try {
        const rootRoutes = await this.getStaticRoutes(rootVdom);
        const match = rootRoutes.find(r => r.dst === `${subnet.networkIp} ${subnet.netmask}`);
        if (match) {
          const routeId = match['seq-num'] || match.seq_num;
          await this.deleteStaticRoute(routeId, rootVdom);
          console.log(`[deprovision] Deleted static route ${subnet.network} (seq-num: ${routeId}) from ${rootVdom}`);
        }
      } catch (e) { errors.push(`static route in ${rootVdom}: ${e.message}`); }
    }

    // 4. Remove VLAN from trunk switch port's allowed-vlans
    if (opts.trunkSwitchSerial && opts.trunkSwitchPort) {
      try {
        await this.removeManagedSwitchPortVlan(
          opts.trunkSwitchSerial, opts.trunkSwitchPort,
          interfaceName, rootVdom
        );
        console.log(`[deprovision] Removed ${interfaceName} from allowed-vlans on ${opts.trunkSwitchSerial}/${opts.trunkSwitchPort}`);
      } catch (e) { errors.push(`switch port vlan remove: ${e.message}`); }
    }

    // 5. Remove the VLAN interface (global scope)
    try { await this.deleteInterface(interfaceName); console.log(`[deprovision] Deleted interface ${interfaceName}`); }
    catch (e) { errors.push(`interface ${interfaceName}: ${e.message}`); }

    // 6. Remove switch-controller VLAN registration from root
    try { await this.deleteSwitchControllerVlan(interfaceName, rootVdom); console.log(`[deprovision] Removed ${interfaceName} from ${rootVdom} switch-controller`); }
    catch (e) { console.warn(`[deprovision] Switch-controller VLAN ${interfaceName}:`, e.message); }

    if (errors.length > 0) console.warn(`[deprovision] Warnings for ${interfaceName}:`, errors);
    return { errors };
  }
}

/**
 * Create a FortiGateAPI instance from a DB firewall row
 */
export function createClient(firewall) {
  return new FortiGateAPI(
    firewall.host,
    firewall.port,
    decryptSecret(firewall.api_key),
    firewall.vdom,
    firewall.verify_tls !== 0
  );
}
