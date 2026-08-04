import { ipv4InCidr } from './ipPolicy.js';

export function sshAddressAllowed(address, { exactAddresses = [], networks = [] } = {}) {
  return exactAddresses.includes(address) || networks.some((cidr) => ipv4InCidr(address, cidr));
}

export function allowedResolvedSshAddresses(addresses, policy = {}) {
  if (!Array.isArray(addresses) || addresses.length === 0) return [];
  const unique = [...new Set(addresses)];
  const allowed = unique.filter((address) => sshAddressAllowed(address, policy));
  // A hostname with one allowed and one management address is unsafe: DNS can
  // choose either on the later connection. Fail the whole name closed.
  return allowed.length === unique.length ? allowed : [];
}
