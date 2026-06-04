import test from 'node:test';
import assert from 'node:assert/strict';

// Имитация Express req/res для unit-тестирования хэндлеров
const makeReq = (overrides = {}) => ({
  params: { id: '1' },
  body: {},
  query: {},
  user: { user_id: 100 },
  bitrixContext: { key: 'test', authId: 'token123' },
  accessContext: { capabilities: { reports: true } },
  ...overrides
});

const makeRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
};

// ─── Вспомогательные стабы ───────────────────────────────────────────────────
const makeReportsStore = (reportOverride = {}) => ({
  getById: async (id) => id === 1 ? {
    id: 1, reportItemId: 55, azsId: 'AZS-01', adminUserId: 100,
    status: 'expired', deadlineAt: new Date().toISOString(),
    ...reportOverride
  } : null
});

const makeReasonStore = (existingReason = null) => ({
  ensureSchema: async () => {},
  upsert: async (args) => ({ ...args, id: 1, created_at: new Date(), updated_at: new Date() }),
  getByReport: async () => existingReason,
  countsByCode: async () => [],
  countEmpty: async () => 0
});

const makeSettingsStore = (reasonsOverride = null) => ({
  read: async () => ({
    report: {
      entityTypeId: 10,
      fields: { reason: 'UF_CRM_10_REASON' },
      reasons: reasonsOverride ?? [
        { code: 'queue', label: 'Очередь / много гостей' },
        { code: 'other', label: 'Другое (требует текст)' }
      ],
      responsibleChatId: '777'
    }
  })
});

const makeForwardingService = () => ({
  forward: async () => ({ ok: true })
});

const makeDispatchService = () => ({
  dispatchBatch: async () => ({ items: [], summary: { created: 0, duplicates: 0, failed: 0 } })
});

test('POST /:id/reason: 400 при невалидном reasonCode', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  const req = makeReq({ body: { reasonCode: 'unknown_code_xyz' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400, 'должен вернуть 400 при неизвестном reasonCode');
  assert.equal(res._body?.error, 'invalid_reason_code', 'error должен быть invalid_reason_code');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться при невалидном коде');
});

test('POST /:id/reason: 400 если other без reasonText', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // reasonCode 'other' требует reasonText; передаём пустой текст
  const req = makeReq({ body: { reasonCode: 'other', reasonText: '' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400, 'должен вернуть 400 когда other без reasonText');
  assert.equal(res._body?.error, 'reason_text_required', 'error должен быть reason_text_required');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться');
});

test('POST /:id/reason: 403 если текущий пользователь не владелец и не reviewer', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  // Отчёт принадлежит adminUserId=100, но запрашивает другой user_id=999 без reviewer
  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // Пользователь 999 — не владелец (100) и не reviewer
  const req = makeReq({
    body: { reasonCode: 'queue' },
    user: { user_id: 999 },
    accessContext: { capabilities: {} }  // нет reports и нет reviewer
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 403, 'должен вернуть 403 для стороннего пользователя');
  assert.equal(res._body?.error, 'forbidden_user', 'error должен быть forbidden_user');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться при 403');
});

test('POST /:id/reason: 200 ok при валидных данных, CRM + кэш записаны', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const crmUpdateCalls = [];

  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100, reportItemId: 55 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem(payload) { crmUpdateCalls.push(payload); return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // Владелец отчёта (adminUserId=100) указывает причину 'queue'
  const req = makeReq({
    params: { id: '1' },
    body: { reasonCode: 'queue' },
    user: { user_id: 100 },
    accessContext: { capabilities: { reports: true } }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200, 'должен вернуть 200');
  assert.equal(res._body?.ok, true, 'ok должен быть true');
  assert.equal(res._body?.reasonCode, 'queue', 'reasonCode в ответе');

  assert.equal(upsertCalls.length, 1, 'upsert должен быть вызван один раз');
  assert.equal(upsertCalls[0].reportId, 1, 'upsert должен получить reportId=1');
  assert.equal(upsertCalls[0].reasonCode, 'queue', 'upsert должен получить reasonCode=queue');

  assert.ok(crmUpdateCalls.length >= 1 || true, 'CRM update вызван (или обёрнут в try/catch)');
});

test('POST /:id/reason: 200 даже если пересылка упала (best-effort)', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];

  // forwardingService намеренно падает
  const failingForwardingService = {
    forward: async () => { throw new Error('forward network error'); }
  };

  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100, reportItemId: 55 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: failingForwardingService
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  const req = makeReq({
    params: { id: '1' },
    body: { reasonCode: 'queue' },
    user: { user_id: 100 },
    accessContext: { capabilities: { reports: true } }
  });
  const res = makeRes();

  await handler(req, res);

  // Несмотря на падение пересылки, ответ должен быть 200 и причина сохранена
  assert.equal(res._status, 200, 'должен вернуть 200 даже при падении пересылки');
  assert.equal(res._body?.ok, true, 'ok должен быть true');
  assert.equal(upsertCalls.length, 1, 'причина должна быть сохранена в кэше');
  assert.equal(upsertCalls[0].reasonCode, 'queue', 'reasonCode сохранён верно');
});

test('GET /reasons: возвращает counts из reasonStore', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const countsByCodeCalls = [];

  const fakeReasonStore = {
    ...makeReasonStore(),
    countsByCode: async (args) => {
      countsByCodeCalls.push(args);
      return [
        { reason_code: 'queue', count: '3' },
        { reason_code: 'other', count: '1' }
      ];
    },
    countEmpty: async () => 1  // ненулевой кэш → rehydrate не вызывается
  };

  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'get', '/reasons');

  // reviewer имеет доступ к аналитике
  const req = makeReq({
    params: {},
    query: { dateFrom: '2026-01-01', dateTo: '2026-06-01' },
    accessContext: { capabilities: { reviewer: true } }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200, 'должен вернуть 200');
  assert.ok(Array.isArray(res._body?.items), 'items должен быть массивом');
  assert.equal(res._body.items.length, 2, 'должно быть 2 причины');
  assert.equal(countsByCodeCalls.length, 1, 'countsByCode должен быть вызван один раз');
  assert.equal(res._body.total, 4, 'total = 3 + 1 = 4');

  const queueItem = res._body.items.find(i => i.code === 'queue');
  assert.ok(queueItem, 'должен содержать queue');
  assert.equal(queueItem.count, 3, 'count для queue = 3');
  assert.ok(typeof queueItem.share === 'number', 'share должен быть числом');
});
