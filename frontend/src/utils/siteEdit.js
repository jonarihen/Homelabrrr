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
