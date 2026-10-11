import { isIP } from 'net';
import dns from 'dns/promises';

// Blocks cloud-image download URLs that resolve to internal/reserved addresses
// (blind-SSRF hardening — the Proxmox host fetches the URL server-side, so a
// crafted URL could otherwise probe loopback, RFC1918 or the cloud metadata
// endpoint 169.254.169.254). Best-effort: the PVE host re-resolves the name
// itself, so DNS rebinding is out of scope; this stops the straightforward
// cases. Homelabs with an internal image mirror can opt out via
// ALLOW_INTERNAL_IMAGE_URLS=true.

// One address classification shared by every outbound-target guard. Callers
// decide which classes they accept: public download URLs accept only `public`,
// while iLO management targets also accept private/shared ranges (management
// networks are expected to be private) but never loopback, link-local,
// metadata, multicast or reserved space.
export type AddressClass = 'invalid' | 'unspecified' | 'loopback' | 'link_local' | 'metadata'
  | 'multicast' | 'reserved' | 'private' | 'shared' | 'benchmark' | 'public';

function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'invalid';
  const [a, b, c, d] = parts;
  if (a === 0) return 'unspecified';                         // "this network"
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'metadata' : 'link_local';
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'metadata'; // Alibaba Cloud
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';     // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';                           // incl. broadcast
  return 'public';
}

// Expand any valid IPv6 text form (compressed, embedded dotted IPv4) into
// eight 16-bit groups so prefixes are compared numerically, not by string.
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = dotted[1].split('.').map(Number);
    if (v4.some((n) => !Number.isInteger(n) || n > 255)) return null;
    text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []).map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.some(Number.isNaN) ? null : groups;
}

function embeddedIPv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function classifyIPv6(ip: string): AddressClass {
  const g = ipv6Groups(ip);
  if (!g) return 'invalid';
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return 'unspecified';
  if (zeroPrefix(7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1), deprecated
  // IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
  // all reach an embedded IPv4 address: classify that address instead.
  if (zeroPrefix(5) && g[5] === 0xffff) return classifyIPv4(embeddedIPv4(g[6], g[7]));
  if (zeroPrefix(6)) return classifyIPv4(embeddedIPv4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyIPv4(embeddedIPv4(g[6], g[7]));
  if (g[0] === 0x2002) return classifyIPv4(embeddedIPv4(g[1], g[2]));
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return 'metadata'; // AWS
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link_local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'private';          // deprecated site-local
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';          // ULA fc00::/7
  return 'public';
}

export function classifyAddress(address: string): AddressClass {
  const version = isIP(address);
  if (version === 4) return classifyIPv4(address);
  if (version === 6) return classifyIPv6(address);
  return 'invalid'; // not a valid IP at all — refuse
}

function isInternalAddress(address: string): boolean {
  return classifyAddress(address) !== 'public';
}

// Management interfaces (iLO) legitimately live on private networks; these
// classes can never be a management target and would make it an SSRF probe.
const PROHIBITED_MANAGEMENT_CLASSES = new Set<AddressClass>(['invalid', 'unspecified', 'loopback', 'link_local', 'metadata', 'multicast', 'reserved']);
export function isProhibitedManagementAddress(address: string): boolean {
  return PROHIBITED_MANAGEMENT_CLASSES.has(classifyAddress(address));
}

/**
 * Resolve the URL's host and throw if any resolved address is internal.
 * No-op when ALLOW_INTERNAL_IMAGE_URLS=true.
 */
export async function assertPublicDownloadUrl(url: string): Promise<void> {
  if (process.env.ALLOW_INTERNAL_IMAGE_URLS === 'true') return;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      const results = await dns.lookup(host, { all: true, verbatim: true });
      addresses = results.map((r) => r.address);
    } catch {
      throw new Error(`Could not resolve host "${host}"`);
    }
  }

  if (addresses.length === 0 || addresses.some(isInternalAddress)) {
    throw new Error(
      'URL resolves to an internal/reserved address. Set ALLOW_INTERNAL_IMAGE_URLS=true to allow internal image sources.'
    );
  }
}
