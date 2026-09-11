import { isIP } from 'net';
import dns from 'dns/promises';
import { isReservedAddress } from './ipReserved.ts';

// Blocks cloud-image download URLs that resolve to internal/reserved addresses
// (blind-SSRF hardening — the Proxmox host fetches the URL server-side, so a
// crafted URL could otherwise probe loopback, RFC1918 or the cloud metadata
// endpoint 169.254.169.254). Best-effort: the PVE host re-resolves the name
// itself, so DNS rebinding is out of scope; this stops the straightforward
// cases. Homelabs with an internal image mirror can opt out via
// ALLOW_INTERNAL_IMAGE_URLS=true.

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

  if (addresses.length === 0 || addresses.some(isReservedAddress)) {
    throw new Error(
      'URL resolves to an internal/reserved address. Set ALLOW_INTERNAL_IMAGE_URLS=true to allow internal image sources.'
    );
  }
}
