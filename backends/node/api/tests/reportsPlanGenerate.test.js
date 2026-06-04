/**
 * Tests for POST /plan/generate
 * Manual "Сформировать график" endpoint — bypasses nightly-admin-context bug by
 * using the live reviewer's req.bitrixContext instead of authContextStore.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as reportsPlan.test.js)
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._payload = payload; return payload; }
  };
  return res;
}

function makeReviewerReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: { authId: 'live-reviewer-token' },
    ...overrides
  };
}

function makeMinimalDeps(overrides = {}) {
  return {
    reportsStore: {
      async getById() { return null; },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    settingsStore: {
      async read() {
        return {
          timezone: 'Europe/Moscow',
          azs: {
            entityTypeId: 145,
            fields: {
              admin: 'UF_CRM_2_ADMIN',
              enabled: 'UF_CRM_2_ENABLED',
              photoSet: 'UF_PHOTO_SET'
            }
          },
          photoType: { entityTypeId: 1112 },
          report: {
            entityTypeId: 163,
            fields: { folderId: 'UF_FOLDER' },
            dispatchTimes: ['09:00', '14:00']
          }
        };
      }
    },
    bitrixClient: {
      diskApi: {},
      async getCrmItem() { return null; },
      async listCrmItems() { return []; }
    },
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore: {
      async getLastAdminContext() { return null; }
    },
    dispatchService: {},
    crmSyncJobStore: {
      async enqueue() { return { id: 1 }; },
      async listByReport() { return []; }
    },
    ...overrides
  };
}

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l?.route?.path === path && l?.route?.methods?.[method]
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /plan/generate returns ok:true and calls ensureSchema + upsertPlanned when 2 enabled AZS with admin', async () => {
  const ensureSchemaCalledTimes = { count: 0 };
  const upsertCalls = [];
  const deleteCalls = [];

  const dispatchPlanStore = {
    async ensureSchema() { ensureSchemaCalledTimes.count++; },
    async upsertPlanned(args) { upsertCalls.push(args); return null; },
    async deletePlannedForDate(args) { deleteCalls.push(args); return 0; },
    async listByDate() { return []; }
  };

  // Two enabled AZS rows — UF_CRM_2_ADMIN and UF_CRM_2_ENABLED fields
  const fakeRows = [
    { id: '101', UF_CRM_2_ADMIN: '50', UF_CRM_2_ENABLED: 'Y' },
    { id: '102', UF_CRM_2_ADMIN: '51', UF_CRM_2_ENABLED: '1' }
  ];

  const bitrixClient = {
    diskApi: {},
    async getCrmItem() { return null; },
    async listCrmItems() { return fakeRows; }
  };

  const deps = makeMinimalDeps({ dispatchPlanStore, bitrixClient });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/plan/generate');

  const req = makeReviewerReq({ body: {} });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res._payload)}`);
  assert.equal(res._payload?.ok, true, `Expected ok:true, got ${JSON.stringify(res._payload)}`);
  assert.equal(res._payload?.azsCount, 2, 'azsCount should be 2');
  assert.ok(res._payload?.planDate, 'planDate must be set');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(res._payload?.planDate), `planDate should be YYYY-MM-DD, got ${res._payload?.planDate}`);

  // ensureSchema must have been called
  assert.equal(ensureSchemaCalledTimes.count, 1, 'ensureSchema must be called once');

  // upsertPlanned called: 2 AZS × 2 dispatchTimes = 4 times
  assert.ok(upsertCalls.length > 0, `upsertPlanned should have been called; got ${upsertCalls.length}`);
  assert.equal(res._payload?.planned, upsertCalls.length, 'planned count should match upsertPlanned call count');
});

test('POST /plan/generate returns 422 no_candidates when listCrmItems returns empty array', async () => {
  const dispatchPlanStore = {
    async ensureSchema() {},
    async upsertPlanned() { return null; },
    async deletePlannedForDate() { return 0; },
    async listByDate() { return []; }
  };

  const bitrixClient = {
    diskApi: {},
    async getCrmItem() { return null; },
    async listCrmItems() { return []; } // no AZS
  };

  const deps = makeMinimalDeps({ dispatchPlanStore, bitrixClient });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/plan/generate');

  const req = makeReviewerReq({ body: {} });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 422, `Expected 422, got ${res.statusCode}`);
  assert.equal(res._payload?.error, 'no_candidates');
});

test('POST /plan/generate returns 403 when caller lacks reviewer capability', async () => {
  const deps = makeMinimalDeps();
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/plan/generate');

  const req = {
    params: {},
    query: {},
    body: {},
    accessContext: { capabilities: {} }, // no reviewer
    bitrixContext: {}
  };
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res._payload?.error, 'forbidden');
});

test('POST /plan/generate returns 503 when dispatchPlanStore is not injected', async () => {
  const deps = makeMinimalDeps(); // no dispatchPlanStore
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/plan/generate');

  const req = makeReviewerReq({ body: {} });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 503, `Expected 503, got ${res.statusCode}`);
  assert.equal(res._payload?.error, 'plan_mode_unavailable');
});
