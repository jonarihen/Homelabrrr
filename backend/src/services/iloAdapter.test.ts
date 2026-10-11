import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHardware, IloError, normalizeHardwareHealth, normalizeMode, physicalSystemIdentity, validateManagementTarget } from './iloAdapter.ts';

const config = { host: 'ilo.example.test', port: 443, username: 'reader', password: 'fixture-only', verifyTls: true };

for (const [oem, generation] of [['Hp', 'ilo4'], ['Hpe', 'ilo5']] as const) {
  test(`${generation} discovers linked resources without changing hardware`, async () => {
    const paths: string[] = [];
    const fixture: Record<string, any> = {
      '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' }, Managers: { '@odata.id': '/redfish/v1/Managers' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/42' }] },
      '/redfish/v1/Systems/42': { UUID: 'hardware-uuid', SerialNumber: 'fixture-serial', Model: 'DL380', Oem: { [oem]: { PowerRegulatorMode: 'Dynamic' } } },
      '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/7' }] },
      '/redfish/v1/Chassis/7': { Power: { '@odata.id': '/redfish/v1/Chassis/7/Power' }, Thermal: { '@odata.id': '/redfish/v1/Chassis/7/Thermal' } },
      '/redfish/v1/Chassis/7/Power': { PowerControl: [{ PowerConsumedWatts: 172, PowerCapacityWatts: 800 }], PowerSupplies: [{ Name: 'PSU 1', SerialNumber: 'private-serial', Status: { Health: 'OK', State: 'Enabled' } }], Redundancy: [{ Status: { Health: 'OK' } }] },
      '/redfish/v1/Chassis/7/Thermal': generation === 'ilo4'
        ? { Temperatures: [{ Name: 'Inlet', CurrentReading: 24, Units: 'Celsius', Status: { Health: 'OK' } }], Fans: [{ FanName: 'Fan 1', CurrentReading: 42, Units: 'Percent', Status: { Health: 'OK' } }] }
        : { Temperatures: [{ Name: 'Inlet', ReadingCelsius: 24, Status: { Health: 'OK' } }], Fans: [{ Name: 'Fan 1', Reading: 42, ReadingUnits: 'Percent', Status: { Health: 'OK' } }] },
      '/redfish/v1/Managers': { Members: [{ '@odata.id': '/redfish/v1/Managers/BMC' }] },
      '/redfish/v1/Managers/BMC': { FirmwareVersion: 'fixture-firmware', Model: `iLO ${generation === 'ilo4' ? '4' : '5'}` },
    };
    const result = await discoverHardware(config, async (path) => { paths.push(path); assert.ok(fixture[path], path); return fixture[path]; }, () => new Date('2026-10-08T12:00:00Z'));
    assert.equal(result.generation, generation);
    assert.equal(result.mode.value, 'dynamic');
    assert.equal(result.sample.watts, 172);
    assert.equal(result.capabilities.writePrivilege, 'unverified');
    assert.equal(result.capabilities.temperatures, 'supported');
    assert.equal(result.capabilities.fans, 'supported');
    assert.equal(result.capabilities.powerSupplies, 'supported');
    assert.equal(result.sample.health?.temperatures[0].celsius, 24);
    assert.equal(result.sample.health?.fans[0].value, 42);
    assert.equal(result.sample.health?.powerRedundancy?.health, 'OK');
    assert.equal(JSON.stringify(result.sample.health).includes('private-serial'), false);
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

test('missing optional thermal endpoint leaves power measurement intact', async () => {
  const fixture: Record<string, any> = {
    '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' } },
    '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/A' }] },
    '/redfish/v1/Systems/A': { UUID: 'stable', Oem: { Hpe: { PowerRegulatorMode: 'Dynamic' } } },
    '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/A' }] },
    '/redfish/v1/Chassis/A': { Power: { '@odata.id': '/redfish/v1/Chassis/A/Power' }, Thermal: { '@odata.id': '/redfish/v1/Chassis/A/Thermal' } },
    '/redfish/v1/Chassis/A/Power': { PowerControl: [{ PowerConsumedWatts: 0 }] },
  };
  const result = await discoverHardware(config, async (path) => { if (path.endsWith('/Thermal')) throw new IloError('missing_endpoint', 'missing'); return fixture[path]; });
  assert.equal(result.sample.watts, 0);
  assert.equal(result.capabilities.temperatures, 'unsupported');
  assert.equal(result.sample.health?.temperatures.length, 0);
  const timedOut = await discoverHardware(config, async (path) => { if (path.endsWith('/Thermal')) throw new IloError('timeout', 'temporary'); return fixture[path]; });
  assert.equal(timedOut.sample.watts, 0);
  assert.equal(timedOut.capabilities.temperatures, 'unavailable');
});

test('optional sensors are bounded, invalid readings stay absent, and raw metadata is excluded', () => {
  const normalized = normalizeHardwareHealth({ Temperatures: Array.from({ length: 70 }, (_, index) => ({ Name: `T${index}`, ReadingCelsius: index === 0 ? 999 : 0, Secret: 'vendor-secret' })),
    Fans: [{ Name: 'F', Reading: 200, ReadingUnits: 'Percent' }] },
  { PowerSupplies: [{ Name: 'PSU', SerialNumber: 'private-serial', Status: { Health: 'Critical' } }], Redundancy: [{ Status: { Health: 'Warning' } }] });
  assert.equal(normalized.temperatures.length, 64);
  assert.equal(normalized.temperatures[0].celsius, null);
  assert.equal(normalized.temperatures[1].celsius, 0);
  assert.equal(normalized.fans[0].value, null);
  assert.equal(normalized.powerSupplies[0].health, 'Critical');
  assert.equal(normalized.limited, true);
  assert.equal(JSON.stringify(normalized).includes('private-serial'), false);
  assert.equal(JSON.stringify(normalized).includes('vendor-secret'), false);
});

test('management target allows private networks and rejects metadata/loopback', async () => {
  assert.equal(await validateManagementTarget('ilo.example.test', async () => [{ address: '192.168.1.10' }] as any), '192.168.1.10');
  for (const address of ['127.0.0.1', '169.254.169.254', '::1']) {
    await assert.rejects(validateManagementTarget(address), (err: unknown) => err instanceof IloError && err.code === 'invalid_target');
  }
});

test('physical identity normalizes vendor formatting and never invents an identity', () => {
  assert.equal(physicalSystemIdentity({ uuid: '  ABCD-1234  ', serial: 'fallback' }), 'abcd-1234');
  assert.equal(physicalSystemIdentity({ uuid: null, serial: '  SGH123  ' }), 'serial:sgh123');
  assert.equal(physicalSystemIdentity({ uuid: ' ', serial: ' ' }), null);
});

test('iLO 4 falls back to linked legacy REST resources only when Redfish root is absent', async () => {
  const calls: string[] = [];
  const fixture: Record<string, any> = {
    '/rest/v1/': { Systems: { href: '/rest/v1/Systems' }, Chassis: { href: '/rest/v1/Chassis' } },
    '/rest/v1/Systems': { Members: [{ href: '/rest/v1/Systems/Gen9' }] },
    '/rest/v1/Systems/Gen9': { UUID: 'gen9', Oem: { Hp: { PowerRegulatorMode: 'Min' } } },
    '/rest/v1/Chassis': { Members: [{ href: '/rest/v1/Chassis/Rack' }] },
    '/rest/v1/Chassis/Rack': { Power: { href: '/rest/v1/Chassis/Rack/Power' } },
    '/rest/v1/Chassis/Rack/Power': { PowerConsumedWatts: 185, PowerCapacityWatts: 800 },
  };
  const discovered = await discoverHardware(config, async (path) => {
    calls.push(path);
    if (path === '/redfish/v1/') throw new IloError('missing_endpoint', 'fixture 404');
    return fixture[path];
  });
  assert.equal(discovered.generation, 'ilo4');
  assert.equal(discovered.mode.value, 'low');
  assert.equal(discovered.sample.watts, 185);
  assert.ok(calls.every((path) => path === '/redfish/v1/' || path.startsWith('/rest/v1/')));
});

test('authentication failure never triggers legacy fallback or follows off-host links', async () => {
  const calls: string[] = [];
  await assert.rejects(discoverHardware(config, async (path) => { calls.push(path); throw new IloError('authentication_failed', 'fixture denial'); }),
    (err: unknown) => err instanceof IloError && err.code === 'authentication_failed');
  assert.deepEqual(calls, ['/redfish/v1/']);
  await assert.rejects(discoverHardware(config, async (path) => {
    if (path === '/redfish/v1/') return { Systems: { '@odata.id': 'https://attacker.example/redfish/v1/Systems' } };
    throw new Error('off-host path was fetched');
  }), (err: unknown) => err instanceof IloError && err.code === 'missing_endpoint');
});
