/**
 * Step catalog for the FortiGate workflow engine.
 *
 * Every workflow step maps onto ONE whitelisted action here. The DB only stores
 * which action runs with which (templated) params — never arbitrary code. Each
 * action:
 *   - declares a validated param schema (`params`) used by the UI and `validate()`
 *   - `plan(rendered, ctx)` returns the API call(s) it WOULD make (dry-run preview)
 *   - `execute(client, rendered, ctx)` performs the call(s), returns { output,
 *     artifacts, calls, skipped } — artifacts are the created objects to be torn
 *     down in reverse on rollback/deprovision.
 *
 * The create* handlers deliberately call the existing `FortiGateAPI` methods (or
 * build the exact same request body) so a seeded default workflow reproduces the
 * historical hardcoded sequences byte-for-byte.
 */

const MAX_CUSTOM_BODY_BYTES = 16 * 1024;

function scopeOf(client, vdom) {
  if (vdom === 'global') return 'global';
  const v = vdom === undefined || vdom === null || vdom === '' ? null : String(vdom);
  return v || client.vdom;
}

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function nameObjects(value) {
  return asList(value).map((n) => ({ name: String(n) }));
}

// ── Shared policy body builder (identical key order to the legacy code) ────────
function buildPolicyBody(p) {
  const body = {
    name: String(p.name || ''),
    srcintf: nameObjects(p.srcintf),
    dstintf: nameObjects(p.dstintf),
    srcaddr: nameObjects(p.srcaddr),
    dstaddr: nameObjects(p.dstaddr),
    action: p.action || 'accept',
    schedule: p.schedule || 'always',
    service: nameObjects(p.service),
    logtraffic: p.logtraffic || 'all',
  };
  if (p.globalLabel !== undefined && p.globalLabel !== '') body['global-label'] = String(p.globalLabel);
  if (p.comments !== undefined && p.comments !== '') body.comments = String(p.comments);
  return body;
}

export const ACTIONS = {
  // ── VLAN interface ──────────────────────────────────────────────────────────
  create_vlan_interface: {
    label: 'Create VLAN interface',
    category: 'interface',
    description: 'Create a VLAN sub-interface at global scope, assigned to the firewall VDOM.',
    params: [
      { name: 'name', type: 'string', required: true, help: 'Interface name, e.g. vlan{{tag}}' },
      { name: 'vlanId', type: 'number', required: true, help: 'VLAN tag' },
      { name: 'parentInterface', type: 'string', required: true, help: 'Parent/trunk interface (e.g. fortilink)' },
      { name: 'ip', type: 'string', required: true, help: 'Interface IP (gateway address)' },
      { name: 'netmask', type: 'string', required: true, help: 'e.g. 255.255.255.0' },
      { name: 'description', type: 'string', required: false, help: 'Optional description' },
      { name: 'allowaccess', type: 'string', required: false, default: 'ping', help: 'Allowed management access' },
      { name: 'role', type: 'string', required: false, default: 'undefined', help: 'Interface role' },
      { name: 'skipIfExists', type: 'boolean', required: false, default: true, help: 'Skip if the interface already exists' },
    ],
    plan(p, ctx, client) {
      return [{
        method: 'POST', path: 'cmdb/system/interface', scope: 'global',
        body: this._body(p, client),
        summary: `Create VLAN interface ${p.name} (tag ${p.vlanId}) on ${p.parentInterface}`,
      }];
    },
    _body(p, client) {
      return {
        name: String(p.name),
        vdom: client?.vdom || String(p.vdom || 'root'),
        type: 'vlan',
        vlanid: Number(p.vlanId),
        interface: String(p.parentInterface),
        ip: `${p.ip} ${p.netmask}`,
        allowaccess: p.allowaccess || 'ping',
        role: p.role || 'undefined',
        ...(p.description ? { description: String(p.description) } : {}),
      };
    },
    async execute(client, p, ctx) {
      const name = String(p.name);
      if (p.skipIfExists !== false) {
        const existing = await client.getInterface(name);
        if (existing) {
          return { skipped: true, output: { interfaceName: name }, artifacts: [], calls: [{ method: 'GET', path: `cmdb/system/interface/${name}`, scope: client.vdom, summary: `Interface ${name} already exists — skipped` }] };
        }
      }
      const body = this._body(p, client);
      await client.request('POST', 'cmdb/system/interface', body, 'global');
      return {
        skipped: false,
        output: { interfaceName: name },
        artifacts: [{ type: 'interface', name }],
        calls: [{ method: 'POST', path: 'cmdb/system/interface', scope: 'global', body, summary: `Created VLAN interface ${name}` }],
      };
    },
  },

  // ── Address object ────────────────────────────────────────────────────────────
  create_address_object: {
    label: 'Create address object',
    category: 'object',
    description: 'Create a firewall address object (ipmask).',
    params: [
      { name: 'name', type: 'string', required: true, help: 'Address object name' },
      { name: 'subnet', type: 'string', required: true, help: 'e.g. "10.11.26.0 255.255.255.0"' },
      { name: 'type', type: 'string', required: false, default: 'ipmask', help: 'Address type' },
      { name: 'comment', type: 'string', required: false, help: 'Optional comment' },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM override (blank = firewall VDOM)' },
      { name: 'skipIfExists', type: 'boolean', required: false, default: true },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/firewall/address', scope: scopeOf(client, p.vdom), body: this._body(p), summary: `Create address object ${p.name} (${p.subnet})` }];
    },
    _body(p) {
      const body = { name: String(p.name), type: p.type || 'ipmask', subnet: String(p.subnet) };
      if (p.comment) body.comment = String(p.comment);
      return body;
    },
    async execute(client, p, ctx) {
      const name = String(p.name);
      const vdom = p.vdom ? String(p.vdom) : null;
      const effVdom = vdom || client.vdom;
      if (p.skipIfExists !== false) {
        const existing = await client.getAddressObject(name, vdom);
        if (existing) {
          return { skipped: true, output: { name }, artifacts: [], calls: [{ method: 'GET', path: `cmdb/firewall/address/${name}`, scope: effVdom, summary: `Address ${name} already exists — skipped` }] };
        }
      }
      // Legacy path used the 2-arg form (name, subnet) with no comment, and the
      // object form with a comment. Preserve both exactly.
      if (p.comment || (p.type && p.type !== 'ipmask')) {
        await client.createAddressObject(this._body(p), '', vdom);
      } else {
        await client.createAddressObject(name, String(p.subnet), vdom);
      }
      return {
        skipped: false,
        output: { name },
        artifacts: [{ type: 'address', name, vdom: effVdom }],
        calls: [{ method: 'POST', path: 'cmdb/firewall/address', scope: effVdom, body: this._body(p), summary: `Created address object ${name}` }],
      };
    },
  },

  // ── Service object ────────────────────────────────────────────────────────────
  create_service_object: {
    label: 'Create service object',
    category: 'object',
    description: 'Create a custom firewall service (TCP or UDP port).',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'protocol', type: 'select', required: true, options: ['tcp', 'udp'], default: 'tcp' },
      { name: 'port', type: 'string', required: true, help: 'Port or range, e.g. 8080' },
      { name: 'comment', type: 'string', required: false },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM override (blank = firewall VDOM)' },
      { name: 'skipIfExists', type: 'boolean', required: false, default: true },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/firewall.service/custom', scope: scopeOf(client, p.vdom), body: this._body(p), summary: `Create service ${p.name} (${p.protocol}/${p.port})` }];
    },
    _body(p) {
      const proto = String(p.protocol || 'tcp').toLowerCase();
      const body = { name: String(p.name) };
      if (p.comment) body.comment = String(p.comment);
      if (proto === 'udp') body['udp-portrange'] = String(p.port);
      else body['tcp-portrange'] = String(p.port);
      return body;
    },
    async execute(client, p, ctx) {
      const name = String(p.name);
      const vdom = p.vdom ? String(p.vdom) : null;
      const effVdom = vdom || client.vdom;
      if (p.skipIfExists !== false) {
        const existing = await client.getServiceObject(name, vdom);
        if (existing) {
          return { skipped: true, output: { name }, artifacts: [], calls: [{ method: 'GET', path: `cmdb/firewall.service/custom/${name}`, scope: effVdom, summary: `Service ${name} already exists — skipped` }] };
        }
      }
      await client.createServiceObject(this._body(p), vdom);
      return {
        skipped: false,
        output: { name },
        artifacts: [{ type: 'service', name, vdom: effVdom }],
        calls: [{ method: 'POST', path: 'cmdb/firewall.service/custom', scope: effVdom, body: this._body(p), summary: `Created service ${name}` }],
      };
    },
  },

  // ── Firewall policy ───────────────────────────────────────────────────────────
  create_policy: {
    label: 'Create firewall policy',
    category: 'policy',
    description: 'Create a firewall policy. Optionally de-dupe by source interface and re-order by label.',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'srcintf', type: 'stringlist', required: true },
      { name: 'dstintf', type: 'stringlist', required: true },
      { name: 'srcaddr', type: 'stringlist', required: true, default: ['all'] },
      { name: 'dstaddr', type: 'stringlist', required: true, default: ['all'] },
      { name: 'action', type: 'select', required: false, options: ['accept', 'deny'], default: 'accept' },
      { name: 'schedule', type: 'string', required: false, default: 'always' },
      { name: 'service', type: 'stringlist', required: false, default: ['ALL'] },
      { name: 'logtraffic', type: 'string', required: false, default: 'all' },
      { name: 'globalLabel', type: 'string', required: false, help: 'Sequence-grouping label' },
      { name: 'comments', type: 'string', required: false },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM override (blank = firewall VDOM)' },
      { name: 'dedupeBySrcintf', type: 'string', required: false, help: 'Skip if a policy already has this src interface' },
      { name: 'moveAfterSameLabel', type: 'boolean', required: false, help: 'Re-order after an existing policy sharing the global-label' },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/firewall/policy', scope: scopeOf(client, p.vdom), body: buildPolicyBody(p), summary: `Create policy "${p.name}" (${asList(p.srcintf).join(',')} → ${asList(p.dstintf).join(',')})` }];
    },
    async execute(client, p, ctx) {
      const vdom = p.vdom ? String(p.vdom) : null;
      const effVdom = vdom || client.vdom;
      const calls = [];

      if (p.dedupeBySrcintf) {
        const iface = String(p.dedupeBySrcintf);
        const all = await client.getPolicies(vdom);
        const dup = all.find((pol) => (pol.srcintf || []).some((i) => i.name === iface));
        if (dup) {
          return { skipped: true, output: { policyId: dup.policyid }, artifacts: [], calls: [{ method: 'GET', path: 'cmdb/firewall/policy', scope: effVdom, summary: `Policy on ${iface} already exists (id ${dup.policyid}) — skipped` }] };
        }
      }

      const body = buildPolicyBody(p);
      const res = await client.createPolicy(body, vdom);
      const policyId = res?.mkey ?? null;
      calls.push({ method: 'POST', path: 'cmdb/firewall/policy', scope: effVdom, body, summary: `Created policy "${body.name}" (id ${policyId})` });

      if (p.moveAfterSameLabel && policyId != null && body['global-label']) {
        try {
          const all = await client.getPolicies(vdom);
          const sibling = all.find((pol) => (pol['global-label'] || '') === body['global-label'] && String(pol.policyid) !== String(policyId));
          if (sibling) {
            await client.movePolicy(policyId, 'after', sibling.policyid, vdom);
            calls.push({ method: 'PUT', path: `cmdb/firewall/policy/${policyId}?action=move&after=${sibling.policyid}`, scope: effVdom, summary: `Moved policy ${policyId} after ${sibling.policyid}` });
          }
        } catch { /* best-effort ordering */ }
      }

      return {
        skipped: false,
        output: { policyId },
        artifacts: policyId != null ? [{ type: 'policy', id: policyId, vdom: effVdom }] : [],
        calls,
      };
    },
  },

  // ── Static route ──────────────────────────────────────────────────────────────
  create_static_route: {
    label: 'Create static route',
    category: 'route',
    description: 'Create a static route in the given VDOM.',
    params: [
      { name: 'dst', type: 'string', required: true, help: 'Destination network address' },
      { name: 'netmask', type: 'string', required: true },
      { name: 'gateway', type: 'string', required: true },
      { name: 'device', type: 'string', required: true, help: 'Egress interface' },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM (blank = firewall VDOM)' },
      { name: 'dedupeByDst', type: 'boolean', required: false, default: true, help: 'Skip if a route to this destination exists' },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/router/static', scope: scopeOf(client, p.vdom), body: { dst: `${p.dst} ${p.netmask}`, gateway: String(p.gateway), device: String(p.device) }, summary: `Create static route ${p.dst}/${p.netmask} via ${p.gateway} dev ${p.device}` }];
    },
    async execute(client, p, ctx) {
      const vdom = p.vdom ? String(p.vdom) : null;
      const effVdom = vdom || client.vdom;
      const target = `${p.dst} ${p.netmask}`;
      if (p.dedupeByDst !== false) {
        const routes = await client.getStaticRoutes(vdom);
        const existing = routes.find((r) => r.dst === target);
        if (existing) {
          const routeId = existing['seq-num'] || existing.seq_num;
          return { skipped: true, output: { routeId }, artifacts: [], calls: [{ method: 'GET', path: 'cmdb/router/static', scope: effVdom, summary: `Route ${target} already exists (seq ${routeId}) — skipped` }] };
        }
      }
      const res = await client.createStaticRoute(String(p.dst), String(p.netmask), String(p.gateway), String(p.device), vdom);
      const routeId = res?.mkey ?? null;
      return {
        skipped: false,
        output: { routeId },
        artifacts: routeId != null ? [{ type: 'static_route', id: routeId, vdom: effVdom }] : [],
        calls: [{ method: 'POST', path: 'cmdb/router/static', scope: effVdom, body: { dst: target, gateway: String(p.gateway), device: String(p.device) }, summary: `Created static route ${target} (seq ${routeId})` }],
      };
    },
  },

  // ── DHCP server ───────────────────────────────────────────────────────────────
  create_dhcp_server: {
    label: 'Create DHCP server',
    category: 'dhcp',
    description: 'Create a DHCP server bound to an interface.',
    params: [
      { name: 'interface', type: 'string', required: true },
      { name: 'gateway', type: 'string', required: true },
      { name: 'netmask', type: 'string', required: true },
      { name: 'startIp', type: 'string', required: true },
      { name: 'endIp', type: 'string', required: true },
      { name: 'dns1', type: 'string', required: false, default: '1.1.1.1' },
      { name: 'dns2', type: 'string', required: false, default: '8.8.8.8' },
      { name: 'dedupeByInterface', type: 'boolean', required: false, default: true },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/system.dhcp/server', scope: client.vdom, body: this._body(p), summary: `Create DHCP server on ${p.interface} (${p.startIp}–${p.endIp})` }];
    },
    _body(p) {
      const body = {
        'default-gateway': String(p.gateway),
        netmask: String(p.netmask),
        interface: String(p.interface),
        'ip-range': [{ 'start-ip': String(p.startIp), 'end-ip': String(p.endIp) }],
        'lease-time': 86400,
        'dns-service': 'specify',
      };
      if (p.dns1) body['dns-server1'] = String(p.dns1);
      if (p.dns2) body['dns-server2'] = String(p.dns2);
      return body;
    },
    async execute(client, p, ctx) {
      const iface = String(p.interface);
      if (p.dedupeByInterface !== false) {
        const servers = await client.getDhcpServers();
        const existing = servers.find((d) => d.interface === iface);
        if (existing) {
          return { skipped: true, output: { dhcpServerId: existing.id }, artifacts: [], calls: [{ method: 'GET', path: 'cmdb/system.dhcp/server', scope: client.vdom, summary: `DHCP server on ${iface} already exists (id ${existing.id}) — skipped` }] };
        }
      }
      const dns = [p.dns1 || '', p.dns2 || ''];
      const res = await client.createDhcpServer(iface, String(p.gateway), String(p.netmask), String(p.startIp), String(p.endIp), dns);
      const dhcpServerId = res?.mkey ?? null;
      return {
        skipped: false,
        output: { dhcpServerId },
        artifacts: dhcpServerId != null ? [{ type: 'dhcp_server', id: dhcpServerId }] : [],
        calls: [{ method: 'POST', path: 'cmdb/system.dhcp/server', scope: client.vdom, body: this._body(p), summary: `Created DHCP server (id ${dhcpServerId})` }],
      };
    },
  },

  // ── Virtual IP (port forward) ────────────────────────────────────────────────
  create_vip: {
    label: 'Create Virtual IP (port forward)',
    category: 'vip',
    description: 'Create a port-forwarding VIP in the given VDOM.',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'extip', type: 'string', required: true, help: 'External (public) IP' },
      { name: 'mappedip', type: 'string', required: true, help: 'Internal destination IP' },
      { name: 'extport', type: 'string', required: true },
      { name: 'mappedport', type: 'string', required: true },
      { name: 'protocol', type: 'select', required: false, options: ['tcp', 'udp'], default: 'tcp' },
      { name: 'extintf', type: 'string', required: false, default: 'any' },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM (blank = firewall VDOM)' },
    ],
    plan(p, ctx, client) {
      return [{ method: 'POST', path: 'cmdb/firewall/vip', scope: scopeOf(client, p.vdom), body: this._body(p), summary: `Create VIP ${p.name} (${p.extport} → ${p.mappedip}:${p.mappedport})` }];
    },
    _body(p) {
      const payload = {
        name: String(p.name),
        extip: String(p.extip),
        mappedip: [{ range: String(p.mappedip) }],
        extintf: p.extintf || 'any',
        portforward: 'enable',
        extport: String(p.extport),
        mappedport: String(p.mappedport),
      };
      if (String(p.protocol || 'tcp').toLowerCase() === 'udp') payload.protocol = 'udp';
      return payload;
    },
    async execute(client, p, ctx) {
      const vdom = p.vdom ? String(p.vdom) : null;
      const effVdom = vdom || client.vdom;
      const body = this._body(p);
      await client.createVip(body, vdom);
      return {
        skipped: false,
        output: { name: String(p.name) },
        artifacts: [{ type: 'vip', name: String(p.name), vdom: effVdom }],
        calls: [{ method: 'POST', path: 'cmdb/firewall/vip', scope: effVdom, body, summary: `Created VIP ${p.name}` }],
      };
    },
  },

  // ── Managed switch port ──────────────────────────────────────────────────────
  assign_switch_port: {
    label: 'Assign managed switch port',
    category: 'switch',
    description: 'Add a VLAN to a managed switch trunk port (or set an access VLAN).',
    params: [
      { name: 'serial', type: 'string', required: true, help: 'Switch serial' },
      { name: 'port', type: 'string', required: true, help: 'Port name' },
      { name: 'vlanName', type: 'string', required: true },
      { name: 'trunk', type: 'boolean', required: false, default: true, help: 'Add to allowed-vlans (trunk) vs access VLAN' },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM (blank = firewall VDOM)' },
    ],
    plan(p, ctx, client) {
      return [{ method: 'PUT', path: `cmdb/switch-controller/managed-switch/${p.serial}`, scope: scopeOf(client, p.vdom), summary: `Add ${p.vlanName} to ${p.trunk === false ? 'access VLAN on' : 'allowed-vlans on'} ${p.serial}/${p.port}` }];
    },
    async execute(client, p, ctx) {
      const vdom = p.vdom ? String(p.vdom) : null;
      const trunk = p.trunk !== false;
      await client.updateManagedSwitchPort(String(p.serial), String(p.port), String(p.vlanName), trunk, vdom);
      return {
        skipped: false,
        output: {},
        artifacts: [{ type: 'switch_port_vlan', serial: String(p.serial), port: String(p.port), vlanName: String(p.vlanName), vdom: vdom || client.vdom }],
        calls: [{ method: 'PUT', path: `cmdb/switch-controller/managed-switch/${p.serial}`, scope: vdom || client.vdom, summary: `Added ${p.vlanName} to ${p.serial}/${p.port}` }],
      };
    },
  },

  // ── Switch-controller VLAN registration ───────────────────────────────────────
  register_switch_controller_vlan: {
    label: 'Register switch-controller VLAN',
    category: 'switch',
    description: 'Register the VLAN with the switch-controller so it surfaces in the UI/API.',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'vlanId', type: 'number', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'vdom', type: 'string', required: false, default: 'root', help: 'VDOM (default root)' },
    ],
    plan(p, ctx, client) {
      const vdom = p.vdom ? String(p.vdom) : 'root';
      return [{ method: 'POST', path: 'cmdb/switch-controller/vlan', scope: vdom, body: { name: String(p.name), vdom, 'vlan-id': Number(p.vlanId), ...(p.description ? { description: String(p.description) } : {}) }, summary: `Register switch-controller VLAN ${p.name}` }];
    },
    async execute(client, p, ctx) {
      const vdom = p.vdom ? String(p.vdom) : 'root';
      const name = String(p.name);
      try {
        await client.createSwitchControllerVlan(name, Number(p.vlanId), p.description ? String(p.description) : '', vdom);
        return { skipped: false, output: {}, artifacts: [{ type: 'switch_controller_vlan', name, vdom }], calls: [{ method: 'POST', path: 'cmdb/switch-controller/vlan', scope: vdom, summary: `Registered switch-controller VLAN ${name}` }] };
      } catch (e) {
        // -15 "duplicate switch-vlan interface" = FortiLink already tracks it.
        // Still record the artifact so deprovision removes it, matching the
        // historical deprovision which always deletes the entry.
        if (String(e.message).includes('-15') || String(e.message).includes('duplicate')) {
          return { skipped: true, output: {}, artifacts: [{ type: 'switch_controller_vlan', name, vdom }], calls: [{ method: 'POST', path: 'cmdb/switch-controller/vlan', scope: vdom, summary: `Switch-controller VLAN ${name} already exists (FortiLink auto-created)` }] };
        }
        throw e;
      }
    },
  },

  // ── Escape hatch: raw API call ────────────────────────────────────────────────
  custom_api_call: {
    label: 'Custom API call',
    category: 'custom',
    description: 'Power-user escape hatch: any FortiGate REST call. Path must start with /api/v2/.',
    params: [
      { name: 'method', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'DELETE'], default: 'POST' },
      { name: 'path', type: 'string', required: true, help: 'Full path, must start with /api/v2/' },
      { name: 'body', type: 'json', required: false, help: 'JSON request body' },
      { name: 'vdom', type: 'string', required: false, help: 'VDOM (blank = firewall VDOM)' },
    ],
    validate(p) {
      const path = String(p.path || '');
      if (!path.startsWith('/api/v2/')) throw new Error('custom_api_call path must start with /api/v2/');
      if (p.body !== undefined && p.body !== null && p.body !== '') {
        const raw = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
        if (Buffer.byteLength(raw) > MAX_CUSTOM_BODY_BYTES) throw new Error(`custom_api_call body exceeds ${MAX_CUSTOM_BODY_BYTES} bytes`);
      }
    },
    plan(p, ctx, client) {
      return [{ method: String(p.method || 'POST'), path: String(p.path || '').replace(/^\/api\/v2\//, ''), scope: scopeOf(client, p.vdom), body: this._body(p), summary: `${p.method} ${p.path}` }];
    },
    _body(p) {
      if (p.body === undefined || p.body === null || p.body === '') return null;
      if (typeof p.body === 'string') {
        try { return JSON.parse(p.body); } catch { return p.body; }
      }
      return p.body;
    },
    async execute(client, p, ctx) {
      this.validate(p);
      const vdom = p.vdom ? String(p.vdom) : null;
      const relPath = String(p.path).replace(/^\/api\/v2\//, '');
      const body = this._body(p);
      await client.request(String(p.method || 'POST'), relPath, body, vdom);
      // Custom calls are unmanaged: there is no automatic teardown mapping.
      return { skipped: false, output: {}, artifacts: [], calls: [{ method: String(p.method || 'POST'), path: relPath, scope: vdom || client.vdom, body, summary: `${p.method} ${p.path} (no automatic teardown)` }] };
    },
  },

  // ── Artifact-based teardown (delete/deprovision triggers) ─────────────────────
  teardown_recorded_artifacts: {
    label: 'Delete recorded artifacts (reverse order)',
    category: 'teardown',
    description: 'Deletes every object the original run created, newest first. Deprovision is artifact-based — it never re-derives from the current workflow definition, so editing a workflow cannot orphan objects.',
    params: [],
    plan(p, ctx) {
      const arts = (ctx && ctx.artifacts) || [];
      if (arts.length === 0) return [{ method: 'DELETE', path: '(recorded artifacts)', scope: '(firewall)', summary: 'Delete recorded artifacts in reverse order' }];
      return arts.slice().reverse().map((a) => ({ method: 'DELETE', path: teardownPath(a), scope: a.vdom || '(firewall vdom)', summary: `Delete ${describeArtifact(a)}` }));
    },
    async execute(client, p, ctx) {
      const arts = (ctx && ctx.artifacts) || [];
      const calls = [];
      for (let i = arts.length - 1; i >= 0; i -= 1) {
        const a = arts[i];
        try { await deleteArtifact(client, a); calls.push({ method: 'DELETE', path: teardownPath(a), scope: a.vdom || client.vdom, summary: `Deleted ${describeArtifact(a)}` }); }
        catch (e) { calls.push({ method: 'DELETE', path: teardownPath(a), scope: a.vdom || client.vdom, summary: `Failed to delete ${describeArtifact(a)}: ${e.message}` }); }
      }
      return { skipped: false, output: {}, artifacts: [], calls };
    },
  },
};

/** Preview path string for an artifact's DELETE call. */
export function teardownPath(a) {
  switch (a.type) {
    case 'interface': return `cmdb/system/interface/${a.name}`;
    case 'address': return `cmdb/firewall/address/${a.name}`;
    case 'service': return `cmdb/firewall.service/custom/${a.name}`;
    case 'policy': return `cmdb/firewall/policy/${a.id}`;
    case 'static_route': return `cmdb/router/static/${a.id}`;
    case 'dhcp_server': return `cmdb/system.dhcp/server/${a.id}`;
    case 'vip': return `cmdb/firewall/vip/${a.name}`;
    case 'switch_port_vlan': return `cmdb/switch-controller/managed-switch/${a.serial}`;
    case 'switch_controller_vlan': return `cmdb/switch-controller/vlan/${a.name}`;
    default: return `(${a.type})`;
  }
}

/**
 * Validate a step's params against its action schema. Throws on error.
 */
export function validateStep(action, rawParams) {
  const def = ACTIONS[action];
  if (!def) throw new Error(`Unknown workflow action: ${action}`);
  const params = rawParams || {};
  for (const spec of def.params) {
    if (spec.required) {
      const v = params[spec.name];
      const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
      // A template like "{{tag}}" satisfies "required" — it resolves at run time.
      if (missing) throw new Error(`Action "${action}" is missing required param "${spec.name}"`);
    }
  }
  if (typeof def.validate === 'function') def.validate(params);
  return true;
}

/**
 * Delete a single recorded artifact (best-effort). Returns nothing; throws on
 * a hard failure so the caller can record the error.
 */
export async function deleteArtifact(client, artifact) {
  switch (artifact.type) {
    case 'interface':
      return client.deleteInterface(artifact.name);
    case 'address':
      return client.deleteAddressObject(artifact.name, artifact.vdom || null);
    case 'service':
      return client.deleteServiceObject(artifact.name, artifact.vdom || null);
    case 'policy':
      return client.deletePolicy(artifact.id, artifact.vdom || null);
    case 'static_route':
      return client.deleteStaticRoute(artifact.id, artifact.vdom || null);
    case 'dhcp_server':
      return client.deleteDhcpServer(artifact.id);
    case 'vip':
      return client.deleteVip(artifact.name, artifact.vdom || null);
    case 'switch_port_vlan':
      return client.removeManagedSwitchPortVlan(artifact.serial, artifact.port, artifact.vlanName, artifact.vdom || null);
    case 'switch_controller_vlan':
      return client.deleteSwitchControllerVlan(artifact.name, artifact.vdom || null);
    default:
      throw new Error(`No teardown handler for artifact type "${artifact.type}"`);
  }
}

/** Human summary of an artifact for the run log / UI. */
export function describeArtifact(a) {
  switch (a.type) {
    case 'interface': return `interface ${a.name}`;
    case 'address': return `address ${a.name}${a.vdom ? ` (${a.vdom})` : ''}`;
    case 'service': return `service ${a.name}${a.vdom ? ` (${a.vdom})` : ''}`;
    case 'policy': return `policy ${a.id}${a.vdom ? ` (${a.vdom})` : ''}`;
    case 'static_route': return `route ${a.id}${a.vdom ? ` (${a.vdom})` : ''}`;
    case 'dhcp_server': return `dhcp server ${a.id}`;
    case 'vip': return `vip ${a.name}${a.vdom ? ` (${a.vdom})` : ''}`;
    case 'switch_port_vlan': return `switch ${a.serial}/${a.port} vlan ${a.vlanName}`;
    case 'switch_controller_vlan': return `switch-controller vlan ${a.name}`;
    default: return `${a.type}`;
  }
}

/** Catalog metadata for the frontend (no functions). */
export function catalogMeta() {
  return Object.entries(ACTIONS).map(([key, def]) => ({
    action: key,
    label: def.label,
    category: def.category,
    description: def.description,
    params: def.params,
  }));
}
