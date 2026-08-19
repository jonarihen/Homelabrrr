import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { roles, vlans } from '../db/schema/index.ts';

let testDb: TestDatabase;
let invites: typeof import('./invites.ts');
let closeDb: () => Promise<void>;

// invites.ts queries through the process-wide db singleton, so DATABASE_URL
// must point at the throwaway database BEFORE db/client.ts is first evaluated
// — hence the dynamic imports.
before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  invites = await import('./invites.ts');
  ({ closeDb } = await import('../db/client.ts'));
  await testDb.db.insert(roles).values({ id: 101, name: 'Operator' });
  await testDb.db.insert(vlans).values([
    { id: 11, name: 'lab', tag: 111 },
    { id: 12, name: 'dmz', tag: 112 },
  ]);
});

after(async () => {
  await closeDb();
  await testDb.drop();
});

// Unwrap a normalizeInvitePreset success result or fail the test.
function unwrap<T>(result: { preset: T } | { error: string }): T {
  if ('error' in result) throw new Error(`unexpected preset error: ${result.error}`);
  return result.preset;
}

test('invite tokens are URL-safe and only the sha256 hash is comparable', () => {
  const token = invites.generateInviteToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invites.hashInviteToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(invites.hashInviteToken(token), invites.hashInviteToken(invites.generateInviteToken()));
});

test('quota values parse to integer, null (unlimited), or undefined (invalid)', () => {
  assert.equal(invites.parseQuotaValue(null), null);
  assert.equal(invites.parseQuotaValue(undefined), null);
  assert.equal(invites.parseQuotaValue(''), null);
  assert.equal(invites.parseQuotaValue('4'), 4);
  assert.equal(invites.parseQuotaValue(0), 0);
  assert.equal(invites.parseQuotaValue('-1'), undefined);
  assert.equal(invites.parseQuotaValue('abc'), undefined);
});

test('invite lifecycle status is derived from Date columns', () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  assert.equal(invites.inviteStatus(null), 'invalid');
  assert.equal(invites.inviteStatus(undefined), 'invalid');
  assert.equal(invites.inviteStatus({ revoked_at: past, used_at: past }), 'revoked');
  assert.equal(invites.inviteStatus({ used_at: past }), 'used');
  assert.equal(invites.inviteStatus({ expires_at: past }), 'expired');
  assert.equal(invites.inviteStatus({ expires_at: future }), 'open');
  assert.equal(invites.inviteStatus({}), 'open');
});

test('non-privileged creators are constrained to a bare account preset', async () => {
  assert.deepEqual(await invites.normalizeInvitePreset({ isAdmin: true }),
    { error: 'Only admins can create invites for admin accounts' });
  assert.deepEqual(await invites.normalizeInvitePreset({ roleId: 101 }),
    { error: 'Only admins can attach a role to an invite' });
  assert.deepEqual(await invites.normalizeInvitePreset({ permissions: { can_provision: true } }),
    { error: 'Only admins can grant permissions through an invite' });
  assert.deepEqual(await invites.normalizeInvitePreset({ maxCores: 4 }),
    { error: 'Only admins can set quotas on an invite' });
  assert.deepEqual(await invites.normalizeInvitePreset({ vlanIds: [11] }),
    { error: 'Only admins can grant VLAN access through an invite' });
  const preset = unwrap(await invites.normalizeInvitePreset({}));
  assert.equal(preset.isAdmin, false);
  assert.equal(preset.roleId, null);
  assert.ok(invites.INVITE_PERMISSION_COLUMNS.every((k) => preset.permissions[k] === false));
  assert.deepEqual(preset.vlanIds, []);
});

test('privileged presets validate role and VLAN ids against the database', async () => {
  const opts = { allowAdmin: true, allowPrivileges: true };
  assert.deepEqual(await invites.normalizeInvitePreset({ roleId: 'abc' }, opts), { error: 'Invalid role' });
  assert.deepEqual(await invites.normalizeInvitePreset({ roleId: 999 }, opts), { error: 'Role not found' });
  assert.deepEqual(await invites.normalizeInvitePreset({ vlanIds: [11, 999] }, opts), { error: 'VLAN 999 not found' });
  assert.deepEqual(await invites.normalizeInvitePreset({ maxCores: 'nope' }, opts),
    { error: 'Quota values must be non-negative integers (empty = unlimited)' });

  const preset = unwrap(await invites.normalizeInvitePreset({
    isAdmin: true,
    roleId: '101',
    permissions: { can_provision: 1, not_a_permission: 1 },
    maxCores: '8',
    vlanIds: ['12', 11, 12, 'junk'],
  }, opts));
  assert.deepEqual(preset, {
    isAdmin: true,
    roleId: 101,
    // Only known permission keys survive, as real booleans; unknown keys drop.
    permissions: Object.fromEntries(invites.INVITE_PERMISSION_COLUMNS.map((k) => [k, k === 'can_provision'])),
    maxCores: 8,
    maxMemoryGb: null,
    maxStorageGb: null,
    vlanIds: [12, 11],
  });
});

test('summary resolves role and VLAN labels, tolerating pre-migration 1/0 flags', async () => {
  const summary = await invites.summarizeInvitePreset({
    isAdmin: 1,
    roleId: 101,
    permissions: { can_provision: 1, can_manage_users: true, can_manage_hosts: 0 },
    vlanIds: [12, 999, 11],
  });
  assert.deepEqual(summary, {
    isAdmin: true,
    role: { id: 101, name: 'Operator' },
    grantedPermissions: ['can_provision', 'can_manage_users'],
    quotas: { maxCores: null, maxMemoryGb: null, maxStorageGb: null },
    // Preset order preserved; vanished VLAN 999 silently dropped.
    vlans: [
      { id: 12, name: 'dmz', tag: 112 },
      { id: 11, name: 'lab', tag: 111 },
    ],
  });
  assert.deepEqual(await invites.summarizeInvitePreset(null), {
    isAdmin: false,
    role: null,
    grantedPermissions: [],
    quotas: { maxCores: null, maxMemoryGb: null, maxStorageGb: null },
    vlans: [],
  });
  const missingRole = await invites.summarizeInvitePreset({ roleId: 999 });
  assert.equal(missingRole.role, null);
});
