import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, logAuditEntry } from '../utils/audit.js';
import { sanitizeError } from '../utils/sanitize.js';
import { encryptSecret } from '../utils/secrets.js';
import { createClient } from '../fortigate.js';
import { certNameToSubject, certWildcardCovers, stripCertDateSuffix, SERVER_CERT_MAX } from '../utils/certSlots.js';
import { createCaddyClient, managedRouteId, hostCoveredByWildcard } from '../utils/caddy.js';
import { probeSite, probeAddressFor, PROBE_PORT } from '../utils/caddyProbe.js';
import { sshConfigured, deploySnippet, isSafeRemotePath } from '../utils/caddySnippet.js';
import {
  normalizeDomain, isValidDomain, isValidUpstreamHost, parsePort,
  validateDomainDns, userCanReachUpstream, getUserAllowedUpstreams,
} from '../utils/websiteChecks.js';

const router = Router();
router.use(requireAuth);

const pWebsites = requirePermission('can_manage_websites');
const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';
const AUTH_TYPES = new Set(['none', 'bearer', 'basic', 'header']);

// DNS validation and publishing touch external resolvers / the Caddy admin API;
// rate-limit them per client so a user can't hammer DNS or the ACME pipeline.
const dnsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many DNS/publish attempts — slow down and try again in a few minutes.' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Step / status tracking (mirrors the provisioning stepper) ─────────────────

const INITIAL_STEPS = [
  { key: 'dns',     label: 'DNS points at homelab WAN IP' },
  { key: 'push',    label: 'Push reverse-proxy route to Caddy' },
  { key: 'cert',    label: "Let's Encrypt certificate issued & synced" },
  { key: 'inspect', label: 'Attach cert to FortiGate SSL inspection' },
  { key: 'live',    label: 'Site live' },
];

function stepList(steps) {
  return JSON.stringify(steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' })));
}

function setSiteStep(siteId, key, status, note) {
  const row = db.prepare('SELECT steps FROM caddy_sites WHERE id = ?').get(siteId);
  let steps = [];
  try { steps = row?.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
  db.prepare('UPDATE caddy_sites SET steps = ? WHERE id = ?').run(JSON.stringify(steps), siteId);
}

function setSiteStatus(siteId, status, detail) {
  db.prepare('UPDATE caddy_sites SET status = ?, status_detail = ? WHERE id = ?').run(status, detail ?? '', siteId);
}

// ─── Route conflicts + end-to-end verification ────────────────────────────────

// Phrase a shadowing route for the stepper. It names the upstream the winning
// route actually dials, because that single fact is what ends the investigation
// — the symptom is a 502 mentioning an address the portal was never given.
function conflictMessage(domain, conflict) {
  const what = conflict.upstream
    ? `reverse-proxies it to ${conflict.upstream}`
    : `serves it (${conflict.kinds.join(', ') || 'unknown handler'})`;
  return `Another route on Caddy http server "${conflict.server}" already matches ${domain}`
    + `${conflict.hosts.length ? ` (as ${conflict.hosts.join(', ')})` : ''} and Caddy reaches it first, so it ${what} `
    + 'and this site\'s route is never evaluated. Homelabrrr did not create that route — it is almost certainly a site '
    + 'block in the Caddy host\'s Caddyfile — so it is left untouched. Remove or rename that block, reload Caddy, then Retry.';
}

// Read the live route array back after a push and report anything that shadows
// us. Returns null when the config could not be read — an unverified push is
// reported as unverified, never as verified.
async function checkForConflicts(caddy, siteId, domain) {
  try {
    return await caddy.findConflicts(siteId, domain);
  } catch {
    return null;
  }
}

function recordConflict(site, conflicts) {
  const message = conflictMessage(site.domain, conflicts[0]);
  setSiteStep(site.id, 'push', 'blocked', message);
  setSiteStatus(site.id, 'conflict', message);
  logAuditEntry({
    action: 'website_route_conflict',
    target: site.domain,
    detail: `shadowed on caddy server "${conflicts[0].server}" by a route to ${conflicts[0].upstream || conflicts[0].kinds.join(',') || 'unknown'}`,
  });
  console.warn(`[websites] site ${site.id} (${site.domain}) is shadowed by a pre-existing Caddy route — ${message}`);
}

// One HTTPS request to the published domain, aimed straight at the Caddy host so
// no hairpin-NAT-dependent DNS lookup is involved. Returns null when there is no
// address to aim at, which the caller treats as "not verified" rather than
// "broken" — an unprobeable server must not turn every publish into a failure.
async function probePublishedSite(server, domain) {
  const address = probeAddressFor(server);
  if (!address) return null;
  return probeSite({ address, port: PROBE_PORT, domain });
}

function recordProbe(siteId, probe) {
  db.prepare('UPDATE caddy_sites SET probe_status = ?, probe_http_status = ?, probe_detail = ?, probe_at = datetime(\'now\') WHERE id = ?')
    .run(probe.kind, probe.status || 0, probe.message, siteId);
}

// The single place a site becomes 'live'. It does so only after an actual
// request to the published domain came back serving — "the route was pushed" was
// never evidence that anyone can load the site.
async function finishLive(siteId, site, server, detail) {
  const probe = await probePublishedSite(server, site.domain);
  if (!probe) {
    setSiteStep(siteId, 'live', 'done', 'Could not verify the site end-to-end — the Caddy server has no probeable address.');
    setSiteStatus(siteId, 'live', detail || '');
    return;
  }
  recordProbe(siteId, probe);
  if (probe.ok) {
    setSiteStep(siteId, 'live', 'done', probe.message);
    setSiteStatus(siteId, 'live', detail || '');
    return;
  }
  // The route is in place; what failed is downstream of it. 'upstream' is the
  // user's own service and reads as an error they can act on; the rest are
  // waiting-on-something states.
  setSiteStep(siteId, 'live', probe.kind === 'upstream' ? 'error' : 'blocked', probe.message);
  setSiteStatus(siteId, 'warning', probe.message);
  console.warn(`[websites] site ${siteId} (${site.domain}) published but not serving: ${probe.message}`);
}

// ─── Serializers ───────────────────────────────────────────────────────────────

function serializeSite(row) {
  let steps = [];
  try { steps = row.steps ? JSON.parse(row.steps) : []; } catch { steps = []; }
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name || '',
    domain: row.domain,
    upstreamHost: row.upstream_host,
    upstreamPort: row.upstream_port,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username || null,
    status: row.status,
    statusDetail: row.status_detail || '',
    steps,
    fortigateId: row.fortigate_id,
    inspectionProfile: row.inspection_profile || '',
    certName: row.cert_name || '',
    managed: row.managed !== 0,
    kind: row.kind || 'reverse_proxy',
    wildcard: row.wildcard || '',
    // What an actual HTTPS request to the domain last observed (see caddyProbe).
    probe: row.probe_at
      ? { status: row.probe_status || '', httpStatus: row.probe_http_status || 0, detail: row.probe_detail || '', at: row.probe_at }
      : null,
    createdAt: row.created_at,
    url: `https://${row.domain}`,
  };
}

function serializeServer(row) {
  const fw = row.fortigate_id ? db.prepare('SELECT name, external_ip, wan_interface, root_vdom FROM firewalls WHERE id = ?').get(row.fortigate_id) : null;
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    authType: row.auth_type || 'none',
    hasAuth: !!row.auth_secret,
    serverName: row.server_name || '',
    verifyTls: row.verify_tls !== 0,
    wanIp: effectiveWanIp(row),
    wanIpManual: row.wan_ip || '',
    fortigateId: row.fortigate_id || null,
    fortigateName: fw?.name || null,
    inspectionProfile: row.inspection_profile || '',
    inspectionBundleCert: row.inspection_bundle_cert || '',
    mode: sshConfigured(row) ? 'caddyfile' : 'api',
    sshHost: row.ssh_host || '',
    sshPort: row.ssh_port || 22,
    sshUser: row.ssh_user || '',
    sshAuthType: row.ssh_auth_type || 'key',
    hasSshSecret: !!row.ssh_secret,
    sshHostKey: row.ssh_host_key || '',
    snippetPath: row.snippet_path || '/etc/caddy/homelabrrr.caddy',
    caddyfilePath: row.caddyfile_path || '/etc/caddy/Caddyfile',
    createdAt: row.created_at,
    siteCount: db.prepare('SELECT COUNT(*) AS c FROM caddy_sites WHERE server_id = ?').get(row.id).c,
  };
}

// ─── Lookups ───────────────────────────────────────────────────────────────────

function getServerRow(id) {
  return db.prepare('SELECT * FROM caddy_servers WHERE id = ?').get(id);
}

// WAN IP used for DNS validation: the explicit manual value wins; otherwise fall
// back to the linked FortiGate's stored external IP.
function effectiveWanIp(server) {
  if (server.wan_ip) return server.wan_ip;
  if (server.fortigate_id) {
    const fw = db.prepare('SELECT external_ip FROM firewalls WHERE id = ?').get(server.fortigate_id);
    if (fw?.external_ip) return fw.external_ip;
  }
  return '';
}

// A site row joined with its owner + server name, scoped for reads.
const SITE_SELECT = `
  SELECT s.*, u.username AS owner_username, cs.name AS server_name, cs.server_name AS caddy_server_name
  FROM caddy_sites s
  LEFT JOIN users u ON u.id = s.owner_user_id
  LEFT JOIN caddy_servers cs ON cs.id = s.server_id
`;

function loadSiteForUser(req, id) {
  const row = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(id);
  if (!row) return { row: null };
  const owns = req.session.isAdmin || row.owner_user_id === req.session.userId;
  return { row, owns };
}

// ─── FortiGate cert discovery ──────────────────────────────────────────────────

function deriveCertCandidates(domain, wildcard = '') {
  const names = new Set();
  const add = (d) => {
    names.add(d);
    names.add(d.replace(/\./g, '_'));
    names.add(d.replace(/\./g, '-'));
    names.add(`cert-${d}`);
    names.add(`le-${d}`);
  };
  add(domain.toLowerCase());
  // A site under a wildcard block is covered by the *wildcard* cert, so also
  // try the names sync tools commonly give it (e.g. caddy-forticertsync's
  // `wildcard_example_com` for *.example.com).
  if (wildcard) {
    const base = wildcard.replace(/^\*\./, '').toLowerCase();
    names.add(wildcard.toLowerCase());
    names.add(`_.${base}`);
    add(base);
    for (const b of [base, base.replace(/\./g, '_'), base.replace(/\./g, '-')]) {
      for (const prefix of ['wildcard_', 'wildcard-', 'wildcard.', 'star_', 'star-']) {
        names.add(`${prefix}${b}`);
      }
    }
  }
  return [...names];
}

// Find the local certificate `caddy-forticertsync` synced for this domain (or
// the wildcard covering it). Matching is ranked rather than first-hit, because
// which cert we pick decides which inspection-profile slot gets written:
//
//   1. the cert whose derived subject IS the domain (a renewal differs from its
//      predecessor only by the `_DDMMYYYY` stamp, so subject equality is what
//      identifies "this site's cert" across renewals);
//   2. a wildcard cert that covers the domain — one slot serving every host
//      under it;
//   3. exact name equality against the older hand-rolled derivations, kept for
//      certs synced by other tooling;
//   4. the legacy normalized-substring fallback, last because it is loose
//      enough to return an apex cert for a subdomain.
//
// Within a tier the newest date stamp wins, so a freshly renewed cert is
// preferred over the predecessor still sitting in the store.
async function findSyncedCert(fwClient, rootVdom, domain, wildcard = '') {
  const certs = await fwClient.getLocalCertificates(rootVdom);
  const candidates = deriveCertCandidates(domain, wildcard);
  const normalize = (s) => String(s || '').toLowerCase().replace(/[_-]/g, '.');
  const targets = [domain.toLowerCase()];
  if (wildcard) targets.push(wildcard.replace(/^\*\./, '').toLowerCase());

  const tierOf = (name) => {
    const subject = certNameToSubject(name);
    if (subject && subject === domain.toLowerCase()) return 1;
    if (certWildcardCovers(name, domain)) return 2;
    if (candidates.includes(String(name || '').toLowerCase())) return 3;
    if (targets.some((t) => normalize(name).includes(t))) return 4;
    return 99;
  };

  let best = null;
  for (const cert of certs) {
    const name = String(cert.name || '');
    if (!name) continue;
    const tier = tierOf(name);
    if (tier === 99) continue;
    // The stamp is DDMMYYYY, so compare it as YYYYMMDD to order correctly.
    const stamp = name.slice(stripCertDateSuffix(name).length).replace(/^[_-]/, '');
    const sortable = stamp.length === 8 ? stamp.slice(4) + stamp.slice(2, 4) + stamp.slice(0, 2) : '';
    if (!best || tier < best.tier || (tier === best.tier && sortable > best.sortable)) {
      best = { name, tier, sortable };
    }
  }
  return best ? best.name : null;
}

// Find the live object for `caddy-forticertsync`'s inspection bundle: one
// multi-SAN certificate covering every published domain, stored under
// `<baseName>_<DDMMYYYY>`. Returns the newest generation, or null if the plugin
// has not pushed one yet.
async function findBundleCert(fwClient, rootVdom, baseName) {
  const base = String(baseName || '').trim().toLowerCase();
  if (!base) return null;
  const certs = await fwClient.getLocalCertificates(rootVdom);
  let best = null;
  for (const cert of certs) {
    const name = String(cert.name || '');
    if (stripCertDateSuffix(name).toLowerCase() !== base) continue;
    // DDMMYYYY compared as YYYYMMDD so generations order correctly.
    const stamp = name.slice(stripCertDateSuffix(name).length).replace(/^[_-]/, '');
    const sortable = stamp.length === 8 ? stamp.slice(4) + stamp.slice(2, 4) + stamp.slice(0, 2) : '';
    if (!best || sortable > best.sortable) best = { name, sortable };
  }
  return best ? best.name : null;
}

// ─── Caddyfile snippet sync + API-route reconciliation ─────────────────────────

// Everything Homelabrrr owns on a server, in the shape the snippet needs.
// Error'd rows are left out (their DNS/upstream may be wrong); anything mid-
// flight or live is included so a sync mid-publish can't drop a site.
function managedSitesForSnippet(serverId) {
  return db.prepare(
    "SELECT * FROM caddy_sites WHERE server_id = ? AND managed != 0 AND status != 'error' ORDER BY domain"
  ).all(serverId);
}

// Regenerate + push the snippet, pinning the SSH host key on first use.
async function syncServerSnippet(server) {
  const result = await deploySnippet(server, managedSitesForSnippet(server.id));
  if (!server.ssh_host_key && result.fingerprint) {
    db.prepare('UPDATE caddy_servers SET ssh_host_key = ? WHERE id = ?').run(result.fingerprint, server.id);
  }
  return result;
}

// Which wildcard (if any) covers a domain: ask the live Caddy config first,
// fall back to wildcards already recorded on this server's rows (imports).
async function detectWildcard(caddy, serverId, domain) {
  try {
    const slot = await caddy.findWildcardSlot(domain);
    if (slot?.wildcard) return slot.wildcard;
  } catch { /* admin API unreachable — fall back to what we know */ }
  const known = db.prepare(
    "SELECT DISTINCT wildcard FROM caddy_sites WHERE server_id = ? AND wildcard != ''"
  ).all(serverId);
  const hit = known.find((r) => hostCoveredByWildcard(domain, r.wildcard));
  return hit ? hit.wildcard : '';
}

// API mode only: re-push any managed route missing from the live config (a
// `caddy reload` from the Caddyfile wipes admin-API routes).
//
// The re-push is conflict-checked exactly like the publish path. Self-healing a
// route back into a position where it is shadowed would restore the config and
// none of the behaviour, which is the failure this whole check exists to catch.
async function reconcileManagedRoutes(server) {
  const sites = db.prepare(
    "SELECT * FROM caddy_sites WHERE server_id = ? AND managed != 0 AND status IN ('live', 'warning', 'blocked')"
  ).all(server.id);
  if (sites.length === 0) return { repaired: [], conflicted: [] };
  const caddy = createCaddyClient(server);
  const liveIds = new Set(await caddy.listManagedRouteIds());
  const repaired = [];
  const conflicted = [];
  for (const site of sites) {
    if (liveIds.has(managedRouteId(site.id))) continue;
    const { wildcard } = await caddy.upsertRoute(site.id, site.domain, site.upstream_host, site.upstream_port);
    const conflicts = await checkForConflicts(caddy, site.id, site.domain);
    if (conflicts?.length) {
      recordConflict(site, conflicts);
      conflicted.push(site.domain);
      continue;
    }
    db.prepare('UPDATE caddy_sites SET wildcard = ? WHERE id = ?').run(wildcard || '', site.id);
    repaired.push(site.domain);
  }
  return { repaired, conflicted };
}

// Re-probe published sites so breakage surfaces here rather than in a user's
// bug report. Only the two probe-owned states move: a live site that stops
// serving drops to warning, and a site warned about by a previous probe returns
// to live once it serves again. Nothing else is touched — a 'blocked' or
// 'conflict' site is waiting on an operator, not on a probe.
async function reprobeSites(server) {
  const sites = db.prepare(
    "SELECT * FROM caddy_sites WHERE server_id = ? AND managed != 0 AND status IN ('live', 'warning')"
  ).all(server.id);
  for (const site of sites) {
    const probe = await probePublishedSite(server, site.domain);
    if (!probe) return;   // nothing probeable on this server at all
    const wasFailing = !!site.probe_status && site.probe_status !== 'serving';
    recordProbe(site.id, probe);
    if (site.status === 'live' && !probe.ok) {
      setSiteStep(site.id, 'live', probe.kind === 'upstream' ? 'error' : 'blocked', probe.message);
      setSiteStatus(site.id, 'warning', probe.message);
      console.warn(`[websites] ${site.domain} stopped serving: ${probe.message}`);
    } else if (site.status === 'warning' && probe.ok && wasFailing) {
      setSiteStep(site.id, 'live', 'done', probe.message);
      setSiteStatus(site.id, 'live', '');
      console.log(`[websites] ${site.domain} is serving again: ${probe.message}`);
    }
  }
}

// Background maintenance tick. API-mode servers get their missing routes
// re-pushed (Caddyfile-sync servers need nothing — reloads read the snippet),
// and every server's published sites get re-probed.
//
// The interval is configurable like every other background loop here, and the
// timer is delayed + unref'd like the lease sweeper and tag sync: nothing useful
// happens in the first seconds after boot, and a ticker should never be the
// reason the process stays alive.
const RECONCILE_MS = Math.max(
  60_000,
  parseInt(process.env.WEBSITE_RECONCILE_INTERVAL_MS || '300000', 10) || 300_000,
);
const RECONCILE_START_DELAY_MS = 45_000;

async function websiteMaintenanceTick() {
  let servers = [];
  try { servers = db.prepare('SELECT * FROM caddy_servers').all(); } catch { return; }
  for (const server of servers) {
    try {
      if (!sshConfigured(server)) {
        const { repaired, conflicted } = await reconcileManagedRoutes(server);
        if (repaired.length) console.log(`[websites] re-pushed ${repaired.length} Caddy route(s) on "${server.name}" after a config reload: ${repaired.join(', ')}`);
        if (conflicted.length) console.warn(`[websites] ${conflicted.length} route(s) on "${server.name}" are shadowed by routes Homelabrrr does not own: ${conflicted.join(', ')}`);
      }
      await reprobeSites(server);
    } catch { /* server offline — next tick */ }
  }
}

const reconcileTimer = setInterval(() => { websiteMaintenanceTick(); }, RECONCILE_MS);
reconcileTimer.unref?.();
const reconcileStartTimer = setTimeout(() => { websiteMaintenanceTick(); }, RECONCILE_START_DELAY_MS);
reconcileStartTimer.unref?.();

export function stopWebsiteMaintenance() {
  clearInterval(reconcileTimer);
  clearTimeout(reconcileStartTimer);
}

// ─── The end-to-end publish flow (runs in the background) ──────────────────────

const CERT_POLL_ATTEMPTS = 30;
const CERT_POLL_MS = 6000;

async function runSiteFlow(siteId) {
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(siteId);
  if (!site) return;
  // Imported sites mirror routes owned by the Caddyfile — never push for them.
  if (site.managed === 0) return;
  const server = getServerRow(site.server_id);
  if (!server) {
    setSiteStep(siteId, 'push', 'error', 'Caddy server no longer registered');
    setSiteStatus(siteId, 'error', 'The Caddy server for this site was removed.');
    return;
  }

  // ── Push the route ──────────────────────────────────────────────────────────
  // Caddyfile-sync servers get the snippet regenerated + a validated reload
  // (persistent across the user's own reloads); API-mode servers get an
  // admin-API route (re-pushed by the reconcile tick if a reload drops it).
  setSiteStep(siteId, 'push', 'active');
  setSiteStatus(siteId, 'pushing', '');
  let wildcard = '';
  try {
    const caddy = createCaddyClient(server);
    if (sshConfigured(server)) {
      wildcard = await detectWildcard(caddy, server.id, site.domain);
      db.prepare('UPDATE caddy_sites SET wildcard = ? WHERE id = ?').run(wildcard, siteId);
      await syncServerSnippet(server);
      setSiteStep(siteId, 'push', 'done', wildcard
        ? `Caddyfile snippet updated & Caddy reloaded — the ${wildcard} wildcard certificate covers this site`
        : 'Caddyfile snippet updated & Caddy reloaded');
    } else {
      const pushed = await caddy.upsertRoute(siteId, site.domain, site.upstream_host, site.upstream_port);
      wildcard = pushed.wildcard || '';
      db.prepare('UPDATE caddy_sites SET wildcard = ? WHERE id = ?').run(wildcard, siteId);

      // A 2xx from the admin API only means the route was *stored*. Read the
      // route array back: an appended route always loses to a Caddyfile-derived
      // one for the same hostname, so a conflict here is fatal, not a race.
      const conflicts = await checkForConflicts(caddy, siteId, site.domain);
      if (conflicts === null) {
        setSiteStep(siteId, 'push', 'done', 'Route pushed, but the live config could not be read back to check for conflicting routes.');
      } else if (conflicts.length) {
        recordConflict(site, conflicts);
        return;
      } else if (wildcard) {
        setSiteStep(siteId, 'push', 'done', `Nested under the existing ${wildcard} block — its wildcard certificate covers this site`);
      } else {
        setSiteStep(siteId, 'push', 'done', pushed.serverName ? `Appended to Caddy http server "${pushed.serverName}" — no other route matches this domain` : 'No other route matches this domain');
      }
    }
  } catch (err) {
    // A plaintext-only http server is the operator's to fix on the Caddy host or
    // the server record — retrying the same push cannot change the outcome.
    if (err.code === 'caddy_no_https_server') {
      setSiteStep(siteId, 'push', 'blocked', err.message);
      setSiteStatus(siteId, 'blocked', err.message);
      console.warn(`[websites] site ${siteId} (${site.domain}) not published: ${err.message}`);
      return;
    }
    setSiteStep(siteId, 'push', 'error', err.message);
    setSiteStatus(siteId, 'error', `Could not publish the route to Caddy: ${err.message}`);
    return;
  }

  const fw = site.fortigate_id ? db.prepare('SELECT * FROM firewalls WHERE id = ?').get(site.fortigate_id) : null;
  const profileName = site.inspection_profile || '';

  // No inspection wiring requested → the site is already live through Caddy.
  // Two different situations land here with an empty profile, and only one of
  // them is a choice someone made: a server that never had inspection wired up,
  // versus a site deliberately kept out of a profile that does exist. Say which,
  // because the second is the answer to "why is this profile not filling up".
  if (!fw || !profileName) {
    const note = fw && server.inspection_profile
      ? `SSL inspection is off for this site — it holds none of "${server.inspection_profile}"'s ${SERVER_CERT_MAX} certificate slots`
      : 'No FortiGate inspection profile configured for this site';
    setSiteStep(siteId, 'cert', 'skipped', note);
    setSiteStep(siteId, 'inspect', 'skipped', note);
    await finishLive(siteId, site, server, 'Route published to Caddy. Certificate issuance is handled by Caddy/Let’s Encrypt.');
    return;
  }

  // ── Wait for the synced certificate, then attach it to the profile ──────────
  setSiteStep(siteId, 'cert', 'active');
  setSiteStatus(siteId, 'issuing', '');
  const rootVdom = fw.root_vdom || 'root';
  let certName = null;
  try {
    const client = createClient(fw);

    // Inspection-bundle mode: caddy-forticertsync maintains a single multi-SAN
    // certificate covering every published domain, so a new site needs no
    // certificate of its own and no profile write — its hostname is already
    // inside the bundle's `*.<parent>` SAN. This is the whole point of the
    // mode: publishing costs zero of the profile's 10 slots.
    if (server.inspection_bundle_cert) {
      const bundleCert = await findBundleCert(client, rootVdom, server.inspection_bundle_cert).catch(() => null);
      if (bundleCert) {
        db.prepare('UPDATE caddy_sites SET cert_name = ? WHERE id = ?').run(bundleCert, siteId);
        setSiteStep(siteId, 'cert', 'done', `Covered by the ${bundleCert} inspection bundle`);
        setSiteStep(siteId, 'inspect', 'done', `Bundle already attached to "${profileName}" — no slot used`);
        await finishLive(siteId, site, server, '');
        return;
      }
      // Configured but not on the firewall yet: fall through to per-domain
      // discovery rather than blocking, so a half-migrated setup still works.
      console.warn(`[websites] inspection bundle "${server.inspection_bundle_cert}" not found on ${fw.name} — falling back to per-domain certificate discovery`);
    }

    for (let i = 0; i < CERT_POLL_ATTEMPTS; i++) {
      certName = await findSyncedCert(client, rootVdom, site.domain, wildcard).catch(() => null);
      if (certName) break;
      await sleep(CERT_POLL_MS);
    }

    if (!certName) {
      setSiteStep(siteId, 'cert', 'skipped', 'Certificate not synced to the FortiGate yet — retry once Let’s Encrypt has issued it');
      setSiteStep(siteId, 'inspect', 'skipped', 'Waiting on the certificate');
      setSiteStep(siteId, 'live', 'done');
      setSiteStatus(siteId, 'warning', 'Site is served by Caddy, but the certificate has not synced to the FortiGate yet. Use Retry after a minute to wire up SSL inspection.');
      return;
    }

    setSiteStep(siteId, 'cert', 'done');
    db.prepare('UPDATE caddy_sites SET cert_name = ? WHERE id = ?').run(certName, siteId);

    // ── Attach the cert to the SSL/SSH inspection profile ─────────────────────
    setSiteStep(siteId, 'inspect', 'active');
    setSiteStatus(siteId, 'inspecting', '');
    const result = await client.setInspectionServerCert(profileName, certName, rootVdom, site.domain);
    setSiteStep(siteId, 'inspect', 'done', inspectNote(result, profileName));
    await finishLive(siteId, site, server, '');
  } catch (err) {
    // A full profile is terminal, not transient: FortiOS caps the inbound
    // server-cert list at SERVER_CERT_MAX and retrying the same PUT will fail
    // identically until a slot is freed on the firewall. Say so instead of
    // offering a Retry that cannot succeed.
    if (err.code === 'server_cert_limit') {
      setSiteStep(siteId, 'inspect', 'blocked', err.message);
      setSiteStep(siteId, 'live', 'done');
      setSiteStatus(siteId, 'blocked', `Route is live in Caddy, but SSL inspection could not be wired up: ${err.message}`);
      console.warn(`[websites] site ${siteId} (${site.domain}) blocked — inspection profile "${profileName}" is at its ${SERVER_CERT_MAX}-certificate limit`);
      return;
    }
    setSiteStep(siteId, 'inspect', 'error', err.message);
    setSiteStatus(siteId, 'warning', `Route is live in Caddy, but attaching the certificate to SSL inspection failed: ${err.message}. You can retry.`);
  }
}

// What actually happened on the inspection profile, phrased for the stepper.
function inspectNote(result, profileName) {
  switch (result?.action) {
    case 'covered':
      return `Already covered by the ${result.coveredBy} certificate on "${profileName}" — no slot used`;
    case 'replace':
      return `Replaced the superseded ${result.replaced} on "${profileName}"`;
    case 'already-attached':
      return `Already attached to "${profileName}"`;
    case 'append':
      return `Attached to "${profileName}" (${result.occupied.length} of ${SERVER_CERT_MAX} certificate slots used)`;
    default:
      return '';
  }
}

function startSiteFlow(siteId) {
  // Fire-and-forget; the UI polls status. Failures are captured onto the row.
  runSiteFlow(siteId).catch((err) => {
    console.error(`[websites] site ${siteId} flow crashed:`, err.message);
    try { setSiteStatus(siteId, 'error', sanitizeError(err.message)); } catch { /* ignore */ }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN — Caddy server registration
// ════════════════════════════════════════════════════════════════════════════

router.get('/servers', pWebsites, (req, res) => {
  const rows = db.prepare('SELECT * FROM caddy_servers ORDER BY name').all();
  res.json(rows.map(serializeServer));
});

function validateServerBody(body) {
  const { name, apiUrl } = body;
  if (!name || !apiUrl) return 'Name and admin API URL are required';
  let parsed;
  try { parsed = new URL(apiUrl); } catch { return 'Admin API URL is not a valid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Admin API URL must be http:// or https://';
  if (!parsed.hostname) return 'Admin API URL must include a host';
  const authType = body.authType || 'none';
  if (!AUTH_TYPES.has(authType)) return 'Invalid auth type';
  const verifyTls = body.verifyTls !== false;
  if (parsed.protocol === 'https:' && !verifyTls && !ALLOW_INSECURE_UPSTREAM_TLS) {
    return 'Disabling Caddy admin API TLS verification is blocked unless ALLOW_INSECURE_UPSTREAM_TLS=true is set';
  }
  const sshHost = String(body.sshHost ?? '').trim();
  if (sshHost) {
    if (!String(body.sshUser ?? '').trim()) return 'SSH user is required when Caddyfile sync is enabled';
    const sshPort = body.sshPort === undefined || body.sshPort === '' ? 22 : Number.parseInt(body.sshPort, 10);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return 'SSH port must be between 1 and 65535';
    if (!['key', 'password'].includes(body.sshAuthType || 'key')) return 'SSH auth type must be key or password';
    if (body.snippetPath && !isSafeRemotePath(body.snippetPath)) return 'Snippet path must be absolute, using only letters, digits, and . _ - /';
    if (body.caddyfilePath && !isSafeRemotePath(body.caddyfilePath)) return 'Caddyfile path must be absolute, using only letters, digits, and . _ - /';
  }
  return null;
}

router.post('/servers', pWebsites, async (req, res) => {
  const err = validateServerBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const {
    name, apiUrl, authType = 'none', authSecret = '', serverName = '', verifyTls = true, wanIp = '', fortigateId = null, inspectionProfile = '', inspectionBundleCert = '',
    sshHost = '', sshPort = 22, sshUser = '', sshAuthType = 'key', sshSecret = '',
    snippetPath = '/etc/caddy/homelabrrr.caddy', caddyfilePath = '/etc/caddy/Caddyfile',
  } = req.body;
  try {
    const r = db.prepare(`
      INSERT INTO caddy_servers (name, api_url, auth_type, auth_secret, server_name, verify_tls, wan_ip, fortigate_id, inspection_profile, inspection_bundle_cert,
                                 ssh_host, ssh_port, ssh_user, ssh_auth_type, ssh_secret, snippet_path, caddyfile_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, apiUrl, authType,
      authSecret ? encryptSecret(authSecret) : '',
      serverName, verifyTls ? 1 : 0, wanIp,
      fortigateId || null, inspectionProfile, String(inspectionBundleCert || '').trim(),
      String(sshHost).trim(), parseInt(sshPort, 10) || 22, String(sshUser).trim(), sshAuthType,
      sshSecret ? encryptSecret(sshSecret) : '',
      snippetPath || '/etc/caddy/homelabrrr.caddy', caddyfilePath || '/etc/caddy/Caddyfile',
    );
    logAudit(req, 'website_create_caddy_server', name, apiUrl);

    // Caddyfile sync configured: create the snippet right away so the admin
    // can add the `import` line to the Caddyfile without breaking a reload.
    let syncWarning = '';
    const created = getServerRow(r.lastInsertRowid);
    if (sshConfigured(created)) {
      try { await syncServerSnippet(created); }
      catch (e) { syncWarning = `Server saved, but the first Caddyfile sync failed: ${sanitizeError(e.message)}`; }
    }
    res.json({ id: r.lastInsertRowid, syncWarning });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

router.put('/servers/:id', pWebsites, async (req, res) => {
  const existing = getServerRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Caddy server not found' });
  const merged = {
    ...req.body,
    name: req.body.name ?? existing.name,
    apiUrl: req.body.apiUrl ?? existing.api_url,
    sshHost: req.body.sshHost ?? existing.ssh_host,
    sshPort: req.body.sshPort ?? existing.ssh_port,
    sshUser: req.body.sshUser ?? existing.ssh_user,
    sshAuthType: req.body.sshAuthType ?? existing.ssh_auth_type,
    snippetPath: req.body.snippetPath ?? existing.snippet_path,
    caddyfilePath: req.body.caddyfilePath ?? existing.caddyfile_path,
  };
  const err = validateServerBody(merged);
  if (err) return res.status(400).json({ error: err });

  const name = merged.name;
  const apiUrl = merged.apiUrl;
  const authType = req.body.authType ?? existing.auth_type;
  // Empty authSecret keeps the current one (matches the firewall/PVE pattern).
  const authSecret = req.body.authSecret ? encryptSecret(req.body.authSecret) : existing.auth_secret;
  const serverName = req.body.serverName ?? existing.server_name;
  const verifyTls = req.body.verifyTls === undefined ? existing.verify_tls !== 0 : !!req.body.verifyTls;
  const wanIp = req.body.wanIp ?? existing.wan_ip;
  const fortigateId = req.body.fortigateId === undefined ? existing.fortigate_id : (req.body.fortigateId || null);
  const inspectionProfile = req.body.inspectionProfile ?? existing.inspection_profile;
  const inspectionBundleCert = String(req.body.inspectionBundleCert ?? existing.inspection_bundle_cert ?? '').trim();
  const sshHost = String(merged.sshHost || '').trim();
  const sshPort = parseInt(merged.sshPort, 10) || 22;
  const sshUser = String(merged.sshUser || '').trim();
  const sshAuthType = merged.sshAuthType || 'key';
  const sshSecret = req.body.sshSecret ? encryptSecret(req.body.sshSecret) : existing.ssh_secret;
  // A different SSH host means a different host key — drop the pinned one.
  const sshHostKey = sshHost === (existing.ssh_host || '') ? existing.ssh_host_key : '';
  const snippetPath = merged.snippetPath || '/etc/caddy/homelabrrr.caddy';
  const caddyfilePath = merged.caddyfilePath || '/etc/caddy/Caddyfile';

  db.prepare(`
    UPDATE caddy_servers SET name = ?, api_url = ?, auth_type = ?, auth_secret = ?, server_name = ?, verify_tls = ?, wan_ip = ?, fortigate_id = ?, inspection_profile = ?, inspection_bundle_cert = ?,
                             ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_auth_type = ?, ssh_secret = ?, ssh_host_key = ?, snippet_path = ?, caddyfile_path = ? WHERE id = ?
  `).run(name, apiUrl, authType, authSecret, serverName, verifyTls ? 1 : 0, wanIp, fortigateId, inspectionProfile, inspectionBundleCert,
    sshHost, sshPort, sshUser, sshAuthType, sshSecret, sshHostKey, snippetPath, caddyfilePath, req.params.id);
  logAudit(req, 'website_update_caddy_server', name, apiUrl);

  let syncWarning = '';
  const updated = getServerRow(req.params.id);
  if (sshConfigured(updated)) {
    try { await syncServerSnippet(updated); }
    catch (e) { syncWarning = `Saved, but the Caddyfile sync failed: ${sanitizeError(e.message)}`; }
  }
  res.json({ ok: true, syncWarning });
});

router.delete('/servers/:id', pWebsites, (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  const siteCount = db.prepare('SELECT COUNT(*) AS c FROM caddy_sites WHERE server_id = ?').get(req.params.id).c;
  if (siteCount > 0) {
    return res.status(400).json({ error: `Remove the ${siteCount} published site(s) on this server first.` });
  }
  db.prepare('DELETE FROM caddy_servers WHERE id = ?').run(req.params.id);
  logAudit(req, 'website_delete_caddy_server', server.name, '');
  res.json({ ok: true });
});

router.get('/servers/:id/status', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  const mode = sshConfigured(server) ? 'caddyfile' : 'api';
  try {
    const caddy = createCaddyClient(server);
    const info = await caddy.ping();
    info.mode = mode;
    if (mode === 'api') {
      // Surface drift: managed sites whose admin-API route a reload wiped.
      const liveIds = new Set(await caddy.listManagedRouteIds().catch(() => []));
      info.missingRoutes = db.prepare(
        "SELECT id, domain FROM caddy_sites WHERE server_id = ? AND managed != 0 AND status IN ('live', 'warning', 'blocked')"
      ).all(server.id).filter((s) => !liveIds.has(managedRouteId(s.id))).map((s) => s.domain);
    }
    res.json(info);
  } catch (e) {
    res.json({ online: false, mode, error: e.message });
  }
});

// Manual sync: Caddyfile mode regenerates the snippet + reloads; API mode
// re-pushes any managed routes missing from the live config right now.
router.post('/servers/:id/sync', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  try {
    if (sshConfigured(server)) {
      const result = await syncServerSnippet(server);
      logAudit(req, 'website_sync_caddyfile', server.name, `${result.sites} site(s), reloaded`);
      return res.json({ mode: 'caddyfile', sites: result.sites, reloaded: result.reloaded });
    }
    const { repaired, conflicted } = await reconcileManagedRoutes(server);
    logAudit(req, 'website_sync_routes', server.name,
      `${repaired.length ? repaired.join(', ') : 'no drift'}${conflicted.length ? ` — shadowed: ${conflicted.join(', ')}` : ''}`);
    res.json({ mode: 'api', repaired, conflicted });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// Auto-read the WAN IP from the linked FortiGate (stored external IP, else the
// live WAN interface address) and store it as the manual value.
router.post('/servers/:id/detect-wan-ip', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  if (!server.fortigate_id) return res.status(400).json({ error: 'Link a FortiGate to this Caddy server first' });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(server.fortigate_id);
  if (!fw) return res.status(404).json({ error: 'Linked FortiGate not found' });
  try {
    let ip = fw.external_ip || '';
    if (!ip) {
      const client = createClient(fw);
      const iface = await client.getInterface(fw.wan_interface);
      ip = String(iface?.ip || '').split(' ')[0] || '';
    }
    if (!ip) return res.status(400).json({ error: 'Could not determine a WAN IP from the FortiGate' });
    db.prepare('UPDATE caddy_servers SET wan_ip = ? WHERE id = ?').run(ip, req.params.id);
    logAudit(req, 'website_detect_wan_ip', server.name, ip);
    res.json({ wanIp: ip });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// ─── Import of pre-existing sites from the Caddy config ────────────────────────
// Discovery reads the live config through the admin API and lists every site
// Homelabrrr didn't create (hand-written Caddyfile blocks, incl. hosts nested
// inside wildcard blocks like *.example.com). Import records selected ones as
// managed=0 rows: visible in the portal, occupying their domain (so nobody can
// re-publish over them), but never pushed to / deleted from Caddy.

function annotateDiscovered(serverId, sites) {
  const existingStmt = db.prepare('SELECT id, server_id FROM caddy_sites WHERE domain = ?');
  return sites.map((s) => {
    const existing = existingStmt.get(s.domain);
    let blockedReason = '';
    if (existing) {
      blockedReason = existing.server_id === serverId
        ? 'Already registered in Homelabrrr'
        : 'Domain already registered on another Caddy server';
    } else if (s.domain.includes('*')) {
      blockedReason = 'Wildcard block — its hostnames are listed individually';
    } else if (!isValidDomain(s.domain)) {
      blockedReason = 'Not a public hostname (IP or internal address)';
    } else if (!['reverse_proxy', 'file_server', 'static'].includes(s.kind)) {
      blockedReason = 'Unsupported route type';
    }
    return { ...s, existing: !!existing, importable: !blockedReason, blockedReason };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
}

router.get('/servers/:id/discover', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  try {
    const caddy = createCaddyClient(server);
    const { sites, managedCount } = await caddy.discoverSites();
    res.json({ sites: annotateDiscovered(server.id, sites), managedCount });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

router.post('/servers/:id/import', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  // Only domain names are accepted from the client — upstream/kind/wildcard are
  // re-read from the live Caddy config so nothing user-supplied lands in a row.
  const requested = Array.isArray(req.body.domains) ? req.body.domains.map(normalizeDomain) : null;
  try {
    const caddy = createCaddyClient(server);
    const { sites } = await caddy.discoverSites();
    const annotated = annotateDiscovered(server.id, sites);
    const byDomain = new Map(annotated.map((s) => [s.domain, s]));
    const targets = requested ?? annotated.filter((s) => s.importable).map((s) => s.domain);

    const insert = db.prepare(`
      INSERT INTO caddy_sites (server_id, domain, upstream_host, upstream_port, owner_user_id, status, status_detail, steps, fortigate_id, inspection_profile, managed, kind, wildcard)
      VALUES (?, ?, ?, ?, NULL, 'live', ?, '[]', NULL, '', 0, ?, ?)
    `);
    const imported = [];
    const skipped = [];
    for (const domain of targets) {
      const entry = byDomain.get(domain);
      if (!entry) { skipped.push({ domain, reason: 'Not found in the Caddy config' }); continue; }
      if (!entry.importable) { skipped.push({ domain, reason: entry.blockedReason }); continue; }
      insert.run(
        server.id, domain, entry.upstreamHost || '', entry.upstreamPort || 0,
        'Imported from Caddy — this route is managed in the Caddyfile, not by Homelabrrr.',
        entry.kind || 'reverse_proxy', entry.wildcard || '',
      );
      imported.push(domain);
    }
    logAudit(req, 'website_import_sites', server.name, `${imported.length} imported, ${skipped.length} skipped`);
    res.json({ imported, skipped });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// SSL/SSH inspection profiles + local certs on the linked FortiGate (admin, for
// picking the profile to wire certs into).
router.get('/servers/:id/inspection-profiles', pWebsites, async (req, res) => {
  const server = getServerRow(req.params.id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  if (!server.fortigate_id) return res.json({ profiles: [], certificates: [] });
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(server.fortigate_id);
  if (!fw) return res.status(404).json({ error: 'Linked FortiGate not found' });
  try {
    const client = createClient(fw);
    const rootVdom = fw.root_vdom || 'root';
    const [profiles, certs] = await Promise.all([
      client.getSslSshProfiles(rootVdom),
      client.getLocalCertificates(rootVdom),
    ]);
    res.json({
      profiles: profiles.map((p) => ({ name: p.name, comment: p.comment || '' })),
      certificates: certs.map((c) => ({ name: c.name })),
    });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  ADMIN — all sites + ownership assignment
// ────────────────────────────────────────────────────────────────────────────

router.get('/admin/sites', pWebsites, (req, res) => {
  const rows = db.prepare(`${SITE_SELECT} ORDER BY s.created_at DESC`).all();
  res.json(rows.map(serializeSite));
});

// Minimal directories for the admin dropdowns. Exposed under can_manage_websites
// so a websites-only admin isn't forced to also hold can_manage_users /
// can_manage_firewalls just to assign an owner or link a FortiGate.
router.get('/admin/users', pWebsites, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin FROM users ORDER BY username').all();
  res.json(users.map((u) => ({ id: u.id, username: u.username, isAdmin: u.is_admin === 1 })));
});

router.get('/firewalls', pWebsites, (req, res) => {
  const fws = db.prepare('SELECT id, name, wan_interface, external_ip, root_vdom FROM firewalls ORDER BY name').all();
  res.json(fws.map((f) => ({ id: f.id, name: f.name, wanInterface: f.wan_interface, externalIp: f.external_ip || '', rootVdom: f.root_vdom || 'root' })));
});

router.post('/admin/sites/:id/assign', pWebsites, (req, res) => {
  const { userId } = req.body;
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  let newOwner = null;
  if (userId !== null && userId !== undefined && userId !== '') {
    newOwner = parseInt(userId, 10);
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(newOwner);
    if (!target) return res.status(404).json({ error: 'User not found' });
  }
  db.prepare('UPDATE caddy_sites SET owner_user_id = ? WHERE id = ?').run(newOwner, req.params.id);
  logAudit(req, 'website_assign_site', site.domain, `owner=${newOwner ?? 'none'}`);
  res.json({ ok: true });
});

router.delete('/admin/sites/:id', pWebsites, async (req, res) => {
  const site = db.prepare('SELECT * FROM caddy_sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  await removeSite(site, req);
  logAudit(req, 'website_delete_site', site.domain, 'admin');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  USER — self-service publishing
// ════════════════════════════════════════════════════════════════════════════

// Servers a user can publish to + whether they'd be able to (needs a WAN IP).
router.get('/config', (req, res) => {
  const servers = db.prepare('SELECT * FROM caddy_servers ORDER BY name').all().map((s) => ({
    id: s.id,
    name: s.name,
    wanIp: effectiveWanIp(s),
    hasInspection: !!(s.fortigate_id && s.inspection_profile),
  }));
  res.json({ servers, isAdmin: !!req.session.isAdmin });
});

// The concrete upstream targets this user is allowed to point a site at.
router.get('/upstream-options', (req, res) => {
  if (req.session.isAdmin) {
    return res.json({ isAdmin: true, vms: [], subnets: [] });
  }
  const { vmIps, subnets } = getUserAllowedUpstreams(req.session.userId);
  // Enrich the raw IPs with the assigned VM identity for a friendlier picker.
  const assignments = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(req.session.userId);
  const sshStmt = db.prepare('SELECT host FROM vm_ssh_configs WHERE vmid = ?');
  const vms = [];
  for (const a of assignments) {
    const cfg = sshStmt.get(a.vmid);
    if (cfg?.host && vmIps.includes(cfg.host)) {
      vms.push({ vmid: a.vmid, node: a.node, ip: cfg.host });
    }
  }
  res.json({ isAdmin: false, vms, subnets, vmIps });
});

router.get('/sites', (req, res) => {
  const rows = req.session.isAdmin
    ? db.prepare(`${SITE_SELECT} ORDER BY s.created_at DESC`).all()
    : db.prepare(`${SITE_SELECT} WHERE s.owner_user_id = ? ORDER BY s.created_at DESC`).all(req.session.userId);
  res.json(rows.map(serializeSite));
});

router.get('/sites/:id', (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  res.json(serializeSite(row));
});

router.get('/sites/:id/status', (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  res.json(serializeSite(row));
});

// Pre-flight DNS check used by the publishing stepper (no row created).
router.post('/validate-dns', dnsLimiter, async (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'Enter a valid domain name (e.g. app.example.com)' });
  const server = getServerRow(req.body.serverId);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });
  try {
    const result = await validateDomainDns(domain, effectiveWanIp(server));
    // Admins aren't blocked by a failing check (see POST /sites) — let the UI say so.
    res.json({ ...result, adminOverride: !!req.session.isAdmin });
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e.message) });
  }
});

// Shared validation for create/update.
function validateSiteInput(req, { domain, upstreamHost, upstreamPort }) {
  const d = normalizeDomain(domain);
  if (!isValidDomain(d)) return { error: 'Enter a valid domain name (e.g. app.example.com)' };
  if (!isValidUpstreamHost(upstreamHost)) return { error: 'Upstream host must be a valid IP address or hostname' };
  const port = parsePort(upstreamPort);
  if (port === null) return { error: 'Upstream port must be between 1 and 65535' };
  const reach = userCanReachUpstream(req.session.userId, upstreamHost, req.session.isAdmin);
  if (!reach.ok) return { error: reach.message };
  return { domain: d, upstreamHost, upstreamPort: port };
}

// Resolve which SSL/SSH inspection profile a site is published against.
//
// `''` means "push the route to Caddy and leave the FortiGate alone", and it is
// a deliberate, supported outcome — not a misconfiguration. A profile holds at
// most SERVER_CERT_MAX inbound server certificates, so every site wired into one
// spends a slot. A domain the inspection bundle cannot cover (its zone has no
// DNS-01 credentials, so `caddy-forticertsync` cannot issue a wildcard for it)
// spends that slot on a single hostname — and once the profile is full, every
// later publish is blocked until someone frees a slot on the firewall by hand.
// Turning inspection off for those sites is what keeps the profile from filling.
//
// Only admins may override. `inspectionProfile` pins a specific profile (or ''
// for off) and wins when supplied; `inspect` is the boolean the UI sends, where
// false means off and true restores `onValue`.
function resolveInspectionProfile(req, { current, onValue }) {
  if (!req.session.isAdmin) return current;
  if (req.body.inspectionProfile !== undefined) return String(req.body.inspectionProfile || '').trim();
  if (req.body.inspect !== undefined) return req.body.inspect ? onValue : '';
  return current;
}

router.post('/sites', dnsLimiter, async (req, res) => {
  const server = getServerRow(req.body.serverId);
  if (!server) return res.status(404).json({ error: 'Select a valid Caddy server' });

  const parsed = validateSiteInput(req, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { domain, upstreamHost, upstreamPort } = parsed;

  // Domain uniqueness — friendly message before we hit the UNIQUE constraint.
  const clash = db.prepare('SELECT owner_user_id, managed FROM caddy_sites WHERE domain = ?').get(domain);
  if (clash) {
    if (clash.managed === 0) {
      return res.status(409).json({ error: 'This domain already exists on the Caddy server (imported from its Caddyfile) — change it there instead.' });
    }
    const mine = clash.owner_user_id === req.session.userId;
    return res.status(409).json({ error: mine ? 'You have already published this domain.' : 'This domain is already published by another user.' });
  }

  // DNS must point at the WAN IP before we create anything — for non-admins.
  // Admins may publish ahead of the check: legitimate setups fail it (a fresh
  // subdomain whose record isn't created yet, Cloudflare-proxied records that
  // resolve to CF edge IPs, split-horizon DNS). The result is recorded on the
  // dns step instead of blocking.
  const wanIp = effectiveWanIp(server);
  let dnsResult;
  try {
    dnsResult = await validateDomainDns(domain, wanIp);
  } catch (e) {
    return res.status(500).json({ error: sanitizeError(e.message) });
  }
  if (!dnsResult.ok && !req.session.isAdmin) return res.status(400).json({ error: dnsResult.message });

  // Inspection wiring defaults come from the server; only admins may override.
  const fortigateId = req.session.isAdmin && req.body.fortigateId !== undefined
    ? (req.body.fortigateId || null)
    : (server.fortigate_id || null);
  const inspectionProfile = resolveInspectionProfile(req, {
    current: server.inspection_profile || '',
    onValue: server.inspection_profile || '',
  });

  const steps = INITIAL_STEPS.map((s) => {
    if (s.key !== 'dns') return { ...s, status: 'pending' };
    return dnsResult.ok
      ? { ...s, status: 'done' }
      : { ...s, status: 'skipped', note: `Published without DNS verification (admin): ${dnsResult.message}` };
  });

  let siteId;
  try {
    const r = db.prepare(`
      INSERT INTO caddy_sites (server_id, domain, upstream_host, upstream_port, owner_user_id, status, status_detail, steps, fortigate_id, inspection_profile)
      VALUES (?, ?, ?, ?, ?, 'pushing', '', ?, ?, ?)
    `).run(server.id, domain, upstreamHost, upstreamPort, req.session.userId, stepList(steps), fortigateId, inspectionProfile);
    siteId = r.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This domain is already published.' });
    }
    return res.status(500).json({ error: sanitizeError(e.message) });
  }

  logAudit(req, 'website_create_site', domain, `${upstreamHost}:${upstreamPort} → caddy#${server.id}`);
  startSiteFlow(siteId);

  const row = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(siteId);
  res.json(serializeSite(row));
});

router.put('/sites/:id', dnsLimiter, async (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  if (row.managed === 0) return res.status(400).json({ error: 'This site was imported from Caddy and is managed in the Caddyfile — edit it there.' });
  const server = getServerRow(row.server_id);
  if (!server) return res.status(404).json({ error: 'Caddy server not found' });

  // Domain is immutable (it's the UNIQUE identity + the cert subject); only the
  // upstream target can change. Re-validate ownership of the new upstream.
  const parsed = validateSiteInput(req, { domain: row.domain, upstreamHost: req.body.upstreamHost, upstreamPort: req.body.upstreamPort });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  // Admins may also flip this site's SSL-inspection wiring after the fact —
  // turning it off is how a slot on a full profile gets freed without deleting
  // the site (see resolveInspectionProfile).
  const nextProfile = resolveInspectionProfile(req, {
    current: row.inspection_profile || '',
    onValue: row.inspection_profile || server.inspection_profile || '',
  });
  const inspectionChanged = nextProfile !== (row.inspection_profile || '');

  // Hand the slot back before the row changes: releaseInspectionSlot reads the
  // profile and cert name off the row it is given, so clearing them first would
  // leave the certificate attached to the profile with nothing left to find it.
  if (inspectionChanged && !nextProfile) {
    await releaseInspectionSlot(row, req);
  }

  db.prepare('UPDATE caddy_sites SET upstream_host = ?, upstream_port = ?, inspection_profile = ?, cert_name = ? WHERE id = ?')
    .run(parsed.upstreamHost, parsed.upstreamPort, nextProfile, nextProfile ? row.cert_name : '', row.id);
  logAudit(req, 'website_update_site', row.domain,
    `${parsed.upstreamHost}:${parsed.upstreamPort}`
    + (inspectionChanged ? ` — SSL inspection ${nextProfile ? `→ "${nextProfile}"` : 'off'}` : ''));

  // Reset the pipeline and re-run so Caddy gets the new upstream.
  const steps = INITIAL_STEPS.map((s) => ({ ...s, status: s.key === 'dns' ? 'done' : 'pending' }));
  db.prepare('UPDATE caddy_sites SET steps = ?, status = ?, status_detail = ? WHERE id = ?')
    .run(stepList(steps), 'pushing', '', row.id);
  startSiteFlow(row.id);

  const updated = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(row.id);
  res.json(serializeSite(updated));
});

router.post('/sites/:id/retry', dnsLimiter, (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  if (row.managed === 0) return res.status(400).json({ error: 'This site was imported from Caddy and is managed in the Caddyfile — nothing to retry.' });

  const steps = INITIAL_STEPS.map((s) => ({ ...s, status: s.key === 'dns' ? 'done' : 'pending' }));
  db.prepare('UPDATE caddy_sites SET steps = ?, status = ?, status_detail = ? WHERE id = ?')
    .run(stepList(steps), 'pushing', '', row.id);
  logAudit(req, 'website_retry_site', row.domain, '');
  startSiteFlow(row.id);

  const updated = db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(row.id);
  res.json(serializeSite(updated));
});

router.delete('/sites/:id', async (req, res) => {
  const { row, owns } = loadSiteForUser(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  if (!owns) return res.status(403).json({ error: 'Forbidden' });
  try {
    await removeSite(row, req);
  } catch (e) {
    return res.status(500).json({ error: sanitizeError(e.message) });
  }
  logAudit(req, 'website_delete_site', row.domain, '');
  res.json({ ok: true });
});

// Whether any *other* site still depends on this site's cert being attached to
// its inspection profile. Compared on slot identity rather than literal name so
// a sibling whose row still records last renewal's `<domain>_<old date>` counts
// as a user of the same slot.
function certStillInUse(site) {
  const key = certNameToSubject(site.cert_name) || String(site.cert_name || '').toLowerCase();
  return db.prepare(
    "SELECT cert_name FROM caddy_sites WHERE id != ? AND fortigate_id = ? AND inspection_profile = ? AND cert_name != ''"
  ).all(site.id, site.fortigate_id, site.inspection_profile)
    .some((r) => (certNameToSubject(r.cert_name) || String(r.cert_name || '').toLowerCase()) === key);
}

// Free the site's slot on the SSL/SSH inspection profile, unless another site
// still relies on the same certificate. The cert itself is left in
// `vpn.certificate/local` — `caddy-forticertsync` owns that store, and it can
// only delete a cert once nothing references it, which is exactly what
// detaching here enables. Best-effort: a firewall that's unreachable at delete
// time must not block removing the site.
async function releaseInspectionSlot(site, req) {
  if (!site.fortigate_id || !site.inspection_profile || !site.cert_name) return;
  // Never detach the shared inspection bundle: it covers every published
  // domain, so removing it because one site went away would break all of them.
  const server = getServerRow(site.server_id);
  const bundleBase = String(server?.inspection_bundle_cert || '').trim().toLowerCase();
  if (bundleBase && stripCertDateSuffix(site.cert_name).toLowerCase() === bundleBase) return;
  if (certStillInUse(site)) return;
  const fw = db.prepare('SELECT * FROM firewalls WHERE id = ?').get(site.fortigate_id);
  if (!fw) return;
  try {
    const client = createClient(fw);
    const { removed, remaining, skipped } = await client.detachInspectionServerCert(
      site.inspection_profile, site.cert_name, fw.root_vdom || 'root',
    );
    if (skipped) {
      console.log(`[websites] left "${site.cert_name}" on inspection profile "${site.inspection_profile}" — detaching ${skipped}`);
      return;
    }
    if (removed.length === 0) return;
    if (req) {
      logAudit(req, 'website_detach_inspection_cert', site.domain,
        `${removed.join(', ')} removed from "${site.inspection_profile}" — ${remaining.length}/${SERVER_CERT_MAX} slots used`);
    }
    console.log(`[websites] detached ${removed.join(', ')} from inspection profile "${site.inspection_profile}" (${remaining.length}/${SERVER_CERT_MAX} slots used)`);
  } catch (err) {
    console.warn(`[websites] could not detach cert "${site.cert_name}" from inspection profile "${site.inspection_profile}": ${err.message}`);
  }
}

// Remove the Caddy route for a site (best-effort) and drop the DB row. We only
// ever touch our own @id-tagged Caddy route. Imported (managed=0) sites have no
// route of ours in Caddy: only the DB row is dropped, the Caddyfile-owned route
// stays untouched.
//
// The site's certificate is also detached from its SSL/SSH inspection profile
// when nothing else uses it. Leaving it attached is not harmless: FortiOS only
// allows SERVER_CERT_MAX certificates per profile, so an abandoned reference
// permanently costs a slot that the next publish needs.
async function removeSite(site, req = null) {
  await releaseInspectionSlot(site, req);
  const server = getServerRow(site.server_id);
  if (server && site.managed !== 0 && sshConfigured(server)) {
    // Caddyfile mode: drop the row, then regenerate the snippet without it.
    db.prepare('DELETE FROM caddy_sites WHERE id = ?').run(site.id);
    try {
      await syncServerSnippet(server);
    } catch (err) {
      console.warn(`[websites] snippet sync after deleting site ${site.id} failed (route stays until the next sync/reload): ${err.message}`);
    }
    return;
  }
  if (server && site.managed !== 0) {
    try {
      const caddy = createCaddyClient(server);
      await caddy.deleteRoute(site.id);
    } catch (err) {
      console.warn(`[websites] failed to delete Caddy route for site ${site.id}: ${err.message}`);
    }
  }
  db.prepare('DELETE FROM caddy_sites WHERE id = ?').run(site.id);
}

export default router;
