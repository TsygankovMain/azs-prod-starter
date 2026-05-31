import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Shared helpers
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
    body: {},
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: { key: 'reviewer-ctx-key' },
    ...overrides
  };
}

function makeAdminReq(overrides = {}) {
  return {
    params: {},
    body: {},
    accessContext: { capabilities: { reports: true } },
    bitrixContext: { key: 'admin-ctx-key' },
    ...overrides
  };
}

// Minimal stubs sufficient for router construction. Individual tests override
// the relevant store methods.
function makeMinimalDeps(overrides = {}) {
  return {
    reportsStore: {
      async getById(id) {
        if (Number(id) === 404) return null;
        return { id: Number(id), status: 'in_progress', diskFolderId: 5, azsId: '1', reportItemId: 0 };
      },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    settingsStore: {
      async read() {
        return {
          azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
          photoType: { entityTypeId: 1112 },
          report: {
            entityTypeId: 163,
            fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
            stages: { inProgress: 'DT163_1:IN_PROGRESS' }
          },
          disk: { rootFolderId: 0, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' }
        };
      }
    },
    bitrixClient: {
      diskApi: {
        async findChildFolder() { return null; },
        async findChildFile() { return null; },
        async createFolder() { return { id: 1 }; },
        async markFileDeleted() { return { id: 1 }; },
        async uploadFile() { return { diskObjectId: 1, crmFileId: 1, fileName: 'f.jpg' }; }
      },
      async getCrmItem({ entityTypeId, id }) {
        if (entityTypeId === 145) return { id, title: 'АЗС №1', UF_PHOTO_SET: [42] };
        if (entityTypeId === 1112) return { id: 42, title: '42. Колонки' };
        return null;
      },
      async updateReportItem() { return { ok: true }; }
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

// Find the last handler of a named route in the router stack.
function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l?.route?.path === path && l?.route?.methods?.[method]
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

// ---------------------------------------------------------------------------
// Test 1: POST /:id/resync enqueues a job with report status + contextKey
// ---------------------------------------------------------------------------

test('POST /:id/resync enqueues a job and returns {ok:true, syncQueued:true}', async () => {
  const enqueueCalls = [];

  const deps = makeMinimalDeps({
    crmSyncJobStore: {
      async enqueue(job) { enqueueCalls.push(job); return { id: 1 }; },
      async listByReport() { return []; }
    },
    reportsStore: {
      async getById(id) {
        return { id: Number(id), status: 'in_progress', diskFolderId: 42, azsId: '3' };
      },
      async listPhotos() { return []; },
      async setReportStatus() {}
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/:id/resync');

  const req = makeReviewerReq({
    params: { id: '55' },
    bitrixContext: { key: 'reviewer-ctx-key' }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.ok, true);
  assert.equal(res._payload?.syncQueued, true);
  assert.equal(res._payload?.reportId, 55);

  assert.equal(enqueueCalls.length, 1, 'must enqueue exactly one job');
  assert.equal(enqueueCalls[0].reportId, 55);
  assert.equal(enqueueCalls[0].payload.status, 'in_progress');
  assert.equal(enqueueCalls[0].payload.diskFolderId, 42);
  // contextKey is the caller's key, stored only as an audit/fallback hint. The
  // worker syncs under the portal ADMIN context (see buildCrmSyncRunner / I2).
  assert.equal(enqueueCalls[0].payload.contextKey, 'reviewer-ctx-key');
});

// ---------------------------------------------------------------------------
// Test 2: POST /:id/resync on a missing report returns 404
// ---------------------------------------------------------------------------

test('POST /:id/resync returns 404 when report does not exist', async () => {
  const deps = makeMinimalDeps({
    crmSyncJobStore: {
      async enqueue() { return { id: 1 }; },
      async listByReport() { return []; }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/:id/resync');

  const req = makeReviewerReq({ params: { id: '404' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res._payload?.error, 'report_not_found');
});

// ---------------------------------------------------------------------------
// Test 3: POST /:id/resync returns 403 when caller lacks reviewer/settings capability
// ---------------------------------------------------------------------------

test('POST /:id/resync returns 403 with {error:"forbidden"} and does not enqueue when caller has no reviewer/settings capability', async () => {
  const enqueueCalls = [];

  const deps = makeMinimalDeps({
    crmSyncJobStore: {
      async enqueue(job) { enqueueCalls.push(job); return { id: 1 }; },
      async listByReport() { return []; }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/:id/resync');

  const req = {
    params: { id: '55' },
    body: {},
    accessContext: { capabilities: {} },
    bitrixContext: { key: 'no-caps-key' }
  };
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res._payload?.error, 'forbidden');
  assert.equal(enqueueCalls.length, 0, 'enqueue must NOT be called when 403');
});

// ---------------------------------------------------------------------------
// Test 4: GET /:id syncStatus reflects the latest job state
// ---------------------------------------------------------------------------

test('GET /:id includes syncStatus derived from crmSyncJobStore', async () => {
  // Sub-test A: latest job is 'failed' → synced===false, lastSyncError surfaced
  await (async () => {
    const failedJob = {
      id: 7,
      report_id: 10,
      status: 'failed',
      last_error: 'CRM timeout',
      attempts: 3,
      max_attempts: 3,
      payload: {}
    };

    const deps = makeMinimalDeps({
      crmSyncJobStore: {
        async enqueue() { return { id: 1 }; },
        async listByReport() { return [failedJob]; }
      },
      reportsStore: {
        async getById(id) {
          return { id: Number(id), status: 'done', diskFolderId: 5, azsId: '1', reportItemId: 0 };
        },
        async listPhotos() { return []; },
        async setReportStatus() {}
      }
    });

    const router = createReportsRouter(deps);
    const handler = findHandler(router, 'get', '/:id');

    const req = makeAdminReq({ params: { id: '10' } });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200, 'should succeed');
    assert.equal(res._payload?.syncStatus?.synced, false, 'synced should be false for failed job');
    assert.equal(res._payload?.syncStatus?.lastSyncError, 'CRM timeout', 'lastSyncError should be surfaced');
    assert.equal(res._payload?.syncStatus?.syncState, 'failed');
  })();

  // Sub-test B: no jobs → synced===true (legacy/no-op)
  await (async () => {
    const deps = makeMinimalDeps({
      crmSyncJobStore: {
        async enqueue() { return { id: 1 }; },
        async listByReport() { return []; }
      },
      reportsStore: {
        async getById(id) {
          return { id: Number(id), status: 'done', diskFolderId: 5, azsId: '1', reportItemId: 0 };
        },
        async listPhotos() { return []; },
        async setReportStatus() {}
      }
    });

    const router = createReportsRouter(deps);
    const handler = findHandler(router, 'get', '/:id');

    const req = makeAdminReq({ params: { id: '11' } });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200, 'should succeed');
    assert.equal(res._payload?.syncStatus?.synced, true, 'synced should be true when no jobs');
    assert.equal(res._payload?.syncStatus?.lastSyncError, null);
    assert.equal(res._payload?.syncStatus?.syncState, 'none');
  })();
});
