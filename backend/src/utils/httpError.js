// Shared HTTP-error plumbing for route handlers.
//
// Two conventions grew up side by side: routes/vms.js tagged validation
// failures with `err.statusCode`, while utils/capacity.js, utils/quota.js,
// utils/storageVisibility.js, utils/nodeMaintenance.js and utils/cpuTopology.js
// used `err.status`. Handlers then checked one or the other — so an error
// thrown by the "wrong" helper fell through to a hardcoded 500 and had its
// message run through sanitizeError(), which redacts every IPv4 literal. That
// mangled strings the portal itself wrote for the user and reported ordinary
// user mistakes as server errors (issue #74).
//
// `statusCode` is canonical here. `status` is kept as an accepted alias in both
// directions — readers honour it, and httpError()/tagStatus() write both — so
// nothing that still reads the old property silently regresses.

import { sanitizeError } from './sanitize.js';

const MIN_STATUS = 400;
const MAX_STATUS = 599;

// Only an explicit, plausible error status counts. Anything else (a 2xx, a
// float, NaN, a Proxmox/FortiGate object that happens to carry a `status`
// string like "running") is ignored so it can't turn a failure into a success.
function coerceStatus(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < MIN_STATUS || n > MAX_STATUS) return null;
  return n;
}

// Upstream clients (fortigate.js, caddy.js) reflect the *remote* HTTP status
// onto the error so their own callers can branch on 404-vs-403. That status is
// not the portal's answer to this request and must never be forwarded to the
// browser: a FortiGate 401 (wrong API key) would trip the frontend's
// "401 ⇒ redirect to /login" interceptor and sign the user out over a firewall
// misconfiguration. Those errors mark themselves `expose = false` and are
// reported as a plain sanitized 500, exactly as before this helper existed.
const isPortalAuthored = (err) => err.expose !== false;

/**
 * The HTTP status a thrown value should be reported as.
 * `statusCode` wins over `status` when both are present and disagree.
 * Anything without a usable portal-authored status is a 500.
 */
export function resolveErrorStatus(err) {
  if (!err || typeof err !== 'object') return 500;
  if (!isPortalAuthored(err)) return 500;
  return coerceStatus(err.statusCode) ?? coerceStatus(err.status) ?? 500;
}

/** True when the thrown value carries an explicit portal-authored 4xx/5xx status. */
export function hasHttpStatus(err) {
  if (!err || typeof err !== 'object' || !isPortalAuthored(err)) return false;
  return coerceStatus(err.statusCode) !== null || coerceStatus(err.status) !== null;
}

function messageOf(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return '';
}

/**
 * Build the JSON body for an error response.
 *
 * 4xx bodies are portal-authored, user-facing text ("Network interface net0 is
 * not VLAN-tagged") and are returned verbatim. 5xx bodies may be raw upstream
 * output, so they keep going through sanitizeError().
 *
 * `expose = false` errors already resolve to 500 and so are sanitized; the
 * explicit check keeps that true even if a caller passes a status by hand. A
 * FortiGate rejection can quote internal addresses, which is exactly what
 * sanitizeError() exists to strip.
 */
export function errorPayload(err, status = resolveErrorStatus(err)) {
  const message = messageOf(err);
  if (status >= 500 || err?.expose === false) {
    return { error: sanitizeError(message) };
  }
  return { error: message || 'Request failed' };
}

/** Terminal error response for a route handler. */
export function sendError(res, err) {
  const status = resolveErrorStatus(err);
  return res.status(status).json(errorPayload(err, status));
}

/** Stamp an existing error with a status (canonical + legacy alias). */
export function tagStatus(err, status) {
  err.statusCode = status;
  err.status = status;
  return err;
}

/** Portal-authored error: `throw httpError(400, 'Pick another node')`. */
export function httpError(status, message) {
  return tagStatus(new Error(message), status);
}
