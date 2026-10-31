import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ipv4InCidr } from '../utils/ipPolicy.ts';
import { allowedResolvedSshAddresses, sshAddressAllowed } from '../utils/sshTargetAuthorization.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { firewalls, publicIpAssignments, publicIpPools, publicIps, pveHosts, users, userVlans, vlans } from '../db/schema/index.ts';

test('CIDR policy admits only addresses inside an assigned network', () => {
  assert.equal(ipv4InCidr('10.20.30.40', '10.20.30.0/24'), true);
  assert.equal(ipv4InCidr('10.20.31.40', '10.20.30.0/24'), false);
  assert.equal(ipv4InCidr('127.0.0.1', '10.20.30.0/24'), false);
  assert.equal(ipv4InCidr('2001:db8::1', '10.20.30.0/24'), false);
});

test('exact VM addresses admit IPv4 and IPv6 without admitting neighbors', () => {
  const exactAddresses = ['10.20.30.40', '2001:db8::40'];
  assert.equal(sshAddressAllowed('10.20.30.40', { exactAddresses }), true);
  assert.equal(sshAddressAllowed('2001:db8::40', { exactAddresses }), true);
  assert.equal(sshAddressAllowed('2001:db8::41', { exactAddresses }), false);
});

test('assigned VLAN networks admit an address while management ranges fail closed', () => {
  const networks = ['10.20.30.0/24'];
  assert.equal(sshAddressAllowed('10.20.30.9', { networks }), true);
  assert.equal(sshAddressAllowed('192.168.1.10', { networks }), false);
});

test('hostname resolution pins only names whose every address passes policy', () => {
  assert.deepEqual(allowedResolvedSshAddresses(['10.20.30.9', '10.20.30.10'], { networks: ['10.20.30.0/24'] }), ['10.20.30.9', '10.20.30.10']);
  assert.deepEqual(allowedResolvedSshAddresses(['10.20.30.9', '192.168.1.10'], { networks: ['10.20.30.0/24'] }), []);
  assert.deepEqual(allowedResolvedSshAddresses(['2001:db8::40'], { exactAddresses: ['2001:db8::40'] }), ['2001:db8::40']);
});

test('connection limits persist in PostgreSQL and the explicit admin override still validates ports', async () => {
  const testDb = await createTestDatabase();
  // Unconverted transitive imports (proxmox.ts → the legacy db.ts singleton)
  // still open a SQLite database at import time. Give them a throwaway path
  // and bootstrap env; drop this block once proxmox.ts is on Drizzle.
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-ssh-policy-'));
  try {
    const [user] = await testDb.db
      .insert(users)
      .values({ username: 'ssh-policy-user', password: 'unused-hash' })
      .returning({ id: users.id });

    // A managed VLAN stores no subnet_cidr — its network comes from the tag.
    // Reading the column alone denied every non-admin SSH target, including a
    // VM sitting on the DHCP range of the user's own VLAN (1010 → 10.10.10.0/24).
    const [vlan] = await testDb.db
      .insert(vlans)
      .values({ name: 'assigned', tag: 1010, mode: 'managed', subnet_cidr: '' })
      .returning({ id: vlans.id });
    await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
    // A VLAN the user is NOT assigned to; a guest on it must not make a peer
    // address reachable just by reporting it through the guest agent.
    await testDb.db.insert(vlans).values({ name: 'peer', tag: 1020, mode: 'managed', subnet_cidr: '' });

    // Two clusters, each with a node called 'pve'. Legacy public-IP rows store
    // the bare node name; one records its host, one does not.
    const hosts = await testDb.db.insert(pveHosts).values([
      { name: 'a', host: 'a.test', token_id: 't', token_secret: 's' },
      { name: 'b', host: 'b.test', token_id: 't', token_secret: 's' },
    ]).returning({ id: pveHosts.id });
    const [fw] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'fw.test', api_key: 'k' }).returning({ id: firewalls.id });
    const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: fw.id, name: 'p', external_interface: 'wan' }).returning({ id: publicIpPools.id });
    const legacy = (address: string, private_ip: string, vmid: number, proxmox_host_id: number | null) => testDb.db.insert(publicIps)
      .values({ pool_id: pool.id, firewall_id: fw.id, address }).returning({ id: publicIps.id })
      .then(([ip]) => testDb.db.insert(publicIpAssignments).values({
        public_ip_id: ip.id, firewall_id: fw.id, user_id: user.id, node: 'pve', vmid, private_ip, proxmox_host_id,
      }));
    await legacy('203.0.113.1', '10.50.0.1', 301, hosts[0].id);
    await legacy('203.0.113.2', '10.50.0.2', 302, null);

    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      // The guest reports a peer address on an unassigned VLAN (and one on the
      // user's own VLAN); neither claim may widen what the user can reach.
      mock.module(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/proxmox.ts')).href)}, { exports: {
        getVMConfig: async () => ({ net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,tag=1020', ipconfig0: 'ip=10.10.20.9/24' }),
        getLXCConfig: async () => ({}),
        getVMAgentInterfaces: async () => [{ 'ip-addresses': [{ 'ip-address': '10.10.20.9' }, { 'ip-address': '192.168.1.5' }] }],
      } });
      const { closeDb } = await import('./src/db/client.ts');
      const { authorizeSshTarget, sshConnectionRateLimited } = await import('./src/services/sshTargetPolicy.ts');
      const userId = ${user.id};
      assert.equal(await sshConnectionRateLimited(userId, 'scan', 2), false);
      assert.equal(await sshConnectionRateLimited(userId, 'scan', 2), false);
      assert.equal(await sshConnectionRateLimited(userId, 'scan', 2), true);
      const target = await authorizeSshTarget({ userId, isAdmin: true, node: '1~pve', vmid: 100, host: 'management.example.test', port: 2222 });
      assert.equal(target.adminOverride, true);
      assert.equal(target.port, 2222);
      await assert.rejects(() => authorizeSshTarget({ userId, isAdmin: true, node: '1~pve', vmid: 100, host: 'management.example.test', port: 70000 }));

      const inVlan = await authorizeSshTarget({ userId, isAdmin: false, node: '1~pve', vmid: 101, host: '10.10.10.10', port: 22 });
      assert.equal(inVlan.host, '10.10.10.10');
      assert.equal(inVlan.adminOverride, false);
      assert.deepEqual(inVlan.resolvedAddresses, ['10.10.10.10']);

      // Guest-claimed addresses grant nothing, even inside the VM's own VLAN.
      for (const host of ['10.10.20.9', '192.168.1.5']) {
        await assert.rejects(
          () => authorizeSshTarget({ userId, isAdmin: false, node: '1~pve', vmid: 101, host, port: 22 }),
          /outside the VM addresses or networks assigned to you/,
        );
      }

      // An address outside every assigned VLAN still fails closed.
      await assert.rejects(
        () => authorizeSshTarget({ userId, isAdmin: false, node: '1~pve', vmid: 101, host: '10.99.99.9', port: 22 }),
        /outside the VM addresses or networks assigned to you/,
      );
      // Legacy bare-node rows only match the host they were recorded for.
      const ok = (node, vmid, host) => authorizeSshTarget({ userId, isAdmin: false, node, vmid, host, port: 22 });
      assert.equal((await ok('${hosts[0].id}~pve', 301, '10.50.0.1')).host, '10.50.0.1');
      await assert.rejects(() => ok('${hosts[1].id}~pve', 301, '10.50.0.1'), /outside the VM addresses/);
      // A row with no recorded host is ambiguous with two clusters: fail closed.
      await assert.rejects(() => ok('${hosts[0].id}~pve', 302, '10.50.0.2'), /outside the VM addresses/);
      await closeDb();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DATABASE_URL: testDb.url,
        DB_PATH: join(directory, 'ssh-policy.sqlite'),
        SECRET_ENCRYPTION_KEY: '77'.repeat(32),
        SESSION_SECRET: 'ssh-policy-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'ssh-policy-admin',
        INITIAL_ADMIN_PASSWORD: 'ssh-policy-password-strong',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await testDb.drop();
  }
});
