import test from 'node:test';
import assert from 'node:assert/strict';
import { IloError, setRuntimeMode, type IloTransport, type RuntimePatchTransport } from './iloAdapter.ts';

const config = { host: 'ilo.example.test', port: 443, username: 'reader', password: 'fixture-only', verifyTls: true };

function fixture(oem: 'Hp' | 'Hpe', initial: string) {
  let actual = initial;
  const paths: string[] = [];
  const patches: Array<{ path: string; oem: string; value: string }> = [];
  const read: IloTransport = async (path) => {
    paths.push(path);
    const values: Record<string, any> = {
      '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/42' }] },
      '/redfish/v1/Systems/42': { Oem: { [oem]: { PowerRegulatorMode: actual } } },
    };
    if (!values[path]) throw new Error(`Unexpected hardware read: ${path}`);
    return values[path];
  };
  const patch: RuntimePatchTransport = async (path, vendor, value) => {
    patches.push({ path, oem: vendor, value });
    actual = value;
  };
  return { read, patch, paths, patches };
}

for (const oem of ['Hp', 'Hpe'] as const) {
  test(`${oem} runtime mode PATCH uses only discovered ComputerSystem property and verifies readback`, async () => {
    const fake = fixture(oem, 'Min');
    const result = await setRuntimeMode(config, 'high', fake.read, fake.patch);
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
  const result = await setRuntimeMode(config, 'high', fake.read, patch);
  assert.equal(result.outcome, 'unknown');
  assert.equal(attempts, 1);
});

test('readback mismatch is unknown, not verified', async () => {
  const fake = fixture('Hpe', 'Min');
  const result = await setRuntimeMode(config, 'high', fake.read, async () => {});
  assert.equal(result.outcome, 'unknown');
});
