import test from 'node:test';
import assert from 'node:assert/strict';
import { IloError, setRuntimeMode, type IloTransport, type RuntimePatchTransport } from './iloAdapter.ts';

const config = { host: 'ilo.example.test', port: 443, username: 'reader', password: 'fixture-only', verifyTls: true };

const fast = { sleep: async () => {} };

function fixture(oem: 'Hp' | 'Hpe', initial: string, system: Record<string, unknown> = { PowerState: 'On' }) {
  let actual = initial;
  const paths: string[] = [];
  const patches: Array<{ path: string; oem: string; value: string; etag?: string | null }> = [];
  const read: IloTransport = async (path) => {
    paths.push(path);
    const values: Record<string, any> = {
      '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/42' }] },
      '/redfish/v1/Systems/42': { ...system, Oem: { [oem]: { PowerRegulatorMode: actual, ...(system.PostState ? { PostState: system.PostState } : {}) } } },
    };
    if (!values[path]) throw new Error(`Unexpected hardware read: ${path}`);
    return values[path];
  };
  const patch: RuntimePatchTransport = async (path, vendor, value, etag) => {
    patches.push({ path, oem: vendor, value, ...(etag ? { etag } : {}) });
    actual = value;
  };
  return { read, patch, paths, patches };
}

for (const oem of ['Hp', 'Hpe'] as const) {
  test(`${oem} runtime mode PATCH uses only discovered ComputerSystem property and verifies readback`, async () => {
    const fake = fixture(oem, 'Min');
    const result = await setRuntimeMode(config, 'high', fake.read, fake.patch, undefined, fast);
    assert.equal(result.outcome, 'verified');
    assert.deepEqual(fake.patches, [{ path: '/redfish/v1/Systems/42', oem, value: 'Max' }]);
    assert.ok(fake.paths.every((path) => path.startsWith('/redfish/v1/')));
  });
}

test('already-correct mode avoids a write', async () => {
  const fake = fixture('Hpe', 'Dynamic');
  assert.equal((await setRuntimeMode(config, 'dynamic', fake.read, fake.patch)).outcome, 'already_set');
  assert.equal(fake.patches.length, 0);
});

test('OS Control and unsupported targets cannot produce hardware writes', async () => {
  const fake = fixture('Hp', 'OSControl');
  await assert.rejects(setRuntimeMode(config, 'low', fake.read, fake.patch), IloError);
  await assert.rejects(setRuntimeMode(config, 'os_control' as any, fake.read, fake.patch), IloError);
  assert.equal(fake.patches.length, 0);
});

test('timeout after a possibly accepted PATCH is unknown and never retried in the adapter', async () => {
  const fake = fixture('Hpe', 'Min');
  let attempts = 0;
  const patch: RuntimePatchTransport = async () => { attempts += 1; throw new IloError('timeout', 'fixture timeout'); };
  const result = await setRuntimeMode(config, 'high', fake.read, patch, undefined, fast);
  assert.equal(result.outcome, 'unknown');
  assert.equal(attempts, 1);
});

test('readback mismatch is unknown, not verified', async () => {
  const fake = fixture('Hpe', 'Min');
  const result = await setRuntimeMode(config, 'high', fake.read, async () => {}, undefined, fast);
  assert.equal(result.outcome, 'unknown');
});

test('powered-off, booting and unknown power states refuse writes before any PATCH', async () => {
  for (const system of [{ PowerState: 'Off' }, { PowerState: 'PoweringOn' }, { PowerState: 'On', PostState: 'InPost' }, {}]) {
    const fake = fixture('Hpe', 'Min', system);
    await assert.rejects(setRuntimeMode(config, 'high', fake.read, fake.patch, undefined, fast),
      (err: unknown) => err instanceof IloError && err.code === 'host_not_running');
    assert.equal(fake.patches.length, 0);
  }
});

test('a strong ComputerSystem ETag is sent as If-Match; weak tags are not', async () => {
  const strong = fixture('Hpe', 'Min', { PowerState: 'On', '@odata.etag': '"abc123"' });
  await setRuntimeMode(config, 'high', strong.read, strong.patch, undefined, fast);
  assert.equal(strong.patches[0].etag, '"abc123"');
  const weak = fixture('Hpe', 'Min', { PowerState: 'On', '@odata.etag': 'W/"abc123"' });
  await setRuntimeMode(config, 'high', weak.read, weak.patch, undefined, fast);
  assert.equal(weak.patches[0].etag, undefined);
});

test('bounded readback polls before reporting unknown and accepts a late apply', async () => {
  const fake = fixture('Hpe', 'Min');
  let reads = 0;
  const lateRead: IloTransport = async (path) => {
    const value = await fake.read(path);
    if (path === '/redfish/v1/Systems/42' && ++reads >= 3) value.Oem.Hpe.PowerRegulatorMode = 'Max';
    return value;
  };
  const sleeps: number[] = [];
  const result = await setRuntimeMode(config, 'high', lateRead, async () => {}, undefined, { sleep: async (ms) => { sleeps.push(ms); }, readbackDelayMs: 500 });
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(sleeps, [500]);
  const never = fixture('Hpe', 'Min');
  let neverReads = 0;
  const counting: IloTransport = async (path) => { if (path === '/redfish/v1/Systems/42') neverReads += 1; return never.read(path); };
  assert.equal((await setRuntimeMode(config, 'high', counting, async () => {}, undefined, { ...fast, readbackAttempts: 4 })).outcome, 'unknown');
  assert.equal(neverReads, 5); // one pre-write read plus exactly four bounded readbacks
});

test('a refusing pre-dispatch guard prevents the PATCH', async () => {
  const fake = fixture('Hp', 'Min');
  await assert.rejects(setRuntimeMode(config, 'high', fake.read, fake.patch, async () => false, fast),
    (err: unknown) => err instanceof IloError && err.code === 'policy_changed');
  assert.equal(fake.patches.length, 0);
});
