import { analyzeForwardedFor, mismatchWarning } from '../utils/proxyChain.ts';

// A boot-time check cannot see a real request, so the TRUST_PROXY / hop-count
// comparison has to happen on live traffic. It also must not run on every
// request forever: the verdict never changes within a process, and warning per
// request would flood the log. So we sample the first few authenticated
// requests and warn at most once per process.
const MAX_SAMPLES = 5;
let samples = 0;
let warned = false;

/** Analyze the proxy chain of a live request. The pure work is in utils/proxyChain.js. */
export function inspectProxyChain(req) {
  return analyzeForwardedFor({
    xForwardedFor: req?.headers?.['x-forwarded-for'],
    reqIp: req?.ip,
    trustProxy: process.env.TRUST_PROXY,
  });
}

let warnedInsecure = false;

/**
 * Secure cookies are never set on a request Express sees as plain HTTP, so a
 * proxy that drops X-Forwarded-Proto causes a silent login loop. Warn once.
 */
export function warnIfInsecureWithSecureCookies(req) {
  if (warnedInsecure || process.env.COOKIE_SECURE === 'false' || req?.secure) return false;
  warnedInsecure = true;
  console.warn(
    'Request arrived over plain HTTP while COOKIE_SECURE is enabled: the session cookie will not be set and logins will loop. ' +
      'Make the reverse proxy send "X-Forwarded-Proto: https" (and check TRUST_PROXY), or set COOKIE_SECURE=false for local HTTP-only testing.',
  );
  return true;
}

/**
 * Warn about a broken proxy chain, at most once for the lifetime of the
 * process. Cheap to call on a hot path: after the first warning (or if there is
 * nothing wrong) it does no work at all. Returns true if this call logged.
 */
export function warnIfProxyMismatch(req) {
  warnIfInsecureWithSecureCookies(req);
  if (warned) return false;
  const message = mismatchWarning(inspectProxyChain(req));
  if (!message) return false;
  warned = true;
  console.warn(message);
  return true;
}

/**
 * Sample the first few authenticated requests. Unauthenticated traffic is
 * skipped because container health checks and probes legitimately reach the
 * backend without a proxy in front, and their chain says nothing about how real
 * users arrive. The login route calls warnIfProxyMismatch directly, since that
 * is where a wrong req.ip does its damage.
 */
export function trustProxyCheck(req, _res, next) {
  if (warned || samples >= MAX_SAMPLES) return next();
  if (!req.session?.userId) return next();
  samples += 1;
  warnIfProxyMismatch(req);
  next();
}
