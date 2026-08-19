import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ipv4InCidr } from '../utils/ipPolicy.ts';
import { allowedResolvedSshAddresses, sshAddressAllowed } from '../utils/sshTargetAuthorization.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, userVlans, vlans } from '../db/schema/index.ts';

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

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
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

      // An address outside every assigned VLAN still fails closed.
      await assert.rejects(
        () => authorizeSshTarget({ userId, isAdmin: false, node: '1~pve', vmid: 101, host: '10.99.99.9', port: 22 }),
        /outside the VM addresses or networks assigned to you/,
      );
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
