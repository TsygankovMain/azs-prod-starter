import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEmbeddedPostgresEnabled,
  readPhotoPublishNumberEnv,
  createPhotoQueueUnavailableStore,
  buildPhotoQueueRuntime,
  isPhotoPublishWorkerSupported
} from '../src/reports/photoPublishBoot.js';
import { createRateLimiter } from '../src/shared/rateLimiter.js';
import { createPhotoPublisher } from '../src/reports/photoPublisher.js';
import { createPhotoPublishWorker } from '../src/reports/photoPublishWorker.js';
import { createPhotoPublishWatchdog } from '../src/reports/photoPublishWatchdog.js';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Task 11 — проводка server.js. Модуль photoPublishBoot.js вынесен из
// server.js намеренно: server.js нигде не импортируется тестами (живые
// side-effects на верхнем уровне модуля — подключение к БД, express.listen),
// поэтому мутационная проверка ОБЯЗАНА бить по настоящему, импортируемому
// коду, а не по его копии, переписанной в теле теста — иначе тест
// декоративен (см. отчёт задачи, находка ревью про "восемь раз декоративно").
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Пункт 6: EMBEDDED_POSTGRES читается строго, а не по truthy-строке.
// ---------------------------------------------------------------------------

test('isEmbeddedPostgresEnabled: строка "true" — истина', () => {
  assert.equal(isEmbeddedPostgresEnabled('true'), true);
});

test('isEmbeddedPostgresEnabled: строка "false" — ложь, хотя в JS она truthy', () => {
  // Наивная `if (process.env.EMBEDDED_POSTGRES)` включила бы предохранитель
  // ровно наоборот: непустая строка 'false' истинна в булевом контексте.
  assert.equal(isEmbeddedPostgresEnabled('false'), false);
});

test('isEmbeddedPostgresEnabled: не задано (undefined) — ложь, дефолт", "', () => {
  assert.equal(isEmbeddedPostgresEnabled(undefined), false);
});

test('isEmbeddedPostgresEnabled: пустая строка — ложь', () => {
  assert.equal(isEmbeddedPostgresEnabled(''), false);
});

test('isEmbeddedPostgresEnabled: регистр и пробелы вокруг значения не мешают распознать "true"', () => {
  assert.equal(isEmbeddedPostgresEnabled(' True '), true);
  assert.equal(isEmbeddedPostgresEnabled('TRUE'), true);
});

test('isEmbeddedPostgresEnabled: произвольный мусор — ложь, а не бросает', () => {
  assert.equal(isEmbeddedPostgresEnabled('yes'), false);
  assert.equal(isEmbeddedPostgresEnabled('1'), false);
});

// ---------------------------------------------------------------------------
// Пункт 4: значения окружения валидируются ДО передачи в конструктор.
// ---------------------------------------------------------------------------

test('readPhotoPublishNumberEnv: отсутствующее значение — фолбэк, без предупреждения', () => {
  const logs = [];
  const value = readPhotoPublishNumberEnv({
    rawValue: undefined,
    fallback: 1.4,
    isValid: (n) => n > 0,
    name: 'PHOTO_PUBLISH_RATE_PER_SEC',
    logger: { error: (msg) => logs.push(msg) }
  });
  assert.equal(value, 1.4);
  assert.equal(logs.length, 0, 'отсутствие переменной — это норма (используется дефолт), а не ошибка конфигурации');
});

test('readPhotoPublishNumberEnv: корректное значение проходит как есть', () => {
  const value = readPhotoPublishNumberEnv({
    rawValue: '2.5',
    fallback: 1.4,
    isValid: (n) => n > 0,
    name: 'PHOTO_PUBLISH_RATE_PER_SEC'
  });
  assert.equal(value, 2.5);
});

test('readPhotoPublishNumberEnv: PHOTO_PUBLISH_BURST="кривое значение" -> фолбэк, а не throw', () => {
  // Пункт 4 дословно: createRateLimiter бросает при burst < 1. Приложение не
  // имеет права упасть из-за опечатки в окружении.
  const logs = [];
  const value = readPhotoPublishNumberEnv({
    rawValue: 'кривое значение',
    fallback: 3,
    isValid: (n) => n >= 1,
    name: 'PHOTO_PUBLISH_BURST',
    logger: { error: (msg) => logs.push(msg) }
  });
  assert.equal(value, 3);
  assert.equal(logs.length, 1, 'кривое значение обязано быть залогировано, а не молча проглочено');
  assert.match(logs[0], /PHOTO_PUBLISH_BURST/);
});

test('readPhotoPublishNumberEnv: PHOTO_PUBLISH_BURST="0" -> фолбэк (0 < 1, за гранью допустимого)', () => {
  const value = readPhotoPublishNumberEnv({
    rawValue: '0',
    fallback: 3,
    isValid: (n) => n >= 1,
    name: 'PHOTO_PUBLISH_BURST'
  });
  assert.equal(value, 3);
});

test('readPhotoPublishNumberEnv: отрицательное значение отвергается', () => {
  const value = readPhotoPublishNumberEnv({
    rawValue: '-5',
    fallback: 1.4,
    isValid: (n) => n > 0,
    name: 'PHOTO_PUBLISH_RATE_PER_SEC'
  });
  assert.equal(value, 1.4);
});

// ---------------------------------------------------------------------------
// Заглушка недоступной очереди — .accept() бросает понятную ошибку, а не
// принимает фото туда, откуда их некому забрать, и не оставляет
// createReportsRouter без обязательного параметра (пункт 7).
// ---------------------------------------------------------------------------

test('createPhotoQueueUnavailableStore: accept() бросает с понятной причиной', async () => {
  const store = createPhotoQueueUnavailableStore('EMBEDDED_POSTGRES=true');
  await assert.rejects(
    () => store.accept({ reportId: 1, photoCode: '42' }),
    (error) => {
      assert.match(error.message, /EMBEDDED_POSTGRES=true/);
      assert.equal(error.code, 'photo_queue_unavailable');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// buildPhotoQueueRuntime — единая точка решения, закрывающая пункты 5 и 6.
// ---------------------------------------------------------------------------

test('buildPhotoQueueRuntime: EMBEDDED_POSTGRES=true -> очередь выключена, createStore НЕ вызывается вовсе', () => {
  const logs = [];
  let createStoreCalls = 0;
  const runtime = buildPhotoQueueRuntime({
    isEmbeddedPostgres: true,
    createStore: () => { createStoreCalls += 1; return { async accept() {} }; },
    logger: { error: (msg) => logs.push(msg) }
  });

  assert.equal(runtime.enabled, false);
  assert.equal(createStoreCalls, 0, 'на эфемерной БД конструктор реального стора не должен вызываться вовсе');
  assert.equal(typeof runtime.store.accept, 'function', 'photoQueueStore обязан существовать всегда — см. пункт 7');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /photo_publish_queue_disabled/);
});

test('buildPhotoQueueRuntime: EMBEDDED_POSTGRES=false и стор создаётся успешно -> очередь включена, стор реальный', () => {
  const realStore = { async accept() { return { id: 1 }; } };
  const runtime = buildPhotoQueueRuntime({
    isEmbeddedPostgres: false,
    createStore: () => realStore
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.store, realStore, 'должен быть возвращён ИМЕННО настоящий стор, не обёртка');
});

test('buildPhotoQueueRuntime: createStore бросает -> приложение "поднимается" (возвращает рабочую заглушку, не бросает само)', () => {
  const logs = [];
  const runtime = buildPhotoQueueRuntime({
    isEmbeddedPostgres: false,
    createStore: () => { throw new Error('pool is required'); },
    logger: { error: (msg) => logs.push(msg) }
  });

  assert.equal(runtime.enabled, false);
  assert.equal(typeof runtime.store.accept, 'function');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /pool is required/);
});

test('buildPhotoQueueRuntime: заглушка при отказе создания стора тоже отдаёт понятную ошибку на accept()', async () => {
  const runtime = buildPhotoQueueRuntime({
    isEmbeddedPostgres: false,
    createStore: () => { throw new Error('boom'); },
    logger: { error: () => {} }
  });
  await assert.rejects(() => runtime.store.accept({}), /boom/);
});

// ---------------------------------------------------------------------------
// НАХОДКА при само-ревью (не входит в исходные 9 пунктов, но их прямое
// следствие): photoQueueStore.js полностью поддерживает MySQL, а
// photoPublishWorker.js — НЕТ. Его advisory-лок — Postgres-специфичный SQL
// (pg_try_advisory_lock/pg_advisory_unlock) и его конструктор требует
// pool.connect(), которого у mysql2/promise.Pool попросту не существует
// (там .getConnection(), другой метод и другая форма клиента — см.
// tests/photoPublishWorker.test.js и заголовок photoPublishWorker.js: там
// везде "Postgres", ни слова про MySQL). Без этой проверки на DB_TYPE=mysql
// с EMBEDDED_POSTGRES=false (очередь ВКЛЮЧЕНА — photoQueueStore это
// поддерживает) createPhotoPublishWorker({pool, ...}) бросил бы синхронно
// и уронил бы ВЕСЬ процесс — гораздо хуже, чем просто невозможность
// опубликовать фото: приём фото (не завязанный на advisory-лок) тоже
// перестал бы работать, хотя мог бы.
// ---------------------------------------------------------------------------

test('isPhotoPublishWorkerSupported: pg.Pool-подобный объект (с connect()) — поддерживается', () => {
  assert.equal(isPhotoPublishWorkerSupported({ pool: { connect: async () => {} } }), true);
});

test('isPhotoPublishWorkerSupported: mysql2-подобный пул (getConnection(), без connect()) — НЕ поддерживается', () => {
  assert.equal(isPhotoPublishWorkerSupported({ pool: { getConnection: async () => {}, query: async () => {} } }), false);
});

test('isPhotoPublishWorkerSupported: пустой/отсутствующий pool — НЕ поддерживается, не бросает', () => {
  assert.equal(isPhotoPublishWorkerSupported({ pool: null }), false);
  assert.equal(isPhotoPublishWorkerSupported({}), false);
});

// Замыкает цикл: проверяет саму ПРЕДПОСЫЛКУ, на которой стоит guard выше —
// против НАСТОЯЩЕГО createPhotoPublishWorker, а не только против
// собственного предположения об его контракте. Если photoPublishWorker.js
// когда-нибудь научится работать без pool.connect() (например, добавит
// поддержку .getConnection()), этот тест первым покраснеет и укажет, что
// guard в server.js можно ослаблять.
test('РЕАЛЬНЫЙ createPhotoPublishWorker бросает на mysql2-подобном пуле (без connect()) — подтверждает, почему guard обязателен', () => {
  const mysqlLikePool = { async getConnection() { return {}; }, async query() { return [[]]; } };
  assert.throws(
    () => createPhotoPublishWorker({
      store: { async claimBatch() { return []; } },
      publishOne: async () => ({}),
      limiter: { acquire: async () => {}, penalize() {} },
      pool: mysqlLikePool
    }),
    /connect/
  );
});

// ---------------------------------------------------------------------------
// Пункт 7: photoQueueStore — обязательный параметр конструктора роутера
// отчётов. Раньше он был необязательным (default null) и отказ вылезал не
// при старте, а на первой загрузке фото у живого оператора.
// ---------------------------------------------------------------------------

const REQUIRED_ROUTER_DEPS = {
  reportsStore: {},
  dispatchService: {},
  settingsStore: {},
  bitrixClient: {},
  notificationService: {},
  authContextStore: {},
  crmSyncJobStore: {}
};

test('createReportsRouter: без photoQueueStore бросает при конструировании, а не на первой загрузке фото', () => {
  assert.throws(
    () => createReportsRouter({ ...REQUIRED_ROUTER_DEPS }),
    /photoQueueStore/
  );
});

test('createReportsRouter: photoQueueStore=null тоже бросает (текущий дефолт-параметр, который и был дырой)', () => {
  assert.throws(
    () => createReportsRouter({ ...REQUIRED_ROUTER_DEPS, photoQueueStore: null }),
    /photoQueueStore/
  );
});

test('createReportsRouter: с photoQueueStore конструируется нормально', () => {
  const router = createReportsRouter({
    ...REQUIRED_ROUTER_DEPS,
    photoQueueStore: { async accept() {} }
  });
  assert.equal(typeof router, 'function', 'express.Router() — вызываемая функция-мидлварь');
});

// ---------------------------------------------------------------------------
// Пункт 3: ограничитель темпа — ровно один на процесс, общий для publishOne
// (реальные вызовы Bitrix Disk) и всего остального, что делит с ним бюджет.
// Поведенческая проверка через РЕАЛЬНЫЙ createRateLimiter + РЕАЛЬНЫЙ
// createPhotoPublisher (тот же приём фейков, что и tests/photoPublisher.test.js):
// если бы проводка server.js создавала ВТОРОЙ экземпляр лимитера для воркера
// вместо переиспользования того же самого, у воркера и у publisher были бы
// раздельные бюджеты — этот тест обязан отличать "общий" от "раздельных".
// ---------------------------------------------------------------------------

const makeHarness = () => {
  let clock = 0;
  const sleeps = [];
  return {
    now: () => clock,
    advance: (ms) => { clock += ms; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    sleeps
  };
};

const makeFakeDiskApi = () => {
  const calls = [];
  return {
    calls,
    async findChildFolder() { calls.push('findChildFolder'); return null; },
    async createFolder(parentId) { calls.push('createFolder'); return { id: Number(parentId) * 10 + calls.length }; },
    async findChildFile() { calls.push('findChildFile'); return null; },
    async uploadFile(folderId, { fileName }) { calls.push('uploadFile'); return { diskObjectId: 1, crmFileId: 1, fileName }; }
  };
};

const baseSettingsStore = {
  async read() { return { disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' } }; }
};

const baseReportsStore = {
  async getById(id) { return { id: Number(id), azsId: 'azs-1', slotKey: '2026-05-28:1414' }; }
};

const baseTask = () => ({
  reportId: 1,
  photoCode: 'photo1',
  content: Buffer.from('fake-bytes'),
  mimeType: 'image/jpeg',
  originalName: 'photo.jpg'
});

test('ограничитель темпа — одна и та же ссылка исчерпывает общий бюджет для publisher И для прямого потребителя (воркера)', async () => {
  const h = makeHarness();
  // burst=1: ОДНОГО обращения достаточно, чтобы выбрать весь запас — второй
  // потребитель ОБЯЗАН подождать, если лимитер действительно один общий.
  const sharedLimiter = createRateLimiter({ ratePerSec: 1, burst: 1, now: h.now, sleep: h.sleep });

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi: makeFakeDiskApi() },
    settingsStore: baseSettingsStore,
    reportsStore: baseReportsStore,
    limiter: sharedLimiter,
    resolveContext: () => ({})
  });

  // publishOne() делает НЕСКОЛЬКО вызовов Bitrix (findChildFolder, createFolder
  // на каждый сегмент пути, uploadFile) — первый уже потратит единственный
  // токен; см. photoPublisher.test.js за обоснованием, почему это НЕ 1-к-1.
  await publisher.publishOne(baseTask());
  assert.ok(h.sleeps.length > 0, 'сам publishOne должен был поймать нехватку токена внутри своей же цепочки вызовов');

  const sleepsBefore = h.sleeps.length;
  // Второй, НЕЗАВИСИМЫЙ потребитель (в проде — воркер, penalize() на
  // retryAfterMs) той же самой ссылки limiter: если это ОБЩИЙ бюджет — тоже
  // обязан подождать пополнения, а не проскочить со своим отдельным запасом.
  await sharedLimiter.acquire();
  assert.ok(h.sleeps.length > sleepsBefore, 'второй потребитель обязан был подождать — бюджет общий, а не раздельный');
});

test('ДЕМОНСТРАЦИЯ ОШИБКИ: раздельные лимитеры НЕ делят бюджет (контрольный пример того, чего проводка обязана избежать)', async () => {
  const h = makeHarness();
  const limiterForPublisher = createRateLimiter({ ratePerSec: 1, burst: 1, now: h.now, sleep: h.sleep });
  const limiterForWorker = createRateLimiter({ ratePerSec: 1, burst: 1, now: h.now, sleep: h.sleep });

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi: makeFakeDiskApi() },
    settingsStore: baseSettingsStore,
    reportsStore: baseReportsStore,
    limiter: limiterForPublisher,
    resolveContext: () => ({})
  });

  await publisher.publishOne(baseTask());
  const sleepsBefore = h.sleeps.length;
  await limiterForWorker.acquire();
  assert.equal(h.sleeps.length, sleepsBefore, 'с раздельными лимитерами второй потребитель НЕ ждёт — ровно та ошибка проводки, которую нельзя допустить в server.js');
});

// ---------------------------------------------------------------------------
// Воркеры не стартуют без стора очереди (следствие buildPhotoQueueRuntime:
// enabled=false). Поведенческая проверка на РЕАЛЬНОМ createPhotoPublishWorker:
// если .start() не вызван, claimBatch не вызывается вовсе, даже когда таймер
// сработал бы.
// ---------------------------------------------------------------------------

test('воркер публикации: если .start() не вызван (проводка держит его выключенным), claimBatch не вызывается вовсе', async () => {
  let claimBatchCalls = 0;
  const store = {
    async claimBatch() { claimBatchCalls += 1; return []; }
  };
  const okPool = { async connect() { return { async query() { return { rows: [{ locked: true }] }; }, on() {}, release() {} }; } };

  const worker = createPhotoPublishWorker({
    store,
    publishOne: async () => ({}),
    limiter: { acquire: async () => {}, penalize() {} },
    pool: okPool
  });

  // Проводка server.js обязана НЕ звать worker.start(), когда
  // buildPhotoQueueRuntime().enabled === false — здесь просто НЕ вызываем
  // start(), воспроизводя эту ветку проводки, и доказываем, что без start()
  // ничего не происходит само по себе.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claimBatchCalls, 0, 'без вызова start() воркер не имеет права сам когда-либо забрать хоть одну задачу');

  worker.stop().catch(() => {}); // не должен бросать, даже если ни разу не стартовал
});

// ---------------------------------------------------------------------------
// Пункт 2: сторож обязан молчать на НЕ-ведущем экземпляре, используя ТОТ ЖЕ
// механизм лидерства, что и воркер (worker.isLeader()), а не заводить свой.
// Поведенческая проверка: notify-обёртка, которую строит server.js, должна
// бросать (а не тихо резолвиться) когда isLeader()===false — иначе антиспам-
// память сторожа (photoPublishWatchdog.js) отметит "уже уведомили" на
// экземпляре, который в реальности ничего не отправил, и после смены
// лидерства новый лидер унаследует чужую, никогда не доставленную память.
// ---------------------------------------------------------------------------

test('обёртка notify сторожа: не-ведущий экземпляр НЕ шлёт сообщение и не портит антиспам-память (проверено сквозь настоящий watchdog.tick())', async () => {
  const sentMessages = [];
  let isLeader = false;

  // Тот же приём, что и в server.js: notify бросает, если инстанс не лидер —
  // так photoPublishWatchdog.js (см. runOnce) НЕ обновит lastSignature/
  // lastNotifiedAtMs на неудачной, недоставленной попытке.
  const notify = async ({ text }) => {
    if (!isLeader) {
      throw new Error('photo_publish_watchdog_not_leader');
    }
    sentMessages.push(text);
  };

  const store = {
    async listStuck() {
      return [{ id: 1, report_id: 10, photo_code: '42', publish_attempts: 1, last_publish_error: null, uploaded_at: new Date(0) }];
    }
  };

  const watchdog = createPhotoPublishWatchdog({
    store,
    notify,
    now: () => 10_000_000,
    logger: { error() {}, warn() {} }
  });

  // Тик #1: не лидер -> notify бросает -> tick не роняется, сообщение не ушло.
  await watchdog.tick();
  assert.equal(sentMessages.length, 0, 'follower не имеет права отправить сообщение в чат');

  // Тик #2: этот же процесс СТАЛ лидером (advisory-лок перехвачен после
  // смерти прежнего лидера) — тот же самый набор застрявших фото ОБЯЗАН
  // всё ещё дать сигнал: если бы follower на тике #1 тихо "успешно"
  // промолчал (а не бросил), антиспам-память уже считала бы это "уже
  // предупредили", и это сообщение было бы молча подавлено.
  isLeader = true;
  await watchdog.tick();
  assert.equal(sentMessages.length, 1, 'после смены лидерства тот же набор застрявших фото обязан наконец уйти в чат');
});

test('обёртка notify сторожа: ведущий экземпляр отправляет сообщение как обычно', async () => {
  const sentMessages = [];
  const notify = async ({ text }) => { sentMessages.push(text); };

  const store = {
    async listStuck() {
      return [{ id: 1, report_id: 10, photo_code: '42', publish_attempts: 1, last_publish_error: null, uploaded_at: new Date(0) }];
    }
  };

  const watchdog = createPhotoPublishWatchdog({ store, notify, now: () => 10_000_000, logger: { error() {}, warn() {} } });
  await watchdog.tick();
  assert.equal(sentMessages.length, 1);
});

// ---------------------------------------------------------------------------
// Пункт 1: остановка воркера ОБЯЗАНА идти до закрытия пула. Смоделированный
// pg.Pool: как настоящий pg.Pool, .end() не резолвится, пока не вернутся ВСЕ
// чек-аутнутые через .connect() клиенты — это задокументированное поведение
// pg (см. заголовочный комментарий photoPublishWorker.js: "проверено на
// живом Postgres"), а не выдумка теста. Фейк моделирует ровно это единственное
// свойство, не больше — "подделываем пул объектом", как и остальные тесты
// этого проекта.
//
// Раунд правок 1 (уточнение владельца): ниже проверяется поведение ИМЕННО
// pool.end() в изоляции — без остальной обвязки shutdown() в server.js.
// Сам server.js без await stop() тоже не завис бы НАВСЕГДА: pool.end() там
// уже гоняется наперегонки с 3-секундным таймаутом (шаг 4), а весь shutdown()
// подстрахован безусловным force-exit через 10 с. Утверждение теста ниже
// строго уже: сам вызов pool.end() (то, что стоит на шаге 4) не резолвится
// сам по себе без предварительного возврата клиента — остановка воркера
// именно ДО pool.end() устраняет саму причину задержки, а не просто одну
// из нескольких подстраховок, которые её маскируют ценой лишних секунд.
// ---------------------------------------------------------------------------

const makeCheckoutTrackingPool = () => {
  let checkedOut = 0;
  let onAllReleased = null;
  return {
    async connect() {
      checkedOut += 1;
      return {
        async query() { return { rows: [{ locked: true }] }; },
        on() {},
        release() {
          checkedOut = Math.max(0, checkedOut - 1);
          if (checkedOut === 0 && onAllReleased) onAllReleased();
        }
      };
    },
    // Как настоящий pg.Pool.end(): ждёт возврата ВСЕХ чек-аутнутых клиентов.
    async end() {
      if (checkedOut === 0) return;
      await new Promise((resolve) => { onAllReleased = resolve; });
    },
    get checkedOut() { return checkedOut; }
  };
};

const raceWithTimeout = (promise, ms) => Promise.race([
  promise.then(() => 'resolved'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
]);

test('правильный порядок: await worker.stop() ДО pool.end() — pool.end() резолвится быстро', async () => {
  const pool = makeCheckoutTrackingPool();
  const worker = createPhotoPublishWorker({
    store: { async claimBatch() { return []; } },
    publishOne: async () => ({}),
    limiter: { acquire: async () => {}, penalize() {} },
    pool
  });

  await worker.tick(); // становится лидером -> pool.connect() чек-аутит клиента
  assert.equal(pool.checkedOut, 1, 'тест бессмыслен, если клиент не был реально чек-аутнут');

  await worker.stop(); // ОБЯЗАН вернуть клиента пулу ДО следующей строки

  const result = await raceWithTimeout(pool.end(), 200);
  assert.equal(result, 'resolved', 'pool.end() обязан резолвиться быстро, если stop() уже вернул клиента');
});

test('ДЕМОНСТРАЦИЯ ОШИБКИ: pool.end() БЕЗ предварительного await worker.stop() не резолвится сам по себе — ровно то, что await stop() устраняет в пункте 1', async () => {
  const pool = makeCheckoutTrackingPool();
  const worker = createPhotoPublishWorker({
    store: { async claimBatch() { return []; } },
    publishOne: async () => ({}),
    limiter: { acquire: async () => {}, penalize() {} },
    pool
  });

  await worker.tick();
  assert.equal(pool.checkedOut, 1);

  // Неправильный порядок (то, что было бы в server.js без пункта 1) —
  // pool.end() вызван БЕЗ worker.stop() перед ним. В самом server.js этот
  // конкретный вызов дополнительно подстрахован 3-секундным таймаутом и
  // общим force-exit — здесь же проверяется сам pool.end() в изоляции, без
  // этой внешней обвязки, поэтому таймаут теста (200мс) — просто способ не
  // ждать реальную бесконечность, а не утверждение про весь процесс.
  const result = await raceWithTimeout(pool.end(), 200);
  assert.equal(result, 'timeout',
    'без stop() клиент воркера не возвращается сам — pool.end() сам по себе не резолвится; await stop() устраняет причину, а не просто сокращает время до подстраховки');

  await worker.stop(); // уборка за тестом, не должна бросать
});
