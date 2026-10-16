import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import {
  firewalls, publicIpAssignments, publicIpPools, publicIps, users, userVlans, vlans, vmAssignments, vmSshConfigs,
} from '../db/schema/index.ts';

process.env.SECRET_ENCRYPTION_KEY = '45'.repeat(32);
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { getUserAllowedUpstreams, userCanReachUpstream } = await import('./websiteChecks.ts');
const { closeDb } = await import('../db/client.ts');

test.after(async () => {
  await closeDb();
  await testDb.drop();
});

test('website upstreams come from admin-set data, never the user-editable SSH host', async () => {
  const [user] = await testDb.db.insert(users).values({ username: 'site-owner', password: 'unused' }).returning({ id: users.id });
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'lab', tag: 1010, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node: '1~pve', vmid: 101 });
  // The SSH host is written by the VM's operator, so it must grant nothing here.
  await testDb.db.insert(vmSshConfigs).values({ node: '1~pve', vmid: 101, host: '192.168.1.5' });

  const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'fw.test', api_key: 'x' }).returning({ id: firewalls.id });
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'pool', external_interface: 'wan1' }).returning({ id: publicIpPools.id });
  const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address: '203.0.113.9' }).returning({ id: publicIps.id });
  await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, node: '1~pve', vmid: 101, private_ip: '172.16.5.20',
  });

  const allowed = await getUserAllowedUpstreams(user.id);
  assert.deepEqual(allowed.vmIps, ['172.16.5.20']);
  assert.deepEqual(allowed.subnets, ['10.10.10.0/24']);

  assert.equal((await userCanReachUpstream(user.id, '192.168.1.5', false)).ok, false);
  assert.equal((await userCanReachUpstream(user.id, '172.16.5.20', false)).ok, true);
  assert.equal((await userCanReachUpstream(user.id, '10.10.10.40', false)).ok, true);

  // The same VMID on another cluster carries a second public-IP row; it is not
  // this user's VM, so its private IP grants nothing.
  const [ip2] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: fw.id, address: '203.0.113.10' }).returning({ id: publicIps.id });
  await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip2.id, firewall_id: fw.id, user_id: user.id, node: '2~pve', vmid: 101, private_ip: '172.16.9.9',
  });
  assert.deepEqual((await getUserAllowedUpstreams(user.id)).vmIps, ['172.16.5.20']);

  // Unassigning the VM leaves the public-IP row behind; it must stop counting.
  await testDb.db.delete(vmAssignments).where(eq(vmAssignments.user_id, user.id));
  assert.deepEqual((await getUserAllowedUpstreams(user.id)).vmIps, []);
  assert.equal((await userCanReachUpstream(user.id, '172.16.5.20', false)).ok, false);
});
