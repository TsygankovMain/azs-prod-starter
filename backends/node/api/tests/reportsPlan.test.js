import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Shared helpers (mirrored from reportsResync.test.js)
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
    bitrixContext: {},
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
          azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
          photoType: { entityTypeId: 1112 },
          report: {
            entityTypeId: 163,
            fields: { folderId: 'UF_FOLDER' }
          }
        };
      }
    },
    bitrixClient: {
      diskApi: {},
      async getCrmItem() { return null; }
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

test('GET /plan returns {items:[], planDate:null, enabled:false} when dispatchPlanStore not injected', async () => {
  const deps = makeMinimalDeps(); // no dispatchPlanStore
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/plan');

  const req = makeReviewerReq();
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload, { items: [], planDate: null, enabled: false });
});

test('GET /plan returns 403 when caller lacks reviewer capability', async () => {
  const deps = makeMinimalDeps();
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/plan');

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

test('GET /plan returns rows from dispatchPlanStore for today when enabled', async () => {
  const fakePlanDate = '2026-06-03';
  const fakeRows = [
    {
      azs_id: '101',
      admin_user_id: 50,
      base_time: '08:00',
      execute_at: '2026-06-03T08:07:00.000Z',
      status: 'planned',
      report_item_id: null
    },
    {
      azs_id: '102',
      admin_user_id: 51,
      base_time: '08:00',
      execute_at: '2026-06-03T08:12:00.000Z',
      status: 'dispatched',
      report_item_id: 999
    }
  ];

  const dispatchPlanStore = {
    async listByDate({ planDate }) {
      assert.equal(planDate, fakePlanDate);
      return fakeRows;
    }
  };

  const deps = makeMinimalDeps({ dispatchPlanStore });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/plan');

  const req = makeReviewerReq({ query: { date: fakePlanDate } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.enabled, true);
  assert.equal(res._payload?.planDate, fakePlanDate);
  assert.equal(res._payload?.items?.length, 2);

  const first = res._payload.items[0];
  assert.equal(first.azsId, '101');
  assert.equal(first.adminUserId, 50);
  assert.equal(first.baseTime, '08:00');
  assert.equal(first.status, 'planned');
  assert.equal(first.reportItemId, null);

  const second = res._payload.items[1];
  assert.equal(second.azsId, '102');
  assert.equal(second.status, 'dispatched');
  assert.equal(second.reportItemId, 999);
});

test('GET /plan ignores invalid ?date= and falls back to today', async () => {
  let capturedPlanDate = null;

  const dispatchPlanStore = {
    async listByDate({ planDate }) {
      capturedPlanDate = planDate;
      return [];
    }
  };

  const deps = makeMinimalDeps({ dispatchPlanStore });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/plan');

  const req = makeReviewerReq({ query: { date: 'not-a-date' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.enabled, true);
  // planDate should be today (YYYY-MM-DD format); just validate the shape
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(capturedPlanDate ?? ''), `expected YYYY-MM-DD, got ${capturedPlanDate}`);
  assert.equal(res._payload?.planDate, capturedPlanDate);
});

test('GET /plan returns 502 when listByDate throws', async () => {
  const dispatchPlanStore = {
    async listByDate() {
      throw new Error('DB connection lost');
    }
  };

  const deps = makeMinimalDeps({ dispatchPlanStore });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/plan');

  const req = makeReviewerReq({ query: { date: '2026-06-03' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res._payload?.error, 'plan_failed');
  assert.ok(res._payload?.message?.includes('DB connection lost'));
});
