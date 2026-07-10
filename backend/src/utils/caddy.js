import https from 'https';
import http from 'http';
import { URL } from 'url';
import { decryptSecret } from './secrets.js';

const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// Every route Homelabrrr creates in Caddy is tagged with this @id prefix so we
// can address it individually (PATCH/DELETE /id/homelabrrr-<siteId>) and — just
// as importantly — so we NEVER touch a route we didn't create.
export const MANAGED_ID_PREFIX = 'homelabrrr-';

export function managedRouteId(siteId) {
  return `${MANAGED_ID_PREFIX}${siteId}`;
}

/**
 * Build the reverse-proxy route JSON for a managed site entirely server-side
 * from already-validated fields — we never accept raw Caddy JSON/Caddyfile from
 * a user. The host matcher triggers Caddy's automatic HTTPS (Let's Encrypt) for
 * the domain, and `caddy-forticertsync` picks the issued cert up from there.
 */
export function buildSiteRoute(siteId, domain, upstreamHost, upstreamPort) {
  return {
    '@id': managedRouteId(siteId),
    match: [{ host: [domain] }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: [
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: `${upstreamHost}:${upstreamPort}` }],
              },
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
}

export class CaddyClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiUrl  Base URL of the Caddy admin API, e.g. http://10.0.0.5:2019
   * @param {string} [opts.authType]  'none' | 'bearer' | 'basic' | 'header'
   * @param {string} [opts.authSecret]  decrypted auth material (token / base64 creds / raw header)
   * @param {boolean} [opts.verifyTls]  verify TLS when apiUrl is https
   * @param {string} [opts.serverName]  explicit Caddy http server key (auto-discovered when empty)
   */
  constructor({ apiUrl, authType = 'none', authSecret = '', verifyTls = true, serverName = '' }) {
    const parsed = new URL(apiUrl);
    this.protocol = parsed.protocol; // 'http:' | 'https:'
    this.hostname = parsed.hostname;
    this.port = parsed.port || (this.protocol === 'https:' ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/+$/, ''); // usually ''
    this.authType = authType;
    this.authSecret = authSecret;
    this.verifyTls = verifyTls;
    this.serverName = serverName || '';
  }

  authHeader() {
    if (!this.authSecret || this.authType === 'none') return {};
    if (this.authType === 'bearer') return { Authorization: `Bearer ${this.authSecret}` };
    if (this.authType === 'basic') return { Authorization: `Basic ${this.authSecret}` };
    if (this.authType === 'header') return { Authorization: this.authSecret };
    return {};
  }

  request(method, path, data = null) {
    if (this.protocol === 'https:' && !this.verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
      return Promise.reject(new Error('Caddy admin API TLS verification is disabled. Re-enable it or set ALLOW_INSECURE_UPSTREAM_TLS=true as a temporary exception.'));
    }

    const body = data === null || data === undefined ? null : JSON.stringify(data);
    const options = {
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.authHeader(),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    if (this.protocol === 'https:') {
      options.agent = new https.Agent({ rejectUnauthorized: this.verifyTls });
    }

    return new Promise((resolve, reject) => {
      const lib = this.protocol === 'https:' ? https : http;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            const msg = parsed?.error || (typeof parsed === 'string' && parsed) || `HTTP ${res.statusCode}`;
            const err = new Error(`Caddy admin API error: ${msg}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      });
      req.on('error', (err) => reject(new Error(`Caddy connection error: ${err.message}`)));
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Caddy admin API request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  async getConfig(path = '/') {
    const res = await this.request('GET', `/config${path === '/' ? '/' : path}`);
    return res.body;
  }

  /** Lightweight reachability + summary check for the admin UI. */
  async ping() {
    const cfg = await this.getConfig('/');
    const servers = cfg?.apps?.http?.servers || {};
    const managed = await this.listManagedRouteIds().catch(() => []);
    return {
      online: true,
      servers: Object.keys(servers),
      managedRoutes: managed.length,
    };
  }

  /**
   * Resolve which http server key to attach routes to. Prefers an explicitly
   * configured name, then a server listening on :443/:80, then the first key.
   */
  async resolveServerName() {
    if (this.serverName) return this.serverName;
    const servers = (await this.getConfig('/apps/http/servers')) || {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      throw new Error('Caddy has no http servers configured — cannot attach a site route');
    }
    const preferred = names.find((n) => {
      const listen = servers[n]?.listen || [];
      return listen.some((l) => /:(443|80)$/.test(String(l)));
    });
    this.serverName = preferred || names[0];
    return this.serverName;
  }

  /** GET the managed route for a site, or null if it isn't present. */
  async getRoute(siteId) {
    try {
      const res = await this.request('GET', `/id/${managedRouteId(siteId)}`);
      return res.body;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 500) return null;
      throw err;
    }
  }

  /** Create the route if missing, otherwise replace it in place by @id. */
  async upsertRoute(siteId, domain, upstreamHost, upstreamPort) {
    const route = buildSiteRoute(siteId, domain, upstreamHost, upstreamPort);
    const existing = await this.getRoute(siteId);
    if (existing) {
      // PATCH /id/<id> replaces the object at that path; keep the @id in the body.
      await this.request('PATCH', `/id/${managedRouteId(siteId)}`, route);
    } else {
      const serverName = await this.resolveServerName();
      await this.request('POST', `/config/apps/http/servers/${encodeURIComponent(serverName)}/routes`, route);
    }
    return route;
  }

  /** Delete the managed route for a site (no-op if it's already gone). */
  async deleteRoute(siteId) {
    try {
      await this.request('DELETE', `/id/${managedRouteId(siteId)}`);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 500) return;
      throw err;
    }
  }

  /** @id values of every route Homelabrrr owns on this Caddy instance. */
  async listManagedRouteIds() {
    const cfg = await this.getConfig('/');
    const servers = cfg?.apps?.http?.servers || {};
    const ids = [];
    for (const name of Object.keys(servers)) {
      for (const route of servers[name]?.routes || []) {
        const id = route['@id'];
        if (typeof id === 'string' && id.startsWith(MANAGED_ID_PREFIX)) ids.push(id);
      }
    }
    return ids;
  }
}

/** Build a CaddyClient from a caddy_servers DB row (secret decrypted at call time). */
export function createCaddyClient(row) {
  return new CaddyClient({
    apiUrl: row.api_url,
    authType: row.auth_type || 'none',
    authSecret: row.auth_secret ? decryptSecret(row.auth_secret) : '',
    verifyTls: row.verify_tls !== 0,
    serverName: row.server_name || '',
  });
}
