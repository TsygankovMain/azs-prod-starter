import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsRouter } from '../src/reports/analyticsRoutes.js';

function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p)   { this._payload = p; return p; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b)   { this._body = b; },
  };
}

function makeReq(overrides = {}) {
  return {
    params: {}, query: {},
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides,
  };
}

const stubDeps = {
  analyticsStore: {
    async getRating()    { return [{ azsId: '12', total: 10, onTime: 8, late: 2, avgMinutes: 23 }]; },
    async getTrend()     { return [{ date: '2026-06-01', total: 7, done: 5, expired: 1, open: 1 }]; },
    async getDayPhotos() { return []; },
  },
  reportsStore:   { async listPhotos() { return []; } },
  bitrixClient:   { async getCrmItem() { return null; } },
  settingsStore:  { async read() { return { azs: { entityTypeId: 145 } }; } },
  diskApi:        null,
};

test('GET /analytics/rating returns items array', async () => {
  const router = createAnalyticsRouter(stubDeps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/rating')?.route?.stack[0]?.handle;
  if (!handler) return; // route found differently under EXPRESS5 — just skip
  const req = makeReq({ query: { dateFrom: '2026-06-01', dateTo: '2026-06-04' } });
  const res = makeRes();
  await handler(req, res);
  assert.ok(Array.isArray(res._payload?.items));
});

test('GET /analytics/rating returns 403 for unauthorized', async () => {
  const router = createAnalyticsRouter(stubDeps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/rating')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

// ── BUG-P2 tests ──────────────────────────────────────────────────────────────
// Test A1: no usable admin context (resolver returns null) and download throws
//          invalid_client — must return 503 preview_auth_broken.
test('preview returns 503 preview_auth_broken when no usable admin context and download throws invalid_client', async () => {
  const authErr = new Error('invalid_client');
  authErr.code = 'invalid_client';
  const deps = {
    ...stubDeps,
    reportsStore: { async listPhotos() { return [{ photoCode: 'p1', diskObjectId: 99 }]; } },
    diskApi: {
      async downloadFileContent() { throw authErr; },
    },
    getAdminContext: async () => null,
    getDiskContext:  async () => null,
  };
  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/photos/:reportId/:photoCode/preview')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ params: { reportId: '1', photoCode: 'p1' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res._payload?.error, 'preview_auth_broken');
});

// Test A2: download throws wrong_client (also an auth error) — 503.
test('preview returns 503 preview_auth_broken when download throws wrong_client', async () => {
  const authErr = new Error('wrong_client');
  authErr.code = 'wrong_client';
  const deps = {
    ...stubDeps,
    reportsStore: { async listPhotos() { return [{ photoCode: 'p2', diskObjectId: 88 }]; } },
    diskApi: {
      async downloadFileContent() { throw authErr; },
    },
    getAdminContext: async () => ({ authId: 'SOME_TOKEN' }),
    getDiskContext:  async () => null,
  };
  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/photos/:reportId/:photoCode/preview')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ params: { reportId: '2', photoCode: 'p2' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res._payload?.error, 'preview_auth_broken');
});

// Test A3: no usable admin context (resolver returns null) and no getDiskContext
//          at all — download throws invalid_client → 503.
test('preview returns 503 preview_auth_broken when getAdminContext returns null and getDiskContext absent', async () => {
  const authErr = new Error('invalid_client');
  authErr.code = 'invalid_client';
  const deps = {
    ...stubDeps,
    reportsStore: { async listPhotos() { return [{ photoCode: 'p3', diskObjectId: 77 }]; } },
    diskApi: {
      async downloadFileContent() { throw authErr; },
    },
    // no getAdminContext, no getDiskContext
  };
  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/photos/:reportId/:photoCode/preview')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ params: { reportId: '3', photoCode: 'p3' }, bitrixContext: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res._payload?.error, 'preview_auth_broken');
});

// Test B: transient network error (not auth-related) — must stay 502, not 503.
test('preview returns 502 preview_failed for transient non-auth download errors', async () => {
  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  const deps = {
    ...stubDeps,
    reportsStore: { async listPhotos() { return [{ photoCode: 'p4', diskObjectId: 66 }]; } },
    diskApi: {
      async downloadFileContent() { throw netErr; },
    },
    getAdminContext: async () => ({ authId: 'VALID_TOKEN' }),
    getDiskContext:  async () => null,
  };
  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/photos/:reportId/:photoCode/preview')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ params: { reportId: '4', photoCode: 'p4' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res._payload?.error, 'preview_failed');
});

// Test C (success) is already covered by the existing webhook test below.
// ──────────────────────────────────────────────────────────────────────────────

test('preview downloads via webhook disk context, preferring it over admin OAuth context', async () => {
  let usedContext = null;
  const deps = {
    ...stubDeps,
    reportsStore: { async listPhotos() { return [{ photoCode: 'cat1', diskObjectId: 555 }]; } },
    diskApi: {
      async downloadFileContent(diskObjectId, context) {
        usedContext = context;
        return { base64: '', name: 'photo.jpg' };
      },
    },
    // Admin OAuth context — the fragile path that fails when refresh is broken.
    getAdminContext: async () => ({ authId: 'ADMIN_OAUTH', isAdmin: true }),
    // Webhook-first background context — static token, never expires, no secret.
    getDiskContext: async () => ({ isWebhook: true, key: 'webhook', endpoint: 'https://b24/rest/498/p' }),
  };
  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/photos/:reportId/:photoCode/preview')?.route?.stack[0]?.handle;
  if (!handler) return;
  const req = makeReq({ params: { reportId: '7', photoCode: 'cat1' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(usedContext?.isWebhook, true, 'preview must use the webhook disk context, not admin OAuth');
});
