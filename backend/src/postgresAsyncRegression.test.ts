import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ACTIONS } from './workflows/catalog.ts';

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('PostgreSQL-backed scheduler settings and audit writes are awaited', async () => {
  const index = await source('./index.ts');
  assert.match(index, /const settings = await getTagSyncSettings\(\);/);
  assert.match(index, /await logAuditEntry\(\{[\s\S]*?action: 'vm_tags_sync_scheduled'/);
});

test('operations routes await PostgreSQL maintenance work and status', async () => {
  const operations = await source('./routes/operations.ts');
  assert.match(operations, /database: await databaseMaintenanceStatus\(\)/);
  assert.match(operations, /const result = await runDatabaseMaintenance\(\{ batchSize \}\);/);
  assert.match(operations, /await logAudit\(req, 'database_backup_verified'/);
  assert.doesNotMatch(operations, /'database_maintenance_run', 'sqlite'/);
});

test('cloud-image target discovery resolves PostgreSQL host queries before use', async () => {
  const targets = await source('./utils/cloudImageTargets.ts');
  assert.match(targets, /const ownHost = await getHost\(ownHostId\);/);
  assert.match(targets, /for \(const h of await getHosts\(\)\)/);
});

test('workflow previews receive their firewall client after the TypeScript conversion', () => {
  const client = { vdom: 'lab' };
  const cases = [
    ['create_vlan_interface', { name: 'vlan1015', vlanId: 1015, parentInterface: 'fortilink', ip: '10.10.15.1', netmask: '255.255.255.0' }],
    ['create_address_object', { name: 'net', subnet: '10.10.15.0 255.255.255.0' }],
    ['create_service_object', { name: 'tcp-443', protocol: 'tcp', port: '443' }],
    ['create_policy', { name: 'policy', srcintf: 'vlan1015', dstintf: 'wan', srcaddr: 'all', dstaddr: 'all' }],
    ['create_static_route', { dst: '10.10.15.0', netmask: '255.255.255.0', gateway: '10.0.0.1', device: 'wan' }],
    ['create_dhcp_server', { interface: 'vlan1015', gateway: '10.10.15.1', netmask: '255.255.255.0', startIp: '10.10.15.10', endIp: '10.10.15.200' }],
    ['create_vip', { name: 'vip', extport: '443', mappedip: '10.10.15.10', mappedport: '443' }],
    ['assign_switch_port', { serial: 'switch', port: 'port1', vlanName: 'vlan1015' }],
    ['custom_api_call', { method: 'GET', path: 'monitor/system/status' }],
  ];

  for (const [action, params] of cases) {
    assert.doesNotThrow(() => ACTIONS[action].plan(params, {}, client), `${action} preview`);
  }
});

test('recorded-artifact teardown uses the execution context', async () => {
  const deleted = [];
  const result = await ACTIONS.teardown_recorded_artifacts.execute(
    { vdom: 'lab', deleteInterface: async (name) => { deleted.push(name); } },
    {},
    { artifacts: [{ type: 'interface', name: 'vlan1015' }] },
  );
  assert.deepEqual(deleted, ['vlan1015']);
  assert.equal(result.calls[0].summary, 'Deleted interface vlan1015');
});
