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
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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
  // Spy для дурабельной CRM-записи причины: updateReasonCrmField → bitrixClient.updateReportItem
  const updateReportItemCalls = [];

  // settings содержит entityTypeId, fields.reason, чтобы updateReasonCrmField прошёл все гварды
  // reportItemId=55 в reportsStore, чтобы Number(reportItemId)>0
  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100, reportItemId: 55 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; },
      async updateReportItem(payload) { updateReportItemCalls.push(payload); return { ok: true }; }
    },
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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

  // Реальная дурабельная запись: updateReasonCrmField вызывает bitrixClient.updateReportItem
  assert.equal(updateReportItemCalls.length, 1, 'updateReportItem должен быть вызван ровно один раз');
  assert.equal(updateReportItemCalls[0].entityTypeId, 10, 'entityTypeId должен быть 10');
  assert.equal(updateReportItemCalls[0].id, 55, 'id должен быть reportItemId=55');
  // encodeValue для пресета (не other) = label из настроек
  assert.equal(
    updateReportItemCalls[0].fields?.['UF_CRM_10_REASON'],
    'Очередь / много гостей',
    'поле UF_CRM_10_REASON должно содержать label пресета queue'
  );
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
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
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

// ─── Бэкафилл кэша причин: маркер + батч вместо N+1 (reason-rehydrate-report.md) ───

function findReasonsHandler(router) {
  const layer = router.stack.find(
    (l) => l?.route?.path === '/reasons' && l?.route?.methods?.get
  );
  assert.ok(layer, 'Route GET /reasons must exist');
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

test('GET /reasons: бэкафилл помечается выполненным даже когда ничего не нашли — повторный заход не бьёт Bitrix снова (сам баг из прод)', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  // 5 отчётов со связанным CRM item, но ни у одного из них Bitrix не отдаёт
  // значение причины — имитация «нормального» состояния (все сдали вовремя).
  const listItems = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, reportItemId: 900 + i, azsId: `AZS-0${i}`, adminUserId: 100
  }));

  let listCrmItemsCalls = 0;
  let getCrmItemCalls = 0;
  let backfillDone = false;
  let markBackfillDoneCalls = 0;

  const fakeReasonStore = {
    ensureSchema: async () => {},
    upsert: async () => { throw new Error('upsert НЕ должен вызываться — Bitrix не вернул ни одного значения причины'); },
    getByReport: async () => null,
    countsByCode: async () => [],
    // Кэш «выглядит пустым» на КАЖДЫЙ вызов — это и есть баг: countEmpty()
    // никогда не меняется сам по себе, только маркер должен останавливать повтор.
    countEmpty: async () => 0,
    isBackfillDone: async () => backfillDone,
    markBackfillDone: async () => { backfillDone = true; markBackfillDoneCalls += 1; }
  };

  const fakeReportsStore = {
    getById: async () => null,
    list: async () => listItems
  };

  const fakeBitrixClient = {
    async getCrmItem() { getCrmItemCalls += 1; return null; },
    async listCrmItems({ filter }) {
      listCrmItemsCalls += 1;
      assert.deepEqual(
        [...filter['@id']].sort((a, b) => a - b),
        listItems.map((i) => i.reportItemId).sort((a, b) => a - b),
        'фильтр @id должен покрывать все reportItemId разом'
      );
      // Строки существуют в CRM, но поле причины пустое — «прогнали и не нашли».
      return listItems.map((item) => ({ id: item.reportItemId }));
    }
  };

  const router = createReportsRouter({
    reportsStore: fakeReportsStore,
    settingsStore: makeSettingsStore(),
    bitrixClient: fakeBitrixClient,
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findReasonsHandler(router);
  const reqOptions = { params: {}, query: {}, accessContext: { capabilities: { reviewer: true } } };

  // Первый заход: маркера ещё нет → бэкафилл должен прогнаться один раз батчем.
  const res1 = makeRes();
  await handler(makeReq(reqOptions), res1);
  assert.equal(res1._status, 200, 'первый запрос должен вернуть 200');
  assert.equal(listCrmItemsCalls, 1, 'должен быть ровно один batched вызов listCrmItems');
  assert.equal(markBackfillDoneCalls, 1, 'после прогона (пусть и без вставок) маркер обязан быть проставлен');

  // Второй заход: кэш «всё ещё пуст» (countEmpty всегда 0 — воспроизводит прод-баг),
  // но маркер уже стоит → бэкафилл повторяться не должен.
  const res2 = makeRes();
  await handler(makeReq(reqOptions), res2);
  assert.equal(res2._status, 200, 'второй запрос тоже должен вернуть 200');
  assert.equal(listCrmItemsCalls, 1, 'второй заход НЕ должен снова дёргать Bitrix — это и есть тест на маркер');
  assert.equal(getCrmItemCalls, 0, 'старый поштучный crm.item.get не должен вызываться вовсе');
});

test('GET /reasons: бэкафилл, который ещё ни разу не запускали, находит и вставляет причины из CRM', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  const listItems = [
    { id: 1, reportItemId: 501, azsId: 'AZS-01', adminUserId: 10 },
    { id: 2, reportItemId: 502, azsId: 'AZS-02', adminUserId: 20 },
    { id: 3, reportItemId: 503, azsId: 'AZS-03', adminUserId: 30 } // без причины в CRM
  ];

  const upsertCalls = [];
  let listCrmItemsCalls = 0;
  let markBackfillDoneCalls = 0;

  const fakeReasonStore = {
    ensureSchema: async () => {},
    upsert: async (args) => { upsertCalls.push(args); return { ...args, id: args.reportId }; },
    getByReport: async () => null,
    countsByCode: async () => [],
    countEmpty: async () => 0,
    isBackfillDone: async () => false,
    markBackfillDone: async () => { markBackfillDoneCalls += 1; }
  };

  const fakeReportsStore = { getById: async () => null, list: async () => listItems };

  const fakeBitrixClient = {
    async getCrmItem() { throw new Error('getCrmItem НЕ должен вызываться — только батч listCrmItems'); },
    async listCrmItems() {
      listCrmItemsCalls += 1;
      return [
        { id: 501, UF_CRM_10_REASON: 'Очередь / много гостей' },
        { id: 502, UF_CRM_10_REASON: 'Другое: течь топлива' },
        { id: 503, UF_CRM_10_REASON: '' }
      ];
    }
  };

  const router = createReportsRouter({
    reportsStore: fakeReportsStore,
    settingsStore: makeSettingsStore(),
    bitrixClient: fakeBitrixClient,
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findReasonsHandler(router);
  const res = makeRes();
  await handler(makeReq({ params: {}, query: {}, accessContext: { capabilities: { reviewer: true } } }), res);

  assert.equal(res._status, 200);
  assert.equal(listCrmItemsCalls, 1, 'должен быть один batched вызов listCrmItems');
  assert.equal(upsertCalls.length, 2, 'вставить нужно только 2 отчёта — у третьего пустое поле причины');
  assert.equal(upsertCalls[0].reportId, 1);
  assert.equal(upsertCalls[0].reasonCode, 'queue');
  assert.equal(upsertCalls[0].reasonText, null);
  assert.equal(upsertCalls[1].reportId, 2);
  assert.equal(upsertCalls[1].reasonCode, 'other');
  assert.equal(upsertCalls[1].reasonText, 'течь топлива');
  assert.equal(markBackfillDoneCalls, 1, 'после успешного прогона маркер должен быть проставлен');
});

test('GET /reasons: для 500 отчётов число вызовов Bitrix ограничено страницами, а не равно 500', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  const N = 500;
  const listItems = Array.from({ length: N }, (_, i) => ({
    id: i + 1, reportItemId: 10000 + i, azsId: `AZS-${i}`, adminUserId: 1
  }));

  let listCrmItemsCalls = 0;
  let getCrmItemCalls = 0;
  let capturedIdCount = null;

  const fakeReasonStore = {
    ensureSchema: async () => {},
    upsert: async () => ({}),
    getByReport: async () => null,
    countsByCode: async () => [],
    countEmpty: async () => 0,
    isBackfillDone: async () => false,
    markBackfillDone: async () => {}
  };

  const fakeReportsStore = { getById: async () => null, list: async () => listItems };

  const fakeBitrixClient = {
    async getCrmItem() { getCrmItemCalls += 1; return null; },
    async listCrmItems({ filter }) {
      listCrmItemsCalls += 1;
      capturedIdCount = filter['@id'].length;
      return []; // пустой ответ — важно только число вызовов и охват id
    }
  };

  const router = createReportsRouter({
    reportsStore: fakeReportsStore,
    settingsStore: makeSettingsStore(),
    bitrixClient: fakeBitrixClient,
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findReasonsHandler(router);
  const res = makeRes();
  await handler(makeReq({ params: {}, query: {}, accessContext: { capabilities: { reviewer: true } } }), res);

  assert.equal(res._status, 200);
  assert.equal(getCrmItemCalls, 0, 'старый N+1 метод (по одному вызову на отчёт) не должен вызываться вовсе');
  assert.equal(listCrmItemsCalls, 1, `на ${N} отчётов должен быть 1 batched вызов listCrmItems, а не ${N}`);
  assert.equal(capturedIdCount, N, 'все N id должны попасть в один @id-фильтр, а не быть отброшены');
});

test('GET /reasons: падение Bitrix при бэкафилле не ломает роут и не помечает бэкафилл выполненным', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  const listItems = [{ id: 1, reportItemId: 700, azsId: 'AZS-07', adminUserId: 5 }];
  let markBackfillDoneCalls = 0;

  const fakeReasonStore = {
    ensureSchema: async () => {},
    upsert: async () => { throw new Error('upsert НЕ должен вызываться — Bitrix упал до получения данных'); },
    getByReport: async () => null,
    countsByCode: async () => [],
    countEmpty: async () => 0,
    isBackfillDone: async () => false,
    markBackfillDone: async () => { markBackfillDoneCalls += 1; }
  };

  const fakeReportsStore = { getById: async () => null, list: async () => listItems };

  const fakeBitrixClient = {
    async getCrmItem() { throw new Error('getCrmItem НЕ должен вызываться'); },
    async listCrmItems() {
      throw new Error('Bitrix REST crm.item.list failed with HTTP 503: QUERY_LIMIT_EXCEEDED');
    }
  };

  const router = createReportsRouter({
    reportsStore: fakeReportsStore,
    settingsStore: makeSettingsStore(),
    bitrixClient: fakeBitrixClient,
    dispatchService: makeDispatchService(),
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — этот файл не трогает приём фото.
    photoQueueStore: { async accept() {} },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findReasonsHandler(router);
  const res = makeRes();
  await handler(makeReq({ params: {}, query: {}, accessContext: { capabilities: { reviewer: true } } }), res);

  assert.equal(res._status, 200, 'роут должен остаться рабочим (best-effort) даже если Bitrix упал при бэкафилле');
  assert.ok(Array.isArray(res._body?.items), 'ответ должен содержать items несмотря на упавший бэкафилл');
  assert.equal(markBackfillDoneCalls, 0, 'при ошибке бэкафилл НЕ должен быть помечен как выполненный — иначе следующий заход его больше не повторит');
});
