import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import assert from 'node:assert/strict';
import { userVlanCidrs, vlanRowCidr, vlanRowsToCidrs } from './vlanSubnets.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vlans, userVlans, firewalls, firewallVlanSync, workflows, workflowRuns } from '../db/schema/index.ts';

test('a managed VLAN derives its network from the tag, not from subnet_cidr', () => {
  // Managed VLANs are stored with an empty subnet_cidr on purpose — reading
  // that column alone left every one of them covering nothing.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: '' }), '10.10.10.0/24');
  assert.equal(vlanRowCidr({ tag: 1012, mode: 'managed', subnet_cidr: null }), '10.10.12.0/24');
  assert.equal(vlanRowCidr({ tag: 1126, mode: 'managed' }), '10.11.26.0/24');
});

test('an explicit subnet_cidr wins over the derived network', () => {
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: '192.168.5.0/24' }), '192.168.5.0/24');
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: ' 172.16.0.0/16 ' }), '172.16.0.0/16');
});

test('a tagged-only VLAN without a CIDR covers nothing', () => {
  // The portal does not address tagged-only VLANs, so there is no range to
  // infer — granting the derived one would hand out access nobody configured.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: '' }), '');
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: 'not-a-cidr' }), '');
});

test('a subnet_cidr with no prefix falls back instead of being matched against', () => {
  // ipv4InCidr rejects a prefix-less value, so keeping it would silently deny.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: '10.10.10.0' }), '10.10.10.0/24');
});

test('an unusable tag yields no network rather than a bogus one', () => {
  assert.equal(vlanRowCidr({ tag: 99999, mode: 'managed', subnet_cidr: '' }), '');
  assert.equal(vlanRowCidr(null), '');
});

test('rows collapse to a unique, empty-free CIDR list', () => {
  assert.deepEqual(vlanRowsToCidrs([
    { tag: 1010, mode: 'managed', subnet_cidr: '' },
    { tag: 1010, mode: 'managed', subnet_cidr: '' },
    { tag: 700, mode: 'tagged_only', subnet_cidr: '' },
    { tag: 1012, mode: 'managed', subnet_cidr: '' },
  ]), ['10.10.10.0/24', '10.10.12.0/24']);
  assert.deepEqual(vlanRowsToCidrs(null), []);
});

test('userVlanCidrs reads the assigned rows through the passed db handle', async () => {
  const testDb = await createTestDatabase();
  try {
    const [user] = await testDb.db.insert(users).values({ username: 'vlan-subnet-user', password: 'x' }).returning({ id: users.id });
    const [managed] = await testDb.db.insert(vlans).values({ name: 'm', tag: 1012, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
    // A tagged-only VLAN without a CIDR contributes nothing — assigning it must
    // not widen the returned set.
    const [tagged] = await testDb.db.insert(vlans).values({ name: 't', tag: 700, mode: 'tagged_only', subnet_cidr: '' }).returning({ id: vlans.id });
    await testDb.db.insert(userVlans).values([
      { user_id: user.id, vlan_id: managed.id },
      { user_id: user.id, vlan_id: tagged.id },
    ]);

    assert.deepEqual(await userVlanCidrs(testDb.db, user.id), ['10.10.12.0/24']);
    // A user with no assignments covers nothing.
    const [other] = await testDb.db.insert(users).values({ username: 'vlan-subnet-none', password: 'x' }).returning({ id: users.id });
    assert.deepEqual(await userVlanCidrs(testDb.db, other.id), []);
  } finally {
    await testDb.drop();
  }
});

test('a managed VLAN covers the subnet its sync recorded', () => {
  assert.equal(vlanRowCidr({ tag: 1126, mode: 'managed', synced_cidr: '172.11.26.0/24' }), '172.11.26.0/24');
  assert.equal(vlanRowCidr({ tag: 1126, mode: 'managed', synced_cidr: null }), '10.11.26.0/24');
  assert.equal(vlanRowCidr({ tag: 1126, mode: 'tagged_only', synced_cidr: '172.11.26.0/24' }), '');
});

test('userVlanCidrs uses the recorded sync subnet, not the current workflow setting', async () => {
  const testDb = await createTestDatabase();
  try {
    const [user] = await testDb.db.insert(users).values({ username: 'vlan-octet-user', password: 'x' }).returning({ id: users.id });
    const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'h', api_key: 'k' }).returning({ id: firewalls.id });
    // Setting changed after provisioning; must not move the access range.
    await testDb.db.insert(workflows).values({ firewall_id: fw.id, trigger: 'vlan_provision', name: 'p', settings: { subnet: { firstOctet: 192 } } });
    const [synced] = await testDb.db.insert(vlans).values({ name: 's', tag: 1126, mode: 'managed' }).returning({ id: vlans.id });
    const [unsynced] = await testDb.db.insert(vlans).values({ name: 'u', tag: 1012, mode: 'managed' }).returning({ id: vlans.id });
    await testDb.db.insert(firewallVlanSync).values({ firewall_id: fw.id, vlan_id: synced.id, interface_name: 'vlan1126', subnet_cidr: '172.11.26.0/24' });
    await testDb.db.insert(userVlans).values([
      { user_id: user.id, vlan_id: synced.id },
      { user_id: user.id, vlan_id: unsynced.id },
    ]);
    assert.deepEqual((await userVlanCidrs(testDb.db, user.id)).sort(), ['10.10.12.0/24', '172.11.26.0/24']);
  } finally {
    await testDb.drop();
  }
});

const routeLog = (dst: unknown) => [{ stepKey: 'route', calls: [{ method: 'POST', path: 'cmdb/router/static', body: { dst } }] }];

test('migration 0020 backfills only from the recorded route, never current settings', async () => {
  const testDb = await createTestDatabase();
  try {
    const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'h', api_key: 'k' }).returning({ id: firewalls.id });
    // Changed to 192 after provisioning on 172; a non-numeric value must not break the migration either.
    await testDb.db.insert(workflows).values({ firewall_id: fw.id, trigger: 'vlan_provision', name: 'p', settings: { subnet: { firstOctet: 192 } } });
    const [fw2] = await testDb.db.insert(firewalls).values({ name: 'fw2', host: 'h2', api_key: 'k' }).returning({ id: firewalls.id });
    await testDb.db.insert(workflows).values({ firewall_id: fw2.id, trigger: 'vlan_provision', name: 'q', settings: { subnet: { firstOctet: 'abc' } } });
    const [okRun] = await testDb.db.insert(workflowRuns).values({ firewall_id: fw.id, log: routeLog('172.11.26.0 255.255.255.0') }).returning({ id: workflowRuns.id });
    const [junkRun] = await testDb.db.insert(workflowRuns).values({ firewall_id: fw.id, log: { not: 'an array' } }).returning({ id: workflowRuns.id });
    const [oddRun] = await testDb.db.insert(workflowRuns).values({ firewall_id: fw.id, log: [{ calls: 'x' }, ...routeLog(42), ...routeLog('10.0.0.0 255.0.0.0')] }).returning({ id: workflowRuns.id });
    const mk = async (tag: number) => (await testDb.db.insert(vlans).values({ name: `v${tag}`, tag, mode: 'managed' }).returning({ id: vlans.id }))[0].id;
    const [a, b, c, d] = [await mk(1126), await mk(1127), await mk(1128), await mk(1129)];
    await testDb.db.insert(firewallVlanSync).values([
      { firewall_id: fw.id, vlan_id: a, interface_name: 'vlan1126', workflow_run_id: okRun.id, artifacts: [] },
      { firewall_id: fw.id, vlan_id: b, interface_name: 'vlan1127', workflow_run_id: junkRun.id, artifacts: [] },
      { firewall_id: fw.id, vlan_id: c, interface_name: 'vlan1128', workflow_run_id: oddRun.id, artifacts: [] },
      { firewall_id: fw.id, vlan_id: d, interface_name: 'vlan1129' },
    ]);
    const migration = await readFile(new URL('../../drizzle/0020_sync_subnet_cidr.sql', import.meta.url), 'utf8');
    await testDb.db.execute(sql.raw(migration.split('--> statement-breakpoint')[1]));
    const rows = await testDb.db.select({ vlan_id: firewallVlanSync.vlan_id, cidr: firewallVlanSync.subnet_cidr }).from(firewallVlanSync);
    const byVlan = Object.fromEntries(rows.map(r => [r.vlan_id, r.cidr]));
    assert.equal(byVlan[a], '172.11.26.0/24');
    // No usable record → NULL (readers use the legacy 10.x default).
    assert.equal(byVlan[b], null);
    assert.equal(byVlan[c], null);
    assert.equal(byVlan[d], null);
  } finally {
    await testDb.drop();
  }
});
