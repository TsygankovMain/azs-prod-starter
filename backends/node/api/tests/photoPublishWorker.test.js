import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPhotoPublishWorker,
  ADVISORY_LOCK_KEY
} from '../src/reports/photoPublishWorker.js';
import { PHOTO_CODE_NOT_REQUIRED } from '../src/reports/errorCodes.js';

// ---------------------------------------------------------------------------
// Task 7 — воркер публикации. Забирает пачку из photoQueueStore.claimBatch(),
// публикует через injected publishOne (photoPublisher.js — не трогаем),
// решает reschedule/markFailed по injected классификатору ошибок, и держит
// advisory-лок Postgres, чтобы на нескольких экземплярах приложения (Timeweb)
// публиковал ровно один процесс.
//
// Секция 1 — тесты из брифа, ДОСЛОВНО (Шаг 1). Секция 2 — дополнительные
// тесты на отложенную проверку слота (Grabli 2 из задания), которая в брифе
// описана текстом, но не дана готовым тестом. Секция 3 — advisory-лок,
// CRM-синк после публикации, старт/стоп и валидация конструктора.
// ---------------------------------------------------------------------------

const noopLimiter = () => ({ acquire: async () => {}, penalize() {} });

const makeStore = (batches) => ({
  claimed: [], published: [], rescheduled: [], failed: [],
  async claimBatch() { return batches.shift() ?? []; },
  async markPublished(args) { this.published.push(args); },
  async reschedule(args) { this.rescheduled.push(args); },
  async markFailed(args) { this.failed.push(args); }
});

const okPool = { async query() { return { rows: [{ locked: true }] }; } };
const busyPool = { async query() { return { rows: [{ locked: false }] }; } };

// ---------------------------------------------------------------------------
// Секция 1: тесты из брифа (task-7-brief.md, Шаг 1) — дословно.
// ---------------------------------------------------------------------------

test('без advisory-лока воркер не публикует ничего', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: busyPool, publishOne: async () => ({ fileId: 1 }),
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.published.length, 0, 'второй экземпляр обязан молчать');
  assert.equal(worker.isLeader(), false);
});

test('успех переводит фото в published', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.published[0].id, 1);
  assert.equal(store.published[0].fileId, 7);
});

test('временная ошибка переносит попытку с растущей паузой', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 1 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, backoffMs: [1000, 5000, 20000], now: () => 0,
    publishOne: async () => { throw new Error('temporary'); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed.length, 0);
  assert.equal(store.rescheduled[0].nextAttemptAt.getTime(), 5000, 'вторая попытка — вторая пауза');
});

test('исчерпание попыток переводит в failed', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 9 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, maxAttempts: 10,
    publishOne: async () => { throw new Error('still failing'); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed[0].id, 1);
});

test('окончательная ошибка не тратит оставшиеся попытки', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, maxAttempts: 10,
    publishOne: async () => { throw Object.assign(new Error('quota'), { bitrixError: 'DISK_QUOTA_EXCEEDED' }); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed.length, 1, 'сразу failed, без девяти бесполезных повторов');
  assert.equal(store.rescheduled.length, 0);
});

test('Retry-After от портала уходит в ограничитель, а не только в паузу задачи', async () => {
  const penalties = [];
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => { throw Object.assign(new Error('limit'), { statusCode: 503, retryAfterMs: 4000 }); },
    limiter: { acquire: async () => {}, penalize: (ms) => penalties.push(ms) }
  });
  await worker.tick();
  assert.deepEqual(penalties, [4000],
    'иначе остальные два воркера продолжат долбить портал, который попросил паузу');
});

test('падение одной задачи не отменяет остальные в пачке', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }, { id: 2, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async (task) => {
      if (task.id === 1) throw new Error('boom');
      return { fileId: 22 };
    },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.rescheduled.length, 1);
  assert.equal(store.published.length, 1, 'вторая задача опубликована несмотря на первую');
});

// ---------------------------------------------------------------------------
// Секция 2: отложенная проверка слота (slot_verified=false) — Grabli 2.
//
// Task 5 принимает фото со slot_verified=false, когда список требуемых фото
// не удалось узнать локально (Битрикс был недоступен). Обещание "проверим при
// публикации" держит этот воркер — единственное место, где публикация вообще
// происходит. Проверяем все три исхода из задания дословно.
// ---------------------------------------------------------------------------

test('slot_verified=false и код входит в дорезолвленный список — публикуется как обычно', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]]);
  const resolverCalls = [];
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async (task) => { resolverCalls.push(task.id); return ['FRONT', 'BACK']; },
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.deepEqual(resolverCalls, [1], 'резолвер обязан быть вызван ровно для этой задачи');
  assert.equal(store.published.length, 1);
  assert.equal(store.published[0].fileId, 7);
  assert.equal(store.failed.length, 0);
});

test('slot_verified=false и кода нет в дорезолвленном списке — markFailed без публикации', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'WRONG', publish_attempts: 0, slot_verified: false }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT', 'BACK'],
    publishOne: async () => { throw new Error('publishOne не должен вызываться для кода не из списка'); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.failed.length, 1);
  assert.equal(store.failed[0].id, 1);
  assert.match(store.failed[0].error, new RegExp(PHOTO_CODE_NOT_REQUIRED),
    'причина обязана быть внятной, а не голым "failed"');
  assert.equal(store.published.length, 0);
  assert.equal(store.rescheduled.length, 0, 'это не транзиентная ошибка — повторять нечего');
});

test('slot_verified=false и резолвер бросает (Битрикс недоступен) — задача остаётся нетронутой', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 3, slot_verified: false }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { throw new Error('Bitrix is down'); },
    publishOne: async () => { throw new Error('publishOne не должен вызываться, пока слот не резолвлен'); },
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await worker.tick();
  assert.equal(store.published.length, 0);
  assert.equal(store.failed.length, 0, 'отказ по неизвестности — это невидимая потеря, а не markFailed');
  assert.equal(store.rescheduled.length, 0, 'и не трата попытки на reschedule');
});

test('slot_verified=false без сконфигурированного резолвера — тоже ничего не меняем (безопасный дефолт)', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => { throw new Error('publishOne не должен вызываться без резолвера'); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.published.length, 0);
  assert.equal(store.failed.length, 0);
  assert.equal(store.rescheduled.length, 0);
});

test('slot_verified=true — резолвер вообще не вызывается (слот уже проверен)', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: true }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { throw new Error('резолвер не должен вызываться, если слот уже проверен'); },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.published.length, 1);
});

test('slot_verified отсутствует (undefined) — трактуется как уже проверенный слот', async () => {
  // Ровно форма задач из Секции 1 (брифа) — там slot_verified не задаётся
  // вовсе, и ни один из тестов брифа не настраивает резолвер. Явная проверка,
  // что undefined НЕ уходит по ветке "непроверенный слот".
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { throw new Error('резолвер не должен вызываться для undefined'); },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.published.length, 1);
});

test('slot_verified=0 (MySQL TINYINT) трактуется так же, как false', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'WRONG', publish_attempts: 0, slot_verified: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT'],
    publishOne: async () => { throw new Error('publishOne не должен вызываться'); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.failed.length, 1, 'MySQL отдаёт 0/1 вместо true/false — оба обязаны разбираться одинаково');
});

test('slot_verified=1 (MySQL TINYINT) трактуется так же, как true', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: 1 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { throw new Error('резолвер не должен вызываться для slot_verified=1'); },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(store.published.length, 1);
});

// ---------------------------------------------------------------------------
// Секция 3: advisory-лок (детали сверх минимального теста брифа), CRM-синк
// после markPublished, старт/стоп опроса, валидация конструктора.
// ---------------------------------------------------------------------------

test('без лидерства claimBatch вообще не вызывается — не тратим впустую чужую аренду', async () => {
  const calls = [];
  const store = {
    async claimBatch(args) { calls.push(args); return []; },
    async markPublished() {}, async reschedule() {}, async markFailed() {}
  };
  const worker = createPhotoPublishWorker({
    store, pool: busyPool,
    publishOne: async () => ({ fileId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(calls.length, 0, 'claimBatch на неведущем экземпляре взял бы аренду впустую на 5 минут');
});

test('advisory-лок запрашивается по фиксированному постоянному ключу', async () => {
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql, params }); return { rows: [{ locked: true }] }; } };
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /pg_try_advisory_lock/);
  assert.deepEqual(seen[0].params, [ADVISORY_LOCK_KEY]);
});

test('ошибка при проверке advisory-лока не роняет tick и трактуется как «не лидер»', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const throwingPool = { async query() { throw new Error('connection reset'); } };
  const worker = createPhotoPublishWorker({
    store, pool: throwingPool,
    publishOne: async () => ({ fileId: 1 }),
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(worker.isLeader(), false);
  assert.equal(store.published.length, 0);
});

test('claimBatch вызывается с limit=workers (по умолчанию 3)', async () => {
  const calls = [];
  const store = {
    async claimBatch(args) { calls.push(args); return []; },
    async markPublished() {}, async reschedule() {}, async markFailed() {}
  };
  const worker = createPhotoPublishWorker({
    store, pool: okPool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(calls[0].limit, 3);
});

test('workers переопределяет размер пачки claimBatch', async () => {
  const calls = [];
  const store = {
    async claimBatch(args) { calls.push(args); return []; },
    async markPublished() {}, async reschedule() {}, async markFailed() {}
  };
  const worker = createPhotoPublishWorker({
    store, pool: okPool, workers: 5, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(calls[0].limit, 5);
});

test('успешная публикация запускает попытку перевода отчёта в CRM (syncCrmIfComplete)', async () => {
  const store = makeStore([[{ id: 1, report_id: 77, publish_attempts: 0 }]]);
  const crmCalls = [];
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    syncCrmIfComplete: async (reportId) => { crmCalls.push(reportId); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.deepEqual(crmCalls, [77]);
});

test('syncCrmIfComplete не вызывается, если публикация не удалась', async () => {
  const store = makeStore([[{ id: 1, report_id: 77, publish_attempts: 0 }]]);
  const crmCalls = [];
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => { throw new Error('boom'); },
    syncCrmIfComplete: async (reportId) => { crmCalls.push(reportId); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(crmCalls.length, 0);
});

test('падение syncCrmIfComplete не превращает успешную публикацию в ошибку', async () => {
  const store = makeStore([[{ id: 1, report_id: 77, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    syncCrmIfComplete: async () => { throw new Error('crm queue down'); },
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(store.published.length, 1, 'фото реально опубликовано — это не должно откатываться из-за отдельного шага CRM');
  assert.equal(store.failed.length, 0);
  assert.equal(store.rescheduled.length, 0);
});

test('падение store.markPublished для одной задачи не мешает применить исход остальных', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }, { id: 2, publish_attempts: 0 }]]);
  store.markPublished = async (args) => {
    if (args.id === 1) throw new Error('db down');
    store.published.push(args);
  };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async (task) => ({ fileId: task.id * 100 }),
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(store.published.length, 1);
  assert.equal(store.published[0].id, 2);
});

// start()/stop() ниже НЕ используют реальные таймеры/сон по времени — только
// инъецированные setIntervalFn/clearIntervalFn (см. JSDoc в
// photoPublishWorker.js). Причина: тест на "хотя бы пару опросов за 95мс при
// интервале 20мс" один раз реально упал в CI-подобном прогоне под сторонней
// нагрузкой (в рабочей директории параллельно шли другие задачи) — гонка с
// системным таймером, а не баг воркера. Дальше по флоу задания сказано прямо:
// "если твой тест может зависнуть [или зафлакать], перепиши его" — переписано
// на управляемый вручную фейковый "таймер", без ожидания реальных миллисекунд
// и, соответственно, без единого шанса на флаки по нагрузке системы.
const makeFakeScheduler = () => {
  let callback = null;
  let handle = null;
  let handleSeq = 0;
  return {
    setIntervalFn: (fn) => {
      callback = fn;
      handleSeq += 1;
      handle = { id: handleSeq };
      return handle;
    },
    clearIntervalFn: (h) => {
      if (h === handle) {
        callback = null;
        handle = null;
      }
    },
    // "Срабатывание" таймера — синхронный вызов зарегистрированного колбэка,
    // как это в реальности делает event loop у setInterval (сам колбэк внутри
    // асинхронный и не awaits'ится вызывающим — это и есть источник риска
    // пересечения тиков, который проверяет третий тест ниже).
    fire() { if (callback) callback(); },
    get isActive() { return callback !== null; }
  };
};

// Один макротаск-барьер гарантированно дренирует ВСЮ очередь микрозадач
// (включая те, что были добавлены в процессе дренажа) — надёжнее и без
// хрупкой зависимости от количества await-хопов внутри tick()/claimBatch().
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('start() регистрирует опрос через setIntervalFn с заданным pollIntervalMs; stop() снимает его через clearIntervalFn', () => {
  const scheduler = makeFakeScheduler();
  const worker = createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, pollIntervalMs: 2345,
    publishOne: async () => ({ fileId: 1 }),
    limiter: noopLimiter(),
    setIntervalFn: (fn, ms) => { assert.equal(ms, 2345); return scheduler.setIntervalFn(fn); },
    clearIntervalFn: scheduler.clearIntervalFn
  });
  worker.start();
  assert.ok(scheduler.isActive, 'start() обязан зарегистрировать колбэк опроса');
  worker.stop();
  assert.ok(!scheduler.isActive, 'stop() обязан снять именно тот таймер, который вернул setIntervalFn');
});

test('start() идемпотентен — повторные вызовы не регистрируют второй таймер', () => {
  let registrations = 0;
  const worker = createPhotoPublishWorker({
    store: makeStore([]), pool: okPool,
    publishOne: async () => ({ fileId: 1 }),
    limiter: noopLimiter(),
    setIntervalFn: (fn) => { registrations += 1; return { fn }; },
    clearIntervalFn: () => {}
  });
  worker.start();
  worker.start();
  worker.start();
  assert.equal(registrations, 1, 'повторный start() не должен плодить второй таймер');
});

test('start() не запускает пересекающиеся тики, если предыдущий ещё выполняется', async () => {
  const scheduler = makeFakeScheduler();
  let inFlight = 0;
  let maxInFlight = 0;
  let tickStarts = 0;
  let releaseFirstClaim;
  const store = {
    async claimBatch() {
      tickStarts += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Первый claim зависает, пока тест сам не отпустит его — имитирует
      // tick(), который не укладывается в pollIntervalMs (например, ждёт на
      // лимитере). Второе и третье "срабатывание" таймера обязаны застать
      // предыдущий tick ещё не завершённым.
      if (tickStarts === 1) {
        await new Promise((resolve) => { releaseFirstClaim = resolve; });
      }
      inFlight -= 1;
      return [];
    },
    async markPublished() {}, async reschedule() {}, async markFailed() {}
  };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 1 }),
    limiter: noopLimiter(),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn
  });
  worker.start();

  scheduler.fire(); // первое срабатывание -> tick() запускается и зависает внутри claimBatch
  await flushMicrotasks();
  assert.equal(tickStarts, 1);
  assert.equal(maxInFlight, 1);

  scheduler.fire(); // второе срабатывание, пока первый tick ещё не завершился
  scheduler.fire(); // и третье, для верности
  await flushMicrotasks();
  assert.equal(tickStarts, 1, 'гвард ticking обязан проигнорировать срабатывания, пока предыдущий tick не завершился');
  assert.equal(maxInFlight, 1, 'тики не должны пересекаться');

  releaseFirstClaim([]);
  await flushMicrotasks();

  scheduler.fire(); // теперь предыдущий tick завершён -> новое срабатывание обязано запустить второй tick
  await flushMicrotasks();
  assert.equal(tickStarts, 2, 'после завершения предыдущего tick следующее срабатывание обязано запустить новый');

  worker.stop();
});

test('конструктор требует store', () => {
  assert.throws(() => createPhotoPublishWorker({
    pool: okPool, publishOne: async () => {}, limiter: noopLimiter()
  }));
});

test('конструктор требует publishOne-функцию', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, limiter: noopLimiter()
  }));
});

test('конструктор требует limiter с acquire()/penalize()', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, publishOne: async () => {}
  }));
});

test('конструктор требует pool с query() — нужен для advisory-лока', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), publishOne: async () => {}, limiter: noopLimiter()
  }));
});

test('конструктор отвергает workers < 1', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, publishOne: async () => {}, limiter: noopLimiter(), workers: 0
  }));
});
