import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHardware, IloError, normalizeMode, validateManagementTarget } from './iloAdapter.ts';

const config = { host: 'ilo.example.test', port: 443, username: 'reader', password: 'fixture-only', verifyTls: true };

for (const [oem, generation] of [['Hp', 'ilo4'], ['Hpe', 'ilo5']] as const) {
  test(`${generation} discovers linked resources without changing hardware`, async () => {
    const paths: string[] = [];
    const fixture: Record<string, any> = {
      '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' }, Managers: { '@odata.id': '/redfish/v1/Managers' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/42' }] },
      '/redfish/v1/Systems/42': { UUID: 'hardware-uuid', SerialNumber: 'fixture-serial', Model: 'DL380', Oem: { [oem]: { PowerRegulatorMode: 'Dynamic' } } },
      '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/7' }] },
      '/redfish/v1/Chassis/7': { Power: { '@odata.id': '/redfish/v1/Chassis/7/Power' } },
      '/redfish/v1/Chassis/7/Power': { PowerControl: [{ PowerConsumedWatts: 172, PowerCapacityWatts: 800 }] },
      '/redfish/v1/Managers': { Members: [{ '@odata.id': '/redfish/v1/Managers/BMC' }] },
      '/redfish/v1/Managers/BMC': { FirmwareVersion: 'fixture-firmware', Model: `iLO ${generation === 'ilo4' ? '4' : '5'}` },
    };
    const result = await discoverHardware(config, async (path) => { paths.push(path); assert.ok(fixture[path], path); return fixture[path]; }, () => new Date('2026-10-08T12:00:00Z'));
    assert.equal(result.generation, generation);
    assert.equal(result.mode.value, 'dynamic');
    assert.equal(result.sample.watts, 172);
    assert.equal(result.capabilities.writePrivilege, 'unverified');
    assert.ok(paths.every((path) => path.startsWith('/redfish/v1/')));
  });
}

test('unknown and OS Control modes remain display-only; missing watts remain missing', async () => {
  assert.equal(normalizeMode('OSControl'), 'os_control');
  assert.equal(normalizeMode('unexpected'), 'unknown');
  const fixture: Record<string, any> = {
    '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' } },
    '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/X' }] },
    '/redfish/v1/Systems/X': { Oem: { Hpe: { PowerRegulatorMode: 'OSControl' } } },
  };
  const result = await discoverHardware(config, async (path) => fixture[path]);
  assert.equal(result.mode.value, 'os_control');
  assert.equal(result.sample.watts, null);
  assert.equal(result.capabilities.monitoring, 'unsupported');
});

test('management target allows private networks and rejects metadata/loopback', async () => {
  assert.equal(await validateManagementTarget('ilo.example.test', async () => [{ address: '192.168.1.10' }] as any), '192.168.1.10');
  for (const address of ['127.0.0.1', '169.254.169.254', '::1']) {
    await assert.rejects(validateManagementTarget(address), (err: unknown) => err instanceof IloError && err.code === 'invalid_target');
  }
});
