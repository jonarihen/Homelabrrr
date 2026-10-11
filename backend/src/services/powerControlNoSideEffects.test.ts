import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type https from 'node:https';
import {
  createIloTransport, createRuntimePatchTransport, readRuntimeState, setRuntimeMode, type IloConfig,
} from './iloAdapter.ts';
import { PowerController, type ClaimOutcome, type ControlRepository, type ControlSnapshot } from './powerController.ts';
import { weekdayPreset } from './powerPolicy.ts';

// Spy on every HTTP request the real adapter makes through the controller,
// under success and failure. The ONLY permitted write is one PATCH of
// PowerRegulatorMode on the discovered ComputerSystem: never a reset,
// power-cycle, BIOS/settings, watt-cap/PowerLimit, firmware or VM call.

const config: IloConfig = { host: '192.0.2.10', port: 443, username: 'fixture', password: 'fixture-secret', verifyTls: true };
const FORBIDDEN = /Actions|Reset|Bios|Settings|PowerLimit|PowerCap|PowerMetrics|UpdateService|Firmware|SecureBoot|qemu|lxc|nodes\//i;

type Scenario = { patchStatus?: number; patchTimeout?: boolean; applies?: boolean; readFailure?: boolean; powerState?: string };

function fakeIlo(scenario: Scenario) {
  let mode = 'Min';
  const calls: { method: string; path: string; body?: string }[] = [];
  const resources = (): Record<string, any> => ({
    '/redfish/v1/': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' }, Managers: { '@odata.id': '/redfish/v1/Managers' } },
    '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
    '/redfish/v1/Systems/1': { UUID: 'fixture-uuid', PowerState: scenario.powerState ?? 'On', Oem: { Hpe: { PowerRegulatorMode: mode, PostState: 'FinishedPost' } } },
    '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] },
    '/redfish/v1/Chassis/1': { Power: { '@odata.id': '/redfish/v1/Chassis/1/Power' } },
    '/redfish/v1/Chassis/1/Power': { PowerControl: [{ PowerConsumedWatts: 180 }] },
    '/redfish/v1/Managers': { Members: [{ '@odata.id': '/redfish/v1/Managers/1' }] },
    '/redfish/v1/Managers/1': { Model: 'iLO 5', FirmwareVersion: 'fixture' },
  });
  const request = ((options: any, callback: (response: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => { req.emit('error', error); };
    req.end = (body?: string) => {
      calls.push({ method: options.method, path: options.path, body });
      queueMicrotask(() => {
        const response = new EventEmitter() as any;
        response.resume = () => {};
        if (options.method === 'PATCH') {
          if (scenario.patchTimeout) { if (scenario.applies) mode = JSON.parse(body!).Oem.Hpe.PowerRegulatorMode; req.emit('timeout'); return; }
          response.statusCode = scenario.patchStatus ?? 200;
          if (response.statusCode < 300 && scenario.applies !== false) mode = JSON.parse(body!).Oem.Hpe.PowerRegulatorMode;
          callback(response); response.emit('end'); return;
        }
        const value = resources()[options.path];
        response.statusCode = scenario.readFailure ? 503 : value ? 200 : 404;
        callback(response);
        if (value && !scenario.readFailure) response.emit('data', Buffer.from(JSON.stringify(value)));
        response.emit('end');
      });
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, calls };
}

function repository(): ControlRepository & { finished: ClaimOutcome[] } {
  const schedule = weekdayPreset(); schedule.enabled = true;
  let claimed: string | null = null;
  const snap: ControlSnapshot = {
    hardwareId: 1, configVersion: 1, policyVersion: 1, controlEnabled: true, automationEnabled: true, paused: false, driftHold: false,
    supportedModes: ['low', 'dynamic', 'high'], schedule,
    pricePolicy: { enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
      expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' }, cheap: { enabled: false, threshold: '', hysteresis: '' } },
    latch: null, manualOverride: null, lastVerifiedMode: null, lastAutomaticUpshiftAt: null, ilo: config,
  };
  const finished: ClaimOutcome[] = [];
  return {
    finished,
    load: async () => structuredClone(snap),
    claim: async (_s, token) => { if (claimed) return false; claimed = token; return true; },
    claimStillCurrent: async (_s, token) => claimed === token,
    finish: async (_id, _token, outcome) => { finished.push(outcome); claimed = null; },
    observe: async () => {},
    holdExternalDrift: async () => {},
  };
}

const scenarios: Array<[string, Scenario, string]> = [
  ['success', {}, 'verified'],
  ['PATCH rejected', { patchStatus: 500 }, 'unknown'],
  ['PATCH timeout after apply', { patchTimeout: true, applies: true }, 'verified'],
  ['PATCH timeout not applied', { patchTimeout: true, applies: false }, 'unknown'],
  ['accepted but readback mismatch', { applies: false }, 'unknown'],
  ['iLO read failure', { readFailure: true }, 'unavailable'],
  ['host powered off', { powerState: 'Off' }, 'unavailable'],
];

for (const [name, scenario, expected] of scenarios) {
  test(`only a PowerRegulatorMode PATCH can leave the controller (${name})`, async () => {
    const fake = fakeIlo(scenario);
    const deps = { request: fake.request, validateTarget: async () => '192.0.2.10' };
    const readTransport = await createIloTransport(config, deps);
    const patchTransport = await createRuntimePatchTransport(config, deps);
    const repo = repository();
    const controller = new PowerController({
      repository: repo, getApplicablePrice: async () => null,
      now: () => new Date('2026-10-12T16:00:00Z'), sleep: async () => {},
      readState: (cfg) => readRuntimeState(cfg, readTransport),
      writeMode: (cfg, target, _r, _p, guard, options) => setRuntimeMode(cfg, target, readTransport, patchTransport, guard, options),
    });
    const result = await controller.reconcile(1);
    assert.equal(result.status, expected);
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    assert.ok(writes.length <= 1, 'at most one write per reconcile');
    for (const call of fake.calls) {
      assert.doesNotMatch(call.path, FORBIDDEN, `${call.method} ${call.path}`);
      assert.ok(call.method === 'GET' || call.method === 'PATCH', call.method);
    }
    for (const write of writes) {
      assert.equal(write.method, 'PATCH');
      assert.equal(write.path, '/redfish/v1/Systems/1');
      assert.deepEqual(JSON.parse(write.body!), { Oem: { Hpe: { PowerRegulatorMode: 'Max' } } });
    }
    if (['iLO read failure', 'host powered off'].includes(name)) assert.equal(writes.length, 0);
  });
}

// The control modules must not be able to reach Proxmox, VM lifecycle,
// the VM scheduler or any other iLO write primitive, even indirectly.
test('power control import graph cannot reach Proxmox, VM lifecycle or another hardware writer', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = ['./powerController.ts', './powerControlStore.ts', './powerControlWorker.ts', '../routes/powerControl.ts'].map((p) => resolve(here, p));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.{1,2}\/[^']+\.(?:ts|js))'/g)) stack.push(resolve(dirname(file), match[1]));
  }
  const reached = [...seen].map((file) => file.replace(/^.*\/src\//, ''));
  for (const banned of ['scheduler.ts', 'routes/vms.ts', 'utils/vmOps.ts', 'fortigate.ts', 'services/hardwareTelemetry.ts']) {
    assert.ok(!reached.includes(banned), `power control reaches ${banned}`);
  }
  // The only path to proxmox.ts is the notification helper's read-only
  // host-status lookup; no power module imports Proxmox itself.
  for (const file of seen) {
    const source = readFileSync(file, 'utf8');
    const proxmoxImport = /import\s*\{([^}]*)\}\s*from\s*'\.{1,2}\/(?:\.\.\/)*proxmox\.ts'/.exec(source);
    if (!proxmoxImport) continue;
    assert.ok(file.endsWith('utils/notify.ts'), `${file} imports proxmox.ts`);
    assert.deepEqual(proxmoxImport[1].split(',').map((name) => name.trim()).filter(Boolean).sort(), ['getHostStatus', 'getHosts']);
  }
  for (const file of seen) {
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('iloAdapter.ts')) continue;
    assert.doesNotMatch(source, /ComputerSystem\.Reset|PowerLimit|\/Bios\b|createRuntimePatchTransport\(/, file);
  }
  const writers = [...seen].filter((file) => /\bsetRuntimeMode\b/.test(readFileSync(file, 'utf8')) && !file.endsWith('iloAdapter.ts'));
  assert.deepEqual(writers.map((file) => file.replace(/^.*\/src\//, '')), ['services/powerController.ts']);
});
