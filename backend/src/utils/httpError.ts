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
//
// This module is the single entry point for answering a failed request. It owns
// two decisions and delegates the third:
//
//   status   — resolveErrorStatus(), below.
//   authorship — isPortalAuthoredError(), below: is this the portal's own prose
//                or text that came back from Proxmox / FortiGate / SSH / Caddy?
//   wording  — utils/upstreamError.js, for the upstream half: it recognises the
//              failures people actually hit and rewrites them as
//              title/detail/action, falling back to sanitizeError().
//
// Route handlers should only ever need sendError().

import { upstreamErrorPayload } from './upstreamError.ts';
import { incrementMetric } from './metricRegistry.ts';

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
const isExposable = (err) => err.expose !== false;

/**
 * True when `err` carries prose the portal wrote itself rather than text that
 * came back from Proxmox / FortiGate / SSH / Caddy. Portal prose is already
 * safe and already actionable, so redacting it only makes it worse ("needs
 * 8 GB free on 10.0.0.5" → "… on [internal-host]").
 *
 * The marker is an explicit 4xx status, which is the shape every portal-side
 * guard already throws (utils/capacity.js, utils/quota.js, utils/cpuTopology.js,
 * utils/nodeMaintenance.js, utils/storageVisibility.js) and the one httpError()
 * and tagStatus() write.
 *
 * `statusCode` counts here only because `expose = false` is checked first: the
 * two clients that stamp a *remote* status onto an error — fortigate.js and
 * utils/caddy.js — both set it, and they are the only ones that do. Keep that
 * true when adding an upstream client, or its raw text reaches the browser.
 *
 * This is the one authorship check in the codebase. Anything that needs to know
 * whether a message may be shown verbatim asks here.
 */
export function isPortalAuthoredError(err) {
  if (!err || typeof err !== 'object' || !isExposable(err)) return false;
  const status = coerceStatus(err.statusCode) ?? coerceStatus(err.status);
  return status !== null && status <= 499;
}

/**
 * The HTTP status a thrown value should be reported as.
 * `statusCode` wins over `status` when both are present and disagree.
 * Anything without a usable portal-authored status is a 500.
 */
export function resolveErrorStatus(err) {
  if (!err || typeof err !== 'object') return 500;
  if (!isExposable(err)) return 500;
  return coerceStatus(err.statusCode) ?? coerceStatus(err.status) ?? 500;
}

/** True when the thrown value carries an explicit portal-authored 4xx/5xx status. */
export function hasHttpStatus(err) {
  if (!err || typeof err !== 'object' || !isExposable(err)) return false;
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
 * not VLAN-tagged") and are returned verbatim. Everything else is upstream
 * output and goes to utils/upstreamError.js, which answers with a translated
 * `{ error, title, detail, action, href? }` when it recognises the failure and
 * with the sanitizeError() string when it does not.
 *
 * `status` can only ever make the answer more conservative: a 5xx body is never
 * returned as portal prose, even for an error that would otherwise qualify.
 * That, plus the `expose = false` check inside isPortalAuthoredError(), is what
 * keeps a FortiGate rejection — which can quote internal addresses — redacted.
 *
 * @param {Error|string} err
 * @param {number} [status]
 * @param {{host?: string, node?: string, href?: string}} [context] portal labels
 *        used to make a translated message specific. Rarely needed: the Proxmox
 *        client already tags its rejections with the host's label.
 */
export function errorPayload(err, status = resolveErrorStatus(err), context) {
  if (status < 500 && isPortalAuthoredError(err)) {
    const payload = { error: messageOf(err) || 'Request failed' };
    if (err?.name === 'ValidationError') {
      payload.code = String(err.code || 'VALIDATION_ERROR').slice(0, 64);
      if (err.field) payload.field = String(err.field).slice(0, 128);
    }
    return payload;
  }
  return upstreamErrorPayload(err, context);
}

/**
 * Terminal error response for a route handler — the one entry point.
 *
 * A recognised upstream failure is answered in the portal's own words, so the
 * raw text (the only thing naming the actual Proxmox/FortiGate fault) would
 * otherwise be lost. Operators get it in the log; the browser must not.
 */
export function sendError(res, err, context) {
  const status = resolveErrorStatus(err);
  const body = errorPayload(err, status, context);
  if (status >= 500) incrementMetric('upstream_failures', 'source="external"');
  if (body.title) console.error('Upstream failure:', messageOf(err));
  return res.status(status).json(body);
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
