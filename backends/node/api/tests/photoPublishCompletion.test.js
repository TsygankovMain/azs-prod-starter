import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';
import { syncReportToCrmIfComplete } from '../src/reports/photoPublishCompletion.js';

// ---------------------------------------------------------------------------
// Task 8 чинит CRITICAL, внесённый Task 5.
//
// Task 5 перевёл приём фото на photoQueueStore.accept(), который НЕ заполняет
// disk_folder_id — эту колонку заполняет только markPublished(), то есть факт
// публикации в Битриксе. POST /:id/submit при этом требовал хотя бы один
// diskFolderId > 0, иначе бросал ReportSyncError('report_folder_missing', 502)
// — причём ДО setReportStatus({status:'done'}). Оператор грузит фото (200),
// тут же жмёт «сдать» — и получает 502 навсегда, потому что заполнить
// disk_folder_id значит сходить в Битрикс, а во время простоя портала это не
// произойдёт никогда.
//
// Тесты 1-2 ниже бьют по POST /:id/submit напрямую (минуя HTTP-транспорт, тот
// же приём, что и в остальных тестах reportsRoutes: находим handler и зовём
// его). Тесты 3-4 бьют по syncReportToCrmIfComplete — функции, которую после
// markPublished() будет звать воркер публикации (сам воркер — отдельная
// будущая задача, "до воркеров" в терминах брифа); здесь проверяется только
// сама проверка комплекта и постановка задачи в CRM.
// ---------------------------------------------------------------------------

const SETTINGS = {
  azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
  photoType: { entityTypeId: 1112 },
  report: {
    entityTypeId: 163,
    fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
    stages: { inProgress: 'DT163_1:IN_PROGRESS' }
  },
  disk: { rootFolderId: 0, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' }
};

// Один обязательный код (42) — достаточно, чтобы минуть 409
// report_photos_missing и дойти до проверки комплекта/disk_folder_id.
// (Больше не используется тестами submit — Important 1, раунд правок 1:
// submit больше не имеет права обращаться к Битриксу вовсе, когда список
// обязательных фото известен ЛОКАЛЬНО. Оставлен для истории/справки — ни
// один тест ниже его сейчас не импортирует.)
function makeBitrixClient() {
  return {
    diskApi: {},
    async getCrmItem({ entityTypeId, id }) {
      if (entityTypeId === SETTINGS.azs.entityTypeId) {
        return { id, title: `АЗС ${id}`, UF_PHOTO_SET: [42] };
      }
      if (entityTypeId === SETTINGS.photoType.entityTypeId) {
        return { id, title: '42. Колонки' };
      }
      return null;
    }
  };
}

// Important 1 (раунд правок 1): submit раньше звал readRequiredPhotos(),
// которая при холодном кэше типов идёт в Битрикс живьём (reportsRoutes.js:456)
// — «загрузил и сразу сдал» обычно работало (карточка уже прогрела кэш), но
// после рестарта процесса или если запросы попали на разные экземпляры на
// Timeweb — кэш холодный, и /submit падает при мёртвом портале. Тот же
// приём, что и makeThrowingBitrixClient в photoAcceptRoute.test.js (Task 5):
// Proxy, бросающий на ЛЮБОМ обращении, включая доступ к вложенным свойствам
// вроде diskApi — если submit тронет Битрикс хоть как-то, тест упадёт.
function makeThrowingBitrixClient() {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (...args) => {
        throw new Error(
          `bitrixClient.${String(prop)}() must not be called — сдача смены обязана пережить недоступность портала`
        );
      };
    }
  });
}

// Симметрично: settingsStore.read() в проде тоже реально ходит в Bitrix
// ПЕРВЫМ (app.option.get, см. компоновку в server.js/compositeSettingsStore
// и комментарий в photoPublisher.js) — раньше submit звал его безусловно в
// самом начале (нужен был readRequiredPhotos/ensureFolderFieldMapping).
// После Important 1 критический путь /submit его не трогает вовсе.
function makeThrowingSettingsStore() {
  return {
    async read() {
      throw new Error('settingsStore.read() must not be called on the critical path of /submit');
    }
  };
}

function makeAuthContextStore() {
  return {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1', domain: 'example.bitrix24.ru', userId: 1,
          authId: 'admin-auth', refreshToken: 'r', isAdmin: true
        }
      };
    }
  };
}

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
      memberId: 'member-1', domain: 'example.bitrix24.ru', userId: 10,
      authId: 'user-auth', refreshToken: 'r', isAdmin: false
    }
  };
}

// ---------------------------------------------------------------------------
// 1-2: POST /:id/submit
// ---------------------------------------------------------------------------

test('submit проставляет operator_completed_at и возвращает 200, даже когда фото ещё не опубликованы, БЕЗ единого обращения к Битриксу (не 502 report_folder_missing, Important 1)', async () => {
  const reportId = 940101;
  const setOperatorCompletedAtCalls = [];
  const setReportStatusCalls = [];

  const reportsStore = {
    async getById() {
      return {
        id: reportId, slotKey: '2026-08-03:0930', azsId: '9401', adminUserId: 10,
        status: 'in_progress', reportItemId: 999, deadlineAt: new Date().toISOString()
      };
    },
    // Список обязательных кодов — ЛОКАЛЬНО (report_local_state), уровень 1
    // resolveRequiredPhotoSlotLocally, тот же источник, что уже использует
    // приём фото.
    async getRequiredPhotoCodes() { return ['42']; },
    // Фото ПРИНЯТО локально (photoQueueStore.accept, Task 5), но ещё не
    // опубликовано — disk_folder_id пуст. Раньше это приводило к 502.
    async listPhotos() {
      return [{ reportId, photoCode: '42', diskFolderId: null, diskObjectId: null, fileId: null }];
    },
    async setReportStatus(args) { setReportStatusCalls.push(args); },
    async setOperatorCompletedAt(args) { setOperatorCompletedAtCalls.push(args); }
  };

  const crmSyncJobStore = {
    async enqueue() {
      throw new Error('submit не должен ставить задачу в CRM напрямую — это дело проверки комплекта после публикации (syncReportToCrmIfComplete)');
    },
    async listByReport() { return []; }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    // Проксирующие заглушки: бросают на ЛЮБОМ обращении. Important 1 (раунд
    // правок 1): submit больше не имеет права ходить в Битрикс на этом пути
    // (список обязательных кодов известен локально) — если тронет, тест
    // упадёт сразу, а не молча пропустит регресс.
    settingsStore: makeThrowingSettingsStore(),
    bitrixClient: makeThrowingBitrixClient(),
    notificationService: {
      async notifyReportDone() {}, async notifyDispatch() {}, async notifyReportExpired() {}
    },
    authContextStore: makeAuthContextStore(),
    crmSyncJobStore
  });

  const handler = findHandler(router, 'post', '/:id/submit');
  const res = makeRes();
  await handler(makeReq({ reportId }), res);

  assert.equal(
    res.responses[0]?.status, 200,
    `submit обязан вернуть 200, а не блокировать сдачу смены: ${JSON.stringify(res.responses[0]?.payload)}`
  );
  assert.equal(setOperatorCompletedAtCalls.length, 1, 'operator_completed_at обязан быть проставлен ровно один раз');
  assert.equal(setOperatorCompletedAtCalls[0].reportId, reportId);
  assert.ok(setOperatorCompletedAtCalls[0].at instanceof Date, 'at обязан быть Date');
  assert.equal(setReportStatusCalls.length, 1);
  assert.equal(setReportStatusCalls[0].status, 'done');
});

test('дедлайн считается по operator_completed_at, а не по published_at — оператор закончил в 09:59, публикация в 10:05, отчёт сдан вовремя', async () => {
  const reportId = 940102;
  const operatorCompletedAt = new Date('2026-08-03T09:59:00.000Z');
  const laterPublishedAt = new Date('2026-08-03T10:05:00.000Z');

  const setOperatorCompletedAtCalls = [];
  const reportsStore = {
    async getById() {
      return {
        id: reportId, slotKey: '2026-08-03:0930', azsId: '9402', adminUserId: 10,
        status: 'in_progress', reportItemId: 999, deadlineAt: '2026-08-03T10:00:00.000Z'
      };
    },
    async getRequiredPhotoCodes() { return ['42']; },
    async listPhotos() {
      // publishedAt — заведомо ПОЗЖЕ дедлайна. submit не имеет права читать
      // это поле для operator_completed_at — вот что здесь проверяется.
      return [{ reportId, photoCode: '42', diskFolderId: null, publishedAt: laterPublishedAt.toISOString() }];
    },
    async setReportStatus() {},
    async setOperatorCompletedAt(args) { setOperatorCompletedAtCalls.push(args); }
  };
  const crmSyncJobStore = {
    async enqueue() { throw new Error('must not be called from submit'); },
    async listByReport() { return []; }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore: makeThrowingSettingsStore(),
    bitrixClient: makeThrowingBitrixClient(),
    notificationService: {
      async notifyReportDone() {}, async notifyDispatch() {}, async notifyReportExpired() {}
    },
    authContextStore: makeAuthContextStore(),
    crmSyncJobStore,
    now: () => operatorCompletedAt
  });

  const handler = findHandler(router, 'post', '/:id/submit');
  const res = makeRes();
  await handler(makeReq({ reportId }), res);

  assert.equal(res.responses[0]?.status, 200, JSON.stringify(res.responses[0]?.payload));
  assert.equal(setOperatorCompletedAtCalls.length, 1);
  assert.equal(
    setOperatorCompletedAtCalls[0].at.toISOString(), operatorCompletedAt.toISOString(),
    'operator_completed_at обязан быть временем сдачи (09:59), а не временем публикации (10:05)'
  );
  assert.notEqual(setOperatorCompletedAtCalls[0].at.toISOString(), laterPublishedAt.toISOString());
});

test('Important 1: список обязательных фото неизвестен НИ локально, НИ в кэше (Битрикс недоступен) — submit принимает сдачу, а не блокирует её', async () => {
  const reportId = 940105;
  // azsId уникален для этого теста — иначе requiredPhotosCache (модульный
  // синглтон) мог бы оказаться тёплым от другого теста/файла и замаскировать
  // именно тот сценарий, который здесь проверяется (см. тот же приём в
  // photoAcceptRoute.test.js).
  const setOperatorCompletedAtCalls = [];
  const setReportStatusCalls = [];
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnCalls.push(args); };

  try {
    const reportsStore = {
      async getById() {
        return {
          id: reportId, slotKey: '2026-08-03:0930', azsId: '9405-unknown', adminUserId: 10,
          status: 'in_progress', reportItemId: 999, deadlineAt: new Date().toISOString()
        };
      },
      // Колонка пуста — ничего не сохранено локально.
      async getRequiredPhotoCodes() { return null; },
      // Оператор вообще ничего не грузил (или грузил на непроверенный слот) —
      // неважно: список неизвестен, сравнивать не с чем.
      async listPhotos() { return []; },
      async setReportStatus(args) { setReportStatusCalls.push(args); },
      async setOperatorCompletedAt(args) { setOperatorCompletedAtCalls.push(args); }
    };
    const crmSyncJobStore = {
      async enqueue() { throw new Error('must not be called from submit'); },
      async listByReport() { return []; }
    };

    const router = createReportsRouter({
      reportsStore,
      dispatchService: {},
      settingsStore: makeThrowingSettingsStore(),
      bitrixClient: makeThrowingBitrixClient(),
      notificationService: {
        async notifyReportDone() {}, async notifyDispatch() {}, async notifyReportExpired() {}
      },
      authContextStore: makeAuthContextStore(),
      crmSyncJobStore
    });

    const handler = findHandler(router, 'post', '/:id/submit');
    const res = makeRes();
    await handler(makeReq({ reportId }), res);

    assert.equal(
      res.responses[0]?.status, 200,
      `отказать оператору в сдаче из-за НАШЕЙ неспособности узнать список — та же несправедливость, против которой всё затевалось: ${JSON.stringify(res.responses[0]?.payload)}`
    );
    assert.equal(setOperatorCompletedAtCalls.length, 1);
    assert.equal(setReportStatusCalls.length, 1);
    assert.equal(setReportStatusCalls[0].status, 'done');
    assert.ok(warnCalls.length >= 1, 'обязан оставить след в логах, когда список неизвестен');
    assert.equal(warnCalls[0][0], 'report_submit_required_photos_unknown');
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// 3-4: syncReportToCrmIfComplete (вызывается воркером публикации после
// markPublished — самого воркера ещё нет, это тестирует саму функцию)
// ---------------------------------------------------------------------------

function makeCrmSyncJobStoreFake() {
  const jobs = [];
  return {
    jobs,
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

test('отчёт уходит в CRM только когда опубликованы ВСЕ обязательные фото (39 из 40 -> нет, 40 из 40 -> да)', async () => {
  const reportId = 940201;
  const requiredCodes = Array.from({ length: 40 }, (_, i) => String(i + 1));
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 555 }]; }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const incompleteResult = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async countByState({ reportId: id }) { assert.equal(id, reportId); return { accepted: 1, published: 39 }; } },
    crmSyncJobStore
  });
  assert.equal(incompleteResult.synced, false);
  assert.equal(crmSyncJobStore.jobs.length, 0, '39 из 40 published -> enqueue не вызван');

  const completeResult = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async countByState({ reportId: id }) { assert.equal(id, reportId); return { published: 40 }; } },
    crmSyncJobStore
  });
  assert.equal(completeResult.synced, true);
  assert.equal(crmSyncJobStore.jobs.length, 1, '40 из 40 -> enqueue вызван ровно один раз');
  assert.equal(crmSyncJobStore.jobs[0].report_id, reportId);
});

test('повторный проход проверки при уже полном комплекте (повторная публикация последнего фото) не ставит вторую задачу в CRM', async () => {
  const reportId = 940202;
  const requiredCodes = ['1', '2', '3'];
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 777 }]; }
  };
  const photoQueueStore = { async countByState() { return { published: 3 }; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const first = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(first.synced, true);
  assert.equal(crmSyncJobStore.jobs.length, 1);

  const second = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(second.synced, false);
  assert.equal(second.reason, 'already_queued');
  assert.equal(crmSyncJobStore.jobs.length, 1, 'повторный проход при полном комплекте не должен поставить вторую задачу');
});

test('syncReportToCrmIfComplete: список обязательных кодов неизвестен локально -> не синкать молча', async () => {
  const reportId = 940203;
  const reportsStore = {
    async getRequiredPhotoCodes() { return null; },
    async listPhotos() { return []; }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const result = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async countByState() { return {}; } },
    crmSyncJobStore
  });
  assert.equal(result.synced, false);
  assert.equal(crmSyncJobStore.jobs.length, 0);
});
