import https from 'https';
import http from 'http';
import { URL } from 'url';
import { decryptSecret } from './secrets.ts';

const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

// Every route Homelabrrr creates in Caddy is tagged with this @id prefix so we
// can address it individually (PATCH/DELETE /id/homelabrrr-<siteId>) and — just
// as importantly — so we NEVER touch a route we didn't create.
export const MANAGED_ID_PREFIX = 'homelabrrr-';

export function managedRouteId(siteId) {
  return `${MANAGED_ID_PREFIX}${siteId}`;
}

// ─── Config walking helpers (import + wildcard placement) ─────────────────────

/** Union of every `host` value across a route's matcher sets, plus whether any
 *  set carries a client-IP style restriction (`client_ip`/`remote_ip`/`not`). */
function hostsFromMatch(match) {
  const hosts = [];
  let guarded = false;
  for (const m of match || []) {
    for (const h of m.host || []) hosts.push(String(h).toLowerCase());
    if (m.client_ip || m.remote_ip || m.not) guarded = true;
  }
  return { hosts: [...new Set(hosts)], guarded };
}

/** Caddy host wildcards span exactly one label: `*.example.com` covers
 *  `app.example.com` but not `a.b.example.com` or `example.com` itself. */
export function hostCoveredByWildcard(domain, wildcard) {
  if (!String(wildcard).startsWith('*.')) return false;
  const base = String(wildcard).slice(2).toLowerCase();
  const d = String(domain).toLowerCase();
  if (!d.endsWith(`.${base}`)) return false;
  const label = d.slice(0, d.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

/** Does a listen address end on `port`? Handles ':443', '10.0.0.5:443', '[::]:443'. */
function listensOn(server, port) {
  return (server?.listen || []).some((l) => new RegExp(`:${port}$`).test(String(l)));
}

/**
 * Pick which http server key a top-level route should be appended to.
 *
 * Order matters and used to be a coin flip: the old check accepted `:443` *or*
 * `:80` with no preference, so a Caddyfile carrying an explicit `http://` site
 * block could produce a `:80`-only server that sorted first and swallowed every
 * published site — no automatic HTTPS, no certificate, and `https://` never
 * serving, with the publish still reported as successful.
 *
 * Returns { name, listen, tls, source } where `tls` says whether the chosen
 * server actually terminates HTTPS, or null when there are no servers at all.
 * `source` is 'https' | 'http' | 'fallback' — the caller decides what to do
 * about a non-HTTPS choice; this function never guesses on the caller's behalf.
 */
export function pickHttpServer(servers) {
  const names = Object.keys(servers || {});
  if (names.length === 0) return null;
  const describe = (name, tls, source) => ({
    name,
    listen: (servers[name]?.listen || []).map(String),
    tls,
    source,
  });
  const https = names.find((n) => listensOn(servers[n], 443));
  if (https) return describe(https, true, 'https');
  const plain = names.find((n) => listensOn(servers[n], 80));
  if (plain) return describe(plain, false, 'http');
  return describe(names[0], false, 'fallback');
}

/** Does a route's matcher set cover `domain` — exactly, or through a wildcard? */
export function routeMatchesHost(match, domain) {
  const { hosts } = hostsFromMatch(match);
  if (hosts.length === 0) return false;
  const d = String(domain).toLowerCase();
  return hosts.some((h) => h === d || hostCoveredByWildcard(d, h));
}

/** What a route ultimately does, looking through any subroute nesting. */
function summarizeHandlers(route) {
  const kinds = new Set();
  let upstream = '';
  const walk = (handlers) => {
    for (const h of handlers || []) {
      if (h.handler === 'subroute') {
        for (const r of h.routes || []) walk(r.handle);
        continue;
      }
      if (h.handler) kinds.add(h.handler);
      if (h.handler === 'reverse_proxy' && !upstream) upstream = String(h.upstreams?.[0]?.dial || '');
    }
  };
  walk(route.handle);
  return { kinds: [...kinds], upstream };
}

/** Compare two index paths. Negative when `a` is evaluated before `b`. */
function comparePath(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Is `a` a proper prefix of `b` — i.e. is route `a` an ancestor of route `b`? */
function isAncestorPath(a, b) {
  return a.length < b.length && a.every((v, i) => v === b[i]);
}

/**
 * Every route in the live config whose host matcher covers `domain`, tagged with
 * its position. `path` is the index chain down from the server's `routes` array
 * (`[10]`, `[4, 0, 1]`); comparing those lexicographically reproduces Caddy's
 * own evaluation order, which is the whole point — a site block that matches
 * first and is `terminal` stops evaluation, so nothing after it is ever reached.
 *
 * Routes with no host matcher are deliberately ignored: they match everything,
 * so treating them as per-domain conflicts would flag ordinary catch-alls on
 * every publish.
 */
export function collectHostRoutes(servers, domain) {
  const out = [];
  const walk = (routes, server, path) => {
    for (let i = 0; i < (routes || []).length; i++) {
      const route = routes[i] || {};
      const here = [...path, i];
      if (routeMatchesHost(route.match, domain)) {
        out.push({
          server,
          path: here,
          id: typeof route['@id'] === 'string' ? route['@id'] : '',
          hosts: hostsFromMatch(route.match).hosts,
          terminal: route.terminal === true,
          ...summarizeHandlers(route),
        });
      }
      const handle = route.handle || [];
      for (let h = 0; h < handle.length; h++) {
        if (handle[h]?.handler === 'subroute') walk(handle[h].routes, server, [...here, h]);
      }
    }
  };
  for (const name of Object.keys(servers || {})) walk(servers[name]?.routes, name, []);
  return out;
}

/**
 * Routes that shadow the managed route for `siteId`: they match the same domain
 * on the same http server and Caddy reaches them first, so the site's own route
 * is dead config no matter what the admin API said when it was pushed.
 *
 * This is not a race. `POST /config/apps/http/servers/<s>/routes` *appends*, and
 * Caddyfile-derived routes are always loaded before anything appended later —
 * so a pre-existing site block for the same hostname always wins.
 *
 * The site's own route and its ancestors (the wildcard block it may be nested
 * inside, which naturally matches the domain too) are never conflicts. Nothing
 * here mutates anything: conflicts are reported so an operator can remove the
 * offending block, because Homelabrrr never touches a route it did not create.
 */
export function findShadowingRoutes(servers, domain, siteId) {
  const ownId = managedRouteId(siteId);
  const all = collectHostRoutes(servers, domain);
  const own = all.find((r) => r.id === ownId);
  return all.filter((r) => {
    if (r.id === ownId) return false;
    if (!own) return true;                              // our route isn't there at all
    if (r.server !== own.server) return false;          // a different listener entirely
    if (isAncestorPath(r.path, own.path)) return false; // the block we're nested in
    return comparePath(r.path, own.path) < 0;           // only what Caddy reaches first
  });
}

function splitDial(dial) {
  const s = String(dial || '');
  const idx = s.lastIndexOf(':');
  if (idx === -1) return { host: s, port: 0 };
  const port = Number.parseInt(s.slice(idx + 1), 10);
  if (!Number.isInteger(port)) return { host: s, port: 0 };
  return { host: s.slice(0, idx), port };
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
            // Remote status, reflected for caller branching. Upstream text —
            // keep it sanitized even at 4xx (see utils/httpError.js).
            err.expose = false;
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
   * Resolve which http server key to attach routes to, with the reasoning kept:
   * an explicitly configured name wins, otherwise :443 strictly before :80.
   * Returns { name, listen, tls, source } — see pickHttpServer.
   */
  async chooseServer() {
    if (this.serverName) {
      const servers = await this.getConfig('/apps/http/servers').catch(() => null);
      const listen = (servers?.[this.serverName]?.listen || []).map(String);
      return { name: this.serverName, listen, tls: listensOn({ listen }, 443), source: 'configured' };
    }
    const servers = (await this.getConfig('/apps/http/servers')) || {};
    const choice = pickHttpServer(servers);
    if (!choice) {
      throw new Error('Caddy has no http servers configured — cannot attach a site route');
    }
    this.serverName = choice.name;
    return choice;
  }

  async resolveServerName() {
    return (await this.chooseServer()).name;
  }

  /**
   * Read the live route array back and report every route that would be reached
   * before this site's own. See findShadowingRoutes — nothing is mutated.
   */
  async findConflicts(siteId, domain) {
    const servers = (await this.getConfig('/apps/http/servers')) || {};
    return findShadowingRoutes(servers, domain, siteId);
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

  /**
   * Find the wildcard site block (e.g. a Caddyfile `*.example.com { ... }`)
   * whose subroute a new host route should nest inside. Returns the config path
   * of that subroute's routes array, the index to insert at (before the block's
   * trailing catch-all, typically `handle { abort }`), and the wildcard host —
   * or null when no wildcard block covers the domain.
   */
  async findWildcardSlot(domain) {
    const servers = (await this.getConfig('/apps/http/servers')) || {};
    for (const name of Object.keys(servers)) {
      const routes = servers[name]?.routes || [];
      for (let i = 0; i < routes.length; i++) {
        const { hosts } = hostsFromMatch(routes[i].match);
        const wildcard = hosts.find((h) => h.includes('*') && hostCoveredByWildcard(domain, h));
        if (!wildcard) continue;
        const handle = routes[i].handle || [];
        for (let j = 0; j < handle.length; j++) {
          if (handle[j].handler !== 'subroute') continue;
          const sub = handle[j].routes || [];
          let insertIndex = sub.length;
          for (let k = 0; k < sub.length; k++) {
            const { hosts: subHosts } = hostsFromMatch(sub[k].match);
            if (subHosts.length === 0) { insertIndex = k; break; }
          }
          return {
            path: `/apps/http/servers/${encodeURIComponent(name)}/routes/${i}/handle/${j}/routes`,
            insertIndex,
            wildcard,
          };
        }
      }
    }
    return null;
  }

  /**
   * Create the route if missing, otherwise replace it in place by @id.
   * When an existing wildcard block covers the domain, the new route is nested
   * inside that block (before its catch-all) instead of appended at the top
   * level — so the block's wildcard certificate (e.g. DNS-challenge
   * `*.example.com`) serves the site and no per-domain issuance is attempted.
   * Returns { route, wildcard, serverName } — wildcard is '' for a plain
   * top-level route, serverName the http server key the route landed on ('' when
   * it was nested into an existing block, which decides its own listener).
   */
  async upsertRoute(siteId, domain, upstreamHost, upstreamPort) {
    const route = buildSiteRoute(siteId, domain, upstreamHost, upstreamPort);
    const existing = await this.getRoute(siteId);
    if (existing) {
      // PATCH /id/<id> replaces the object at that path (works nested too);
      // keep the @id in the body.
      await this.request('PATCH', `/id/${managedRouteId(siteId)}`, route);
      const slot = await this.findWildcardSlot(domain).catch(() => null);
      return { route, wildcard: slot?.wildcard || '', serverName: '' };
    }
    const slot = await this.findWildcardSlot(domain);
    if (slot) {
      // PUT into an array inserts at the index, shifting the catch-all down.
      await this.request('PUT', `/config${slot.path}/${slot.insertIndex}`, route);
      return { route, wildcard: slot.wildcard, serverName: '' };
    }
    const choice = await this.chooseServer();
    // A site published here is an HTTPS site: it exists to get a Let's Encrypt
    // certificate. Landing it on a server with no :443 listener would produce a
    // green publish and a hostname that never serves over HTTPS — say so
    // instead, and let the admin pin the right key on the server record.
    if (!choice.tls && choice.source !== 'configured') {
      const err = new Error(
        `The only Caddy http server available ("${choice.name}"`
        + `${choice.listen.length ? `, listening on ${choice.listen.join(', ')}` : ''}) does not listen on :443, `
        + 'so an HTTPS site published there would never serve. Add a :443 listener to Caddy, '
        + 'or set the correct server key on the Caddy server record in Admin → Websites.',
      );
      err.code = 'caddy_no_https_server';
      throw err;
    }
    await this.request('POST', `/config/apps/http/servers/${encodeURIComponent(choice.name)}/routes`, route);
    return { route, wildcard: '', serverName: choice.name };
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

  /** @id values of every route Homelabrrr owns on this Caddy instance.
   *  Recurses into subroutes since managed routes may be nested inside a
   *  wildcard site block. */
  async listManagedRouteIds() {
    const cfg = await this.getConfig('/');
    const servers = cfg?.apps?.http?.servers || {};
    const ids = [];
    const walk = (routes) => {
      for (const route of routes || []) {
        const id = route['@id'];
        if (typeof id === 'string' && id.startsWith(MANAGED_ID_PREFIX)) ids.push(id);
        for (const handler of route.handle || []) {
          if (handler.handler === 'subroute') walk(handler.routes);
        }
      }
    };
    for (const name of Object.keys(servers)) walk(servers[name]?.routes);
    return ids;
  }

  /**
   * Discover every site already configured on this Caddy instance (i.e. routes
   * Homelabrrr did NOT create — typically hand-written Caddyfile blocks).
   *
   * Walks all http servers' route trees recursively so wildcard site blocks
   * (`*.example.com { @app host app.example.com; handle @app { ... } }`) yield
   * one entry per concrete hostname, each tagged with the covering wildcard.
   * Routes tagged with our @id prefix are skipped and counted separately.
   * Unknown apps/handlers (custom plugins, event hooks like forticertsync) are
   * simply ignored — only apps.http is inspected.
   *
   * Returns { sites: [{ domain, wildcard, kind, upstreamHost, upstreamPort,
   * upstreamTls, guarded }], managedCount }.
   */
  async discoverSites() {
    const servers = (await this.getConfig('/apps/http/servers')) || {};
    const found = new Map(); // domain -> entry
    let managedCount = 0;

    const record = (ctx, patch) => {
      // Concrete hosts win; a wildcard-only context (a reverse_proxy sitting
      // directly in a wildcard block) is reported under the wildcard itself.
      const domains = ctx.hosts.length ? ctx.hosts : (ctx.wildcard ? [ctx.wildcard] : []);
      for (const domain of domains) {
        const prev = found.get(domain) || {
          domain,
          wildcard: ctx.hosts.length ? ctx.wildcard : '',
          kind: '',
          upstreamHost: '',
          upstreamPort: 0,
          upstreamTls: false,
          guarded: false,
        };
        // A host can carry several handlers (guard subroutes, headers, then the
        // proxy) — the reverse_proxy is the site's identity when present.
        if (!prev.kind || (patch.kind === 'reverse_proxy' && prev.kind !== 'reverse_proxy')) {
          Object.assign(prev, patch);
        }
        prev.guarded = prev.guarded || ctx.guarded;
        found.set(domain, prev);
      }
    };

    const walk = (routes, ctx) => {
      // Guards compile to *sibling* routes preceding the proxy route (e.g. a
      // matcher-scoped `abort @denied` or a `basic_auth`) — once seen, the rest
      // of this scope is behind them.
      let siblingGuard = false;
      for (const route of routes || []) {
        const id = route['@id'];
        if (typeof id === 'string' && id.startsWith(MANAGED_ID_PREFIX)) { managedCount++; continue; }
        const { hosts, guarded } = hostsFromMatch(route.match);
        const concrete = hosts.filter((h) => !h.includes('*'));
        const wild = hosts.find((h) => h.includes('*')) || '';
        const next = {
          hosts: concrete.length ? concrete : ctx.hosts,
          wildcard: wild || ctx.wildcard,
          guarded: ctx.guarded || guarded || siblingGuard,
        };
        for (const handler of route.handle || []) {
          if (handler.handler === 'subroute') {
            walk(handler.routes, next);
          } else if (handler.handler === 'reverse_proxy') {
            const tls = !!handler.transport?.tls;
            const { host, port } = splitDial(handler.upstreams?.[0]?.dial);
            record(next, { kind: 'reverse_proxy', upstreamHost: host, upstreamPort: port || (tls ? 443 : 80), upstreamTls: tls });
          } else if (handler.handler === 'file_server') {
            record(next, { kind: 'file_server' });
          } else if (handler.handler === 'static_response') {
            // `abort` compiles to static_response { abort: true } — a
            // matcher-scoped one is an access guard, not a site.
            if (handler.abort) {
              if (guarded) siblingGuard = true;
            } else {
              record(next, { kind: 'static' });
            }
          } else if (handler.handler === 'authentication') {
            siblingGuard = true;
          }
        }
      }
    };

    for (const name of Object.keys(servers)) {
      walk(servers[name]?.routes, { hosts: [], wildcard: '', guarded: false });
    }
    return { sites: [...found.values()], managedCount };
  }
}

/**
 * Build a CaddyClient from a caddy_servers DB row (secret decrypted at call time).
 *
 * verify_tls is a real PostgreSQL boolean, so the only insecure state is an
 * explicit `false` — `!== false` preserves the old SQLite `!== 0` semantics
 * (a null verify_tls still verifies, i.e. stays secure) without the bug that
 * `false !== 0` is true, which pinned verification on regardless of the setting.
 */
export function createCaddyClient(row) {
  return new CaddyClient({
    apiUrl: row.api_url,
    authType: row.auth_type || 'none',
    authSecret: row.auth_secret ? decryptSecret(row.auth_secret) : '',
    verifyTls: row.verify_tls !== false,
    serverName: row.server_name || '',
  });
}
