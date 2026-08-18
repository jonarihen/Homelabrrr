import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { importDatabase } from './importSqlite.ts';
import { buildFixtureSqlite, FIXTURE } from './sqliteFixture.ts';
import {
  users,
  roles,
  vmSchedules,
  vmLeases,
  invites,
  webauthnCredentials,
  caddySites,
  pveHosts,
  firewalls,
  notificationWebhooks,
  sessions,
  auditLog,
  workflowRuns,
  firewallVlanSync,
  provisionedVms,
  publicIpAssignments,
} from '../db/schema/index.ts';

const silent = () => {};

test('one-shot SQLite import round-trips into PostgreSQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelabrrr-import-'));
  const sourcePath = join(dir, 'old-db.sqlite');
  buildFixtureSqlite(sourcePath);
  const tdb = await createTestDatabase();
  try {
    // The fixture carries a user whose role_id points at a missing role:
    // without --null-orphans the import must abort before writing anything.
    await assert.rejects(
      importDatabase({ source: sourcePath, target: tdb.url, log: silent }),
      /--null-orphans/
    );
    assert.equal((await tdb.db.select().from(users)).length, 0);

    const result = await importDatabase({
      source: sourcePath,
      target: tdb.url,
      nullOrphans: true,
      log: silent,
    });
    assert.equal(result.orphanRefsNulled, 1);
    assert.equal(result.copied.users, 3); // admin + operator + orphan
    assert.ok('sessions' in result.skipped);

    // Booleans became real booleans; the encrypted TOTP secret is byte-identical.
    const [operator] = await tdb.db.select().from(users).where(eq(users.username, 'operator'));
    assert.equal(operator.totp_enabled, true);
    assert.equal(operator.see_all_vms, true);
    assert.equal(operator.can_operate_all_vms, false);
    assert.equal(operator.can_provision, true);
    assert.equal(operator.totp_secret, FIXTURE.totpSecret);
    assert.equal(operator.max_cores, 8);

    // The valid role reference survived and resolves; the orphaned one is NULL.
    assert.ok(operator.role_id !== null);
    const [importerRole] = await tdb.db.select().from(roles).where(eq(roles.id, operator.role_id as number));
    assert.equal(importerRole.name, 'Importer');
    const [orphan] = await tdb.db.select().from(users).where(eq(users.username, FIXTURE.orphanUsername));
    assert.equal(orphan.role_id, null);

    // The bootstrap admin kept its bcrypt hash.
    const [admin] = await tdb.db.select().from(users).where(eq(users.username, FIXTURE.adminUsername));
    assert.equal(admin.is_admin, true);
    assert.ok(admin.password.startsWith('$2'));

    // Schedule: the two numeric exceptions stay numbers; epochs pass through.
    const [schedule] = await tdb.db.select().from(vmSchedules);
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.last_off, -1);
    assert.equal(schedule.days, 127);
    assert.equal(schedule.skip_until, FIXTURE.scheduleSkipUntil);
    assert.equal(schedule.last_action_at, FIXTURE.scheduleLastActionAt);

    // 'YYYY-MM-DD HH:MM:SS' lease expiry parsed as UTC.
    const [lease] = await tdb.db.select().from(vmLeases);
    assert.ok(lease.expires_at instanceof Date);
    assert.equal(lease.expires_at.getTime(), Date.parse(FIXTURE.leaseExpiresAt.replace(' ', 'T') + 'Z'));

    // caddy_sites: probe_at '' sentinel → NULL, steps '' → NULL.
    const [site] = await tdb.db.select().from(caddySites);
    assert.equal(site.probe_at, null);
    assert.equal(site.steps, null);
    assert.equal(site.probe_http_status, 200);

    // Invite preset JSON text became a jsonb object.
    const [invite] = await tdb.db.select().from(invites);
    assert.deepEqual(invite.preset, FIXTURE.invitePreset);

    // WebAuthn: transports array + BLOB public key round-trip.
    const [cred] = await tdb.db.select().from(webauthnCredentials);
    assert.deepEqual(cred.transports, FIXTURE.webauthnTransports);
    assert.ok(Buffer.isBuffer(cred.public_key));
    assert.ok(cred.public_key.equals(FIXTURE.webauthnPublicKey));

    // Remaining encrypted columns are byte-identical.
    const [host] = await tdb.db.select().from(pveHosts);
    assert.equal(host.token_secret, FIXTURE.pveTokenSecret);
    assert.equal(host.ssh_secret, '');
    const [firewall] = await tdb.db.select().from(firewalls);
    assert.equal(firewall.api_key, FIXTURE.firewallApiKey);
    assert.equal(firewall.verify_tls, false);
    const [webhook] = await tdb.db.select().from(notificationWebhooks);
    assert.equal(webhook.url, FIXTURE.webhookUrl);
    assert.deepEqual(webhook.event_types, FIXTURE.webhookEventTypes);

    // jsonb arrays and the new workflow_run_id FK made it across.
    const [run] = await tdb.db.select().from(workflowRuns);
    assert.deepEqual(run.log, FIXTURE.workflowRunLog);
    assert.deepEqual(run.artifacts, ['interface:lab100']);
    const [sync] = await tdb.db.select().from(firewallVlanSync);
    assert.deepEqual(sync.policy_ids, FIXTURE.policyIds);
    assert.equal(sync.workflow_run_id, run.id);

    // Provisioned VM: '' steps → NULL, cloud_image_id preserved (not an orphan).
    const [vm] = await tdb.db.select().from(provisionedVms);
    assert.equal(vm.steps, null);
    assert.ok(vm.cloud_image_id !== null);

    // Audit trail + public IP chain survived.
    assert.equal((await tdb.db.select().from(auditLog)).length, 1);
    const [assignment] = await tdb.db.select().from(publicIpAssignments);
    assert.equal(assignment.private_ip, '10.0.100.10');
    assert.equal(assignment.egress_enabled, true);

    // Sessions were not imported.
    assert.equal((await tdb.db.select().from(sessions)).length, 0);

    // Identity sequences were advanced: a fresh insert gets an id above every
    // imported one instead of colliding.
    const importedIds = (await tdb.db.select({ id: users.id }).from(users)).map((row) => row.id);
    const importedMax = Math.max(...importedIds);
    const [fresh] = await tdb.db
      .insert(users)
      .values({ username: 'post-import-user', password: '$2b$10$freshfreshfreshfreshfreshfreshfreshfreshfreshfreshfres' })
      .returning({ id: users.id });
    assert.ok(fresh.id > importedMax, `expected new id ${fresh.id} > imported max ${importedMax}`);
  } finally {
    await tdb.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});
