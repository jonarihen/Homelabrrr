import { analyzeForwardedFor, mismatchWarning } from '../utils/proxyChain.js';

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

/**
 * Warn about a broken proxy chain, at most once for the lifetime of the
 * process. Cheap to call on a hot path: after the first warning (or if there is
 * nothing wrong) it does no work at all. Returns true if this call logged.
 */
export function warnIfProxyMismatch(req) {
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
