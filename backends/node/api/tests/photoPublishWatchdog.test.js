import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoPublishWatchdog } from '../src/reports/photoPublishWatchdog.js';

// ---------------------------------------------------------------------------
// Fixtures — shape matches photoQueueStore.listStuck()'s real return value:
// { id, report_id, photo_code, publish_attempts, last_publish_error, uploaded_at }.
// No bytes, no EXIF — listStuck() never returns them (see photoQueueStore.js).
// ---------------------------------------------------------------------------

const makeRow = (overrides = {}) => ({
  id: 1,
  report_id: 501,
  photo_code: 'kolonka_1',
  publish_attempts: 0,
  last_publish_error: null,
  uploaded_at: new Date(0).toISOString(),
  ...overrides
});

// Fake store: no mocking library, plain object with a controllable
// listStuck(), same pattern as makeFakePool() in photoQueueStore.test.js.
// Accepts either a static array or a function(args) -> rows, so a single
// instance can change its answer between two tick() calls within one test.
const makeFakeStore = (rowsOrFn) => {
  const calls = [];
  return {
    calls,
    async listStuck(args) {
      calls.push(args);
      return typeof rowsOrFn === 'function' ? rowsOrFn(args) : rowsOrFn;
    }
  };
};

const makeNotify = ({ impl = null } = {}) => {
  const calls = [];
  const fn = async (payload) => {
    calls.push(payload);
    if (impl) return impl(payload);
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
};

const silentLogger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Required Step-1 tests (task-10-brief.md)
// ---------------------------------------------------------------------------

test('молчит, когда застрявших нет', async () => {
  const store = makeFakeStore([]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({ store, notify, logger: silentLogger, now: () => 1_000 });

  const result = await watchdog.tick();

  assert.equal(notify.calls.length, 0, 'notify не должен вызываться, когда listStuck вернул пусто');
  assert.equal(result.notified, false);
  assert.equal(result.stuckCount, 0);
});

test('сигналит при фото старше порога', async () => {
  const stuckAfterMs = 2 * 60 * 60 * 1000;
  const nowMs = 10_000_000_000;
  const oldRow = makeRow({
    id: 42,
    report_id: 777,
    photo_code: 'stella_2',
    uploaded_at: new Date(nowMs - stuckAfterMs - 60_000).toISOString() // старше порога на минуту
  });
  const store = makeFakeStore([oldRow]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({
    store, notify, stuckAfterMs, logger: silentLogger, now: () => nowMs
  });

  await watchdog.tick();

  assert.equal(notify.calls.length, 1, 'notify вызван ровно один раз');
  const payload = notify.calls[0];
  assert.equal(payload.count, 1, 'notify получает число застрявших');
  assert.equal(payload.items.length, 1, 'notify получает список');
  assert.equal(payload.items[0].reportId, 777, 'элемент списка несёт идентификатор отчёта/АЗС');
  assert.equal(payload.items[0].photoCode, 'stella_2', 'элемент списка несёт код слота');
  assert.match(payload.text, /777/);
  assert.match(payload.text, /stella_2/);
});

test('не спамит одним и тем же каждую минуту', async () => {
  const rows = [makeRow({ id: 1, last_publish_error: 'timeout' })];
  const store = makeFakeStore(rows);
  const notify = makeNotify();
  let clock = 0;
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => clock, reminderIntervalMs: 30 * 60 * 1000
  });

  await watchdog.tick();
  clock += 60_000; // минута спустя, тот же набор
  await watchdog.tick();

  assert.equal(notify.calls.length, 1, 'два тика подряд с тем же набором -> ровно один вызов notify');
});

test('код-ревью Раунд 1: одна и та же проблема с разным текстом ошибки на двух тиках подряд не спамит', async () => {
  // bitrixRestClient.js бросает нестандартизированный, "сырой" текст ошибки
  // (тело HTTP-ответа/description), который меняется от попытки к попытке
  // даже когда сама проблема (то же фото, тот же класс отказа) не изменилась.
  // Если бы подпись анти-спама включала этот текст буквально, при затяжном
  // простое портала — ровно том сценарии, ради которого сторож существует —
  // подпись меняла бы почти на каждом тике, дедуп никогда бы не срабатывал,
  // и сторож бы спамил в чат вместо того, чтобы молчать между напоминаниями.
  let attempt = 0;
  const store = {
    async listStuck() {
      attempt += 1;
      return [makeRow({ id: 1, last_publish_error: `HTTP 503: retry-attempt-body-${attempt}` })];
    }
  };
  const notify = makeNotify();
  let clock = 0;
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => clock, reminderIntervalMs: 30 * 60 * 1000
  });

  await watchdog.tick();
  clock += 60_000; // минута спустя — тот же id, но другой текст ошибки
  await watchdog.tick();

  assert.equal(
    notify.calls.length, 1,
    'смена текста ошибки одного и того же фото — не новая проблема, дедуп обязан сработать'
  );
});

test('failed попадает в сигнал сразу, не дожидаясь порога', async () => {
  // По контракту listStuck() (photoQueueStore.js) в выборку немедленно
  // попадают фото без байтов и фото в состоянии 'failed', даже если они
  // моложе olderThanMs — сторож обязан довериться этому решению и НЕ
  // перепроверять возраст сам. Строка здесь совсем свежая (минуту назад),
  // намного младше двухчасового порога, чтобы отличить "доверяю стору" от
  // "сам жду порога".
  const stuckAfterMs = 2 * 60 * 60 * 1000;
  const nowMs = 10_000_000_000;
  const freshFailedRow = makeRow({
    id: 9,
    report_id: 555,
    photo_code: 'shlang_3',
    uploaded_at: new Date(nowMs - 60_000).toISOString(),
    last_publish_error: 'DISK_QUOTA_EXCEEDED'
  });
  const store = makeFakeStore([freshFailedRow]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({
    store, notify, stuckAfterMs, logger: silentLogger, now: () => nowMs
  });

  await watchdog.tick();

  assert.equal(notify.calls.length, 1, 'немедленная категория не должна ждать порога');
  assert.equal(notify.calls[0].items[0].lastError, 'DISK_QUOTA_EXCEEDED');
});

test('падение отправки в чат не роняет тик', async () => {
  const store = makeFakeStore([makeRow({ id: 1 })]);
  const notify = makeNotify({ impl: async () => { throw new Error('bitrix недоступен'); } });
  const errors = [];
  const logger = { info() {}, warn() {}, error: (event, meta) => errors.push({ event, meta }) };
  const watchdog = createPhotoPublishWatchdog({ store, notify, logger, now: () => 10_000_000_000 });

  // await напрямую: если защита от падения когда-нибудь исчезнет, tick()
  // отклонится, и это провалит именно ЭТОТ await — тест упадёт с понятной
  // ошибкой, а не зависнет в ожидании коллбэка, который никогда не придёт.
  const result = await watchdog.tick();

  assert.equal(result.error, true);
  assert.ok(errors.length > 0, 'ошибка отправки обязана быть залогирована');
  assert.ok(
    errors.some((e) => e.event === 'photo_publish_watchdog_notify_failed'),
    'лог обязан содержать понятный маркер именно падения notify'
  );
});

// ---------------------------------------------------------------------------
// Доп. проверки анти-спама: не только "не спамит", но и "не молчит вечно".
// ---------------------------------------------------------------------------

test('персистирующая проблема напоминает о себе повторно после reminderIntervalMs', async () => {
  const store = makeFakeStore([makeRow({ id: 1 })]);
  const notify = makeNotify();
  let clock = 0;
  const reminderIntervalMs = 30 * 60 * 1000;
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => clock, reminderIntervalMs
  });

  await watchdog.tick();
  assert.equal(notify.calls.length, 1);

  clock += reminderIntervalMs - 1;
  await watchdog.tick();
  assert.equal(notify.calls.length, 1, 'ещё не время для напоминания');

  clock += 2; // перешли порог напоминания
  await watchdog.tick();
  assert.equal(notify.calls.length, 2, 'персистирующая проблема обязана напомнить о себе снова');
});

test('изменившийся набор сигналит заново, не дожидаясь напоминания', async () => {
  let currentRows = [makeRow({ id: 1 })];
  const store = { async listStuck() { return currentRows; } };
  const notify = makeNotify();
  let clock = 0;
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => clock, reminderIntervalMs: 30 * 60 * 1000
  });

  await watchdog.tick();
  clock += 60_000; // сильно меньше напоминания
  currentRows = [makeRow({ id: 1 }), makeRow({ id: 2, report_id: 502 })]; // добавился новый застрявший
  await watchdog.tick();

  assert.equal(notify.calls.length, 2, 'новый элемент в наборе — новая проблема, не подавлена дедупом');
});

test('после полного исчезновения проблема при повторном появлении сигналит заново', async () => {
  let currentRows = [makeRow({ id: 1 })];
  const store = { async listStuck() { return currentRows; } };
  const notify = makeNotify();
  let clock = 0;
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => clock, reminderIntervalMs: 30 * 60 * 1000
  });

  await watchdog.tick();
  clock += 60_000;
  currentRows = []; // всё опубликовалось
  await watchdog.tick();
  clock += 60_000;
  currentRows = [makeRow({ id: 1 })]; // тот же id снова застрял
  await watchdog.tick();

  assert.equal(notify.calls.length, 2, 'повторное появление после чистого интервала — новый сигнал, не подавленный дубликат');
});

// ---------------------------------------------------------------------------
// Код-ревью Раунд 1, Important 2: ссылка на карточку отчёта — дежурный не
// должен отдельно искать станцию по номеру отчёта, одно касание должно
// открывать карточку. reportLinks.js уже умеет строить и путь, и полный URL
// из одного reportId, без JOIN и без нового стора.
// ---------------------------------------------------------------------------

test('код-ревью Раунд 1: сообщение содержит полную ссылку на карточку, когда задан publicBaseUrl', async () => {
  const store = makeFakeStore([makeRow({ id: 1, report_id: 777 })]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => 10_000_000_000,
    publicBaseUrl: 'https://portal.example.bitrix24.ru'
  });

  await watchdog.tick();

  const item = notify.calls[0].items[0];
  assert.equal(item.reportLink, 'https://portal.example.bitrix24.ru/admin/777');
  assert.match(notify.calls[0].text, /https:\/\/portal\.example\.bitrix24\.ru\/admin\/777/);
});

test('код-ревью Раунд 1: без publicBaseUrl сообщение всё равно содержит относительный путь, а не отсутствие ссылки', async () => {
  const store = makeFakeStore([makeRow({ id: 1, report_id: 777 })]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => 10_000_000_000, publicBaseUrl: ''
  });

  await watchdog.tick();

  const item = notify.calls[0].items[0];
  assert.equal(item.reportLink, '/admin/777', 'деградация до относительного пути, не до отсутствия ссылки');
  assert.match(notify.calls[0].text, /\/admin\/777/);
});

test('код-ревью Раунд 1: некорректный reportId не роняет тик — ссылки для этой строки просто нет', async () => {
  const store = makeFakeStore([makeRow({ id: 1, report_id: null })]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({
    store, notify, logger: silentLogger, now: () => 10_000_000_000,
    publicBaseUrl: 'https://portal.example.bitrix24.ru'
  });

  const result = await watchdog.tick();

  assert.equal(result.notified, true, 'битый reportId не должен помешать остальному сигналу');
  assert.equal(notify.calls[0].items[0].reportLink, null);
});

// ---------------------------------------------------------------------------
// Приватность: байты и EXIF не могут попасть в сообщение/payload.
// ---------------------------------------------------------------------------

test('в payload и текст сообщения не попадают байты фото и EXIF, даже если строка стора их содержит', async () => {
  const leakyRow = makeRow({
    id: 1,
    report_id: 1,
    photo_code: 'a',
    // listStuck() в реальности такого не отдаёт — это симуляция регресса,
    // который добавил бы лишние поля в строку.
    content: Buffer.from('SUPERSECRETBYTES'),
    exif_at: '55.7558,37.6176'
  });
  const store = makeFakeStore([leakyRow]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({ store, notify, logger: silentLogger, now: () => 10_000_000_000 });

  await watchdog.tick();

  const payload = notify.calls[0];
  assert.equal(payload.items[0].content, undefined, 'байты не должны попасть в структурированный payload');
  assert.equal(payload.items[0].exif_at, undefined, 'EXIF не должен попасть в структурированный payload');
  assert.doesNotMatch(payload.text, /SUPERSECRETBYTES/);
  assert.doesNotMatch(payload.text, /55\.7558/);
});

// ---------------------------------------------------------------------------
// Wiring / smoke
// ---------------------------------------------------------------------------

test('передаёт stuckAfterMs в listStuck как olderThanMs', async () => {
  const store = makeFakeStore([]);
  const notify = makeNotify();
  const stuckAfterMs = 123_456;
  const watchdog = createPhotoPublishWatchdog({ store, notify, stuckAfterMs, logger: silentLogger });

  await watchdog.tick();

  assert.equal(store.calls[0].olderThanMs, stuckAfterMs);
});

test('перекрывающиеся тики не запускают проверку дважды одновременно (guardedTick)', async () => {
  let resolveListStuck;
  const store = {
    async listStuck() {
      return new Promise((resolve) => { resolveListStuck = resolve; });
    }
  };
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({ store, notify, logger: silentLogger });

  const first = watchdog.tick();
  const second = await watchdog.tick();
  assert.deepEqual(second, { skipped: true }, 'второй тик, начавшийся пока первый ещё идёт, обязан пропустить себя');

  resolveListStuck([]);
  await first;
});

test('start()/stop() не бросают и идемпотентны', () => {
  const store = makeFakeStore([]);
  const notify = makeNotify();
  const watchdog = createPhotoPublishWatchdog({ store, notify, logger: silentLogger, intervalMs: 60_000 });

  assert.doesNotThrow(() => watchdog.start());
  assert.doesNotThrow(() => watchdog.start(), 'повторный start() — no-op, не должен пересоздавать таймер');
  assert.doesNotThrow(() => watchdog.stop());
  assert.doesNotThrow(() => watchdog.stop(), 'повторный stop() безопасен');
});

test('createPhotoPublishWatchdog требует store с listStuck', () => {
  assert.throws(() => createPhotoPublishWatchdog({ notify: async () => {} }));
});

test('createPhotoPublishWatchdog требует notify-функцию', () => {
  assert.throws(() => createPhotoPublishWatchdog({ store: makeFakeStore([]) }));
});
