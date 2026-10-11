import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type https from 'node:https';
import { createIloTransport, discoverHardware } from './iloAdapter.ts';

// End-to-end proof over the real read transport: discovery is fed a fixture
// that advertises reset, BIOS and firmware-update links, and must still only
// issue body-less GETs against inventory/telemetry resources.
const config = { host: 'ilo.example.test', port: 443, username: 'fixture-reader', password: 'fixture-secret', verifyTls: true };
const FORBIDDEN = /Actions|Bios|UpdateService|FirmwareInventory|SecureBoot|Settings|Reset|AccountService|SessionService/i;

function fixtureFor(prefix: '/redfish/v1' | '/rest/v1', oem: 'Hp' | 'Hpe'): Record<string, any> {
  const l = (path: string) => (prefix === '/rest/v1' ? { href: `${prefix}${path}` } : { '@odata.id': `${prefix}${path}` });
  return {
    [`${prefix}/`]: { Systems: l('/Systems'), Chassis: l('/Chassis'), Managers: l('/Managers'),
      UpdateService: l('/UpdateService'), AccountService: l('/AccountService'), SessionService: l('/SessionService') },
    [`${prefix}/Systems`]: { Members: [l('/Systems/1')] },
    [`${prefix}/Systems/1`]: { UUID: 'fixture-uuid', Model: 'ProLiant DL380', Bios: l('/Systems/1/Bios'),
      Actions: { '#ComputerSystem.Reset': { target: `${prefix}/Systems/1/Actions/ComputerSystem.Reset` } },
      Oem: { [oem]: { PowerRegulatorMode: 'Max', Actions: { [`#${oem}ComputerSystemExt.PowerButton`]: { target: `${prefix}/Systems/1/Actions/Oem/PowerButton` } } } } },
    [`${prefix}/Chassis`]: { Members: [l('/Chassis/1')] },
    [`${prefix}/Chassis/1`]: { Power: l('/Chassis/1/Power'), Thermal: l('/Chassis/1/Thermal'), Actions: { '#Chassis.Reset': { target: `${prefix}/Chassis/1/Actions/Chassis.Reset` } } },
    [`${prefix}/Chassis/1/Power`]: { PowerControl: [{ PowerConsumedWatts: 210, PowerLimit: { LimitInWatts: null } }], PowerSupplies: [], Redundancy: [] },
    [`${prefix}/Chassis/1/Thermal`]: { Temperatures: [], Fans: [] },
    [`${prefix}/Managers`]: { Members: [l('/Managers/1')] },
    [`${prefix}/Managers/1`]: { Model: oem === 'Hp' ? 'iLO 4' : 'iLO 5', FirmwareVersion: 'fixture', Actions: { '#Manager.Reset': { target: `${prefix}/Managers/1/Actions/Manager.Reset` } } },
  };
}

function recordingNetwork(fixture: Record<string, any>) {
  const calls: { method: string; path: string; written: unknown[] }[] = [];
  const request = ((options: any, callback: (response: any) => void) => {
    const req = new EventEmitter() as any;
    const written: unknown[] = [];
    req.write = (chunk: unknown) => { written.push(chunk); return true; };
    req.destroy = (error: Error) => { req.emit('error', error); };
    req.end = (body?: unknown) => {
      if (body !== undefined) written.push(body);
      calls.push({ method: options.method, path: options.path, written });
      queueMicrotask(() => {
        const response = new EventEmitter() as any;
        const body = fixture[options.path];
        response.statusCode = body ? 200 : 404;
        response.resume = () => {};
        callback(response);
        if (body) response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, calls };
}

for (const [prefix, oem] of [['/redfish/v1', 'Hpe'], ['/redfish/v1', 'Hp'], ['/rest/v1', 'Hp']] as const) {
  test(`discovery over ${prefix} (${oem}) issues only body-less GETs and never follows control links`, async () => {
    const fake = recordingNetwork(fixtureFor(prefix, oem));
    const transport = await createIloTransport(config, { request: fake.request, validateTarget: async () => '192.168.40.10' });
    const result = await discoverHardware(config, transport);
    assert.equal(result.sample.watts, 210);
    assert.equal(result.mode.value, 'high');
    assert.ok(fake.calls.length > 0);
    for (const call of fake.calls) {
      assert.equal(call.method, 'GET', call.path);
      assert.deepEqual(call.written, [], `${call.path} carried a body`);
      assert.equal(FORBIDDEN.test(call.path), false, `discovery touched ${call.path}`);
    }
  });
}

// Static proof: the collector and the hardware router (and everything they
// import, transitively) never reference the runtime write primitives. Only
// the single power controller may reach them.
const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_PRIMITIVE = /\b(setRuntimeMode|createRuntimePatchTransport|RuntimePatchTransport)\b/;

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(srcRoot, entry)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+\.ts)['"]|import\(\s*['"](\.{1,2}\/[^'"]+\.ts)['"]\s*\)/g)) {
      queue.push(resolve(dirname(file), match[1] || match[2]));
    }
  }
  return seen;
}

test('collector and hardware routes cannot reach a runtime power write', () => {
  for (const entry of ['services/hardwareTelemetry.ts', 'routes/hardware.ts']) {
    const graph = importGraph(entry);
    assert.ok(graph.has(resolve(srcRoot, 'services/iloAdapter.ts')), `${entry} uses the read adapter`);
    for (const file of graph) {
      const rel = relative(srcRoot, file);
      assert.notEqual(rel, 'services/powerController.ts', `${entry} imports the power controller`);
      assert.notEqual(rel, 'services/powerControlWorker.ts', `${entry} imports the power worker`);
      if (rel === 'services/iloAdapter.ts') continue; // defines, but the graph never calls, the primitives
      assert.equal(WRITE_PRIMITIVE.test(readFileSync(file, 'utf8')), false, `${rel} (reached from ${entry}) references a write primitive`);
    }
  }
});

test('only the iLO adapter and the single power controller reference write primitives', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && WRITE_PRIMITIVE.test(readFileSync(path, 'utf8'))) offenders.push(relative(srcRoot, path));
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders.sort(), ['services/iloAdapter.ts', 'services/powerController.ts']);
});
