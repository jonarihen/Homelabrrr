import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import express from 'express';
import request from 'supertest';
import { requestContext } from '../utils/logger.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

// The vms router imports proxmox.ts, whose insecure-upstream switch is read
// at module load; the fake PVE API below speaks TLS with a self-signed cert.
process.env.SECRET_ENCRYPTION_KEY = '44'.repeat(32);
process.env.ALLOW_INSECURE_UPSTREAM_TLS = 'true';
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;

const { default: vmsRouter } = await import('./vms.ts');
const { users, pveHosts, vmAssignments } = await import('../db/schema/index.ts');

// Long-lived self-signed certificate for the fake PVE API (verify_tls=false
// on the test host row makes rejectUnauthorized irrelevant).
const PVE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDpGXUATGPM9OWE
8bTbyq85nya9cTe6lqY6KCNeJTvfodkYqkscscMqUnUDV6nIOeHbyOudImLTrv/L
Wdlp+oSygJQHv25S5CeQNxSZOnMvHhbATerV5zDK/AWb/o1rtcRUdivPASvlVgdW
e1NDIE3EoPXL4zk3i8v1+kUjQT9CIQzeyQWutUHHopsqX0VGrf8S3mKkajHfbWXR
YvLN6385nrd4LJdP1U9SxbZ8DkM3l1qyAQa8g3hPZqg2uZnkxnKC5Pg/GI5J/m76
feef1rQQLVqd9CW96gz2BI/zhQNoWtSUPpSzLp+rMKUUOIYH1v8995sKX0QSNgFZ
bYLDAX5FAgMBAAECggEACJhMNKEccvO6vM6uxQXxtRW1t3mDvQkOAwn01+VWklXk
6+BnmZzCXf6hWuiyFXRw7Ao6Cda5PyXuP6DF//7hQrWz/58i4cKQ5OPrCgVaNuwM
mbWlyZJXPbzSNiDKNSUEIrsivWTFKhUkex9cABciVvQ6a/SqaO5qLF04jGa8/uKo
Ep/hhJEf8ZY7dmBiuSDFU9apLggWfevrGKB4Vf/32isE4/XCzkxt3YNRShEZsWF0
94/QDN2k7WVDaNKG2Cpms9GbNTpIKf/vaT4Tq5ynzNnn6pMtquMaHC9ZEzYw1Q2n
MdWye8qUCqcxgWmFMEqtQFzuSHkNj/DYsF5xtkLHMQKBgQD5Qw2BIs9zBp1Lki28
i/vVXkgG/7w9FA2oe/4z7EVEHLU+m5MqUcV6+fDlJxty3pPaEQDqHTGQhn1ofCFk
NufBuBhaOuVpfhUR0VTycp3DKsOHHn4Dpx+FU5umN+TE+NU/f9EIyi9x4DgKVITe
ZgMLV2aUJZQ3qPy+Aq+/YFw/fQKBgQDvZo5tCJ/+PrKsfawKjiZGqwBLXIHUlpK/
PFUEigGQv+lptvmkf3DMdfHrMWr5MF7WYk7rBjfrYes6vZ7dut/RIg9Nd8eTJ4mo
dtBnClWNvLYSzE9H9H3UrJWXaZn9JtmDH+F2Wlghvo0qjIfkP7C5QnLfOuKrRCep
3UTTd1uEaQKBgQDEonTgzolAgJNNrn+OIhAEfl/rxYrF1DACHe6nH1h1JwCD507t
L5zOKqYy3+rzb0rL2GYUSftzu+TqrCHbYMTrOUNcyuF3mxMb/zs4F9sEv5OH4DIg
x5JCJ3a+ZZF/IZ14fmh0uqs69lq/K3W1zFvScpxlek+2qQTZEF18Z5PeMQKBgH7l
+usa3kwTifxa5T33GZzt+cr4ry0z33eVEG/Gg4vp3l0WC4BBuVX30xNbb5vFIxA6
riBwfGW90sWhS7u22fruNfRXYKfFFngA+vkThkQKWuzd9cxrceOw096dsG17EWMr
HATzYLIKYqPCOCoqBJA/A8sGWK52AxxMWLZLF2y5AoGAIuKPOUbhIPxZaFmNSGg1
GzVu7TVOzQA6V6mgsV3PT4JscKEeGpGcj6ZCnsvvlkNI2g0b3YU1KSDQJngw99le
dp+RgMgVO17kiL5Od3LL9xIFeA3RK4Vz4zeFxUVc++jHmqpYHTV2YwK/2iA+a0FQ
a+3i5wMo/QzoSE1GaKiDjzY=
-----END PRIVATE KEY-----`;
const PVE_CERT = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUckD1xhekxO19M11Bdqnnjoaxkf4wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNZmFrZS1wdmUudGVzdDAgFw0yNjA5MTgwOTEwNDBaGA8y
MTI2MDgyNTA5MTA0MFowGDEWMBQGA1UEAwwNZmFrZS1wdmUudGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAOkZdQBMY8z05YTxtNvKrzmfJr1xN7qW
pjooI14lO9+h2RiqSxyxwypSdQNXqcg54dvI650iYtOu/8tZ2Wn6hLKAlAe/blLk
J5A3FJk6cy8eFsBN6tXnMMr8BZv+jWu1xFR2K88BK+VWB1Z7U0MgTcSg9cvjOTeL
y/X6RSNBP0IhDN7JBa61QceimypfRUat/xLeYqRqMd9tZdFi8s3rfzmet3gsl0/V
T1LFtnwOQzeXWrIBBryDeE9mqDa5meTGcoLk+D8Yjkn+bvp955/WtBAtWp30Jb3q
DPYEj/OFA2ha1JQ+lLMun6swpRQ4hgfW/z33mwpfRBI2AVltgsMBfkUCAwEAAaNv
MG0wHQYDVR0OBBYEFHFMIBKK947KWeXdXtl38gobwtVuMB8GA1UdIwQYMBaAFHFM
IBKK947KWeXdXtl38gobwtVuMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJ
bG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQCNCh4BpCIerSBwzSPY
YUu3eJw98f7KJDOM5js6ayAg7sqT7XKUnx2reol+Kgx2BaLnncNrq4n8cHCLQv3V
cNaGi1DuO1vAoNl/6d1gy8dKSnONzL/j8OQFW6K7rSy64WHucMR4ByHQdcHYKd+R
GMBnm8OOdrHb+kIq64l8Q9+vcGl9RhEDhnBCNlSkaLaYSfshOUegU/fIdftcz+XR
lHFOfpjZwny7yCbNfsaLqn0tXMunhRdNKv++JJHmXINmnnTZXnjGKjbygFjtqudJ
4IX+mJha+zfiAP5O2AlqZCY6856MbegDrICFQcZ4mFsOR0aZqdE3f3AQQIQpZj7o
X2oe
-----END CERTIFICATE-----`;

// qemu 101 fails, lxc 101 answers; both fail for 102; qemu 103 answers and
// its lxc fallback must never be consulted.
const STATUS_PLAN: Record<string, { code: number; data: Record<string, unknown> | null }> = {
  '/api2/json/nodes/pve1/qemu/101/status/current': { code: 500, data: null },
  '/api2/json/nodes/pve1/lxc/101/status/current': { code: 200, data: { status: 'running', name: 'ct-101', vmid: 101 } },
  '/api2/json/nodes/pve1/qemu/102/status/current': { code: 500, data: null },
  '/api2/json/nodes/pve1/lxc/102/status/current': { code: 500, data: null },
  '/api2/json/nodes/pve1/qemu/103/status/current': { code: 200, data: { status: 'stopped', name: 'vm-103', vmid: 103 } },
  '/api2/json/nodes/pve1/lxc/103/status/current': { code: 500, data: null },
};

const pveCalls: string[] = [];
const pveServer = https.createServer({ key: PVE_KEY, cert: PVE_CERT }, (req, res) => {
  const path = (req.url || '').split('?')[0];
  pveCalls.push(path);
  const plan = STATUS_PLAN[path];
  if (!plan) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: null }));
    return;
  }
  res.writeHead(plan.code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: plan.data }));
});
await new Promise<void>((resolve) => pveServer.listen(0, '127.0.0.1', () => resolve()));
const pvePort = (pveServer.address() as { port: number }).port;

const [userRow] = await testDb.db.insert(users).values([
  { username: 'vm-list-user', password: 'x' },
]).returning({ id: users.id });
const userId = userRow.id;

const [hostRow] = await testDb.db.insert(pveHosts).values({
  name: 'fake-pve',
  host: '127.0.0.1',
  port: pvePort,
  token_id: 'portal@pve!test-token',
  token_secret: 'test-token-secret',
  verify_tls: false,
}).returning({ id: pveHosts.id });
const nodeRef = `${hostRow.id}~pve1`;

await testDb.db.insert(vmAssignments).values([
  { user_id: userId, node: nodeRef, vmid: 101 },
  { user_id: userId, node: nodeRef, vmid: 102 },
  { user_id: userId, node: nodeRef, vmid: 103 },
]);

test.after(async () => {
  await new Promise<void>((resolve) => pveServer.close(() => resolve()));
  await testDb.drop();
});

function app() {
  const instance = express();
  instance.use(requestContext, express.json());
  instance.use((req, _res, next) => {
    req.session = { userId, username: 'vmuser', isAdmin: false };
    next();
  });
  instance.use('/api/vms', vmsRouter);
  return instance;
}

test('GET /vms falls back to LXC status and only reports error when both lookups fail', async () => {
  const response = await request(app()).get('/api/vms');
  assert.equal(response.status, 200);
  const byVmid = Object.fromEntries(response.body.map((vm: Record<string, unknown>) => [vm.vmid, vm]));

  const lxc = byVmid[101];
  assert.equal(lxc.type, 'lxc');
  assert.equal(lxc.status, 'running');
  assert.equal(lxc.name, 'ct-101');
  assert.equal(lxc.node, 'pve1');
  assert.equal(lxc.nodeRef, nodeRef);
  assert.equal(lxc.hostName, 'fake-pve');
  assert.equal(lxc.lease, null);

  const qemu = byVmid[103];
  assert.equal(qemu.type, 'qemu');
  assert.equal(qemu.status, 'stopped');
  assert.equal(qemu.name, 'vm-103');
  assert.equal(pveCalls.filter((p) => p.includes('/lxc/103/')).length, 0);

  const broken = byVmid[102];
  assert.equal(broken.status, 'error');
  assert.equal(broken.name, 'VM 102');
  assert.equal('type' in broken, false);
});
