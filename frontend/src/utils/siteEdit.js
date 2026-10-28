// Client-side helpers for the "edit a published website" form. The backend is
// still the authority (utils/websiteChecks.js re-validates every field); these
// only keep the Save button honest so an obviously-bad or no-op edit doesn't
// cost a round trip — and, since saving restarts the publish pipeline, a no-op
// save doesn't take a live site back through "pushing" for nothing.

// Mirrors backend parsePort: an integer in 1..65535, else null.
export function normalizeUpstreamPort(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function normalizeUpstreamHost(value) {
  return String(value ?? '').trim();
}

// True when the draft is submittable: a non-empty host and a valid port.
export function isUpstreamDraftValid(draft) {
  return !!normalizeUpstreamHost(draft?.upstreamHost) && normalizeUpstreamPort(draft?.upstreamPort) !== null;
}

// True when the draft actually differs from what the site is published with.
export function hasUpstreamChanged(site, draft) {
  return (
    normalizeUpstreamHost(draft?.upstreamHost) !== normalizeUpstreamHost(site?.upstreamHost) ||
    normalizeUpstreamPort(draft?.upstreamPort) !== normalizeUpstreamPort(site?.upstreamPort)
  );
}

// Whether a site is wired into a FortiGate SSL/SSH inspection profile. Sites
// carry the profile name they were published against; empty means the route is
// served by Caddy and the firewall is left alone — which is also what keeps the
// site out of the profile's capped server-certificate list.
export function isInspectionOn(site) {
  return String(site?.inspectionProfile ?? '').trim() !== '';
}

// True when the draft differs from the published site in any editable field.
// Inspection is only compared when the draft carries the flag: the form omits
// it for non-admins, and an absent field must not read as "turned off".
export function hasSiteChanged(site, draft) {
  if (hasUpstreamChanged(site, draft)) return true;
  if (draft?.inspect === undefined) return false;
  return !!draft.inspect !== isInspectionOn(site);
}

// Statuses a site passes through while its publish pipeline runs.
export const IN_FLIGHT = ['validating', 'pushing', 'issuing', 'inspecting', 'pending'];

// The status a site is filed under on the Websites list: the short-lived
// pipeline steps collapse into one 'publishing' bucket so chips stay put while
// a publish moves through them, and a missing status reads as the column default.
export function siteStatusGroup(site) {
  const status = site?.status || 'pending';
  return IN_FLIGHT.includes(status) ? 'publishing' : status;
}

// Site count per status group, in first-seen order. The selected group keeps
// its chip (at 0) after its last site moves on, so an empty list explains itself.
export function siteStatusCounts(sites, selected = 'all') {
  const counts = {};
  for (const s of sites) counts[siteStatusGroup(s)] = (counts[siteStatusGroup(s)] || 0) + 1;
  if (selected !== 'all' && !counts[selected]) counts[selected] = 0;
  return counts;
}

// Websites list filter: `query` matches domain, upstream and owner (and a
// non-proxy kind like file_server) case-insensitively; `status` is 'all' or a
// siteStatusGroup value.
export function filterSites(sites, { query = '', status = 'all' } = {}) {
  const q = query.trim().toLowerCase();
  return sites.filter((s) => (status === 'all' || siteStatusGroup(s) === status) && (!q ||
    [s.domain, s.upstreamHost, s.upstreamHost && `${s.upstreamHost}:${s.upstreamPort}`, s.kind !== 'reverse_proxy' && s.kind, s.ownerUsername]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}
