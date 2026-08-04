import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredScopeForRequest } from '../utils/apiTokenScopes.js';

test('API token scopes distinguish reads, VM writes, infrastructure, and admin writes', () => {
  assert.equal(requiredScopeForRequest({ method: 'GET', path: '/api/admin/users' }), 'read');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/vms/x' }), 'vm:operate');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/websites/sites' }), 'infrastructure:write');
  assert.equal(requiredScopeForRequest({ method: 'DELETE', path: '/api/public-ips/assignments/1' }), 'infrastructure:write');
  assert.equal(requiredScopeForRequest({ method: 'DELETE', path: '/api/admin/users/1' }), 'admin');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/auth/tokens' }), null);
});
