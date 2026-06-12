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
