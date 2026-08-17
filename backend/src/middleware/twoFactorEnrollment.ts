const ENROLLMENT_ONLY_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/reauthenticate',
  '/api/auth/2fa/setup',
  '/api/auth/2fa/enable',
  '/api/health',
]);

export function enforceTwoFactorEnrollmentOnly(req, res, next) {
  if (!req.session?.twoFactorEnrollmentOnly || ENROLLMENT_ONLY_PATHS.has(req.path)) return next();
  return res.status(403).json({ error: 'Two-factor setup is required before accessing the portal' });
}
