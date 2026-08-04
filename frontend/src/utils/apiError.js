// Normalise whatever a component happens to be holding onto into the shape
// <ErrorCallout> renders.
//
// The backend's newer error payloads carry `{ error, title, detail, action,
// href? }` (see backend/src/utils/upstreamError.js), but the great majority of
// call sites still store a plain string from `err.response?.data?.error`. Both
// have to render, so this accepts:
//
//   - an axios error            (reads err.response.data)
//   - a response body object    ({ error } or { title, detail, action, href })
//   - a plain string
//   - an Error
//   - null / undefined
//
// and always answers a complete shape with a non-empty `title`. That is what
// makes the migration incremental: a converted endpoint gets title + detail +
// fix button, everything else keeps rendering exactly the string it did before.

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function normalizeApiError(input, fallback = 'Something went wrong') {
  const blank = { title: str(fallback) || 'Something went wrong', detail: '', action: '', href: '' };
  if (input === null || input === undefined || input === false) return blank;

  if (typeof input === 'string') {
    return str(input) ? { ...blank, title: str(input) } : blank;
  }
  if (typeof input !== 'object') return blank;

  // axios error → the response body; anything else is treated as the body.
  const data = input.response?.data ?? input;

  if (typeof data === 'string') {
    return str(data) ? { ...blank, title: str(data) } : blank;
  }

  if (data && typeof data === 'object') {
    if (str(data.title)) {
      return {
        title: str(data.title),
        detail: str(data.detail),
        action: str(data.action),
        href: str(data.href),
      };
    }
    if (str(data.error)) return { ...blank, title: str(data.error) };
  }

  // Network failure, or a thrown Error that never reached the server.
  if (str(input.message)) return { ...blank, title: str(input.message) };
  return blank;
}

/** Where a `href` points, in words. Keep in step with upstreamError.js. */
export function errorHrefLabel(href) {
  if (href === '/admin/hosts') return 'Proxmox hosts';
  if (href === '/admin/firewalls') return 'Firewalls';
  return 'settings';
}
