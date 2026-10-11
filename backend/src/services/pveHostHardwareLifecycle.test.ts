import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { pveHosts } from '../db/schema/index.ts';

// Separate file: db/client.ts binds DATABASE_URL once per process.

test('decommissioned iLO connections are detached on host deletion; active ones block it', async () => {
  const t = await createTestDatabase();
  process.env.DATABASE_URL = t.url;
  const { deletePveHost, pveHostDependencies } = await import('./pveHostLifecycle.ts');
  const { hardwareConnections, hardwareEnergyIntervals, hardwarePowerSamples } = await import('../db/schema/index.ts');
  const { eq } = await import('drizzle-orm');
  try {
    await t.db.insert(pveHosts).values({ name: 'anchor', host: 'anchor.invalid', token_id: 'id', token_secret: 'secret' });
    const [host] = await t.db.insert(pveHosts).values({ name: 'retired', host: 'retired.invalid', token_id: 'id', token_secret: 'secret' }).returning({ id: pveHosts.id });
    const [plain] = await t.db.insert(pveHosts).values({ name: 'no-ilo', host: 'plain.invalid', token_id: 'id', token_secret: 'secret' }).returning({ id: pveHosts.id });
    const [active] = await t.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~node-a`, target_host: 'ilo-a.invalid', username: 'reader', secret: 'enc', system_uuid: 'uuid-a' }).returning();
    await t.db.insert(hardwarePowerSamples).values({ hardware_id: active.id, node_ref: active.node_ref, observed_at: new Date('2026-10-01T10:00:00Z'), watts: '250', mode: 'dynamic', origin: 'fixture' });
    await t.db.insert(hardwareEnergyIntervals).values({ hardware_id: active.id, start_utc: new Date('2026-10-01T10:00:00Z'), end_utc: new Date('2026-10-01T10:15:00Z'), kwh: '0.062500000', covered_seconds: 900, expected_seconds: 900, quality: 'integrated_complete', method_version: 'trapezoid_v1' });

    const blocked = await pveHostDependencies(host.id);
    assert.deepEqual(blocked.dependencies.map((d) => d.label), ['active hardware connections']);
    await assert.rejects(() => deletePveHost(host.id), (error: { code?: string }) => error.code === 'PVE_HOST_HAS_DEPENDENCIES');

    // Decommission (as the hardware route does): wipe the secret, keep identity.
    await t.db.update(hardwareConnections).set({ lifecycle_state: 'decommissioned', secret: '', collection_enabled: false, control_enabled: false }).where(eq(hardwareConnections.id, active.id));
    assert.equal((await pveHostDependencies(host.id)).total, 0);
    assert.equal(await deletePveHost(host.id), 1);

    const [archived] = await t.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, active.id));
    assert.equal(archived.pve_host_id, null);
    assert.equal(archived.node_ref, `${host.id}~node-a`, 'historical node snapshot is kept');
    assert.equal(archived.system_uuid, 'uuid-a');
    assert.equal((await t.db.select().from(hardwarePowerSamples).where(eq(hardwarePowerSamples.hardware_id, active.id))).length, 1);
    assert.equal((await t.db.select().from(hardwareEnergyIntervals).where(eq(hardwareEnergyIntervals.hardware_id, active.id))).length, 1);

    // An active connection can never lose its host.
    await assert.rejects(t.db.insert(hardwareConnections).values({ pve_host_id: null, node_ref: '9~x', target_host: 'x.invalid', username: 'r', secret: 'enc' }));
    // A host that never had iLO is unaffected.
    assert.equal((await pveHostDependencies(plain.id)).total, 0);
    assert.equal(await deletePveHost(plain.id), 1);
  } finally {
    await t.drop();
  }
});
