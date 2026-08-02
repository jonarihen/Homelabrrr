// Regression coverage for port-forward target eligibility.
// The bug: getScopedPortForwardTargets() silently filtered VMs out of the
// "Target VM" dropdown, so a user saw an empty list with no idea which VM was
// missing or why. Every case below used to be an invisible `.filter()`.
// Run with:  node --test src/utils/portForwardTargets.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPortForwardTargets, blockedErrorText, blockedStatus, vlanLabel, BLOCKED_CODES,
} from './portForwardTargets.js';

const VM = (over = {}) => ({
  node: 'pve', nodeRef: '1~pve', vmid: 105, name: 'web-01', status: 'running', type: 'qemu', ...over,
});

// A world where web-01 is fully publishable; each test breaks exactly one thing.
const happy = {
  vms: [VM()],
  sshConfigs: [{ node: '1~pve', vmid: 105, host: '10.10.1.20', port: 22 }],
  vlanTags: new Map([['1~pve/105', 1001]]),
  vlans: [{ id: 3, name: 'office', tag: 1001 }],
  vlanSyncs: [{ vlan_tag: 1001, interface_name: 'vlan1001' }],
  userVlanTags: [1001],
  unrestricted: false,
  canManageVlans: false,
  rootDstInterface: 'lab-root1',
  firewallName: 'fw-edge',
};

const build = (over = {}) => buildPortForwardTargets({ ...happy, ...over });
const only = (over = {}) => {
  const targets = build(over);
  assert.equal(targets.length, 1, 'the VM must stay in the list, never be filtered away');
  return targets[0];
};

test('an eligible VM resolves its IP, VLAN interface and destination interface', () => {
  const t = only();
  assert.equal(t.eligible, true);
  assert.equal(t.blocked, null);
  assert.equal(t.ip, '10.10.1.20');
  assert.equal(t.sshPort, 22);
  assert.equal(t.vlanTag, 1001);
  assert.equal(t.vlanName, 'office');
  assert.equal(t.vlanInterface, 'vlan1001');
  assert.equal(t.dstInterface, 'lab-root1');
  assert.equal(t.nodeRef, '1~pve');
  assert.equal(t.overridable, false);
});

test('no_ip: a VM with no SSH config row is listed, not hidden', () => {
  const t = only({ sshConfigs: [] });
  assert.equal(t.eligible, false);
  assert.equal(t.blocked.code, 'no_ip');
  assert.match(t.blocked.message, /doesn't know this VM's IP address/);
  assert.match(t.blocked.action, /SSH Host\/IP/);
  assert.equal(t.blocked.href, '/vm/1~pve/105');
  assert.equal(t.blocked.short, 'no IP recorded');
  assert.equal(t.ip, '');
});

test('no_ip: an SSH config row with a blank host counts as no IP', () => {
  const t = only({ sshConfigs: [{ node: '1~pve', vmid: 105, host: '  ', port: 22 }] });
  assert.equal(t.blocked.code, 'no_ip');
});

test('untagged: a VM whose net0 carries no tag= is listed with the VLAN reason', () => {
  const t = only({ vlanTags: new Map([['1~pve/105', null]]) });
  assert.equal(t.eligible, false);
  assert.equal(t.blocked.code, 'untagged');
  assert.match(t.blocked.message, /no VLAN tag/);
  assert.equal(t.blocked.href, '/vm/1~pve/105');
  assert.equal(t.vlanTag, null);
  assert.equal(t.vlanInterface, '');
  assert.equal(t.dstInterface, '');
});

test('untagged: a VM missing from the config map is treated as untagged', () => {
  const t = only({ vlanTags: new Map() });
  assert.equal(t.blocked.code, 'untagged');
});

test('vlan_not_synced: names the VLAN and the firewall, and links only for VLAN admins', () => {
  const t = only({ vlanSyncs: [] });
  assert.equal(t.eligible, false);
  assert.equal(t.blocked.code, 'vlan_not_synced');
  assert.equal(t.blocked.message, "VLAN office (tag 1001) hasn't been synced to firewall fw-edge yet.");
  assert.match(t.blocked.action, /An admin needs to sync it/);
  assert.equal(t.blocked.href, null, 'plain text for non-admins');

  const admin = only({ vlanSyncs: [], canManageVlans: true });
  assert.equal(admin.blocked.href, '/admin/vlans');
  assert.equal(admin.blocked.action, 'Sync it under Networking → VLANs.');
});

test('vlan_not_synced: a tag Homelabrrr has never registered degrades to "tag N"', () => {
  const t = only({ vlans: [], vlanSyncs: [], userVlanTags: [] });
  assert.equal(t.blocked.code, 'vlan_not_synced');
  assert.match(t.blocked.message, /VLAN tag 1001 hasn't been synced/);
});

test('vlan_not_assigned: a synced VLAN the user does not own is listed, and leaks no interface', () => {
  const t = only({ userVlanTags: [] });
  assert.equal(t.eligible, false);
  assert.equal(t.blocked.code, 'vlan_not_assigned');
  assert.equal(t.blocked.message, "VLAN office (tag 1001) isn't assigned to you.");
  assert.equal(t.blocked.href, null);
  // The create path re-derives dstInterface from this row — it must stay empty.
  assert.equal(t.vlanInterface, '');
  assert.equal(t.dstInterface, '');
});

test('vlan_not_assigned never fires for a firewall-wide manager', () => {
  const t = only({ userVlanTags: [], unrestricted: true });
  assert.equal(t.eligible, true);
  assert.equal(t.blocked, null);
  assert.equal(t.vlanInterface, 'vlan1001');
});

test('precedence follows BLOCKED_CODES: the fact closest to the VM wins', () => {
  assert.deepEqual(BLOCKED_CODES, ['no_ip', 'untagged', 'vlan_not_synced', 'vlan_not_assigned']);

  // All four broken at once → no_ip.
  assert.equal(only({
    sshConfigs: [], vlanTags: new Map(), vlanSyncs: [], userVlanTags: [],
  }).blocked.code, 'no_ip');

  // IP present, everything else broken → untagged.
  assert.equal(only({
    vlanTags: new Map(), vlanSyncs: [], userVlanTags: [],
  }).blocked.code, 'untagged');

  // IP + tag present, unsynced and unassigned → vlan_not_synced.
  assert.equal(only({ vlanSyncs: [], userVlanTags: [] }).blocked.code, 'vlan_not_synced');

  // Only the assignment missing → vlan_not_assigned.
  assert.equal(only({ userVlanTags: [] }).blocked.code, 'vlan_not_assigned');
});

test('privileged users keep the manual-interface override for VLAN-blocked VMs', () => {
  const untagged = only({ vlanTags: new Map(), unrestricted: true });
  assert.equal(untagged.eligible, false);
  assert.equal(untagged.overridable, true, 'admin can still pick the interface by hand');

  const noIp = only({ sshConfigs: [], unrestricted: true });
  assert.equal(noIp.overridable, false, 'no IP means nothing to map to, override impossible');
});

test('accessibleKeys scopes the list; VMs outside it are omitted entirely', () => {
  const vms = [VM(), VM({ vmid: 106, name: 'db-01' })];
  assert.deepEqual(
    build({ vms, accessibleKeys: ['1~pve/106'] }).map(t => t.vmid),
    [106],
  );
  assert.deepEqual(
    build({ vms, accessibleKeys: null }).map(t => t.vmid).sort(),
    [105, 106],
  );
});

test('non-VM resource types are skipped', () => {
  assert.deepEqual(build({ vms: [VM({ type: 'storage' })] }), []);
});

test('legacy bare-node ssh rows resolve only when the vmid is unambiguous', () => {
  const legacy = [{ node: 'pve', vmid: 105, host: '10.10.1.20', port: 2222 }];
  assert.equal(only({ sshConfigs: legacy }).ip, '10.10.1.20');

  // Same bare node/vmid on two clusters — the legacy row is ambiguous, so it
  // must not be applied to either VM.
  const collide = [VM(), VM({ nodeRef: '2~pve' })];
  const targets = build({ vms: collide, sshConfigs: legacy, accessibleKeys: null });
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map(t => t.ip), ['', '']);
  assert.deepEqual(targets.map(t => t.blocked.code), ['no_ip', 'no_ip']);
});

test('selectable VMs sort ahead of blocked ones, then alphabetically', () => {
  const vms = [
    VM({ vmid: 105, name: 'zeta' }),
    VM({ vmid: 106, name: 'alpha' }),
    VM({ vmid: 107, name: 'beta' }),
  ];
  const targets = build({
    vms,
    accessibleKeys: null,
    // only zeta (105) has an IP
    sshConfigs: [{ node: '1~pve', vmid: 105, host: '10.10.1.20', port: 22 }],
    vlanTags: new Map([['1~pve/105', 1001], ['1~pve/106', 1001], ['1~pve/107', 1001]]),
  });
  assert.deepEqual(targets.map(t => t.name), ['zeta', 'alpha', 'beta']);
  assert.deepEqual(targets.map(t => t.eligible), [true, false, false]);
});

test('vlanTags accepts a plain object or pair array as well as a Map', () => {
  assert.equal(only({ vlanTags: { '1~pve/105': 1001 } }).vlanTag, 1001);
  assert.equal(only({ vlanTags: [['1~pve/105', 1001]] }).vlanTag, 1001);
  assert.equal(only({ vlanTags: [{ key: '1~pve/105', vlanTag: 1001 }] }).vlanTag, 1001);
});

test('vlanLabel names the VLAN when known and degrades to the bare tag', () => {
  assert.equal(vlanLabel(1001, 'office'), 'office (tag 1001)');
  assert.equal(vlanLabel(1001, ''), 'tag 1001');
  assert.equal(vlanLabel(1001, null), 'tag 1001');
});

test('blockedErrorText joins message and action into one API error line', () => {
  const t = only({ sshConfigs: [] });
  assert.equal(
    blockedErrorText(t.blocked),
    "Homelabrrr doesn't know this VM's IP address yet. Set the SSH Host/IP on the VM page.",
  );
  assert.equal(blockedErrorText(null), '');
});

test('blockedStatus is 403 for the authorization reason and 400 for the rest', () => {
  assert.equal(blockedStatus({ code: 'vlan_not_assigned' }), 403);
  for (const code of ['no_ip', 'untagged', 'vlan_not_synced']) {
    assert.equal(blockedStatus({ code }), 400);
  }
});

test('a VM with no name falls back to "VM <vmid>"', () => {
  assert.equal(only({ vms: [VM({ name: '' })] }).name, 'VM 105');
});
