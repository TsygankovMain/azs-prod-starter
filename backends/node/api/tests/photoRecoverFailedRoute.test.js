import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// C4 (финальное ревью ветки) — POST /photos/recover-failed. Тот же приём
// тестирования маршрута напрямую через router.stack, что и tests/reportsResync.test.js
// (ближайший прецедент того же класса действия — "оператор вручную дёргает
// повтор застрявшего отчёта", та же проверка canUseReviewerTools).
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
    user: { user_id: 777, name: 'Дежурный Иванов' },
    ...overrides
  };
}

function makeMinimalDeps(overrides = {}) {
  return {
    reportsStore: {
      async getById(id) { return { id: Number(id), status: 'in_progress', diskFolderId: 5, azsId: '1', reportItemId: 0 }; },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    settingsStore: { async read() { return {}; } },
    bitrixClient: { diskApi: {}, async updateReportItem() { return { ok: true }; } },
    notificationService: {},
    authContextStore: { async getLastAdminContext() { return null; } },
    dispatchService: {},
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    photoQueueStore: { async accept() {}, async recoverFailed() { return []; } },
    ...overrides
  };
}

function findHandler(router, method, path) {
  const layer = router.stack.find((l) => l?.route?.path === path && l?.route?.methods?.[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

test('POST /photos/recover-failed: 403 без reviewer/settings capability, стор не вызывается', async () => {
  const calls = [];
  const deps = makeMinimalDeps({
    photoQueueStore: { async accept() {}, async recoverFailed(args) { calls.push(args); return []; } }
  });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/photos/recover-failed');

  const req = { params: {}, body: { reportId: 42 }, accessContext: { capabilities: {} } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res._payload?.error, 'forbidden');
  assert.equal(calls.length, 0, 'recoverFailed не должен вызываться при 403');
});

test('POST /photos/recover-failed: {reportId} — вызывает стор, возвращает recoveredCount/recoveredIds', async () => {
  const calls = [];
  const deps = makeMinimalDeps({
    photoQueueStore: {
      async accept() {},
      async recoverFailed(args) {
        calls.push(args);
        return [{ id: 5, report_id: 42, photo_code: 'FRONT' }, { id: 6, report_id: 42, photo_code: 'BACK' }];
      }
    }
  });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/photos/recover-failed');

  const req = makeReviewerReq({ body: { reportId: 42 } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload?.ok, true);
  assert.equal(res._payload?.recoveredCount, 2);
  assert.deepEqual(res._payload?.recoveredIds, [5, 6]);
  assert.deepEqual(calls, [{ reportId: 42, ids: undefined }]);
});

test('POST /photos/recover-failed: {ids} — вызывает стор со списком, а не с reportId', async () => {
  const calls = [];
  const deps = makeMinimalDeps({
    photoQueueStore: {
      async accept() {},
      async recoverFailed(args) { calls.push(args); return [{ id: 7 }, { id: 9 }]; }
    }
  });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/photos/recover-failed');

  const req = makeReviewerReq({ body: { ids: [7, 9] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload?.recoveredIds, [7, 9]);
  assert.deepEqual(calls, [{ reportId: undefined, ids: [7, 9] }]);
});

test('POST /photos/recover-failed: неоднозначный/пустой селектор — 400, а не 500 (ошибка вызывающего)', async () => {
  const deps = makeMinimalDeps({
    photoQueueStore: {
      async accept() {},
      // Реальная валидация живёт в photoQueueStore.js (normalizeRecoverFailedSelector) —
      // здесь фейк воспроизводит именно её контракт (бросает RangeError),
      // чтобы проверить, что РОУТ, а не только стор, транслирует это в 400.
      async recoverFailed({ reportId, ids }) {
        const hasReportId = reportId !== undefined && reportId !== null;
        const hasIds = Array.isArray(ids) && ids.length > 0;
        if (hasReportId === hasIds) throw new RangeError('recoverFailed: ровно один селектор обязателен');
        return [];
      }
    }
  });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/photos/recover-failed');

  const reqBoth = makeReviewerReq({ body: { reportId: 1, ids: [2, 3] } });
  const resBoth = makeRes();
  await handler(reqBoth, resBoth);
  assert.equal(resBoth.statusCode, 400);
  assert.equal(resBoth._payload?.error, 'invalid_selector');

  const reqNeither = makeReviewerReq({ body: {} });
  const resNeither = makeRes();
  await handler(reqNeither, resNeither);
  assert.equal(resNeither.statusCode, 400);
  assert.equal(resNeither._payload?.error, 'invalid_selector');
});

test('POST /photos/recover-failed: пишет аудит-лог с actorUserId/actorName/selector/recoveredIds ("кто и когда")', async () => {
  const deps = makeMinimalDeps({
    photoQueueStore: {
      async accept() {},
      async recoverFailed() { return [{ id: 11, report_id: 5 }]; }
    }
  });
  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'post', '/photos/recover-failed');

  const req = makeReviewerReq({ body: { reportId: 5 }, user: { user_id: 321, name: 'Оператор Петров' } });
  const res = makeRes();

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => { logged.push(args); };
  try {
    await handler(req, res);
  } finally {
    console.log = originalLog;
  }

  const auditLine = logged.map((args) => args[0]).find((line) => {
    try { return JSON.parse(line).event === 'photo_publish_failed_recovered'; } catch { return false; }
  });
  assert.ok(auditLine, 'обязана быть залогирована строка события photo_publish_failed_recovered');
  const parsed = JSON.parse(auditLine);
  assert.equal(parsed.actorUserId, 321, 'кто дёрнул — обязан быть записан');
  assert.equal(parsed.actorName, 'Оператор Петров');
  assert.deepEqual(parsed.selector, { reportId: 5 });
  assert.deepEqual(parsed.recoveredIds, [11]);
  assert.equal(parsed.recoveredCount, 1);
  assert.ok(typeof parsed.at === 'string' && !Number.isNaN(Date.parse(parsed.at)), 'когда дёрнул — обязана быть валидная дата');
});
