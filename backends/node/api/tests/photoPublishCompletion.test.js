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
    crmSyncJobStore,
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — POST /:id/submit его не трогает,
    // поэтому нужна только валидная форма, а не рабочая реализация.
    photoQueueStore: { async accept() {} }
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
    now: () => operatorCompletedAt,
    // Task 11: photoQueueStore теперь обязательный параметр конструктора
    // роутера (см. reportsRoutes.js) — POST /:id/submit его не трогает,
    // поэтому нужна только валидная форма, а не рабочая реализация.
    photoQueueStore: { async accept() {} }
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
      crmSyncJobStore,
      // Task 11: photoQueueStore теперь обязательный параметр конструктора
      // роутера (см. reportsRoutes.js) — POST /:id/submit его не трогает,
      // поэтому нужна только валидная форма, а не рабочая реализация.
      photoQueueStore: { async accept() {} }
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

  const incompleteStates = requiredCodes.map((code, i) => ({ photoCode: code, publishState: i < 39 ? 'published' : 'accepted' }));
  const incompleteResult = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async listPhotoStates({ reportId: id }) { assert.equal(id, reportId); return incompleteStates; } },
    crmSyncJobStore
  });
  assert.equal(incompleteResult.synced, false);
  assert.equal(crmSyncJobStore.jobs.length, 0, '39 из 40 published -> enqueue не вызван');

  const completeStates = requiredCodes.map((code) => ({ photoCode: code, publishState: 'published' }));
  const completeResult = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async listPhotoStates({ reportId: id }) { assert.equal(id, reportId); return completeStates; } },
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
  const photoQueueStore = { async listPhotoStates() { return requiredCodes.map((code) => ({ photoCode: code, publishState: 'published' })); } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const first = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(first.synced, true);
  assert.equal(crmSyncJobStore.jobs.length, 1);

  const second = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(second.synced, false);
  assert.equal(second.reason, 'already_queued');
  assert.equal(crmSyncJobStore.jobs.length, 1, 'повторный проход при полном комплекте не должен поставить вторую задачу');
});

// ---------------------------------------------------------------------------
// Important 2 (раунд правок 1, ревью Task 8): цепочка через /resync.
// Ручной /resync ставит задачу в CRM БЕЗУСЛОВНО (см. reportsRoutes.js,
// /:id/resync), в том числе ДО завершения публикации — тогда diskFolderId в
// её payload пуст. Старая идемпотентность («есть хоть какая-то задача —
// значит уже синкнуто») считала бы отчёт навсегда обработанным, даже если
// та единственная задача никогда не записала ссылку на папку Диска.
// ---------------------------------------------------------------------------

test('Important 2: существующая задача с ПУСТЫМ diskFolderId (например, ручной /resync до публикации) не блокирует постановку новой, уже с настоящей папкой', async () => {
  const reportId = 940209;
  const requiredCodes = ['1'];
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 999 }]; }
  };
  const photoQueueStore = { async listPhotoStates() { return [{ photoCode: '1', publishState: 'published' }]; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  // Симулируем ручной /resync ДО публикации: задача уже стоит, но с пустой папкой.
  await crmSyncJobStore.enqueue({
    reportId,
    payload: { diskFolderId: null, contextKey: '', domain: '', memberId: '' }
  });
  assert.equal(crmSyncJobStore.jobs.length, 1, 'подготовка: одна "пустая" задача уже стоит');

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });

  assert.equal(result.synced, true, 'задача с пустой папкой не должна считаться "уже синкнуто"');
  assert.equal(crmSyncJobStore.jobs.length, 2, 'обязана появиться новая задача — уже с настоящей папкой');
  const newJobPayload = JSON.parse(crmSyncJobStore.jobs[1].payload);
  assert.equal(newJobPayload.diskFolderId, 999, 'новая задача обязана нести настоящий diskFolderId');
});

test('Important 2: существующая задача с НЕПУСТЫМ diskFolderId по-прежнему блокирует повторную постановку', async () => {
  const reportId = 940210;
  const requiredCodes = ['1'];
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 555 }]; }
  };
  const photoQueueStore = { async listPhotoStates() { return [{ photoCode: '1', publishState: 'published' }]; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  await crmSyncJobStore.enqueue({
    reportId,
    payload: { diskFolderId: 555, contextKey: '', domain: '', memberId: '' }
  });

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });

  assert.equal(result.synced, false);
  assert.equal(result.reason, 'already_queued');
  assert.equal(crmSyncJobStore.jobs.length, 1, 'задача с настоящей папкой обязана по-прежнему считаться "уже синкнуто"');
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
    photoQueueStore: { async listPhotoStates() { return []; } },
    crmSyncJobStore
  });
  assert.equal(result.synced, false);
  assert.equal(crmSyncJobStore.jobs.length, 0);
});

// ---------------------------------------------------------------------------
// Координатор, мутационный прогон финального ревью: "пустой массив требуемых
// кодов трактуется как полный комплект — сравнение «ноль больше либо равно
// нулю» даёт ложный успех... Тесты при этом всегда возвращают null и никогда
// пустой массив." Тест выше действительно всегда использует null — код уже
// защищён (`!Array.isArray(requiredCodes) || requiredCodes.length === 0`),
// но ветка requiredCodes.length===0 (в отличие от !Array.isArray) не была
// проверена НИ РАЗУ. Ниже — именно она, отдельно от null.
// ---------------------------------------------------------------------------

test('syncReportToCrmIfComplete: ПУСТОЙ МАССИВ (не null) требуемых кодов -> тоже required_codes_unknown, а не ложный успех "0 >= 0"', async () => {
  const reportId = 940204;
  const reportsStore = {
    async getRequiredPhotoCodes() { return []; }, // пустой массив — НЕ null
    async listPhotos() { return []; }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();
  const result = await syncReportToCrmIfComplete({
    reportId,
    reportsStore,
    photoQueueStore: { async listPhotoStates() { return []; } },
    crmSyncJobStore
  });
  assert.equal(result.synced, false, 'пустой список требуемых кодов не должен трактоваться как "ноль из нуля — комплект полон"');
  assert.equal(result.reason, 'required_codes_unknown');
  assert.equal(crmSyncJobStore.jobs.length, 0, 'задача в CRM не должна была быть поставлена');
});

// ---------------------------------------------------------------------------
// I4 (финальное ревью ветки) — "готовый отчёт может молча не доехать до CRM".
// Опасный случай — требуемые коды неизвестны, НО все уже принятые фото уже
// published: очередь публикации считает работу сделанной, а без списка
// требуемых кодов мы никогда не узнаем, был ли комплект действительно
// полным. Эта функция вызывается ТОЛЬКО из завершения публикации — если
// публиковать больше нечего, для этого отчёта больше не будет события,
// которое повторило бы проверку. Молчать здесь недопустимо — обязан быть
// громкий, отдельный сигнал (event: photo_report_crm_sync_orphaned).
// ---------------------------------------------------------------------------

const withCapturedConsoleError = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
};

test('I4: все принятые фото уже published, но required_photo_codes неизвестен -> громкий лог photo_report_crm_sync_orphaned', async () => {
  const reportId = 940301;
  const reportsStore = {
    async getRequiredPhotoCodes() { return null; }, // backfill молча не удался (reportsRoutes.js .catch(() => {}))
    async listPhotos() { return []; }
  };
  const photoQueueStore = {
    async listPhotoStates() {
      return [
        { photoCode: '1', publishState: 'published' },
        { photoCode: '2', publishState: 'published' },
        { photoCode: '3', publishState: 'published' }
      ];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const logged = await withCapturedConsoleError(async () => {
    const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'required_codes_unknown');
  });

  const orphanLine = logged.map((args) => args[0]).find((line) => {
    try { return JSON.parse(line).event === 'photo_report_crm_sync_orphaned'; } catch { return false; }
  });
  assert.ok(orphanLine, 'обязан быть залогирован event photo_report_crm_sync_orphaned — иначе фото в Битриксе, карточка не обновлена, и никто не узнает');
  const parsed = JSON.parse(orphanLine);
  assert.equal(parsed.reportId, reportId);
  assert.equal(parsed.publishedCount, 3);
});

test('I4: НЕ все фото published (отчёт ещё не завершён) -> НЕТ громкого лога — это нормальное, ожидаемое состояние', async () => {
  const reportId = 940302;
  const reportsStore = {
    async getRequiredPhotoCodes() { return null; },
    async listPhotos() { return []; }
  };
  const photoQueueStore = {
    async listPhotoStates() {
      return [
        { photoCode: '1', publishState: 'published' },
        { photoCode: '2', publishState: 'accepted' } // всё ещё в очереди — рано, не опасно
      ];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const logged = await withCapturedConsoleError(async () => {
    await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  });

  const orphanLine = logged.map((args) => args[0]).find((line) => {
    try { return JSON.parse(line).event === 'photo_report_crm_sync_orphaned'; } catch { return false; }
  });
  assert.equal(orphanLine, undefined, 'отчёт ещё не весь опубликован — это норма, громкий лог здесь был бы ложной тревогой');
});

test('I4: у отчёта вообще нет строк report_photo -> НЕТ громкого лога (нечего публиковать, не "потеряно")', async () => {
  const reportId = 940303;
  const reportsStore = {
    async getRequiredPhotoCodes() { return null; },
    async listPhotos() { return []; }
  };
  const photoQueueStore = { async listPhotoStates() { return []; } };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const logged = await withCapturedConsoleError(async () => {
    await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  });

  const orphanLine = logged.map((args) => args[0]).find((line) => {
    try { return JSON.parse(line).event === 'photo_report_crm_sync_orphaned'; } catch { return false; }
  });
  assert.equal(orphanLine, undefined, 'пустой список фото — это не "все опубликованы", тревога здесь была бы бессмысленной');
});

// ---------------------------------------------------------------------------
// Important 3 (раунд правок 1): агрегат (было — countByState, count >=
// requiredCodes.length) недостаточен — количество может совпасть, а
// КОНКРЕТНЫЕ коды не совпасть. Оба сценария ниже — реальные пробои агрегата,
// которые обязана ловить построчная сверка (listPhotoStates).
// ---------------------------------------------------------------------------

test('Important 3: лишний опубликованный код (не входящий в requiredCodes, например с непроверенного слота) не маскирует реально недостающий обязательный код', async () => {
  const reportId = 940207;
  const requiredCodes = ['1', '2'];
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 111 }]; }
  };
  // Код '1' — обязательный, опубликован. Код '2' — обязательный, НЕ
  // опубликован. Код '999' — опубликован, но в requiredCodes не входит
  // (например, принят на непроверенном слоте, слот оказался неверным).
  // Агрегат счёл бы published=2 >= requiredCodes.length(2) "полным
  // комплектом" — ложно.
  const photoQueueStore = {
    async listPhotoStates() {
      return [
        { photoCode: '1', publishState: 'published' },
        { photoCode: '999', publishState: 'published' }
      ];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(result.synced, false, 'лишний опубликованный код (не из requiredCodes) не должен маскировать недостающий код 2');
  assert.equal(crmSyncJobStore.jobs.length, 0);
});

test('Important 3: смена состава обязательных кодов посреди смены при том же их числе не маскирует реально недостающий новый код', async () => {
  const reportId = 940208;
  // Было обязательно ['1','2'], стало ['1','3'] (то же число — 2): код '3'
  // теперь обязателен, но ещё не опубликован; код '2' опубликован, но уже не
  // обязателен. Агрегат: published=2 (коды 1 и 2) >= requiredCodes.length(2)
  // — ложный "полный комплект".
  const requiredCodes = ['1', '3'];
  const reportsStore = {
    async getRequiredPhotoCodes() { return requiredCodes; },
    async listPhotos() { return [{ reportId, photoCode: '1', diskFolderId: 222 }]; }
  };
  const photoQueueStore = {
    async listPhotoStates() {
      return [
        { photoCode: '1', publishState: 'published' },
        { photoCode: '2', publishState: 'published' } // старый код, уже не обязателен
      ];
    }
  };
  const crmSyncJobStore = makeCrmSyncJobStoreFake();

  const result = await syncReportToCrmIfComplete({ reportId, reportsStore, photoQueueStore, crmSyncJobStore });
  assert.equal(result.synced, false, 'код 3 реально не опубликован — комплект не полный, несмотря на совпавшее по числу published');
  assert.equal(crmSyncJobStore.jobs.length, 0);
});
