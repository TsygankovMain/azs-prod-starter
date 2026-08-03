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
// Секция 1 — тесты из брифа, ДОСЛОВНО (Шаг 1). Секция 2 — отложенная
// проверка слота (Grabli 2). Секция 3+ — advisory-лок (включая раунд правок
// 1, Critical), CRM-синк, backfill списка требуемых кодов (раунд правок 1,
// Important), старт/стоп, валидация конструктора.
// ---------------------------------------------------------------------------

const noopLimiter = () => ({ acquire: async () => {}, penalize() {} });

const makeStore = (batches) => ({
  claimed: [], published: [], rescheduled: [], failed: [],
  async claimBatch() { return batches.shift() ?? []; },
  async markPublished(args) { this.published.push(args); },
  async reschedule(args) { this.rescheduled.push(args); },
  async markFailed(args) { this.failed.push(args); }
});

// Простой pool.connect()-совместимый фейк: один и тот же клиент на каждый
// connect(), query() всегда отвечает одним и тем же locked. Годится для
// подавляющего большинства тестов, которым важен только факт "лидер/не
// лидер" — для механики session-affinity самой по себе см. makeTrackedPool
// в секции "Advisory-лок: выделенный клиент" ниже.
const makeSimplePool = (locked) => {
  const client = {
    async query() { return { rows: [{ locked }] }; },
    on() {},
    release() {}
  };
  return { async connect() { return client; } };
};
const okPool = makeSimplePool(true);
const busyPool = makeSimplePool(false);

// Один макротаск-барьер гарантированно дренирует ВСЮ очередь микрозадач
// (включая те, что были добавлены в процессе дренажа) — надёжнее и без
// хрупкой зависимости от количества await-хопов внутри tick()/claimBatch().
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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
// Секция 3: advisory-лок — базовый гейтинг (лидер/не лидер).
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

// ---------------------------------------------------------------------------
// Секция 4: Advisory-лок — ВЫДЕЛЕННЫЙ КЛИЕНТ (раунд правок 1, Critical).
//
// Ревьюер поднял реальный Postgres 17 и сконструировал pool ровно как
// server.js:107 (без переопределения размера — 10 соединений). При pool.query()
// «ровно один лидер» физически не гарантирован: 5 тиков из 8 под фоновой
// нагрузкой на пул вернули locked=false, хотя лок держало собственное
// простаивающее соединение того же процесса — проверка просто ушла на другое
// физическое соединение. Хуже: переработанное простаивающее соединение тихо
// теряло лок, и второй, независимый pool немедленно перехватывал его — два
// лидера. Фикс — pool.connect(): один выделенный клиент на весь процесс
// воркера, все проверки лока идут ТОЛЬКО через него. Тесты ниже не поднимают
// реальный Postgres (в проекте — node:test без реальной БД), а проверяют
// САМ КОНТРАКТ: сколько раз вызван pool.connect(), тот ли самый клиент
// опрашивается повторно, что происходит при обрыве/ошибке клиента и при
// остановке воркера.
// ---------------------------------------------------------------------------

// Отслеживающий фейк pool.connect() — в отличие от makeSimplePool, даёт
// заглянуть, что именно происходит с каждым выданным клиентом: сколько раз
// реально подключались, какие SQL/параметры ушли на КАЖДОГО клиента отдельно,
// что случилось при release()/событии error.
const makeTrackedPool = ({ responses } = {}) => {
  const clients = [];
  const pool = {
    async connect() {
      const listeners = {};
      const c = {
        queryLog: [],
        releaseLog: [],
        async query(sql, params) {
          c.queryLog.push({ sql, params });
          const next = responses && responses.length ? responses.shift() : undefined;
          return next ?? { rows: [{ locked: true }] };
        },
        on(event, handler) {
          (listeners[event] ||= []).push(handler);
          return c;
        },
        emit(event, ...args) {
          (listeners[event] || []).forEach((h) => h(...args));
        },
        release(err) { c.releaseLog.push(err); }
      };
      clients.push(c);
      return c;
    }
  };
  // connectCount умышленно НЕ даём отдельным полем/геттером верхнего уровня:
  // деструктуризация геттера при возврате застыла бы на значении в момент
  // возврата (см. комментарий в первом тесте ниже, который на этом споткнулся).
  // clients.length — то же самое, но живое.
  return { pool, clients };
};

test('advisory-лок запрашивается по фиксированному постоянному ключу через выделенный клиент', async () => {
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(clients[0].queryLog.length, 1);
  assert.match(clients[0].queryLog[0].sql, /pg_try_advisory_lock/);
  assert.deepEqual(clients[0].queryLog[0].params, [ADVISORY_LOCK_KEY]);
  await worker.stop();
});

test('pool.connect() вызывается один раз на несколько тиков; после первого успеха лок НЕ перезахватывается повторно (раунд правок 2, Blocker)', async () => {
  // Не деструктурируем connectCount: это геттер на исходном объекте — при
  // деструктуризации он бы вычислился ОДИН раз, в момент вызова
  // makeTrackedPool(), и дальше отдавал бы застывший снимок (0), а не живое
  // значение. Читаем clients.length напрямую.
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[], [], []]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  await worker.tick();
  await worker.tick();
  assert.equal(clients.length, 1, 'ровно тот баг с ревью: pool.query()/повторный connect() могли бы отдать другое физическое соединение');
  // Раунд правок 2 (Blocker): было queryLog.length === 3 (по запросу на
  // тик) — именно это раньше копило N держаний на одной сессии за N тиков
  // лидерства, хотя releaseClient() снимает только одно. pg_try_advisory_lock
  // — счётчик, а не флаг (см. заголовочный комментарий photoPublishWorker.js)
  // — сессия, уже держащая лок, не обязана перепроверять его повторно, пока
  // жива; смерть сессии детектится событием 'error', а не повторным опросом.
  assert.equal(clients[0].queryLog.length, 1,
    'второй и третий тик обязаны переиспользовать уже подтверждённое лидерство, а не повторно слать pg_try_advisory_lock на той же сессии');
  await worker.stop();
});

test('конкурентные вызовы tick() не порождают второй pool.connect() и не шлют второй pg_try_advisory_lock (раунд правок 2)', async () => {
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[], []]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(clients.length, 1, 'иначе один из клиентов навсегда «утекает» из пула, оставшись checked-out');
  // Раунд правок 2: без дедупликации самой попытки стать лидером (не только
  // подключения) два конкурентных tick(), оба заставшие leader===false ДО
  // того, как первый успеет присвоить результат, отправили бы ДВА
  // pg_try_advisory_lock с одной и той же сессии — на реальном Postgres оба
  // успешны (сессия реентерабельна сама к себе), и счётчик держаний снова
  // стал бы больше 1 несмотря на основной фикс (не перезахватывать, если
  // УЖЕ лидер) — момент разрыва ровно в том, что "уже лидер" в этот момент
  // ещё не присвоено.
  assert.equal(clients[0].queryLog.length, 1, 'конкурентные попытки стать лидером обязаны делить один и тот же запрос, а не слать по своему');
  await worker.stop();
});

test('обрыв выделенного клиента (событие error) -> следующий тик переподключается на новый клиент', async () => {
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[], []]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await worker.tick();
  assert.equal(clients.length, 1);

  clients[0].emit('error', new Error('connection terminated'));
  assert.equal(clients[0].releaseLog.length, 1, 'сломанный клиент обязан быть отдан пулу, а не просто забыт');
  assert.ok(clients[0].releaseLog[0], 'release() обязан получить ошибку, чтобы пул уничтожил соединение, а не переработал его сомнительным (Опыт D ревьюера)');

  await worker.tick();
  assert.equal(clients.length, 2, 'после обрыва клиента следующий тик обязан подключиться заново');
  await worker.stop();
});

test('ошибка query() на выделенном клиенте -> клиент отбрасывается, tick трактует это как «не лидер», не падает', async () => {
  let queryCallCount = 0;
  const releaseLog = [];
  const pool = {
    async connect() {
      const c = {
        async query() {
          queryCallCount += 1;
          throw new Error('connection reset');
        },
        on() {},
        release(err) { releaseLog.push(err); }
      };
      return c;
    }
  };
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(worker.isLeader(), false);
  assert.equal(store.published.length, 0);
  assert.equal(queryCallCount, 1);
  assert.equal(releaseLog.length, 1, 'клиент, у которого упал запрос, обязан быть отдан пулу, а не просто забыт (утечка checked-out соединения)');
  await worker.stop();
});

test('pool.connect() сам бросает (пул исчерпан/БД недоступна) -> tick не падает, трактуется как «не лидер»', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const pool = { async connect() { throw new Error('pool exhausted'); } };
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(worker.isLeader(), false);
  assert.equal(store.published.length, 0);
  await worker.stop();
});

test('stop() снимает advisory-лок (pg_advisory_unlock) и освобождает клиента, если был лидером', async () => {
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(worker.isLeader(), true);

  await worker.stop();

  assert.equal(clients[0].releaseLog.length, 1, 'клиент обязан вернуться в пул');
  assert.equal(clients[0].releaseLog[0], undefined, 'штатная остановка — не ошибка, release() без аргумента');
  const unlockCall = clients[0].queryLog.find((c) => /pg_advisory_unlock/.test(c.sql));
  assert.ok(unlockCall, 'лок обязан быть явно снят перед освобождением клиента');
  assert.deepEqual(unlockCall.params, [ADVISORY_LOCK_KEY]);
});

test('stop() без лидерства не зовёт pg_advisory_unlock, но клиента освобождает', async () => {
  const { pool, clients } = makeTrackedPool({ responses: [{ rows: [{ locked: false }] }] });
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await worker.tick();
  assert.equal(worker.isLeader(), false);

  await worker.stop();

  assert.equal(clients[0].releaseLog.length, 1);
  const unlockCall = clients[0].queryLog.find((c) => /pg_advisory_unlock/.test(c.sql));
  assert.equal(unlockCall, undefined, 'лок, которым не владели, снимать незачем — бессмысленный вызов и вводящий в заблуждение лог');
});

test('stop() до единого tick() — безопасный no-op (клиента ещё нет)', async () => {
  const worker = createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await assert.doesNotReject(() => worker.stop());
});

// ---------------------------------------------------------------------------
// Секция 5: CRM-синк после markPublished.
// ---------------------------------------------------------------------------

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

// Раунд правок 1 (M8): исходный тест проходил и без внутреннего try/catch в
// finishPublished — внешний catch в цикле tick() тоже ловит падение
// syncCrmIfComplete, поэтому store.published/failed/rescheduled сами по себе
// не отличают "поймал внутренний обработчик" от "поймал внешний". Разница —
// в специфичности лога (photo_publish_crm_sync_enqueue_failed против общего
// photo_publish_apply_outcome_failed), и именно её теперь проверяет тест.
test('падение syncCrmIfComplete не превращает успешную публикацию в ошибку, и ловится ИМЕННО внутренним обработчиком CRM-шага', async () => {
  const store = makeStore([[{ id: 1, report_id: 77, publish_attempts: 0 }]]);
  const logs = [];
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    syncCrmIfComplete: async () => { throw new Error('crm queue down'); },
    limiter: noopLimiter(),
    logger: { error: (key, meta) => logs.push({ key, meta }), log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(store.published.length, 1, 'фото реально опубликовано — это не должно откатываться из-за отдельного шага CRM');
  assert.equal(store.failed.length, 0);
  assert.equal(store.rescheduled.length, 0);
  assert.ok(
    logs.some((entry) => entry.key === 'photo_publish_crm_sync_enqueue_failed'),
    'падение CRM-шага обязано быть залогировано СВОИМ специфичным ключом'
  );
  assert.ok(
    !logs.some((entry) => entry.key === 'photo_publish_apply_outcome_failed'),
    'если сработал внешний catch цикла tick() вместо внутреннего — это и есть регресс M8'
  );
});

// ---------------------------------------------------------------------------
// Секция 6: изоляция падения store-вызовов при применении исхода.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Секция 7: backfill дорезолвленного списка в report_local_state
// (раунд правок 1, Important) + дедупликация конкурентных резолвов (минор).
//
// Воркер (resolveRequiredPhotoCodes: живой список) и POST /:id/submit
// (report_local_state.required_photo_codes: снепшот на момент открытия
// карточки) читают список требуемых кодов из РАЗНЫХ источников. Если состав
// требований у АЗС сменится между ними, submit увидит более новый список и
// может засчитать помеченный здесь код как загруженный. persistResolvedCodes
// закрывает дрейф по конструкции: после каждого успешного резолва актуальный
// список пишется обратно в report_local_state тем же приёмом, что и открытие
// карточки (reportsStore.setRequiredPhotoCodes).
// ---------------------------------------------------------------------------

test('успешный дорезолв списка пишет его обратно в report_local_state (reportsStore.setRequiredPhotoCodes)', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]]);
  const setCalls = [];
  const reportsStore = { async setRequiredPhotoCodes(args) { setCalls.push(args); } };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT', 'BACK'],
    reportsStore,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.deepEqual(setCalls, [{ reportId: 55, codes: ['FRONT', 'BACK'] }]);
  assert.equal(store.published.length, 1);
});

test('пишет дорезолвленный список обратно, даже если сам код не входит в него (not_required)', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'WRONG', publish_attempts: 0, slot_verified: false }]]);
  const setCalls = [];
  const reportsStore = { async setRequiredPhotoCodes(args) { setCalls.push(args); } };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT', 'BACK'],
    reportsStore,
    publishOne: async () => { throw new Error('publishOne не должен вызываться'); },
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.deepEqual(setCalls, [{ reportId: 55, codes: ['FRONT', 'BACK'] }]);
  assert.equal(store.failed.length, 1);
});

test('если резолвер списка бросил, запись в report_local_state не происходит', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 3, slot_verified: false }]]);
  const setCalls = [];
  const reportsStore = { async setRequiredPhotoCodes(args) { setCalls.push(args); } };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { throw new Error('Bitrix is down'); },
    reportsStore,
    publishOne: async () => { throw new Error('publishOne не должен вызываться'); },
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await worker.tick();
  assert.equal(setCalls.length, 0, 'нечего писать, если сам резолв не удался');
});

test('падение reportsStore.setRequiredPhotoCodes не мешает публикации — это best-effort backfill', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]]);
  const reportsStore = { async setRequiredPhotoCodes() { throw new Error('db down'); } };
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT'],
    reportsStore,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(store.published.length, 1);
});

test('reportsStore не сконфигурирован — backfill просто не происходит, публикация работает как раньше', async () => {
  const store = makeStore([[{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => ['FRONT'],
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: noopLimiter()
  });
  await assert.doesNotReject(() => worker.tick());
  assert.equal(store.published.length, 1);
});

test('конкурентные фото ОДНОГО report_id внутри одного тика делят один резолв (не дублируют поход в Битрикс)', async () => {
  const store = makeStore([[
    { id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false },
    { id: 2, report_id: 55, photo_code: 'BACK', publish_attempts: 0, slot_verified: false }
  ]]);
  let resolverCalls = 0;
  let releaseResolver;
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => {
      resolverCalls += 1;
      return new Promise((resolve) => { releaseResolver = resolve; });
    },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  const tickPromise = worker.tick();
  await flushMicrotasks();
  assert.equal(resolverCalls, 1, 'два фото одного report_id обязаны дождаться ОДНОГО резолва, а не сделать по своему');
  releaseResolver(['FRONT', 'BACK']);
  await tickPromise;
  assert.equal(store.published.length, 2);
  assert.equal(resolverCalls, 1);
});

test('разные report_id резолвятся независимо (дедупликация не смешивает разные отчёты)', async () => {
  const store = makeStore([[
    { id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false },
    { id: 2, report_id: 66, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }
  ]]);
  const seenReportIds = [];
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async (task) => { seenReportIds.push(task.report_id); return ['FRONT']; },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick();
  assert.deepEqual(seenReportIds.sort(), [55, 66]);
  assert.equal(store.published.length, 2);
});

// ---------------------------------------------------------------------------
// Секция 8: start()/stop() — периодический опрос.
//
// НЕ используют реальные таймеры/сон по времени — только инъецированные
// setIntervalFn/clearIntervalFn (см. JSDoc в photoPublishWorker.js). Причина:
// исходный вариант этих тестов спал реальными миллисекундами и один раз
// реально упал под сторонней нагрузкой на машине — гонка с системным
// таймером, а не баг воркера. Переписано на управляемый вручную фейковый
// "таймер", без ожидания реальных миллисекунд и без единого шанса на флаки
// по нагрузке системы.
// ---------------------------------------------------------------------------

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

test('start() регистрирует опрос через setIntervalFn с заданным pollIntervalMs; stop() снимает его через clearIntervalFn', async () => {
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
  await worker.stop();
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

  await worker.stop();
});

// ---------------------------------------------------------------------------
// Секция 9: валидация конструктора.
// ---------------------------------------------------------------------------

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

test('конструктор требует pool с connect() — нужен выделенный клиент для advisory-лока', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), publishOne: async () => {}, limiter: noopLimiter()
  }));
});

// Раунд правок 1 (Critical): регрессионный тест на саму найденную форму
// бага — pool с одним лишь query() (без connect()) когда-то было ровно тем,
// что этот файл принимал как валидный pool. Теперь обязан отвергаться на
// старте, а не молча ловить session-affinity баг в проде.
test('конструктор отвергает pool без connect() (старая query()-only форма)', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), pool: { query: async () => ({ rows: [{ locked: true }] }) },
    publishOne: async () => {}, limiter: noopLimiter()
  }));
});

test('конструктор отвергает workers < 1', () => {
  assert.throws(() => createPhotoPublishWorker({
    store: makeStore([]), pool: okPool, publishOne: async () => {}, limiter: noopLimiter(), workers: 0
  }));
});

// ---------------------------------------------------------------------------
// Секция 10: раунд правок 2 (Blocker) — pg_try_advisory_lock/pg_advisory_unlock
// это СЧЁТЧИК держаний на сессию, а не глобальный флаг.
//
// makeSimplePool/makeTrackedPool выше отвечают locked:true на КАЖДЫЙ запрос
// независимо от того, кто и сколько раз уже захватывал — они не моделируют
// реальную семантику Postgres и поэтому НЕ МОГЛИ поймать баг раунда 1
// (tryBecomeLeader перезахватывал лок на каждом tick(), releaseClient снимал
// только один раз — после нескольких тиков лидерства лок оставался висеть
// после stop()). Ревьюер поймал это только на живом Postgres 17. Ниже —
// минимальный симулятор РЕАЛЬНОЙ семантики, достаточный, чтобы тест мог
// провалиться так же, как проваливался бы на живой базе.
// ---------------------------------------------------------------------------

const createAdvisorySimulator = () => {
  const holders = new Map(); // key -> { session, count }
  return {
    tryLock(sessionId, key) {
      const holder = holders.get(key);
      if (!holder) {
        holders.set(key, { session: sessionId, count: 1 });
        return true;
      }
      if (holder.session === sessionId) {
        holder.count += 1;
        return true;
      }
      return false; // держит другая сессия
    },
    unlock(sessionId, key) {
      const holder = holders.get(key);
      if (!holder || holder.session !== sessionId || holder.count <= 0) return false;
      holder.count -= 1;
      if (holder.count <= 0) holders.delete(key);
      return true;
    },
    // Обрыв соединения — Postgres снимает ВСЕ держания этой сессии сразу,
    // независимо от счётчика.
    endSession(sessionId) {
      for (const [key, holder] of holders) {
        if (holder.session === sessionId) holders.delete(key);
      }
    }
  };
};

let simulatedSessionSeq = 0;

// pool.connect()-совместимый фейк поверх симулятора: КАЖДЫЙ connect() —
// новая "сессия" (как и в реальности — новое физическое соединение), а
// query() реально исполняет pg_try_advisory_lock/pg_advisory_unlock против
// ОБЩЕГО симулятора (несколько таких pool, созданных с ОДНИМ и тем же
// simulator, представляют несколько экземпляров приложения на одну базу).
const makeSimulatedPool = (simulator) => {
  const clients = [];
  const pool = {
    async connect() {
      simulatedSessionSeq += 1;
      const sessionId = simulatedSessionSeq;
      const listeners = {};
      let ended = false;
      const c = {
        sessionId,
        queryLog: [],
        releaseLog: [],
        async query(sql, params) {
          c.queryLog.push({ sql, params });
          const key = params?.[0];
          if (/pg_try_advisory_lock/.test(sql)) {
            return { rows: [{ locked: simulator.tryLock(sessionId, key) }] };
          }
          if (/pg_advisory_unlock/.test(sql)) {
            return { rows: [{ released: simulator.unlock(sessionId, key) }] };
          }
          throw new Error(`makeSimulatedPool: неизвестный для теста SQL: ${sql}`);
        },
        on(event, handler) {
          (listeners[event] ||= []).push(handler);
          return c;
        },
        // Имитация обрыва TCP-соединения: сессия обрывается на стороне
        // Postgres (снимает ВСЕ её держания) И клиент об этом узнаёт через
        // 'error' — ровно то, что происходит в проде.
        kill(error = new Error('simulated connection loss')) {
          if (ended) return;
          ended = true;
          simulator.endSession(sessionId);
          (listeners.error || []).forEach((h) => h(error));
        },
        release(err) { c.releaseLog.push(err); }
      };
      clients.push(c);
      return c;
    }
  };
  return { pool, clients };
};

// ---------------------------------------------------------------------------
// ГЛАВНЫЙ тест раунда 2: несколько тиков лидерства, потом stop() — второй,
// полностью независимый воркер (свой pool.connect(), но ТА ЖЕ база —
// общий simulator) обязан суметь стать лидером сразу после этого. Если
// счётчик держаний не обнулился (баг раунда 1), второй воркер получит
// locked:false, хотя первый уже "остановлен".
//
// Перед реализацией фикса этот тест запускался ОТДЕЛЬНО
// (node --test tests/photoPublishWorker.test.js) против кода раунда 1 и
// падал именно на assert.equal(workerB.isLeader(), true, ...) — см.
// task-7-report.md, раздел "Раунд правок 2", за точным выводом.
// ---------------------------------------------------------------------------

test('раунд 2 (Blocker): stop() после НЕСКОЛЬКИХ тиков лидерства обязан полностью снять лок — независимый воркер должен суметь стать лидером', async () => {
  const simulator = createAdvisorySimulator();
  const { pool: poolA } = makeSimulatedPool(simulator);
  const storeA = makeStore([[], [], [], [], []]); // 5 тиков подряд лидером
  const workerA = createPhotoPublishWorker({
    store: storeA, pool: poolA, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await workerA.tick();
  }
  assert.equal(workerA.isLeader(), true, 'workerA обязан быть лидером после серии тиков');

  await workerA.stop();

  const { pool: poolB } = makeSimulatedPool(simulator);
  const storeB = makeStore([[]]);
  const workerB = createPhotoPublishWorker({
    store: storeB, pool: poolB, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await workerB.tick();
  assert.equal(
    workerB.isLeader(),
    true,
    'лок обязан быть полностью свободен после stop() воркера, побывшего лидером НЕСКОЛЬКО тиков — иначе второй экземпляр приложения не сможет опубликовать НИЧЕГО'
  );
  await workerB.stop();
});

// ---------------------------------------------------------------------------
// Второй механизм той же поломки раунда 2: stop() не координировался с уже
// летящим tick(). Гвард ticking в start() защищает только срабатывания
// планировщика между собой — прямой вызов stop() СНАРУЖИ, ровно в момент,
// когда tick() уже взял лидерство (или ещё только берёт), раньше приводил к
// тому, что releaseClient() отрабатывал ДО завершения tick(). Два варианта
// гонки: пока tick() ещё решает вопрос лидерства, и пока tick() уже лидер и
// обрабатывает пачку.
// ---------------------------------------------------------------------------

test('раунд 2: stop(), вызванный ПОКА tick() ещё захватывает лидерство, дожидается его перед освобождением клиента', async () => {
  let firstQueryStarted = false;
  let releaseFirstQuery;
  const queryLog = [];
  const releaseLog = [];
  const pool = {
    async connect() {
      const c = {
        async query(sql, params) {
          queryLog.push({ sql, params });
          if (!firstQueryStarted) {
            firstQueryStarted = true;
            // pg_try_advisory_lock зависает, пока тест сам не отпустит —
            // имитирует медленную сеть/сервер ровно в момент, когда извне
            // прилетает stop().
            return new Promise((resolve) => {
              releaseFirstQuery = () => resolve({ rows: [{ locked: true, released: true }] });
            });
          }
          return { rows: [{ locked: true, released: true }] };
        },
        on() {},
        release(err) { releaseLog.push(err); }
      };
      return c;
    }
  };
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });

  const tickPromise = worker.tick();
  await flushMicrotasks(); // дать tick() дойти до pg_try_advisory_lock и повиснуть там

  let stopResolved = false;
  const stopPromise = worker.stop().then(() => { stopResolved = true; });
  await flushMicrotasks();
  assert.equal(stopResolved, false, 'stop() не имеет права завершиться, пока tick() ещё не решил вопрос лидерства');
  assert.equal(releaseLog.length, 0, 'клиент не должен быть освобождён, пока tick() им ещё пользуется');

  releaseFirstQuery();
  await tickPromise;
  await stopPromise;

  assert.equal(stopResolved, true);
  assert.equal(releaseLog.length, 1, 'после завершения tick() stop() обязан освободить клиента');
});

test('раунд 2: stop(), вызванный ПОКА tick() уже лидер и обрабатывает пачку, дожидается завершения обработки', async () => {
  const { pool, clients } = makeTrackedPool();
  let releasePublish;
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool,
    publishOne: async () => new Promise((resolve) => { releasePublish = () => resolve({ fileId: 1 }); }),
    limiter: noopLimiter()
  });

  const tickPromise = worker.tick();
  await flushMicrotasks(); // дать tick() пройти лидерство + claimBatch и повиснуть внутри publishOne

  let stopResolved = false;
  const stopPromise = worker.stop().then(() => { stopResolved = true; });
  await flushMicrotasks();
  assert.equal(stopResolved, false, 'stop() не имеет права освободить клиента, пока публикация всё ещё выполняется');

  releasePublish();
  await tickPromise;
  await stopPromise;

  assert.equal(stopResolved, true);
  assert.equal(store.published.length, 1, 'публикация, начатая до stop(), обязана довестись до конца');
  assert.equal(clients[0].releaseLog.length, 1);
});

// ---------------------------------------------------------------------------
// Гэпы в покрытии, найденные ревью (раунд правок 2, "на моё усмотрение", но
// сделано): мутации "убрать finally в resolveRequiredPhotoCodesShared" и
// "убрать проверку идентичности в dropClient" проходили зелёными — сам код
// был верен, дыры были только в тестах.
// ---------------------------------------------------------------------------

test('раунд 2 (гэп покрытия): resolveRequiredPhotoCodesShared не кэширует результат навсегда — раздельные во времени вызовы для того же report_id резолвят заново', async () => {
  const store = makeStore([
    [{ id: 1, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }],
    [{ id: 2, report_id: 55, photo_code: 'FRONT', publish_attempts: 0, slot_verified: false }]
  ]);
  let resolverCalls = 0;
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    resolveRequiredPhotoCodes: async () => { resolverCalls += 1; return ['FRONT']; },
    publishOne: async () => ({ fileId: 1, fileName: 'a.jpg', diskFolderId: 1, diskObjectId: 1 }),
    limiter: noopLimiter()
  });
  await worker.tick(); // первый резолв для report_id=55, полностью завершился
  assert.equal(resolverCalls, 1);
  await worker.tick(); // второй, НЕ пересекающийся по времени тик — тот же report_id
  assert.equal(resolverCalls, 2,
    'без очистки inFlightResolves в finally второй вызов делил бы устаревший, уже завершившийся промис первого навсегда');
});

test('раунд 2 (гэп покрытия): запоздавшее ВТОРОЕ событие error от уже отброшенного клиента не портит текущего здорового лидера', async () => {
  const { pool, clients } = makeTrackedPool();
  const store = makeStore([[], []]);
  const worker = createPhotoPublishWorker({
    store, pool, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter(),
    logger: { error() {}, log() {} }
  });

  await worker.tick(); // client[0] активен, лидер
  assert.equal(worker.isLeader(), true);

  clients[0].emit('error', new Error('первое событие error'));

  await worker.tick(); // переподключение -> client[1] активен, снова лидер
  assert.equal(clients.length, 2);
  assert.equal(worker.isLeader(), true);

  // Запоздавшее ВТОРОЕ событие error от того же СТАРОГО (уже отброшенного)
  // клиента — реальный node-postgres иногда шлёт 'error' более одного раза
  // на одно и то же соединение.
  clients[0].emit('error', new Error('запоздавшее второе событие error'));

  assert.equal(worker.isLeader(), true, 'запоздавшее событие от чужого (уже отброшенного) клиента не должно портить текущего лидера');

  await worker.tick(); // следующий тик обязан переиспользовать client[1], не переподключаться зря
  assert.equal(clients.length, 2, 'здоровый client[1] не должен быть отброшен из-за чужого запоздалого события');

  await worker.stop();
});

// Основной фикс (tryBecomeLeader не перезахватывает, если уже лидер) держит
// счётчик держаний этой сессии не выше 1 в любом НОРМАЛЬНОМ потоке — из-за
// этого сам по себе он делает цикл в releaseClient недоказуемым обычным
// путём (одного unlock всегда достаточно, если счётчик и так не превышает
// 1). Этот тест искусственно раздувает счётчик В ОБХОД воркера (имитируя
// гипотетический будущий баг или посторонний SQL с того же соединения),
// чтобы доказать: releaseClient снимает лок ПОЛНОСТЬЮ независимо от того,
// откуда взялся лишний счётчик, а не потому, что тот НИКОГДА не бывает
// больше 1.
test('раунд 2 (защита в глубину): releaseClient снимает лок ПОЛНОСТЬЮ, даже если счётчик держаний искусственно больше 1', async () => {
  const simulator = createAdvisorySimulator();
  const { pool: poolA, clients: clientsA } = makeSimulatedPool(simulator);
  const store = makeStore([[]]);
  const worker = createPhotoPublishWorker({
    store, pool: poolA, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });

  await worker.tick(); // становится лидером нормальным путём воркера — держание №1
  assert.equal(worker.isLeader(), true);

  // В обход обычного пути воркера досоздаём ещё два держания НА ТОЙ ЖЕ
  // сессии — счётчик становится 3.
  simulator.tryLock(clientsA[0].sessionId, ADVISORY_LOCK_KEY);
  simulator.tryLock(clientsA[0].sessionId, ADVISORY_LOCK_KEY);

  await worker.stop();

  const { pool: poolB } = makeSimulatedPool(simulator);
  const workerB = createPhotoPublishWorker({
    store: makeStore([[]]), pool: poolB, publishOne: async () => ({ fileId: 1 }), limiter: noopLimiter()
  });
  await workerB.tick();
  assert.equal(
    workerB.isLeader(),
    true,
    'releaseClient обязан снимать лок В ЦИКЛЕ, пока не «нечего снимать», а не одним вызовом — иначе искусственно раздутый счётчик оставил бы лок висеть'
  );
  await workerB.stop();
});
