// Authorization and integrity decisions for public IP assignments.
//
// Every rule the issue lists as a constraint lives here as a pure predicate:
// the caller loads the rows it already has to load anyway and passes them in,
// and gets back either `null` (allowed) or `{ status, error }` to return
// verbatim. Same shape as utils/vlanAccess.js — no db handle, no req/res, so
// the decisions are unit-testable without a database.

import { normalizeIpv4, cidrContains } from './publicIpPools.ts';

// Statuses in which an assignment may back a port forward. `deprovisioning`
// and `error` are excluded: those are teardown/broken states and must fail
// closed rather than publish traffic onto an address that is being released.
//
// `pending` is included on purpose. FortiGate provisioning of the egress path
// (SNAT pool, policy route, kill switch) is a later phase; until it exists,
// every assignment sits at `pending` and excluding it would make the feature
// unreachable. Callers surface `describeAssignmentProvisioning()` so nobody
// mistakes a pending assignment for a provisioned one.
export const USABLE_ASSIGNMENT_STATUSES = new Set(['pending', 'provisioning', 'active', 'degraded']);

// Statuses in which the FortiGate side is believed to be fully in place.
export const PROVISIONED_ASSIGNMENT_STATUSES = new Set(['active']);

/**
 * Human-readable provisioning state for API responses, so a client can tell a
 * recorded assignment from a live one.
 */
export function describeAssignmentProvisioning(status) {
  const value = String(status || 'pending');
  if (PROVISIONED_ASSIGNMENT_STATUSES.has(value)) {
    return { status: value, provisioned: true, note: '' };
  }
  return {
    status: value,
    provisioned: false,
    note: 'FortiGate provisioning for public IP assignments is not implemented yet — '
      + 'the egress path (SNAT pool, policy route, kill switch) must still be configured out of band.',
  };
}

/**
 * May this request publish a port forward on `publicIp`?
 *
 *   publicIp   — the `public_ips` row, or null/undefined when unknown
 *   pool       — the owning `public_ip_pools` row
 *   assignment — the `public_ip_assignments` row for that address, or null
 *   target     — { mappedIp, vmid } the forward is actually pointing at
 *
 * The target check is NOT a permission check and applies to administrators too:
 * the VIP and the (future) SNAT identity are both bound to the assignment's
 * private IP, so publishing a different destination on that address would
 * produce a forward whose return path does not exist.
 */
export function checkPublicIpUsage({
  isAdmin = false,
  unrestricted = false,
  userId = null,
  publicIp = null,
  pool = null,
  assignment = null,
  target = {},
} = {}) {
  if (!publicIp) return { status: 404, error: 'Public IP not found on this firewall' };

  if (publicIp.state === 'disabled') {
    return { status: 409, error: `Public IP ${publicIp.address} is disabled` };
  }
  if (publicIp.state === 'error') {
    return { status: 409, error: `Public IP ${publicIp.address} is in an error state` };
  }
  if (pool && pool.enabled === 0) {
    return { status: 409, error: `Public IP pool "${pool.name}" is disabled` };
  }

  if (!assignment) {
    return { status: 409, error: `Public IP ${publicIp.address} is not assigned to a VM` };
  }
  if (!USABLE_ASSIGNMENT_STATUSES.has(String(assignment.status || ''))) {
    return {
      status: 409,
      error: `The assignment for ${publicIp.address} is ${assignment.status} and cannot be used right now`,
    };
  }

  const privileged = isAdmin || unrestricted;
  if (!privileged && String(assignment.user_id) !== String(userId)) {
    return { status: 403, error: 'That public IP is assigned to another user' };
  }

  const assignedIp = normalizeIpv4(assignment.private_ip);
  const wantedIp = normalizeIpv4(target?.mappedIp);
  if (!wantedIp || assignedIp !== wantedIp) {
    return {
      status: 403,
      error: `Public IP ${publicIp.address} is assigned to ${assignedIp || 'another target'}, `
        + `not ${wantedIp || 'the selected destination'}`,
    };
  }

  const assignedVmid = assignment.vmid === null || assignment.vmid === undefined ? null : String(assignment.vmid);
  const wantedVmid = target?.vmid === null || target?.vmid === undefined || target?.vmid === ''
    ? null
    : String(target.vmid);
  if (assignedVmid && wantedVmid && assignedVmid !== wantedVmid) {
    return {
      status: 403,
      error: `Public IP ${publicIp.address} is assigned to VM ${assignedVmid}, not VM ${wantedVmid}`,
    };
  }

  return null;
}

/**
 * May this address be assigned to this user / VM / private IP?
 *
 *   publicIp        — the `public_ips` row being handed out
 *   pool            — its `public_ip_pools` row
 *   targetUserId    — the user receiving it
 *   vmOwnedByUser   — result of a strict VM-assignment lookup for that user
 *   privateIp       — the private IPv4 the address should map to
 *   vmIps           — private IPs already known for that VM
 *   userVlanCidrs   — subnets of the VLANs assigned to that user
 *   existingForIp   — an assignment already holding this address, or null
 *   existingEgress  — an assignment already giving this firewall+private IP an
 *                     egress address, or null
 */
export function checkAssignmentRequest({
  publicIp = null,
  pool = null,
  targetUserId = null,
  vmOwnedByUser = false,
  privateIp = '',
  vmIps = [],
  userVlanCidrs = [],
  existingForIp = null,
  existingEgress = null,
  egressEnabled = true,
} = {}) {
  if (!publicIp) return { status: 404, error: 'Public IP not found' };
  if (!pool) return { status: 404, error: 'Public IP pool not found' };
  if (pool.enabled === 0) return { status: 409, error: `Public IP pool "${pool.name}" is disabled` };
  if (publicIp.state === 'disabled' || publicIp.state === 'error') {
    return { status: 409, error: `Public IP ${publicIp.address} is ${publicIp.state}` };
  }
  if (publicIp.state === 'reserved') {
    return { status: 409, error: `Public IP ${publicIp.address} is reserved and cannot be assigned` };
  }
  if (existingForIp) {
    return { status: 409, error: `Public IP ${publicIp.address} is already assigned` };
  }

  if (!targetUserId) return { status: 400, error: 'A target user is required' };
  if (!vmOwnedByUser) {
    return { status: 403, error: 'The selected VM must be assigned to the selected user' };
  }

  const address = normalizeIpv4(privateIp);
  if (!address) return { status: 400, error: 'A valid private IPv4 address is required' };

  const belongsToVm = (vmIps || []).some((ip) => normalizeIpv4(ip) === address);
  const belongsToVlan = (userVlanCidrs || []).some((cidr) => cidrContains(cidr, address));
  if (!belongsToVm && !belongsToVlan) {
    return {
      status: 400,
      error: `${address} does not belong to the selected VM or to a VLAN assigned to that user`,
    };
  }

  if (egressEnabled && existingEgress) {
    return {
      status: 409,
      error: `${address} already has a dedicated egress public IP on this firewall. `
        + 'A private address may only egress through one public IP.',
    };
  }

  return null;
}

/**
 * May this assignment be released? Port forwards published on the address keep
 * it pinned — releasing it underneath them would leave FortiGate VIPs pointing
 * at an address the portal no longer tracks.
 *
 * `force` mirrors the issue's explicit force-cleanup operation; it is a
 * parameter here so the rule is expressible, but the API does not offer it yet
 * because tearing the dependent forwards down needs the FortiGate workflow.
 */
export function checkAssignmentDeletion({ assignment = null, portForwardCount = 0, force = false } = {}) {
  if (!assignment) return { status: 404, error: 'Assignment not found' };
  const count = Number(portForwardCount) || 0;
  if (count > 0 && !force) {
    return {
      status: 409,
      error: `${count} port forward${count === 1 ? '' : 's'} still use this public IP. `
        + 'Delete them first, then release the address.',
    };
  }
  return null;
}

/** May this address row be deleted outright? Only when nothing references it. */
export function checkPublicIpDeletion({ publicIp = null, assignmentCount = 0, portForwardCount = 0 } = {}) {
  if (!publicIp) return { status: 404, error: 'Public IP not found' };
  if (Number(assignmentCount) > 0) {
    return { status: 409, error: `${publicIp.address} is assigned. Release the assignment first.` };
  }
  if (Number(portForwardCount) > 0) {
    return { status: 409, error: `${publicIp.address} is still referenced by port forwards` };
  }
  return null;
}
