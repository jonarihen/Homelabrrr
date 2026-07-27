// Routes the SPA renders for signed-out visitors.
//
// AuthProvider probes GET /auth/me on every mount, so on these pages a 401 is
// the expected steady state — not an expired session. The api.js response
// interceptor must therefore NOT bounce the visitor to /login here, or the
// page is torn down before it can be used (an invitee following their link
// lands on the sign-in form they have no account for).

const PUBLIC_ROUTE_PATTERNS = [
  /^\/login\/?$/,
  /^\/invite\/[^/]+\/?$/,
];

// True when `pathname` is one of the signed-out routes above. Anything that
// isn't a string is treated as non-public, so an unexpected value keeps the
// old redirect-on-401 behaviour rather than silently swallowing it.
export function isPublicPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return PUBLIC_ROUTE_PATTERNS.some((re) => re.test(pathname));
}
