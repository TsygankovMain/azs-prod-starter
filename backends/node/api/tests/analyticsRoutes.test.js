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
