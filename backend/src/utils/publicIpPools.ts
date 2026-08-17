// Public IPv4 pool address maths: CIDR parsing, address expansion, and the plan
// that turns a pool definition into individual `public_ips` rows.
//
// Pure by design — no db handle, no network, no Express req/res. Callers pass
// the rows they already loaded in as plain arrays so this stays unit-testable.
//
// One rule deserves calling out because it is easy to get wrong: a routed
// public prefix is NOT a LAN. The first ("network") and last ("broadcast")
// addresses of a routed transit prefix are frequently usable, and a /31 has no
// network/broadcast at all. Which addresses the provider keeps for itself is a
// provider-specific fact, so expansion returns EVERY address in the prefix and
// the administrator marks the provider's addresses as `reserved` explicitly.
// We never guess.

// Lifecycle of a single public address.
export const PUBLIC_IP_STATES = ['available', 'reserved', 'assigned', 'disabled', 'error'];

// Lifecycle of an address→user/VM assignment. Only `pending` is reachable today:
// the FortiGate provisioning workflow that would drive the rest is a later phase.
export const ASSIGNMENT_STATUSES = [
  'pending', 'provisioning', 'active', 'degraded', 'deprovisioning', 'error',
];

// Guard rail for pool expansion. A /22 already means 1024 rows; anything larger
// is almost certainly a typo rather than an intent to enumerate the prefix.
export const MAX_POOL_EXPANSION = 1024;

/**
 * Canonical dotted-quad, or '' when the value is not a plain IPv4 literal.
 * Leading zeros are rejected rather than normalized — '010.0.0.1' is ambiguous
 * (octal in some resolvers) and must never silently alias to '10.0.0.1'.
 */
export function normalizeIpv4(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return '';
  const octets = raw.split('.');
  if (octets.some((o) => o.length > 1 && o.startsWith('0'))) return '';
  const parts = octets.map(Number);
  if (parts.some((n) => n > 255)) return '';
  return parts.join('.');
}

/** Dotted-quad → unsigned 32-bit integer, or null when the address is invalid. */
export function ipv4ToInt(value) {
  const address = normalizeIpv4(value);
  if (!address) return null;
  return address.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

/** Unsigned 32-bit integer → dotted-quad, or '' when out of range. */
export function intToIpv4(value) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) return '';
  return [16777216, 65536, 256, 1]
    .map((divisor) => Math.floor(value / divisor) % 256)
    .join('.');
}

/**
 * Parse `a.b.c.d/nn`. Returns the normalized network/broadcast bounds, or null.
 * A host address inside the prefix is accepted ('203.0.113.5/29' → the /29 it
 * belongs to) so administrators can paste whatever their provider gave them.
 */
export function parseCidr(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^([0-9.]+)\/(\d{1,2})$/);
  if (!match) return null;
  const base = ipv4ToInt(match[1]);
  const prefix = Number(match[2]);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const size = 2 ** (32 - prefix);
  const network = Math.floor(base / size) * size;
  const broadcast = network + size - 1;
  return {
    input: raw,
    prefix,
    size,
    network,
    broadcast,
    networkAddress: intToIpv4(network),
    broadcastAddress: intToIpv4(broadcast),
    cidr: `${intToIpv4(network)}/${prefix}`,
  };
}

/** Is `address` inside `cidr`? False for anything unparseable. */
export function cidrContains(cidr, address) {
  const parsed = parseCidr(cidr);
  const int = ipv4ToInt(address);
  if (!parsed || int === null) return false;
  return int >= parsed.network && int <= parsed.broadcast;
}

/**
 * Every address in `cidr`, first and last included (see the module header for
 * why). Returns `{ error, addresses }` — `error` is a human-readable string
 * suitable for a 400 response, `addresses` is empty when `error` is set.
 */
export function expandCidrAddresses(cidr, { max = MAX_POOL_EXPANSION } = {}) {
  const parsed = parseCidr(cidr);
  if (!parsed) return { error: `"${String(cidr ?? '').trim()}" is not a valid IPv4 CIDR`, addresses: [] };
  if (parsed.size > max) {
    return {
      error: `${parsed.cidr} contains ${parsed.size} addresses, more than the ${max} this pool may enumerate at once`,
      addresses: [],
    };
  }
  const addresses = [];
  for (let int = parsed.network; int <= parsed.broadcast; int += 1) {
    addresses.push(intToIpv4(int));
  }
  return { error: null, addresses, cidr: parsed };
}

// Reserved entries may be plain addresses or { address, reason } objects.
function reservedMap(reserved) {
  const map = new Map();
  for (const entry of reserved || []) {
    const address = normalizeIpv4(typeof entry === 'string' ? entry : entry?.address);
    if (!address) continue;
    const reason = typeof entry === 'string' ? '' : String(entry?.reason ?? entry?.reserved_reason ?? '');
    map.set(address, reason);
  }
  return map;
}

function addressSet(rows) {
  const set = new Set();
  for (const row of rows || []) {
    const address = normalizeIpv4(typeof row === 'string' ? row : row?.address);
    if (address) set.add(address);
  }
  return set;
}

/**
 * Turn an import request into the exact rows to insert.
 *
 *   { cidr }                       — enumerate the whole prefix
 *   { addresses: [...] }           — take exactly these addresses
 *   { cidr, addresses: [...] }     — these addresses, rejected if outside the prefix
 *   { reserved: [...] }            — mark these as `reserved` instead of `available`
 *   { existing: [...] }            — addresses already stored for the pool
 *
 * Returns `{ error, add, duplicates, invalid, outOfRange }`. Reserved addresses
 * are still recorded (an administrator needs to see the provider's gateway in
 * the pool) but land in state `reserved`, so `usablePoolAddresses` skips them.
 */
export function planPoolAddresses({
  cidr = '',
  addresses = [],
  reserved = [],
  existing = [],
  max = MAX_POOL_EXPANSION,
} = {}) {
  const result = { error: null, add: [], duplicates: [], invalid: [], outOfRange: [] };
  const explicit = (addresses || []).filter((a) => String(a ?? '').trim() !== '');
  const hasCidr = String(cidr ?? '').trim() !== '';

  let source = [];
  if (explicit.length > 0) {
    source = explicit;
  } else if (hasCidr) {
    const expanded = expandCidrAddresses(cidr, { max });
    if (expanded.error) return { ...result, error: expanded.error };
    source = expanded.addresses;
  } else {
    return { ...result, error: 'Provide a CIDR or an explicit list of addresses' };
  }

  const reservedByAddress = reservedMap(reserved);
  const known = addressSet(existing);
  const seen = new Set();

  for (const candidate of source) {
    const address = normalizeIpv4(candidate);
    if (!address) {
      result.invalid.push(String(candidate ?? '').trim());
      continue;
    }
    if (hasCidr && !cidrContains(cidr, address)) {
      result.outOfRange.push(address);
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    if (known.has(address)) {
      result.duplicates.push(address);
      continue;
    }
    const isReserved = reservedByAddress.has(address);
    result.add.push({
      address,
      state: isReserved ? 'reserved' : 'available',
      reserved_reason: isReserved ? reservedByAddress.get(address) : '',
    });
  }

  return result;
}

/** Addresses an administrator may still hand out (state `available` only). */
export function usablePoolAddresses(rows) {
  return (rows || [])
    .filter((row) => (row?.state || 'available') === 'available')
    .map((row) => normalizeIpv4(row?.address))
    .filter(Boolean);
}
