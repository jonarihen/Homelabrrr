const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function canonicalOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function requestOriginAllowed({ origin, allowedOrigin, protocol, host }) {
  const supplied = canonicalOrigin(origin);
  if (!supplied) return false;
  const configured = canonicalOrigin(allowedOrigin);
  if (configured) return supplied === configured;
  return supplied === canonicalOrigin(`${protocol}://${host}`);
}

export function csrfProtection({ allowedOrigin = '' } = {}) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || req.apiToken) return next();

    const protocol = req.protocol || (req.secure ? 'https' : 'http');
    if (!requestOriginAllowed({
      origin: req.headers.origin,
      allowedOrigin,
      protocol,
      host: req.get('host'),
    })) {
      return res.status(403).json({ error: 'Request origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    }
    next();
  };
}
