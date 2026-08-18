import { after } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vmAssignments } from '../db/schema/index.ts';

// vmAccess.ts imports the PG singleton (db/client.ts throws without
// DATABASE_URL) and — until permissions.ts is converted — transitively opens
// the legacy sqlite db.ts at import time. Both need their env set BEFORE the
// module loads, hence the dynamic import below.
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;

const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmaccess-sqlite-'));
process.env.DB_PATH = path.join(sqliteDir, 'db.sqlite');
process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.INITIAL_ADMIN_USERNAME = process.env.INITIAL_ADMIN_USERNAME || 'admin';
process.env.INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'test-only-password';

const {
  userCanAccessVm, userOwnsVm, vmOpContext, userCanPerformVmOp, userSeesAllVms,
} = await import('./vmAccess.ts');

// Ids deliberately avoid 1: the legacy sqlite bootstrap creates admin id 1,
// and userHasPermission still reads sqlite until permissions.ts converts —
// colliding ids would let that stale admin row shadow these PG users.
await testDb.db.insert(users).values([
  { id: 10, username: 'assignee', password: 'x' },
  { id: 11, username: 'db-admin', password: 'x', is_admin: true },
]);
await testDb.db.insert(vmAssignments).values([
  { user_id: 10, node: 'pve1', vmid: 100 }, // legacy bare node name
  { user_id: 10, node: '2~pve2', vmid: 200 }, // encoded host~node ref
]);

after(async () => {
  // Close the app singleton pool before dropping, so drop()'s WITH (FORCE)
  // doesn't have to terminate its connections out from under it.
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  await testDb.drop();
  fs.rmSync(sqliteDir, { recursive: true, force: true });
});

test('userOwnsVm matches assignments across nodeRef candidate spellings', async () => {
  // Bare row found by both bare and encoded lookups (legacy-row candidates).
  assert.equal(await userOwnsVm(10, 'pve1', 100), true);
  assert.equal(await userOwnsVm(10, '1~pve1', 100), true);
  // Encoded row found by the encoded lookup...
  assert.equal(await userOwnsVm(10, '2~pve2', 200), true);
  // ...but a bare lookup only tries the bare candidate — same as the old
  // per-candidate loop.
  assert.equal(await userOwnsVm(10, 'pve2', 200), false);
  // String vmid (route params) parses like before.
  assert.equal(await userOwnsVm(10, 'pve1', '100'), true);
});

test('userOwnsVm denies on wrong user, wrong vmid, and empty node', async () => {
  assert.equal(await userOwnsVm(999, 'pve1', 100), false);
  assert.equal(await userOwnsVm(10, 'pve1', 101), false);
  // Empty node → zero lookup candidates → deny without querying (inArray guard).
  assert.equal(await userOwnsVm(10, '', 100), false);
});

test('userCanAccessVm: admin bypass, assignment grant, default deny', async () => {
  assert.equal(await userCanAccessVm(999, 'pve1', 100, true), true);
  assert.equal(await userCanAccessVm(10, 'pve1', 100, false), true);
  assert.equal(await userCanAccessVm(10, 'pve1', 999, false), false);
});

test('vmOpContext short-circuits admins and resolves facts for the rest', async () => {
  assert.deepEqual(await vmOpContext(999, 'pve1', 100, true), { isAdmin: true });
  // A PG boolean is_admin row bypasses too (no === 1 anywhere).
  assert.deepEqual(await vmOpContext(11, 'pve1', 100, false), { isAdmin: true });
  assert.deepEqual(await vmOpContext(404, 'pve1', 100, false), { isAdmin: false });
  assert.deepEqual(await vmOpContext(10, 'pve1', 100, false), {
    isAdmin: false,
    isAssigned: true,
    seeAllVms: false,
    operateAllVms: false,
    canEditHardware: false,
  });
});

test('userCanPerformVmOp gates by tier through the resolved context', async () => {
  // 'own' tier: assignment grants it, absence denies it.
  assert.equal(await userCanPerformVmOp(10, 'pve1', 100, false, 'vm.delete'), true);
  assert.equal(await userCanPerformVmOp(10, 'pve1', 999, false, 'vm.delete'), false);
  // Unknown ops fail closed even for the assignee.
  assert.equal(await userCanPerformVmOp(10, 'pve1', 100, false, 'vm.nonsense'), false);
  // The hardware axis binds the assignee as well.
  assert.equal(await userCanPerformVmOp(10, 'pve1', 100, false, 'vm.hardware'), false);
  // Admin bypasses everything, unknown ops included.
  assert.equal(await userCanPerformVmOp(999, 'pve1', 100, true, 'vm.nonsense'), true);
});

test('userSeesAllVms: admin yes, plain assignee no', async () => {
  assert.equal(await userSeesAllVms(999, true), true);
  assert.equal(await userSeesAllVms(10, false), false);
});
