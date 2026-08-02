// Coverage for the sidebar's admin section model.
//
// The regression this guards: a user whose only grant was canManagePortForwards
// saw no Networking section at all, so the page they were delegated had no link
// anywhere in the UI. Sections are now derived from their links, and the tests
// below pin that invariant down for every permission combination.
//
// Run with:  node --test src/utils/navSections.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ONLY, NAV_SECTIONS, makeCan, visibleSections } from './navSections.js';

// Every granular permission the sidebar knows about, straight from the model.
const ALL_PERMS = [...new Set(
  NAV_SECTIONS.flatMap((s) => s.links.flatMap((l) => l.perms)),
)].filter((perm) => perm !== ADMIN_ONLY);

const shape = (sections) => sections.map((s) => [s.label, s.links.map((l) => l.label)]);
const canFrom = (user) => makeCan(user);
const user = (permissions, isAdmin = false) => ({ isAdmin, permissions });

test('a user whose ONLY permission is canManagePortForwards sees the Port Forwarding link', () => {
  const sections = visibleSections(canFrom(user({ canManagePortForwards: true })));
  assert.deepEqual(shape(sections), [['Networking', ['Port Forwarding']]]);
  assert.equal(sections[0].links[0].to, '/admin/port-forwarding');
});

test('a user with no permissions at all sees no admin sections', () => {
  assert.deepEqual(visibleSections(canFrom(user({}))), []);
  assert.deepEqual(visibleSections(canFrom(user({ canManageVlans: false, canManagePortForwards: 0 }))), []);
  assert.deepEqual(visibleSections(canFrom(undefined)), []);
  assert.deepEqual(visibleSections(canFrom(null)), []);
});

test('an admin sees every section and every link, admin-only children included', () => {
  const sections = visibleSections(canFrom(user({}, true)));
  assert.deepEqual(shape(sections), [
    ['Infrastructure', ['PVE Hosts', 'Firewalls', 'Workflows', 'Templates', 'VM Leases']],
    ['Networking', ['VLANs', 'Policies', 'Port Forwarding', 'Websites', 'Assignments']],
    ['Access', ['Users', 'Roles', 'Notifications', 'Audit Log']],
  ]);
});

test('admin-only links stay hidden from every granular grant', () => {
  // VM Leases and Notifications have no delegable permission — handing a
  // non-admin the full permission map must not surface them.
  const everything = Object.fromEntries(ALL_PERMS.map((perm) => [perm, true]));
  const sections = visibleSections(canFrom(user(everything)));
  const labels = sections.flatMap((s) => s.links.map((l) => l.label));
  assert.equal(labels.includes('VM Leases'), false);
  assert.equal(labels.includes('Notifications'), false);
  // ...but everything else is there, in order.
  assert.deepEqual(shape(sections), [
    ['Infrastructure', ['PVE Hosts', 'Firewalls', 'Workflows', 'Templates']],
    ['Networking', ['VLANs', 'Policies', 'Port Forwarding', 'Websites', 'Assignments']],
    ['Access', ['Users', 'Roles', 'Audit Log']],
  ]);
});

test('makeCan: admins pass everything, non-admins only their own map', () => {
  const admin = makeCan(user({}, true));
  assert.equal(admin('canManageHosts'), true);
  assert.equal(admin(ADMIN_ONLY), true);

  const scoped = makeCan(user({ canManagePortForwards: true }));
  assert.equal(scoped('canManagePortForwards'), true);
  assert.equal(scoped('canManageFirewalls'), false);
  // A non-admin can never satisfy the admin-only sentinel, whatever their map says.
  assert.equal(scoped(ADMIN_ONLY), false);
  assert.equal(makeCan(user({ isAdmin: true }))(ADMIN_ONLY), false);
  assert.equal(makeCan(undefined)('canManageUsers'), false);
});

test('a bad or missing predicate hides everything rather than leaking links', () => {
  assert.deepEqual(visibleSections(undefined), []);
  assert.deepEqual(visibleSections(null), []);
  assert.deepEqual(visibleSections('nope'), []);
});

test('every link declares at least one permission — no unreachable entries', () => {
  for (const section of NAV_SECTIONS) {
    assert.ok(section.links.length > 0, `${section.label} has no links`);
    for (const link of section.links) {
      assert.ok(Array.isArray(link.perms) && link.perms.length > 0, `${link.label} declares no perms`);
      assert.ok(link.to && link.label && link.icon, `${link.label} is missing to/label/icon`);
    }
  }
});

test('visibleSections does not mutate the shared model', () => {
  const before = JSON.stringify(NAV_SECTIONS);
  visibleSections(canFrom(user({ canManageUsers: true })));
  visibleSections(canFrom(user({}, true)));
  assert.equal(JSON.stringify(NAV_SECTIONS), before);
});

// --- exhaustive invariants over every permission combination ----------------

// All 2^n grant maps a non-admin can hold.
function everyGrantCombination() {
  const combos = [];
  for (let mask = 0; mask < (1 << ALL_PERMS.length); mask++) {
    const perms = {};
    ALL_PERMS.forEach((perm, i) => { if (mask & (1 << i)) perms[perm] = true; });
    combos.push(perms);
  }
  return combos;
}

test('a section appears exactly when at least one of its links is visible', () => {
  for (const perms of [...everyGrantCombination().map((p) => user(p)), user({}, true)]) {
    const can = makeCan(perms);
    const sections = visibleSections(can);
    for (const model of NAV_SECTIONS) {
      const expected = model.links.filter((l) => l.perms.some(can));
      const rendered = sections.find((s) => s.label === model.label);
      if (expected.length === 0) {
        assert.equal(rendered, undefined, `${model.label} rendered with no visible links`);
      } else {
        assert.ok(rendered, `${model.label} hidden despite ${expected.length} visible link(s)`);
        assert.deepEqual(rendered.links.map((l) => l.to), expected.map((l) => l.to));
      }
    }
    // No empty shells, and section order is always the model's order.
    assert.ok(sections.every((s) => s.links.length > 0));
    assert.deepEqual(
      sections.map((s) => s.label),
      NAV_SECTIONS.map((s) => s.label).filter((label) => sections.some((s) => s.label === label)),
    );
  }
});

// The pre-fix sidebar, reproduced verbatim, so the refactor can be diffed
// against it instead of trusted. Section gates were hand-maintained; the link
// gates below are the ones that actually shipped.
function legacySidebar({ isAdmin = false, permissions = {} }) {
  const can = (perm) => !!(isAdmin || permissions[perm]);
  const out = [];
  const showInfra = can('canManageHosts') || can('canManageFirewalls') || can('canManageTemplates');
  const showNet = can('canManageVlans') || can('canManagePolicies') || can('canManageAssignments') || can('canManageWebsites');
  const showAccess = can('canManageUsers') || can('canViewAuditLog') || isAdmin;
  if (showInfra) {
    const links = [];
    if (can('canManageHosts')) links.push('PVE Hosts');
    if (can('canManageFirewalls')) links.push('Firewalls');
    if (can('canManageFirewalls')) links.push('Workflows');
    if (can('canManageTemplates')) links.push('Templates');
    if (isAdmin) links.push('VM Leases');
    out.push(['Infrastructure', links]);
  }
  if (showNet) {
    const links = [];
    if (can('canManageVlans')) links.push('VLANs');
    if (can('canManagePolicies')) links.push('Policies');
    if (can('canManageFirewalls') || can('canManagePortForwards')) links.push('Port Forwarding');
    if (can('canManageWebsites')) links.push('Websites');
    if (can('canManageAssignments')) links.push('Assignments');
    out.push(['Networking', links]);
  }
  if (showAccess) {
    const links = [];
    if (can('canManageUsers')) links.push('Users');
    if (can('canManageUsers')) links.push('Roles');
    if (isAdmin) links.push('Notifications');
    if (can('canViewAuditLog')) links.push('Audit Log');
    out.push(['Access', links]);
  }
  return out;
}

test('behavior is unchanged except where the old section gate swallowed Port Forwarding', () => {
  let fixed = 0;
  for (const u of [...everyGrantCombination().map((p) => user(p)), user({}, true)]) {
    const legacy = legacySidebar(u);
    const next = shape(visibleSections(makeCan(u)));
    const p = u.permissions;
    const legacyHidNetworking = !(p.canManageVlans || p.canManagePolicies || p.canManageAssignments || p.canManageWebsites) && !u.isAdmin;
    const mayForward = !!(p.canManageFirewalls || p.canManagePortForwards);
    if (legacyHidNetworking && mayForward) {
      // The bug: the link was permitted but its section was gated off.
      fixed++;
      assert.deepEqual(next, [...legacy, ['Networking', ['Port Forwarding']]].sort(
        (a, b) => ['Infrastructure', 'Networking', 'Access'].indexOf(a[0]) - ['Infrastructure', 'Networking', 'Access'].indexOf(b[0]),
      ));
    } else {
      assert.deepEqual(next, legacy, `changed for ${JSON.stringify(u)}`);
    }
  }
  assert.ok(fixed > 0, 'expected the port-forward regression to be reproducible');
});
