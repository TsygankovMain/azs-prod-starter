import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter, buildCrmSyncRunner } from '../src/reports/reportsRoutes.js';
import { syncReportToCrmIfComplete } from '../src/reports/photoPublishCompletion.js';
import { resolveReportStageId } from '../src/reports/reportCrmSync.js';
import { createCrmSyncWorker } from '../src/reports/crmSyncWorker.js';

// ---------------------------------------------------------------------------
// BUG-8709: сданный отчёт остаётся в CRM в стадии «в работе».
//
// Что было. Единственным триггером перевода стадии была проверка комплекта
// после публикации фото (photoPublishCompletion.js), а POST /:id/submit
// намеренно не ставил задачу в очередь. Публикация фото почти всегда
// заканчивается на секунду-две РАНЬШЕ, чем оператор жмёт «сдать» (на проде —
// 1326 задач из 1464 поставлены до сдачи). Значит задача ставилась, пока
// dispatch_log.status ещё 'in_progress', раннер писал стадию «в работе», а
// после смены статуса на 'done' повторить перевод было НЕЧЕМ: публиковать
// больше нечего, а идемпотентность («задача с непустой папкой уже есть»)
// вернула бы already_queued даже если бы проверку кто-то позвал.
//
// Чинится двумя половинами; ниже проверяются обе, плюс наблюдаемость.
// ---------------------------------------------------------------------------

const ORTK_SETTINGS = {
  report: {
    entityTypeId: 1116,
    fields: { folderId: 'ufCrm36_1778062550', photos: 'ufCrm36_1778062580' },
    stages: {
      new: 'DT1116_44:NEW',
      inProgress: 'DT1116_44:PREPARATION',
      done: 'DT1116_44:SUCCESS',
      expired: 'DT1116_44:FAIL',
      rejected: 'DT1116_44:UC_07G901'
    }
  }
};

function makeCrmSyncJobStoreFake() {
  const jobs = [];
  return {
    jobs,
    payloads() { return jobs.map((j) => JSON.parse(j.payload)); },
    async enqueue({ reportId, payload }) {
      const job = { id: jobs.length + 1, report_id: Number(reportId), payload: JSON.stringify(payload), status: 'pending' };
      jobs.push(job);
      return job;
    },
    async listByReport(reportId) {
      return jobs.filter((j) => j.report_id === Number(reportId));
    }
  };
}

const SILENT_LOGGER = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// 1. Ядро бага: смена статуса обязана порождать новую задачу
// ---------------------------------------------------------------------------

test('BUG-8709: задача, поставленная под статусом in_progress, НЕ закрывает потребность в задаче под done', async () => {
  const reportId = 870901;
  let status = 'in_progress';
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 4242, status }; },
    async getRequiredPhotoCodes() { return ['1', '2']; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 421860 }]; }
  };
  const photoQueueStore = {
    async listPhotoStates() {
      return [{ photoCode: '1', publishState: 'published' }, { photoCode: '2', publishState: 'published' }];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const deps = { reportId, reportsStore, photoQueueStore, crmSyncJobStore, logger: SILENT_LOGGER };

  // Момент T+0: воркер опубликовал последнее обязательное фото. Оператор ещё
  // не нажал «сдать» — отчёт в работе.
  const onPublish = await syncReportToCrmIfComplete(deps);
  assert.equal(onPublish.synced, true);
  assert.equal(onPublish.triggerStatus, 'in_progress');
  assert.equal(crmSyncJobStore.jobs.length, 1);
  assert.equal(crmSyncJobStore.payloads()[0].triggerStatus, 'in_progress');

  // Момент T+2: оператор сдал смену. Ровно здесь до правки всё и обрывалось —
  // already_queued, карточка навсегда в DT1116_44:PREPARATION.
  status = 'done';
  const onSubmit = await syncReportToCrmIfComplete(deps);
  assert.equal(onSubmit.synced, true, 'смена статуса обязана породить новую задачу, а не вернуть already_queued');
  assert.equal(onSubmit.triggerStatus, 'done');
  assert.equal(crmSyncJobStore.jobs.length, 2);
  assert.equal(crmSyncJobStore.payloads()[1].triggerStatus, 'done');
  assert.equal(crmSyncJobStore.payloads()[1].diskFolderId, 421860);
});

test('BUG-8709: повторный проход при ТОМ ЖЕ статусе по-прежнему не плодит задачи', async () => {
  const reportId = 870902;
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 1, status: 'done' }; },
    async getRequiredPhotoCodes() { return ['1']; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 555 }]; }
  };
  const photoQueueStore = { async listPhotoStates() { return [{ photoCode: '1', publishState: 'published' }]; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const deps = { reportId, reportsStore, photoQueueStore, crmSyncJobStore, logger: SILENT_LOGGER };

  assert.equal((await syncReportToCrmIfComplete(deps)).synced, true);
  const second = await syncReportToCrmIfComplete(deps);
  assert.equal(second.synced, false);
  assert.equal(second.reason, 'already_queued');
  assert.equal(crmSyncJobStore.jobs.length, 1);
});

test('BUG-8709: залипшая задача БЕЗ triggerStatus (данные до правки) не блокирует починку', async () => {
  const reportId = 870903;
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 2, status: 'done' }; },
    async getRequiredPhotoCodes() { return ['1']; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 777 }]; }
  };
  const photoQueueStore = { async listPhotoStates() { return [{ photoCode: '1', publishState: 'published' }]; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  // Ровно то, что лежит в проде: задача с настоящей папкой, но без признака,
  // ради какого статуса она ставилась.
  await crmSyncJobStore.enqueue({ reportId, payload: { diskFolderId: 777, contextKey: '', domain: '', memberId: '' } });

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore, logger: SILENT_LOGGER });

  assert.equal(result.synced, true, 'старая задача без triggerStatus не имеет права считаться закрывающей');
  assert.equal(crmSyncJobStore.jobs.length, 2);
  assert.equal(crmSyncJobStore.payloads()[1].triggerStatus, 'done');
});

test('BUG-8709: условие перевода НЕ ослаблено — при неопубликованном обязательном фото задачи нет ни при каком статусе', async () => {
  const reportId = 870904;
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 3, status: 'done' }; },
    async getRequiredPhotoCodes() { return ['1', '2']; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 888 }]; }
  };
  const photoQueueStore = {
    async listPhotoStates() {
      return [{ photoCode: '1', publishState: 'published' }, { photoCode: '2', publishState: 'accepted' }];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore, logger: SILENT_LOGGER });

  assert.equal(result.synced, false);
  assert.equal(result.reason, 'incomplete');
  assert.deepEqual(result.missingCodes, ['2']);
  assert.equal(crmSyncJobStore.jobs.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Вторая половина правки: /:id/submit — второй триггер
// ---------------------------------------------------------------------------

function findHandler(router, method, path) {
  const layer = router.stack.find((l) => l?.route?.path === path && l?.route?.methods?.[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

function makeRes() {
  const responses = [];
  return {
    responses,
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { responses.push({ status: this.statusCode, payload }); return payload; }
  };
}

function makeReq({ reportId }) {
  return {
    params: { id: String(reportId) },
    body: {},
    user: { id: 10 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'member-1', domain: 'ortk.bitrix24.ru', userId: 10,
      authId: 'user-auth', refreshToken: 'r', isAdmin: false
    }
  };
}

// Сдача смены обязана переживать недоступность портала (Important 1, Task 8):
// критический путь /submit не имеет права трогать Битрикс и настройки.
function makeThrowingBitrixClient() {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => { throw new Error(`bitrixClient.${String(prop)}() must not be called from /submit`); };
    }
  });
}

function buildSubmitRouter({ reportId, publishStates, crmSyncJobStore, photoQueueStore = null }) {
  // Статус живёт в замыкании: submit сначала читает отчёт (in_progress),
  // затем переводит его в 'done', и только потом зовёт проверку комплекта —
  // та обязана увидеть уже НОВЫЙ статус.
  let status = 'in_progress';
  const calls = { setReportStatus: [], setOperatorCompletedAt: [] };
  const reportsStore = {
    async getById(id) {
      return {
        id: Number(id), slotKey: '2026-09-06:0855', azsId: '164', adminUserId: 10,
        status, reportItemId: 14426, deadlineAt: new Date(Date.now() + 3600e3).toISOString()
      };
    },
    async getRequiredPhotoCodes() { return ['1', '2']; },
    async listPhotos() {
      return [
        { reportId, photoCode: '1', diskFolderId: 421538, diskObjectId: 1 },
        { reportId, photoCode: '2', diskFolderId: 421538, diskObjectId: 2 }
      ];
    },
    async setReportStatus(args) { calls.setReportStatus.push(args); status = args.status; },
    async setOperatorCompletedAt(args) { calls.setOperatorCompletedAt.push(args); }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore: { async read() { throw new Error('settingsStore.read() must not be called on the critical path of /submit'); } },
    bitrixClient: makeThrowingBitrixClient(),
    notificationService: { async notifyReportDone() {}, async notifyDispatch() {}, async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore,
    photoQueueStore: photoQueueStore || {
      async accept() {},
      async listPhotoStates() { return publishStates; }
    }
  });

  return { router, calls };
}

test('BUG-8709: /submit ставит задачу на перевод стадии, когда все обязательные фото уже опубликованы (типовая гонка прода)', async () => {
  const reportId = 870910;
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const { router, calls } = buildSubmitRouter({
    reportId,
    publishStates: [{ photoCode: '1', publishState: 'published' }, { photoCode: '2', publishState: 'published' }],
    crmSyncJobStore
  });

  const res = makeRes();
  await findHandler(router, 'post', '/:id/submit')(makeReq({ reportId }), res);

  assert.equal(res.responses[0]?.status, 200, JSON.stringify(res.responses[0]?.payload));
  assert.deepEqual(calls.setReportStatus, [{ reportId, status: 'done' }]);
  assert.equal(crmSyncJobStore.jobs.length, 1, '/submit обязан поставить задачу — иначе стадию переводить некому');
  const payload = crmSyncJobStore.payloads()[0];
  assert.equal(payload.triggerStatus, 'done', 'проверка обязана увидеть УЖЕ обновлённый статус, а не тот, что был на входе в submit');
  assert.equal(payload.diskFolderId, 421538);
  // payload.status намеренно не заморожен: buildCrmSyncRunner перечитывает
  // dispatch_log.status в момент выполнения задачи.
  assert.equal(payload.status, undefined);
});

test('BUG-8709: /submit не ставит задачу, пока публикация не завершена (перевод останется за воркером публикации)', async () => {
  const reportId = 870911;
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const { router } = buildSubmitRouter({
    reportId,
    publishStates: [{ photoCode: '1', publishState: 'published' }, { photoCode: '2', publishState: 'accepted' }],
    crmSyncJobStore
  });

  const res = makeRes();
  await findHandler(router, 'post', '/:id/submit')(makeReq({ reportId }), res);

  assert.equal(res.responses[0]?.status, 200);
  assert.equal(crmSyncJobStore.jobs.length, 0, 'фото ещё не доехали до Битрикса — переводить стадию рано');
});

test('BUG-8709: сбой проверки комплекта не превращает уже состоявшуюся сдачу смены в ошибку оператору', async () => {
  const reportId = 870912;
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const { router, calls } = buildSubmitRouter({
    reportId,
    publishStates: [],
    crmSyncJobStore,
    photoQueueStore: {
      async accept() {},
      async listPhotoStates() { throw new Error('очередь публикации недоступна'); }
    }
  });

  const res = makeRes();
  await findHandler(router, 'post', '/:id/submit')(makeReq({ reportId }), res);

  assert.equal(res.responses[0]?.status, 200, 'сдача смены уже записана — падать нельзя');
  assert.equal(calls.setReportStatus.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Наблюдаемость: отказ Битрикса обязан попадать в лог с текстом
// ---------------------------------------------------------------------------

test('BUG-8709: Битрикс ответил 200, но стадию не переключил -> отказ с текстом, а не тихий успех', async () => {
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 14426, status: 'done' }; },
    async listPhotos() { return [{ photoCode: '1', diskFolderId: 421538 }]; }
  };
  const settingsStore = { async read() { return ORTK_SETTINGS; } };
  const admin = {
    key: 'm1:ortk.bitrix24.ru:1',
    context: { authId: 'tok', domain: 'ortk.bitrix24.ru', memberId: 'm1', isAdmin: true }
  };
  const authContextStore = {
    async getLastAdminContext() { return admin; },
    async getLastAdminContextForPortal() { return admin; }
  };
  const bitrixClient = {
    // Классическая причуда портала: update принят (200), а стадия осталась
    // прежней — например, stageId не принадлежит категории элемента.
    async updateReportItem() { return { id: 14426 }; },
    async getCrmItem() {
      return { id: 14426, stageId: 'DT1116_44:PREPARATION', ufCrm36_1778062550: '421538' };
    }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, logger: SILENT_LOGGER });

  await assert.rejects(
    () => runSync({
      report_id: 870920,
      payload: JSON.stringify({ triggerStatus: 'done', diskFolderId: 421538, domain: 'ortk.bitrix24.ru', memberId: 'm1' })
    }),
    (error) => {
      assert.equal(error.code, 'report_stage_sync_failed');
      assert.match(error.message, /DT1116_44:SUCCESS/, 'в тексте обязана быть ожидаемая стадия');
      assert.match(error.message, /DT1116_44:PREPARATION/, 'в тексте обязана быть фактическая стадия');
      return true;
    }
  );
});

test('BUG-8709: стадия переключилась -> синк проходит и стадия действительно записана', async () => {
  const updates = [];
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 14426, status: 'done' }; },
    async listPhotos() { return [{ photoCode: '1', diskFolderId: 421538 }]; }
  };
  const settingsStore = { async read() { return ORTK_SETTINGS; } };
  const admin = { key: 'm1:ortk.bitrix24.ru:1', context: { authId: 'tok', domain: 'ortk.bitrix24.ru', memberId: 'm1', isAdmin: true } };
  const authContextStore = {
    async getLastAdminContext() { return admin; },
    async getLastAdminContextForPortal() { return admin; }
  };
  const bitrixClient = {
    async updateReportItem(args) { updates.push(args); return { id: 14426 }; },
    async getCrmItem() { return { id: 14426, stageId: 'DT1116_44:SUCCESS', ufCrm36_1778062550: '421538' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, logger: SILENT_LOGGER });
  await runSync({
    report_id: 870921,
    payload: JSON.stringify({ triggerStatus: 'done', diskFolderId: 421538, domain: 'ortk.bitrix24.ru', memberId: 'm1' })
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields.stageId, 'DT1116_44:SUCCESS');
  assert.equal(updates[0].entityTypeId, 1116);
  assert.equal(updates[0].id, 14426);
});

test('BUG-8709: промежуточный отказ синка попадает в лог с текстом ошибки, а не только в колонку last_error', async () => {
  const warnings = [];
  const store = {
    jobs: [{ id: 1, report_id: 55, payload: '{}', attempts: 0, max_attempts: 4 }],
    async claimNextDue() { return this.jobs.shift() ?? null; },
    async markDone() {},
    async markFailed() {},
    async reschedule() {}
  };
  const worker = createCrmSyncWorker({
    store,
    runSync: async () => { throw new Error('Report CRM stage was not synced. Expected "DT1116_44:SUCCESS", got "DT1116_44:PREPARATION"'); },
    logger: { log() {}, warn(event, data) { warnings.push({ event, data }); }, error() {} }
  });

  assert.equal(await worker.tick(), true);

  assert.equal(warnings.length, 1, 'неудачная попытка обязана оставить след в логе');
  assert.equal(warnings[0].event, 'crm_sync_job_retry');
  assert.equal(warnings[0].data.jobId, 1);
  assert.equal(warnings[0].data.reportId, 55);
  assert.equal(warnings[0].data.attempt, 1);
  assert.match(warnings[0].data.message, /DT1116_44:SUCCESS/);
});

// ---------------------------------------------------------------------------
// 4. Маппинг стадий — единственный источник для записи И для проверки
// ---------------------------------------------------------------------------

test('resolveReportStageId: боевой маппинг ОРТК разбирается целиком', () => {
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'new' }), 'DT1116_44:NEW');
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'in_progress' }), 'DT1116_44:PREPARATION');
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'done' }), 'DT1116_44:SUCCESS');
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'expired' }), 'DT1116_44:FAIL');
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'rejected' }), 'DT1116_44:UC_07G901');
});

test('resolveReportStageId: статусы без стадии и пустые настройки дают null, а не мусорную стадию', () => {
  // 'cancelled'/'failed' стадии не имеют по замыслу — карточка остаётся как есть.
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'cancelled' }), null);
  assert.equal(resolveReportStageId({ settings: ORTK_SETTINGS, status: 'failed' }), null);
  assert.equal(resolveReportStageId({ settings: {}, status: 'done' }), null);
  assert.equal(resolveReportStageId({ settings: { report: { stages: { done: '   ' } } }, status: 'done' }), null);
});

test('BUG-8709: сдача при ненастроенной стадии done кричит в лог, а не молчит', async () => {
  const errors = [];
  const settingsNoDoneStage = {
    report: { entityTypeId: 1116, fields: { folderId: 'ufCrm36_1778062550' }, stages: { inProgress: 'DT1116_44:PREPARATION' } }
  };
  const reportsStore = {
    async getById(id) { return { id: Number(id), reportItemId: 14426, status: 'done' }; },
    async listPhotos() { return [{ photoCode: '1', diskFolderId: 421538 }]; }
  };
  const admin = { key: 'm1:ortk.bitrix24.ru:1', context: { authId: 'tok', domain: 'ortk.bitrix24.ru', memberId: 'm1', isAdmin: true } };
  const runSync = buildCrmSyncRunner({
    reportsStore,
    settingsStore: { async read() { return settingsNoDoneStage; } },
    bitrixClient: {
      async updateReportItem() { return { id: 14426 }; },
      async getCrmItem() { return { id: 14426, stageId: 'DT1116_44:PREPARATION', ufCrm36_1778062550: '421538' }; }
    },
    authContextStore: { async getLastAdminContext() { return admin; }, async getLastAdminContextForPortal() { return admin; } },
    logger: { log() {}, warn() {}, error(event, data) { errors.push({ event, data }); } }
  });

  await runSync({
    report_id: 870930,
    payload: JSON.stringify({ triggerStatus: 'done', diskFolderId: 421538, domain: 'ortk.bitrix24.ru', memberId: 'm1' })
  });

  const notConfigured = errors.find((e) => e.event === 'crm_stage_not_configured');
  assert.ok(notConfigured, 'ненастроенная стадия для done обязана быть громкой');
  assert.equal(notConfigured.data.status, 'done');
  assert.equal(notConfigured.data.reportItemId, 14426);
});
