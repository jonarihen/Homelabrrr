// Regression coverage for issue #103: a site published through the portal was
// reported LIVE with every step green while returning 502 to every visitor,
// because a hand-written Caddyfile block for the same hostname sat earlier in
// the route array and Caddy never reached the appended route.
//
// The two halves of that bug are pure functions here: finding the shadowing
// route in a config tree, and picking the http server key to append to.
// Run with:  node --test src/utils/caddy.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiteRoute,
  collectHostRoutes,
  createCaddyClient,
  findShadowingRoutes,
  hostCoveredByWildcard,
  managedRouteId,
  pickHttpServer,
  routeMatchesHost,
} from './caddy.ts';

// A Caddyfile-derived site block: host matcher + subroute + reverse_proxy.
function staticBlock(host, dial) {
  return {
    match: [{ host: [host] }],
    handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial }] }] }] }],
    terminal: true,
  };
}

// ─── pickHttpServer — issue #103 defect 4 ────────────────────────────────────

test('a :443 server is preferred even when a :80 server sorts first', () => {
  const choice = pickHttpServer({
    srv0: { listen: [':80'] },
    srv1: { listen: [':443'] },
  });
  assert.equal(choice.name, 'srv1');
  assert.equal(choice.tls, true);
  assert.equal(choice.source, 'https');
});

test('a :80-only config is reported as non-TLS rather than passed off as fine', () => {
  const choice = pickHttpServer({ srv0: { listen: ['10.0.0.5:2019'] }, srv1: { listen: [':80'] } });
  assert.equal(choice.name, 'srv1');
  assert.equal(choice.tls, false);
  assert.equal(choice.source, 'http');
});

test('with no :443 and no :80 the first key is a last resort, flagged as such', () => {
  const choice = pickHttpServer({ mgmt: { listen: ['127.0.0.1:2019'] } });
  assert.deepEqual([choice.name, choice.tls, choice.source], ['mgmt', false, 'fallback']);
});

test('listen addresses with an explicit host or IPv6 still count as :443', () => {
  assert.equal(pickHttpServer({ a: { listen: ['10.0.0.5:443'] } }).tls, true);
  assert.equal(pickHttpServer({ a: { listen: ['[::]:443'] } }).tls, true);
  // A port that merely contains 443 is not port 443.
  assert.equal(pickHttpServer({ a: { listen: [':4433'] } }).tls, false);
});

test('an empty server map yields no choice at all', () => {
  assert.equal(pickHttpServer({}), null);
  assert.equal(pickHttpServer(undefined), null);
});

// ─── host matching ───────────────────────────────────────────────────────────

test('a route matches a domain exactly, case-insensitively, or by wildcard', () => {
  assert.equal(routeMatchesHost([{ host: ['site.example.com'] }], 'site.example.com'), true);
  assert.equal(routeMatchesHost([{ host: ['SITE.example.com'] }], 'site.example.com'), true);
  assert.equal(routeMatchesHost([{ host: ['*.example.com'] }], 'site.example.com'), true);
  assert.equal(routeMatchesHost([{ host: ['other.example.com'] }], 'site.example.com'), false);
  // A wildcard spans exactly one label — the shared helper's rule.
  assert.equal(hostCoveredByWildcard('a.b.example.com', '*.example.com'), false);
  assert.equal(routeMatchesHost([{ host: ['*.example.com'] }], 'a.b.example.com'), false);
});

test('a route with no host matcher matches nothing — catch-alls are not conflicts', () => {
  assert.equal(routeMatchesHost(undefined, 'site.example.com'), false);
  assert.equal(routeMatchesHost([{}], 'site.example.com'), false);
});

// ─── collectHostRoutes ───────────────────────────────────────────────────────

test('the upstream of a Caddyfile site block is found through its subroute', () => {
  const servers = { srv1: { routes: [staticBlock('site.example.com', '10.0.99.10:80')] } };
  const [found] = collectHostRoutes(servers, 'site.example.com');
  assert.equal(found.upstream, '10.0.99.10:80');
  assert.deepEqual(found.kinds, ['reverse_proxy']);
  assert.equal(found.terminal, true);
  assert.deepEqual(found.path, [0]);
});

test('nested routes are collected with the index path that orders them', () => {
  const servers = {
    srv1: {
      routes: [
        staticBlock('other.example.com', '10.0.0.1:80'),
        {
          match: [{ host: ['*.example.com'] }],
          handle: [{ handler: 'subroute', routes: [staticBlock('site.example.com', '10.0.0.2:80')] }],
        },
      ],
    },
  };
  const found = collectHostRoutes(servers, 'site.example.com');
  // The wildcard block matches too, and sits above the concrete route inside it.
  assert.deepEqual(found.map((r) => r.path), [[1], [1, 0, 0]]);
});

// ─── findShadowingRoutes — issue #103 defect 1 ───────────────────────────────

// The exact incident: a legacy Caddyfile block at index 0 pointing at a dead
// host, and Homelabrrr's own appended route at index 10.
const INCIDENT = {
  srv1: {
    routes: [
      staticBlock('site-b.example.com', '10.0.99.10:80'),
      staticBlock('unrelated.example.com', '10.0.0.9:80'),
      { ...buildSiteRoute(4, 'site-a.example.com', '10.0.0.10', 8081) },
      { ...buildSiteRoute(10, 'site-b.example.com', '10.0.0.10', 8083) },
    ],
  },
};

test('a pre-existing block for the same host is reported, naming its upstream', () => {
  const conflicts = findShadowingRoutes(INCIDENT, 'site-b.example.com', 10);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].upstream, '10.0.99.10:80');
  assert.equal(conflicts[0].server, 'srv1');
  assert.deepEqual(conflicts[0].hosts, ['site-b.example.com']);
});

test('the sites with no static counterpart are reported clean — that is why they worked', () => {
  assert.deepEqual(findShadowingRoutes(INCIDENT, 'site-a.example.com', 4), []);
});

test('a route Caddy reaches only after ours does not shadow it', () => {
  const servers = {
    srv1: {
      routes: [
        buildSiteRoute(7, 'site.example.com', '10.0.0.10', 8080),
        staticBlock('site.example.com', '10.0.99.10:80'),
      ],
    },
  };
  assert.deepEqual(findShadowingRoutes(servers, 'site.example.com', 7), []);
});

test('the wildcard block our route is nested inside is never a conflict', () => {
  const servers = {
    srv1: {
      routes: [{
        match: [{ host: ['*.example.com'] }],
        handle: [{
          handler: 'subroute',
          routes: [
            buildSiteRoute(3, 'site.example.com', '10.0.0.10', 8080),
            { handle: [{ handler: 'static_response', abort: true }] },
          ],
        }],
        terminal: true,
      }],
    },
  };
  assert.deepEqual(findShadowingRoutes(servers, 'site.example.com', 3), []);
});

test('but a sibling wildcard block ahead of our route does shadow it', () => {
  const servers = {
    srv1: {
      routes: [
        staticBlock('*.example.com', '10.0.99.10:80'),
        buildSiteRoute(3, 'site.example.com', '10.0.0.10', 8080),
      ],
    },
  };
  const conflicts = findShadowingRoutes(servers, 'site.example.com', 3);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].hosts, ['*.example.com']);
});

test('a matching route on a different http server is a different listener, not a conflict', () => {
  const servers = {
    srv0: { routes: [staticBlock('site.example.com', '10.0.99.10:80')] },
    srv1: { routes: [buildSiteRoute(3, 'site.example.com', '10.0.0.10', 8080)] },
  };
  assert.deepEqual(findShadowingRoutes(servers, 'site.example.com', 3), []);
});

test('when our route is absent entirely, every matching route is reported', () => {
  const servers = { srv1: { routes: [staticBlock('site.example.com', '10.0.99.10:80')] } };
  assert.equal(findShadowingRoutes(servers, 'site.example.com', 99).length, 1);
});

test('our own route is identified by its @id, never reported against itself', () => {
  const servers = { srv1: { routes: [buildSiteRoute(3, 'site.example.com', '10.0.0.10', 8080)] } };
  assert.equal(servers.srv1.routes[0]['@id'], managedRouteId(3));
  assert.deepEqual(findShadowingRoutes(servers, 'site.example.com', 3), []);
});

test('another portal-managed route for the same host is still a conflict', () => {
  // Domain uniqueness should prevent this, but a stale route left by a failed
  // delete must not be silently tolerated just because we created it.
  const servers = {
    srv1: {
      routes: [
        buildSiteRoute(2, 'site.example.com', '10.0.0.10', 9000),
        buildSiteRoute(3, 'site.example.com', '10.0.0.10', 8080),
      ],
    },
  };
  const conflicts = findShadowingRoutes(servers, 'site.example.com', 3);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, managedRouteId(2));
});

test('an empty or missing config is not a conflict', () => {
  assert.deepEqual(findShadowingRoutes({}, 'site.example.com', 1), []);
  assert.deepEqual(findShadowingRoutes({ srv1: {} }, 'site.example.com', 1), []);
});

// ─── createCaddyClient — the verify_tls mapping ──────────────────────────────
//
// Same defect as the FortiGate client (see fortigate.test.ts): `verify_tls` is
// a real PostgreSQL boolean now, and the leftover `!== 0` comparison read
// `false` as "verify" because `false !== 0` is true.

function serverRow(verifyTls) {
  return {
    api_url: 'https://caddy.example.com:2019',
    auth_type: 'none',
    auth_secret: '',
    server_name: 'srv0',
    verify_tls: verifyTls,
  };
}

test('verify_tls false disables Caddy admin API verification', () => {
  assert.equal(createCaddyClient(serverRow(false)).verifyTls, false);
});

test('verify_tls true (or null) verifies the Caddy admin API', () => {
  assert.equal(createCaddyClient(serverRow(true)).verifyTls, true);
  assert.equal(createCaddyClient(serverRow(null)).verifyTls, true);
  assert.equal(createCaddyClient(serverRow(undefined)).verifyTls, true);
});
