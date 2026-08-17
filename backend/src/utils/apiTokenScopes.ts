export const API_TOKEN_SCOPES = new Set(['read', 'vm:operate', 'infrastructure:write', 'admin']);

const INFRASTRUCTURE_PREFIXES = [
  '/api/cloud-images',
  '/api/isos',
  '/api/notifications',
  '/api/portal',
  '/api/public-ips',
  '/api/websites',
  '/api/workflows',
];

export function requiredScopeForRequest({ method, path }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/auth')) return null;
  if (INFRASTRUCTURE_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'infrastructure:write';
  return 'vm:operate';
}
