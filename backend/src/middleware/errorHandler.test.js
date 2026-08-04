import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler } from './errorHandler.js';
import { httpError } from '../utils/httpError.js';

test('Express 5 forwards async rejections and preserves portal-authored status', async () => {
  const app = express();
  app.use((req, _res, next) => { req.requestId = 'request-1234'; next(); });
  app.get('/reject', async () => { throw httpError(409, 'Conflict from portal validation'); });
  app.use(globalErrorHandler);
  const response = await request(app).get('/reject');
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'Conflict from portal validation');
  assert.equal(response.body.requestId, 'request-1234');
});

test('errors after headers are committed delegate to Express final handling', () => {
  const error = new Error('stream failed');
  let delegated = null;
  globalErrorHandler(error, { requestId: 'request-5678' }, { headersSent: true }, (value) => { delegated = value; });
  assert.equal(delegated, error);
});
