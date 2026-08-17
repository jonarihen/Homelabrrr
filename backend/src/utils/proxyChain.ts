// X-Forwarded-For / TRUST_PROXY agreement analysis.
//
// Express resolves `req.ip` by walking X-Forwarded-For from the right, trusting
// exactly `trust proxy` hops. When TRUST_PROXY does not match the number of
// proxies actually in front of the backend, `req.ip` silently becomes a *proxy*
// address instead of the client's. Two things break, both invisibly:
//   * the per-(username, ip) login lockout collapses into a global one, so ten
//     bad passwords from anyone lock an account for everyone, and
//   * the audit log records the proxy's address for every action.
// Nothing about that state is observable from the outside, so this module turns
// one request's headers into a verdict the API, the UI and the runtime warning
// can all share.
//
// Pure: no Express `req`, no DB, no `process.env` reads — callers pass the three
// inputs in.

// What src/index.js falls back to when TRUST_PROXY is unset (docker-compose
// supplies 2; a bare `node src/index.ts` gets this).
export const DEFAULT_TRUST_PROXY = 1;

/**
 * Interpret the TRUST_PROXY env value the way Express expects it: a hop count,
 * the booleans `true`/`false`, or a proxy address/subnet list passed through
 * verbatim. This is the value handed to `app.set('trust proxy', …)`.
 */
export function parseTrustProxy(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TRUST_PROXY;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}

/**
 * Reduce an address to a comparable form: strip an optional port, `[…]` IPv6
 * brackets and a `%zone` suffix, lower-case it, and unwrap IPv4-mapped IPv6
 * (`::ffff:203.0.113.9` → `203.0.113.9`). Returns '' for anything empty.
 */
export function normalizeIp(value) {
  if (value === null || value === undefined) return '';
  let ip = String(value).trim();
  if (!ip) return '';

  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    ip = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    // "203.0.113.9:51234" — only ever an IPv4 host:port, since a bare IPv6
    // address has more than one colon and would not match.
    ip = ip.slice(0, ip.indexOf(':'));
  }

  ip = ip.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];

  return ip;
}

/**
 * True for addresses that cannot be a real internet client: RFC1918 private
 * space, loopback, link-local, IPv6 unique-local (fc00::/7) and IPv6
 * link-local (fe80::/10). Unparseable input is not private — a value we cannot
 * read must never be used as evidence of a misconfiguration.
 */
export function isPrivateOrLoopback(value) {
  const ip = normalizeIp(value);
  if (!ip) return false;

  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true;
    const head = ip.split(':')[0];
    if (!head) return false;
    const n = Number.parseInt(head, 16);
    if (!Number.isFinite(n)) return false;
    if (n >= 0xfc00 && n <= 0xfdff) return true; // fc00::/7  unique local
    if (n >= 0xfe80 && n <= 0xfebf) return true; // fe80::/10 link local
    return false;
  }

  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (a > 255 || b > 255) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Split an X-Forwarded-For header into its entries. Tolerates a missing header,
 * an array (duplicate headers), empty entries and stray whitespace — a forged
 * header is attacker-controlled text, so the count must never depend on it
 * being well-formed.
 */
export function parseForwardedFor(header) {
  if (header === null || header === undefined) return [];
  const raw = Array.isArray(header) ? header.join(',') : String(header);
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function trustProxyLabel(configured, parsed) {
  return configured === null ? `${parsed} (default)` : configured;
}

function describe({ hops, parsed, configured, agrees, suspicious, reqIp }) {
  const label = trustProxyLabel(configured, parsed);

  if (suspicious) {
    return `X-Forwarded-For carried ${hops} hop(s) but req.ip resolved to ${reqIp || 'a private address'}, `
      + `which is private/loopback — TRUST_PROXY=${label} does not match the proxies actually in front of `
      + 'the backend, so per-IP login lockout and audit IPs are keyed on a proxy instead of the client.';
  }
  if (agrees === false) {
    return `TRUST_PROXY=${label} but X-Forwarded-For carried ${hops} hop(s) — req.ip may be a proxy address, `
      + 'which breaks per-IP login lockout and audit attribution.';
  }
  if (agrees === true) {
    return `X-Forwarded-For carried ${hops} hop(s), matching TRUST_PROXY=${label}.`;
  }
  if (hops === 0) {
    return 'No X-Forwarded-For header on this request — req.ip is the direct socket address.';
  }
  if (parsed === true) {
    return `TRUST_PROXY=${label} trusts every hop, so the client picks its own req.ip by setting `
      + 'X-Forwarded-For. Set it to the number of proxies in front of the backend instead.';
  }
  return `TRUST_PROXY=${label} is not a hop count, so the ${hops}-hop X-Forwarded-For chain cannot be `
    + 'checked automatically.';
}

/**
 * Verdict for a single request.
 *
 *   hops                  entries observed in X-Forwarded-For
 *   trustProxy            the configured value as Express received it
 *   trustProxyConfigured  the raw env string, or null when unset (default)
 *   agrees                true / false, or null when it cannot be decided
 *                         (no header at all, or a non-numeric TRUST_PROXY)
 *   suspicious            proof of misconfiguration — see below
 *   reason                one human-readable sentence, always populated
 *
 * `suspicious` means: the request carried X-Forwarded-For, yet req.ip came out
 * private/loopback *and* is not the left-most entry of the chain. That is the
 * nginx-container signature (req.ip = 172.18.0.x). The left-most check is what
 * keeps a legitimate LAN client from tripping it: with a correct hop count
 * req.ip equals the left-most entry, private or not.
 */
export function analyzeForwardedFor({ xForwardedFor, reqIp, trustProxy } = {}) {
  const chain = parseForwardedFor(xForwardedFor);
  const hops = chain.length;

  const configured = trustProxy === undefined || trustProxy === null || trustProxy === ''
    ? null
    : String(trustProxy);
  const parsed = parseTrustProxy(trustProxy);
  const trustedHops = typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;

  const clientIp = normalizeIp(reqIp);
  const claimedClient = normalizeIp(chain[0]);
  const suspicious = hops > 0
    && clientIp !== ''
    && isPrivateOrLoopback(clientIp)
    && clientIp !== claimedClient;

  const agrees = hops > 0 && trustedHops !== null ? hops === trustedHops : null;

  return {
    hops,
    trustProxy: parsed,
    trustProxyConfigured: configured,
    agrees,
    suspicious,
    reason: describe({ hops, parsed, configured, agrees, suspicious, reqIp: clientIp }),
  };
}

/**
 * The log line for a broken chain, or null when there is nothing to say. Split
 * out from the middleware so the "when do we warn" decision is testable without
 * an Express request.
 */
export function mismatchWarning(analysis) {
  if (!analysis) return null;
  if (!analysis.suspicious && analysis.agrees !== false) return null;
  return `[trust-proxy] ${analysis.reason} `
    + 'Set TRUST_PROXY to the number of proxies in front of the backend (README → "Counting your proxies") '
    + 'and check Account → Connection in the portal.';
}
