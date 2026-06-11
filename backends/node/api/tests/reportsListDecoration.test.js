/**
 * Tests for GET / (reports list) — errorReason and deliveredViaFallback decoration.
 * These fields are added in reportsRoutes.js using classifyDispatchError.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';
import { NOTIFY_FALLBACK_PREFIX } from '../src/notifications/notificationService.js';

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
// Tests
// ---------------------------------------------------------------------------

test('GET / decorates failed item with errorReason=KEYBOARD_REJECTED and deliveredViaFallback=false', async () => {
  const fakeItems = [
    {
      id: 528,
      slot_key: '2026-06-11_0800',
      azs_id: '101',
      admin_user_id: 50,
      status: 'failed',
      error_text: 'Bitrix error: PARAM_KEYBOARD_ERROR in keyboard structure',
      report_item_id: null,
      jitter_minutes: null,
      scheduled_at: null,
      deadline_at: null,
      disk_folder_id: null,
      created_at: null,
      updated_at: null
    }
  ];

  const deps = makeMinimalDeps({
    reportsStore: {
      async list() {
        // Return already-normalized view-model rows as reportsStore.list produces them
        return fakeItems.map((row) => ({
          id: Number(row.id),
          slotKey: row.slot_key,
          azsId: row.azs_id,
          adminUserId: Number(row.admin_user_id),
          status: row.status,
          errorText: row.error_text ?? null,
          reportItemId: row.report_item_id,
          jitterMinutes: row.jitter_minutes,
          scheduledAt: row.scheduled_at,
          deadlineAt: row.deadline_at,
          diskFolderId: row.disk_folder_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({ query: { dateFrom: '2026-06-11', dateTo: '2026-06-11' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.items?.length, 1);
  const item = res._payload.items[0];
  assert.equal(item.errorReason, 'KEYBOARD_REJECTED');
  assert.equal(item.deliveredViaFallback, false);
  assert.equal(item.errorText, 'Bitrix error: PARAM_KEYBOARD_ERROR in keyboard structure');
});

test('GET / decorates fallback item with errorReason=NOTIFY_FALLBACK and deliveredViaFallback=true', async () => {
  const fakeItems = [
    {
      id: 529,
      slotKey: '2026-06-11_1000',
      azsId: '102',
      adminUserId: 51,
      status: 'done',
      errorText: `${NOTIFY_FALLBACK_PREFIX}PARAM_KEYBOARD_ERROR in keyboard structure`,
      reportItemId: null,
      jitterMinutes: null,
      scheduledAt: null,
      deadlineAt: null,
      diskFolderId: null,
      createdAt: null,
      updatedAt: null
    }
  ];

  const deps = makeMinimalDeps({
    reportsStore: { async list() { return fakeItems; } }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({ query: { dateFrom: '2026-06-11', dateTo: '2026-06-11' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.equal(item.errorReason, 'NOTIFY_FALLBACK');
  assert.equal(item.deliveredViaFallback, true);
});

test('GET / sets errorReason=null and deliveredViaFallback=false for item with no errorText', async () => {
  const fakeItems = [
    {
      id: 530,
      slotKey: '2026-06-11_1200',
      azsId: '103',
      adminUserId: 52,
      status: 'done',
      errorText: null,
      reportItemId: null,
      jitterMinutes: null,
      scheduledAt: null,
      deadlineAt: null,
      diskFolderId: null,
      createdAt: null,
      updatedAt: null
    }
  ];

  const deps = makeMinimalDeps({
    reportsStore: { async list() { return fakeItems; } }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({ query: { dateFrom: '2026-06-11', dateTo: '2026-06-11' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.equal(item.errorReason, null);
  assert.equal(item.deliveredViaFallback, false);
  assert.equal(item.errorText, null);
});

test('GET / decorates item with errorReason=NO_AUTH_CONTEXT for skipped slot', async () => {
  const fakeItems = [
    {
      id: 531,
      slotKey: '2026-06-11_0900',
      azsId: '104',
      adminUserId: 53,
      status: 'failed',
      errorText: 'skipped: no auth context at send time',
      reportItemId: null,
      jitterMinutes: null,
      scheduledAt: null,
      deadlineAt: null,
      diskFolderId: null,
      createdAt: null,
      updatedAt: null
    }
  ];

  const deps = makeMinimalDeps({
    reportsStore: { async list() { return fakeItems; } }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');

  const req = makeReviewerReq({ query: { dateFrom: '2026-06-11', dateTo: '2026-06-11' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.equal(item.errorReason, 'NO_AUTH_CONTEXT');
  assert.equal(item.deliveredViaFallback, false);
});
