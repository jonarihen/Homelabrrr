// Regression coverage for public IP ownership and permission decisions.
// Run with:  node --test src/utils/publicIpAccess.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USABLE_ASSIGNMENT_STATUSES,
  checkAssignmentDeletion,
  checkAssignmentRequest,
  checkPublicIpDeletion,
  checkPublicIpUsage,
  describeAssignmentProvisioning,
} from './publicIpAccess.ts';

const OWNER = 42;
const OTHER = 43;

const publicIp = (overrides = {}) => ({
  id: 7, pool_id: 1, firewall_id: 1, address: '203.0.113.10', state: 'assigned', ...overrides,
});
const pool = (overrides = {}) => ({ id: 1, name: 'NovaCloud Frankfurt', enabled: 1, ...overrides });
const assignment = (overrides = {}) => ({
  id: 5, public_ip_id: 7, user_id: OWNER, vmid: 101, private_ip: '10.10.7.10', status: 'pending', ...overrides,
});

// ─── Using a public IP for a port forward ───────────────────────────────────

test('the owner may publish on their own address to their own target', () => {
  assert.equal(checkPublicIpUsage({
    userId: OWNER,
    publicIp: publicIp(),
    pool: pool(),
    assignment: assignment(),
    target: { mappedIp: '10.10.7.10', vmid: 101 },
  }), null);
});

test('an unknown address is a 404, not a silent fallback to the WAN', () => {
  const denial = checkPublicIpUsage({ userId: OWNER, publicIp: null, target: { mappedIp: '10.10.7.10' } });
  assert.equal(denial.status, 404);
});

test('another user’s address is refused', () => {
  const denial = checkPublicIpUsage({
    userId: OTHER,
    publicIp: publicIp(),
    pool: pool(),
    assignment: assignment(),
    target: { mappedIp: '10.10.7.10', vmid: 101 },
  });
  assert.equal(denial.status, 403);
  assert.match(denial.error, /assigned to another user/);
});

test('an administrator may publish on any user’s address', () => {
  assert.equal(checkPublicIpUsage({
    isAdmin: true,
    userId: OTHER,
    publicIp: publicIp(),
    pool: pool(),
    assignment: assignment(),
    target: { mappedIp: '10.10.7.10', vmid: 101 },
  }), null);
});

test('the destination must be the address’s assigned target — for admins too', () => {
  for (const caller of [{ userId: OWNER }, { isAdmin: true, userId: OTHER }, { unrestricted: true, userId: OTHER }]) {
    const denial = checkPublicIpUsage({
      ...caller,
      publicIp: publicIp(),
      pool: pool(),
      assignment: assignment(),
      target: { mappedIp: '10.10.8.10', vmid: 101 },
    });
    assert.equal(denial.status, 403);
    assert.match(denial.error, /assigned to 10\.10\.7\.10/);
  }
});

test('a mismatched VM is refused even when the private IP happens to line up', () => {
  const denial = checkPublicIpUsage({
    userId: OWNER,
    publicIp: publicIp(),
    pool: pool(),
    assignment: assignment(),
    target: { mappedIp: '10.10.7.10', vmid: 999 },
  });
  assert.equal(denial.status, 403);
  assert.match(denial.error, /VM 101/);
});

test('an unassigned address cannot be published on', () => {
  const denial = checkPublicIpUsage({
    userId: OWNER, publicIp: publicIp({ state: 'available' }), pool: pool(), assignment: null,
    target: { mappedIp: '10.10.7.10' },
  });
  assert.equal(denial.status, 409);
  assert.match(denial.error, /not assigned/);
});

test('disabled addresses and disabled pools fail closed', () => {
  assert.equal(checkPublicIpUsage({
    userId: OWNER, publicIp: publicIp({ state: 'disabled' }), pool: pool(), assignment: assignment(),
    target: { mappedIp: '10.10.7.10' },
  }).status, 409);
  assert.equal(checkPublicIpUsage({
    userId: OWNER, publicIp: publicIp(), pool: pool({ enabled: 0 }), assignment: assignment(),
    target: { mappedIp: '10.10.7.10' },
  }).status, 409);
});

test('addresses being torn down or in error cannot back a new forward', () => {
  for (const status of ['deprovisioning', 'error']) {
    const denial = checkPublicIpUsage({
      userId: OWNER, publicIp: publicIp(), pool: pool(), assignment: assignment({ status }),
      target: { mappedIp: '10.10.7.10', vmid: 101 },
    });
    assert.equal(denial.status, 409, `expected ${status} to be refused`);
    assert.ok(!USABLE_ASSIGNMENT_STATUSES.has(status));
  }
});

test('a pending assignment is usable but never reported as provisioned', () => {
  assert.ok(USABLE_ASSIGNMENT_STATUSES.has('pending'));
  const described = describeAssignmentProvisioning('pending');
  assert.equal(described.provisioned, false);
  assert.match(described.note, /not implemented yet/);
  assert.equal(describeAssignmentProvisioning('active').provisioned, true);
  assert.equal(describeAssignmentProvisioning('active').note, '');
});

// ─── Creating an assignment ─────────────────────────────────────────────────

const request = (overrides = {}) => ({
  publicIp: publicIp({ state: 'available' }),
  pool: pool(),
  targetUserId: OWNER,
  vmOwnedByUser: true,
  privateIp: '10.10.7.10',
  vmIps: ['10.10.7.10'],
  userVlanCidrs: ['10.10.7.0/24'],
  existingForIp: null,
  existingEgress: null,
  egressEnabled: true,
  ...overrides,
});

test('a well-formed assignment is allowed', () => {
  assert.equal(checkAssignmentRequest(request()), null);
});

test('the VM must actually be assigned to the target user', () => {
  const denial = checkAssignmentRequest(request({ vmOwnedByUser: false }));
  assert.equal(denial.status, 403);
  assert.match(denial.error, /assigned to the selected user/);
});

test('the private IP must belong to the VM or to one of the user’s VLANs', () => {
  // Neither a known VM address nor inside an assigned VLAN.
  const denial = checkAssignmentRequest(request({
    privateIp: '192.168.50.10', vmIps: ['10.10.7.10'], userVlanCidrs: ['10.10.7.0/24'],
  }));
  assert.equal(denial.status, 400);
  assert.match(denial.error, /does not belong/);

  // A VLAN the user holds is enough even when the portal has no SSH host on file.
  assert.equal(checkAssignmentRequest(request({
    privateIp: '10.10.7.55', vmIps: [], userVlanCidrs: ['10.10.7.0/24'],
  })), null);

  // …and so is a known VM address with no matching VLAN CIDR recorded.
  assert.equal(checkAssignmentRequest(request({
    privateIp: '10.10.7.10', vmIps: ['10.10.7.10'], userVlanCidrs: [],
  })), null);
});

test('a malformed private IP is rejected', () => {
  assert.equal(checkAssignmentRequest(request({ privateIp: 'not-an-ip' })).status, 400);
});

test('one active assignment per public IP', () => {
  const denial = checkAssignmentRequest(request({ existingForIp: { id: 9 } }));
  assert.equal(denial.status, 409);
  assert.match(denial.error, /already assigned/);
});

test('one active egress public IP per firewall and private IP', () => {
  const denial = checkAssignmentRequest(request({ existingEgress: { id: 9 } }));
  assert.equal(denial.status, 409);
  assert.match(denial.error, /only egress through one public IP/);
  // An assignment that does not claim egress may still be created.
  assert.equal(checkAssignmentRequest(request({ existingEgress: { id: 9 }, egressEnabled: false })), null);
});

test('reserved, disabled and errored addresses cannot be handed out', () => {
  for (const state of ['reserved', 'disabled', 'error']) {
    const denial = checkAssignmentRequest(request({ publicIp: publicIp({ state }) }));
    assert.equal(denial.status, 409, `expected ${state} to be refused`);
  }
});

test('a disabled pool cannot hand out addresses', () => {
  assert.equal(checkAssignmentRequest(request({ pool: pool({ enabled: 0 }) })).status, 409);
});

// ─── Releasing ──────────────────────────────────────────────────────────────

test('an assignment cannot be released while port forwards reference it', () => {
  const denial = checkAssignmentDeletion({ assignment: assignment(), portForwardCount: 2 });
  assert.equal(denial.status, 409);
  assert.match(denial.error, /2 port forwards still use this public IP/);
});

test('releasing is allowed once nothing references the address', () => {
  assert.equal(checkAssignmentDeletion({ assignment: assignment(), portForwardCount: 0 }), null);
});

test('explicit force cleanup overrides the dependency check', () => {
  assert.equal(checkAssignmentDeletion({ assignment: assignment(), portForwardCount: 2, force: true }), null);
});

test('an address row cannot be deleted while assigned or referenced', () => {
  assert.equal(checkPublicIpDeletion({ publicIp: publicIp(), assignmentCount: 1 }).status, 409);
  assert.equal(checkPublicIpDeletion({ publicIp: publicIp(), portForwardCount: 1 }).status, 409);
  assert.equal(checkPublicIpDeletion({ publicIp: publicIp(), assignmentCount: 0, portForwardCount: 0 }), null);
  assert.equal(checkPublicIpDeletion({ publicIp: null }).status, 404);
});
