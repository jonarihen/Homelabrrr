import https from 'https';
import { URL } from 'url';

// ─── End-to-end reachability probe for a published site ───────────────────────
//
// Publishing used to call a site LIVE the moment Caddy's admin API returned 200
// for the route push. "The route was accepted" and "the site serves" are not the
// same statement, and the gap between them is where a shadowed route hides: a
// site can be green on every step and return 502 to every visitor.
//
// Two things this deliberately does NOT do:
//
//   * It does not resolve the domain through public DNS. The record points at
//     the homelab WAN IP, and plenty of homelab routers don't hairpin NAT — so
//     a DNS-based probe would fail from inside the network for reasons that have
//     nothing to do with the site. Instead it connects straight to the
//     registered Caddy server's own address and sets both the TLS SNI and the
//     Host header to the published domain: the programmatic `curl --resolve`.
//
//   * It does not collapse the failure modes. A 502 from a correctly-routed site
//     is the user's own upstream being down and is theirs to fix; an untrusted
//     certificate means issuance hasn't completed; a refused connection is the
//     Caddy host. Each needs different words, so each gets its own kind.

export const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 8000;

/**
 * Turn a raw probe observation into a verdict.
 *
 * kinds: 'serving' (ok) | 'cert' | 'upstream' | 'server-error' | 'unreachable'
 * @param {{status?: number, tlsError?: string, networkError?: string, port?: number}} obs
 */
export function classifyProbe({ status = 0, tlsError = '', networkError = '', port = PROBE_PORT } = {}) {
  if (networkError) {
    return {
      ok: false,
      kind: 'unreachable',
      status: 0,
      message: `Could not reach the Caddy server on port ${port} to verify the site: ${networkError}`,
    };
  }
  if (!status) {
    return {
      ok: false,
      kind: 'unreachable',
      status: 0,
      message: `The Caddy server accepted the connection on port ${port} but returned no HTTP response.`,
    };
  }
  // Caddy answered, so the route is reachable — but with a certificate no
  // public client would accept. Almost always ACME still in flight (Caddy
  // serves its internal CA cert until Let's Encrypt issues).
  if (tlsError) {
    return {
      ok: false,
      kind: 'cert',
      status,
      message: `Caddy is serving this domain, but the certificate is not publicly trusted yet (${tlsError}) — usually Let’s Encrypt issuance still in progress. Retry in a minute.`,
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      ok: false,
      kind: 'upstream',
      status,
      message: `Caddy is serving this domain but cannot reach the upstream (HTTP ${status}). Check that the target is running and reachable from the Caddy host.`,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      kind: 'server-error',
      status,
      message: `The published domain answered with HTTP ${status}.`,
    };
  }
  // Anything below 500 — 200, 302 to a login page, 401, even 404 — proves the
  // request reached the intended site through the intended route.
  return { ok: true, kind: 'serving', status, message: `Verified serving over HTTPS (HTTP ${status}).` };
}

/**
 * Fire one HTTPS request at `address:port`, presenting `domain` as SNI + Host.
 *
 * `rejectUnauthorized` is false on purpose and is not a TLS bypass: the probe
 * sends no credentials and reads nothing but a status line, and the certificate
 * state it would otherwise throw away is exactly what distinguishes "issuance
 * hasn't finished" from "the upstream is down". It is *reported*, never ignored.
 * Credentialed calls to Caddy still go through CaddyClient.request(), which
 * honours verify_tls / ALLOW_INSECURE_UPSTREAM_TLS.
 *
 * Never rejects — a probe that fails is a verdict, not an exception.
 */
export function probeSite({ address, port = PROBE_PORT, domain, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (obs) => { if (!settled) { settled = true; resolve(classifyProbe({ port, ...obs })); } };
    let tlsError = '';

    const req = https.request({
      host: address,
      port,
      servername: domain,
      path: '/',
      method: 'GET',
      headers: { Host: domain, 'User-Agent': 'Homelabrrr-site-probe/1' },
      rejectUnauthorized: false,
      agent: false,
    }, (res) => {
      res.resume();   // drain; only the status line matters
      done({ status: res.statusCode, tlsError });
    });

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        if (!socket.authorized) {
          tlsError = String(socket.authorizationError || 'certificate not trusted');
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ networkError: `timed out after ${timeoutMs}ms` });
    });
    req.on('error', (err) => done({ networkError: err.message }));
    req.end();
  });
}

/**
 * The address to probe for a registered Caddy server: its admin API host, which
 * is the Caddy host itself. Returns '' when the URL is unusable, in which case
 * the caller skips the probe rather than guessing.
 */
export function probeAddressFor(server) {
  try {
    return new URL(server.api_url).hostname || '';
  } catch {
    return '';
  }
}
