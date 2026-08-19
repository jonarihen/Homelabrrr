/**
 * Built-in default workflow definitions.
 *
 * Each trigger's default steps reproduce the historical hardcoded FortiGate
 * sequence EXACTLY (see fortigate.js `provisionVlan` and the admin VIP/policy
 * routes). Seeding these on migration keeps existing deployments byte-for-byte
 * identical; admins can then reorder / toggle / parametrize per firewall.
 *
 * Step shape: { step_key, action, label, params, condition, continue_on_error }
 */

export const TRIGGERS = [
  { trigger: 'vlan_provision',       label: 'VLAN — provision',        subjectType: 'vlan',         kind: 'create', description: 'Runs when a VLAN is synced to this firewall.' },
  { trigger: 'vlan_deprovision',     label: 'VLAN — deprovision',      subjectType: 'vlan',         kind: 'delete', description: 'Runs when a VLAN is unsynced / deleted. Artifact-based teardown.' },
  { trigger: 'port_forward_create',  label: 'Port forward — create',   subjectType: 'port_forward', kind: 'create', description: 'Runs when a port forward (VIP + policy chain) is created.' },
  { trigger: 'port_forward_delete',  label: 'Port forward — delete',   subjectType: 'port_forward', kind: 'delete', description: 'Runs when a managed port forward is deleted. Artifact-based teardown.' },
  { trigger: 'policy_create',        label: 'Policy — create',         subjectType: 'policy',       kind: 'create', description: 'Runs when an inter-VLAN policy is created.' },
  { trigger: 'policy_delete',        label: 'Policy — delete',         subjectType: 'policy',       kind: 'delete', description: 'Runs when an inter-VLAN policy is deleted.' },
];

export const TRIGGER_MAP = Object.fromEntries(TRIGGERS.map((t) => [t.trigger, t]));

// Variables available to templates per trigger — surfaced by the UI variable picker.
export const TRIGGER_VARIABLES = {
  vlan_provision: [
    '{{tag}}', '{{name}}',
    '{{subnet.ip}}', '{{subnet.netmask}}', '{{subnet.network}}', '{{subnet.networkIp}}',
    '{{subnet.gateway}}', '{{subnet.dhcpStart}}', '{{subnet.dhcpEnd}}',
    '{{allowInternet}}', '{{enableDhcp}}', '{{trunkConfigured}}',
    '{{firewall.parent_interface}}', '{{firewall.lab_vdom_link}}', '{{firewall.root_vdom}}',
    '{{firewall.root_vdom_link}}', '{{firewall.route_gateway}}', '{{firewall.trunk_switch_serial}}',
    '{{firewall.trunk_switch_port}}', '{{firewall.vdom}}',
    '{{steps.iface.interfaceName}}', '{{steps.addr.name}}',
  ],
  port_forward_create: [
    '{{name}}', '{{protocol}}', '{{externalPort}}', '{{internalIp}}', '{{internalPort}}',
    '{{serviceName}}', '{{labAddressName}}', '{{externalIp}}', '{{wanZone}}', '{{dstInterface}}',
    '{{vlanInterface}}', '{{labSrcInterface}}', '{{rootVdom}}', '{{labVdom}}', '{{srcAddresses}}',
    '{{firewall.root_vdom}}', '{{firewall.vdom}}',
  ],
  policy_create: [
    '{{action}}', '{{bidirectional}}', '{{services}}',
    '{{srcVlan.interface_name}}', '{{srcVlan.name}}', '{{srcVlan.tag}}',
    '{{dstVlan.interface_name}}', '{{dstVlan.name}}', '{{dstVlan.tag}}',
    '{{srcAddrName}}', '{{dstAddrName}}',
  ],
  vlan_deprovision: [],
  port_forward_delete: [],
  policy_delete: [],
};

function step(step_key, action, params, opts = {}) {
  return {
    step_key,
    action,
    label: opts.label || '',
    params: params || {},
    condition: opts.condition || '',
    continue_on_error: opts.continueOnError ? 1 : 0,
  };
}

export function defaultSteps(trigger) {
  switch (trigger) {
    case 'vlan_provision':
      return [
        step('iface', 'create_vlan_interface', {
          name: 'vlan{{tag}}',
          vlanId: '{{tag}}',
          parentInterface: '{{firewall.parent_interface}}',
          ip: '{{subnet.ip}}',
          netmask: '{{subnet.netmask}}',
          description: '{{name}}',
        }, { label: 'VLAN interface' }),
        step('addr', 'create_address_object', {
          name: 'NET-{{subnet.networkIp}}_24',
          subnet: '{{subnet.networkIp}} {{subnet.netmask}}',
        }, { label: 'Subnet address object' }),
        step('policy', 'create_policy', {
          name: '{{steps.iface.interfaceName}}-internet',
          srcintf: ['{{steps.iface.interfaceName}}'],
          dstintf: ['{{firewall.lab_vdom_link}}'],
          srcaddr: ['{{steps.addr.name}}'],
          dstaddr: ['all'],
          action: 'accept',
          schedule: 'always',
          service: ['ALL'],
          logtraffic: 'all',
          globalLabel: '{{name}} ({{steps.iface.interfaceName}})',
          comments: 'Auto-created for {{name}} ({{steps.iface.interfaceName}})',
          dedupeBySrcintf: '{{steps.iface.interfaceName}}',
        }, { label: 'Internet access policy', condition: '{{allowInternet}}' }),
        step('route', 'create_static_route', {
          dst: '{{subnet.networkIp}}',
          netmask: '{{subnet.netmask}}',
          gateway: '{{firewall.route_gateway}}',
          device: '{{firewall.root_vdom_link}}',
          vdom: '{{firewall.root_vdom}}',
        }, { label: 'Static route (root VDOM)' }),
        step('dhcp', 'create_dhcp_server', {
          interface: '{{steps.iface.interfaceName}}',
          gateway: '{{subnet.gateway}}',
          netmask: '{{subnet.netmask}}',
          startIp: '{{subnet.dhcpStart}}',
          endIp: '{{subnet.dhcpEnd}}',
          dns1: '1.1.1.1',
          dns2: '8.8.8.8',
        }, { label: 'DHCP server', condition: '{{enableDhcp}}' }),
        step('switch_port', 'assign_switch_port', {
          serial: '{{firewall.trunk_switch_serial}}',
          port: '{{firewall.trunk_switch_port}}',
          vlanName: '{{steps.iface.interfaceName}}',
          trunk: true,
          vdom: '{{firewall.root_vdom}}',
        }, { label: 'Trunk switch port', condition: '{{trunkConfigured}}', continueOnError: true }),
        step('sc_vlan', 'register_switch_controller_vlan', {
          name: '{{steps.iface.interfaceName}}',
          vlanId: '{{tag}}',
          description: '{{name}}',
          vdom: '{{firewall.root_vdom}}',
        }, { label: 'Switch-controller VLAN', continueOnError: true }),
      ];

    case 'port_forward_create':
      return [
        step('svc_root', 'create_service_object', {
          name: '{{serviceName}}',
          protocol: '{{protocol}}',
          port: '{{internalPort}}',
          comment: 'Managed port forward service for {{name}}',
          vdom: '{{rootVdom}}',
        }, { label: 'Service object (root VDOM)' }),
        step('svc_lab', 'create_service_object', {
          name: '{{serviceName}}',
          protocol: '{{protocol}}',
          port: '{{internalPort}}',
          comment: 'Managed port forward service for {{name}}',
          vdom: '{{labVdom}}',
        }, { label: 'Service object (lab VDOM)', condition: '{{vlanInterface}}' }),
        step('addr_lab', 'create_address_object', {
          name: '{{labAddressName}}',
          type: 'ipmask',
          subnet: '{{internalIp}} 255.255.255.255',
          comment: 'Managed port forward destination for {{name}}',
          vdom: '{{labVdom}}',
        }, { label: 'Destination address (lab VDOM)', condition: '{{vlanInterface}}' }),
        step('vip', 'create_vip', {
          name: '{{name}}',
          extip: '{{externalIp}}',
          mappedip: '{{internalIp}}',
          extintf: 'any',
          extport: '{{externalPort}}',
          mappedport: '{{internalPort}}',
          protocol: '{{protocol}}',
          vdom: '{{rootVdom}}',
        }, { label: 'Virtual IP' }),
        step('policy_root', 'create_policy', {
          name: 'PF: {{name}}',
          srcintf: ['{{wanZone}}'],
          dstintf: ['{{dstInterface}}'],
          srcaddr: '{{srcAddresses}}',
          dstaddr: ['{{name}}'],
          action: 'accept',
          schedule: 'always',
          service: ['{{serviceName}}'],
          logtraffic: 'all',
          globalLabel: 'Port Forwarding (VM Manager)',
          comments: 'Auto-created by VM Manager for {{name}}',
          vdom: '{{rootVdom}}',
        }, { label: 'Inbound policy (root VDOM)' }),
        step('policy_lab', 'create_policy', {
          name: 'PF: {{name}}',
          srcintf: ['{{labSrcInterface}}'],
          dstintf: ['{{vlanInterface}}'],
          srcaddr: ['all'],
          dstaddr: ['{{labAddressName}}'],
          action: 'accept',
          schedule: 'always',
          service: ['{{serviceName}}'],
          logtraffic: 'all',
          globalLabel: 'Port Forwarding ({{vlanInterface}})',
          comments: 'Auto-created by VM Manager for {{name}}',
          vdom: '{{labVdom}}',
          moveAfterSameLabel: true,
        }, { label: 'Forward policy (lab VDOM)', condition: '{{vlanInterface}}' }),
      ];

    case 'policy_create':
      return [
        step('forward', 'create_policy', {
          name: '{{srcVlan.interface_name}}-to-{{dstVlan.interface_name}}',
          srcintf: ['{{srcVlan.interface_name}}'],
          dstintf: ['{{dstVlan.interface_name}}'],
          srcaddr: ['{{srcAddrName}}'],
          dstaddr: ['{{dstAddrName}}'],
          action: '{{action}}',
          schedule: 'always',
          service: '{{services}}',
          logtraffic: 'all',
          globalLabel: '{{srcVlan.name}} ({{srcVlan.interface_name}})',
          comments: 'Inter-VLAN policy created via VM Manager',
        }, { label: 'Forward policy' }),
        step('reverse', 'create_policy', {
          name: '{{dstVlan.interface_name}}-to-{{srcVlan.interface_name}}',
          srcintf: ['{{dstVlan.interface_name}}'],
          dstintf: ['{{srcVlan.interface_name}}'],
          srcaddr: ['{{dstAddrName}}'],
          dstaddr: ['{{srcAddrName}}'],
          action: '{{action}}',
          schedule: 'always',
          service: '{{services}}',
          logtraffic: 'all',
          globalLabel: '{{dstVlan.name}} ({{dstVlan.interface_name}})',
          comments: 'Inter-VLAN policy created via VM Manager',
        }, { label: 'Reverse policy', condition: '{{bidirectional}}' }),
      ];

    case 'vlan_deprovision':
    case 'port_forward_delete':
    case 'policy_delete':
      return [
        step('teardown', 'teardown_recorded_artifacts', {}, { label: 'Delete recorded artifacts' }),
      ];

    default:
      return [];
  }
}

export function defaultWorkflowName(trigger) {
  const meta = TRIGGER_MAP[trigger];
  return meta ? `Default: ${meta.label}` : `Default: ${trigger}`;
}
