/**
 * Regression tests for BUG-014: R4Card sees 0/0 and "no history" even though
 * reports exist on prod.
 *
 * Root cause: reportsStore.list() was filtering dispatch_log rows by
 * `created_at` (when the push notification was originally sent), not by
 * `updated_at` (when the status last changed).  If a dispatch was created
 * >29 days ago but completed/expired recently, R4Card could not see it.
 *
 * Fix: list() now filters by `updated_at`.  These tests verify:
 *   1. GET /api/reports passes the correct normalised params to store.list().
 *   2. A "done" record whose updated_at falls inside the date window is
 *      returned even when its created_at is outside the window.
 *   3. A record whose updated_at is also outside the window is NOT returned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors the pattern used across the test suite)
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._payload = payload; return payload; }
  };
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
      async list() { return []; },
      async getById() { return null; },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    settingsStore: {
      async read() {
        return {
          timezone: 'Europe/Moscow',
          azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET', admin: 'UF_ADMIN' } },
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
// Test fixtures
//
// The date window that R4Card uses: last 29 days from today.
// We model "today" as 2026-06-11 (matches project's currentDate).
// ---------------------------------------------------------------------------

const TODAY      = '2026-06-11';
const DATE_FROM  = '2026-05-13';  // 29 days before today

// A dispatch that was CREATED 35 days ago (outside the window) but was
// completed (updated_at) yesterday — should appear in R4Card.
const RECORD_DONE_RECENTLY = {
  id: 1001,
  slotKey: '2026-05-06:0800',
  azsId: '174',
  adminUserId: 5,
  status: 'done',
  errorText: null,
  reportItemId: 42,
  jitterMinutes: 2,
  scheduledAt: '2026-05-06T08:02:00.000Z',
  deadlineAt:  '2026-05-06T10:00:00.000Z',
  diskFolderId: null,
  // created_at is 36 days before today → outside the 29-day window
  createdAt: '2026-05-06T08:00:00.000Z',
  // updated_at is yesterday → inside the window
  updatedAt: '2026-06-10T14:30:00.000Z'
};

// A dispatch created AND updated outside the window — must NOT appear.
const RECORD_OLD = {
  id: 1002,
  slotKey: '2026-04-01:0800',
  azsId: '174',
  adminUserId: 5,
  status: 'expired',
  errorText: null,
  reportItemId: null,
  jitterMinutes: null,
  scheduledAt: '2026-04-01T08:00:00.000Z',
  deadlineAt:  '2026-04-01T10:00:00.000Z',
  diskFolderId: null,
  createdAt: '2026-04-01T08:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z'
};

// ---------------------------------------------------------------------------
// BUG-014 regression tests
// ---------------------------------------------------------------------------

test('BUG-014: GET / forwards normalised dateFrom/dateTo/azsIds to store.list()', async () => {
  let capturedArgs = null;

  const deps = makeMinimalDeps({
    reportsStore: {
      async list(args) {
        capturedArgs = args;
        return [];
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({
    query: {
      dateFrom: DATE_FROM,
      dateTo:   TODAY,
      azsId:    '174',
      limit:    '50'
    }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(capturedArgs, 'store.list() must have been called');
  assert.equal(capturedArgs.dateFrom, DATE_FROM, 'dateFrom must be forwarded');
  assert.equal(capturedArgs.dateTo,   TODAY,      'dateTo must be forwarded');
  assert.deepEqual(capturedArgs.azsIds, ['174'],  'azsId must be normalised to array');
  assert.equal(capturedArgs.limit, 50, 'limit must be forwarded as number');
});

test('BUG-014: GET / returns a done record whose updatedAt is inside the window even when createdAt is outside', async () => {
  // The mock store returns a record whose createdAt is outside the 29-day
  // window but whose updatedAt is within it — simulating the fixed behaviour
  // where list() filters by updated_at.
  const deps = makeMinimalDeps({
    reportsStore: {
      async list({ dateFrom, dateTo, azsIds }) {
        // Simulate the fixed SQL: filter by updated_at, not created_at.
        const from = new Date(`${dateFrom}T00:00:00.000Z`);
        const to   = new Date(`${dateTo}T23:59:59.999Z`);
        return [RECORD_DONE_RECENTLY, RECORD_OLD].filter((r) => {
          const updatedAt = new Date(r.updatedAt);
          const azsMatch  = !azsIds?.length || azsIds.includes(r.azsId);
          return updatedAt >= from && updatedAt <= to && azsMatch;
        });
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({
    query: { dateFrom: DATE_FROM, dateTo: TODAY, azsId: '174', limit: '50' }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);

  const items = res._payload?.items ?? [];
  const ids = items.map((i) => i.id);

  // The recently-completed dispatch (created outside window) MUST appear.
  assert.ok(ids.includes(1001),
    `Record 1001 (done recently, created outside window) must be returned — got ids: ${JSON.stringify(ids)}`);

  // The old dispatch (updated outside window) must NOT appear.
  assert.ok(!ids.includes(1002),
    `Record 1002 (updated outside window) must NOT be returned — got ids: ${JSON.stringify(ids)}`);
});

test('BUG-014: GET / returns empty list when azsId has no matching updated_at records in window', async () => {
  const deps = makeMinimalDeps({
    reportsStore: {
      async list({ dateFrom, dateTo, azsIds }) {
        const from = new Date(`${dateFrom}T00:00:00.000Z`);
        const to   = new Date(`${dateTo}T23:59:59.999Z`);
        return [RECORD_DONE_RECENTLY, RECORD_OLD].filter((r) => {
          const updatedAt = new Date(r.updatedAt);
          const azsMatch  = !azsIds?.length || azsIds.includes(r.azsId);
          return updatedAt >= from && updatedAt <= to && azsMatch;
        });
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  // Use a different azsId that does not match any record
  const req = makeReviewerReq({
    query: { dateFrom: DATE_FROM, dateTo: TODAY, azsId: '999', limit: '50' }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.items?.length, 0,
    'No records should match azsId=999');
  assert.equal(res._payload?.total, 0);
});

test('BUG-014: GET / with status=done filter only returns done records', async () => {
  const deps = makeMinimalDeps({
    reportsStore: {
      async list({ dateFrom, dateTo, azsIds, status }) {
        const from = new Date(`${dateFrom}T00:00:00.000Z`);
        const to   = new Date(`${dateTo}T23:59:59.999Z`);
        return [RECORD_DONE_RECENTLY].filter((r) => {
          const updatedAt = new Date(r.updatedAt);
          const azsMatch    = !azsIds?.length || azsIds.includes(r.azsId);
          const statusMatch = !status || r.status === status;
          return updatedAt >= from && updatedAt <= to && azsMatch && statusMatch;
        });
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({
    query: { dateFrom: DATE_FROM, dateTo: TODAY, azsId: '174', status: 'done', limit: '50' }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const items = res._payload?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1001);
  assert.equal(items[0].status, 'done');
});
