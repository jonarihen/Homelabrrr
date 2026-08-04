import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { csrfProtection } from '../middleware/requestSecurity.js';
import { requestContext } from '../utils/logger.js';
import { validateObject, validatePort } from '../utils/validation.js';

const testDirectory = mkdtempSync(join(tmpdir(), 'homelabrrr-route-integration-'));
process.env.DB_PATH = join(testDirectory, 'integration.sqlite');
process.env.SECRET_ENCRYPTION_KEY = '44'.repeat(32);
process.env.INITIAL_ADMIN_USERNAME = 'integration-admin';
process.env.INITIAL_ADMIN_PASSWORD = 'integration-password-strong';
const { requireAdmin, requireAuth } = await import('../middleware/auth.js');
test.after(() => rmSync(testDirectory, { recursive: true, force: true }));

function appForIntegration() {
  const app = express();
  app.use(requestContext, express.json());
  app.use((req, _res, next) => {
    const role = req.get('x-test-role');
    if (role) req.session = { userId: 1, username: role, isAdmin: role === 'admin' };
    next();
  });
  app.use(csrfProtection({ allowedOrigin: 'https://portal.example.com' }));
  app.get('/private', requireAuth, (_req, res) => res.json({ ok: true }));
  app.get('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));
  app.post('/validated', (req, res) => {
    validateObject(req.body, { fields: ['port'], required: ['port'] });
    res.json({ port: validatePort(req.body.port) });
  });
  app.get('/upstream-rejection', async () => {
    throw new Error('connect ECONNREFUSED 10.20.30.40 /srv/private/key.pem');
  });
  app.use(globalErrorHandler);
  return app;
}

test('route integration covers authentication and administrator authorization', async () => {
  const app = appForIntegration();
  assert.equal((await request(app).get('/private')).status, 401);
  assert.equal((await request(app).get('/admin').set('x-test-role', 'operator')).status, 403);
  assert.equal((await request(app).get('/admin').set('x-test-role', 'admin')).status, 200);
});

test('route integration rejects malformed and unexpected JSON fields consistently', async () => {
  const app = appForIntegration();
  const headers = { Origin: 'https://portal.example.com' };
  const malformed = await request(app).post('/validated').set(headers).send({ port: '22x' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'VALIDATION_ERROR');
  const unexpected = await request(app).post('/validated').set(headers).send({ port: 22, password: 'never-accepted' });
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.body.code, 'UNEXPECTED_FIELD');
});

test('route integration sanitizes async upstream failures and returns a request ID', async () => {
  const response = await request(appForIntegration()).get('/upstream-rejection').set('x-request-id', 'integration-request-123');
  assert.equal(response.status, 500);
  assert.equal(response.body.requestId, 'integration-request-123');
  assert.doesNotMatch(JSON.stringify(response.body), /10\.20\.30\.40|srv|private|key\.pem/);
});
