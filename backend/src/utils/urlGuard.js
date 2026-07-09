import { isIP } from 'net';
import dns from 'dns/promises';

// Blocks cloud-image download URLs that resolve to internal/reserved addresses
// (blind-SSRF hardening — the Proxmox host fetches the URL server-side, so a
// crafted URL could otherwise probe loopback, RFC1918 or the cloud metadata
// endpoint 169.254.169.254). Best-effort: the PVE host re-resolves the name
// itself, so DNS rebinding is out of scope; this stops the straightforward
// cases. Homelabs with an internal image mirror can opt out via
// ALLOW_INTERNAL_IMAGE_URLS=true.

function isInternalIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||                              // "this network"
    a === 10 ||                             // RFC1918
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT 100.64/10
    (a === 169 && b === 254) ||             // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
    (a === 192 && b === 168) ||             // RFC1918
    (a === 198 && (b === 18 || b === 19)) ||// benchmarking 198.18/15
    a >= 224                                // multicast + reserved + broadcast
  );
}

function isInternalIPv6(ip) {
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

function isInternalAddress(address) {
  const version = isIP(address);
  if (version === 4) return isInternalIPv4(address);
  if (version === 6) return isInternalIPv6(address);
  return true; // not a valid IP at all — refuse
}

/**
 * Resolve the URL's host and throw if any resolved address is internal.
 * No-op when ALLOW_INTERNAL_IMAGE_URLS=true.
 */
export async function assertPublicDownloadUrl(url) {
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
