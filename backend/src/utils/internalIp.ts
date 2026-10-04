// Internal/reserved IPv4 ranges shared by the SSRF URL guard and the website
// DNS validation. See utils/urlGuard.ts for the reasoning: these blocks are
// refused as proxied destinations / download sources.

function secondOctetRange(b, lo, hi): boolean {
  return b >= lo && b <= hi;
}

export function isInternalIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;

  const isCgnat = a === 100 && secondOctetRange(b, 64, 127); // 100.64/10
  const isLinkLocal = a === 169 && b === 254; // link-local / metadata
  const isRfc1918B = a === 172 && secondOctetRange(b, 16, 31);
  const isRfc1918C = a === 192 && b === 168;
  const isBenchmarking = a === 198 && (b === 18 || b === 19); // 198.18/15

  const isThisNetwork = a === 0;
  const isRfc1918A = a === 10;
  const isLoopback = a === 127;
  const isMulticastOrReserved = a >= 224;

  const isInternal = [
    isThisNetwork,
    isRfc1918A,
    isLoopback,
    isCgnat,
    isLinkLocal,
    isRfc1918B,
    isRfc1918C,
    isBenchmarking,
    isMulticastOrReserved,
  ].some(Boolean);

  return isInternal;
}

export function isInternalIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped — dotted (::ffff:10.0.0.1) or the URL-normalized hex-group
  // form (::ffff:a00:1); check the embedded IPv4 against the v4 ranges.
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isInternalIPv4(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isInternalIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7 (ULA), fe80::/10 (link-local), fec0::/10 (deprecated site-local)
  return /^(fc|fd|fe[89ab]|fe[c-f])/.test(lower);
}
