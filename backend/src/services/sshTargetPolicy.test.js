import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ipv4InCidr } from '../utils/ipPolicy.js';
import { allowedResolvedSshAddresses, sshAddressAllowed } from '../utils/sshTargetAuthorization.js';

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

test('connection limits persist in SQLite and the explicit admin override still validates ports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-ssh-policy-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { default: db } = await import('./src/db.js');
      const { authorizeSshTarget, sshConnectionRateLimited } = await import('./src/services/sshTargetPolicy.js');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      assert.equal(sshConnectionRateLimited(user.id, 'scan', 2), false);
      assert.equal(sshConnectionRateLimited(user.id, 'scan', 2), false);
      assert.equal(sshConnectionRateLimited(user.id, 'scan', 2), true);
      const target = await authorizeSshTarget({ userId: user.id, isAdmin: true, node: '1~pve', vmid: 100, host: 'management.example.test', port: 2222 });
      assert.equal(target.adminOverride, true);
      assert.equal(target.port, 2222);
      await assert.rejects(() => authorizeSshTarget({ userId: user.id, isAdmin: true, node: '1~pve', vmid: 100, host: 'management.example.test', port: 70000 }));

      // A managed VLAN stores no subnet_cidr — its network comes from the tag.
      // Reading the column alone denied every non-admin SSH target, including a
      // VM sitting on the DHCP range of the user's own VLAN (1010 → 10.10.10.0/24).
      const vlan = db.prepare("INSERT INTO vlans (name, tag, mode, subnet_cidr) VALUES ('assigned', 1010, 'managed', '')").run();
      db.prepare('INSERT INTO user_vlans (user_id, vlan_id) VALUES (?, ?)').run(user.id, vlan.lastInsertRowid);

      const inVlan = await authorizeSshTarget({ userId: user.id, isAdmin: false, node: '1~pve', vmid: 101, host: '10.10.10.10', port: 22 });
      assert.equal(inVlan.host, '10.10.10.10');
      assert.equal(inVlan.adminOverride, false);
      assert.deepEqual(inVlan.resolvedAddresses, ['10.10.10.10']);

      // An address outside every assigned VLAN still fails closed.
      await assert.rejects(
        () => authorizeSshTarget({ userId: user.id, isAdmin: false, node: '1~pve', vmid: 101, host: '10.99.99.9', port: 22 }),
        /outside the VM addresses or networks assigned to you/,
      );
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
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
  }
});
