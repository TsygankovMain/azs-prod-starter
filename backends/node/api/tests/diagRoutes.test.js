import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDiagRouter } from '../src/diag/diagRoutes.js';

const silentLogger = { info() {}, warn() {}, error() {} };

const makeStore = () => ({
  inserted: [],
  async insert(row) { this.inserted.push(row); return { id: 1, code: row.code, created_at: new Date() }; },
  async getByCode(code) { return code === 'A7F3QQ' ? { id: 1, code, bundle: { v: 1 } } : null; },
  async list() { return [{ id: 1, code: 'A7F3QQ' }]; }
});

// Fix round (ревью, BLOCKING 2): req.accessContext раньше нигде не
// проставлялся в этом тестовом стенде — прод-мидлварь attachAccessContext
// сюда не подключена. По умолчанию выдаём admin-доступ (полные
// capabilities), чтобы существующие тесты ниже (которые проверяют не
// авторизацию, а поведение самих роутов) не различали поведение до и после
// гейта. Тесты самого гейта переопределяют accessContext через overrides.
const ADMIN_ACCESS_CONTEXT = { role: 'admin', capabilities: { settings: true, reviewer: true, reports: true }, access: {} };

const startServer = (store, overrides = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { user_id: 498 };
    req.accessContext = 'accessContext' in overrides ? overrides.accessContext : ADMIN_ACCESS_CONTEXT;
    next();
  });
  app.use('/api/diag', createDiagRouter({
    store,
    randomBytes: overrides.randomBytes || (() => Buffer.from([0, 1, 2, 3, 4, 5])),
    logger: silentLogger,
    serverSelfCheck: overrides.serverSelfCheck ?? null,
    chatNotifier: overrides.chatNotifier ?? null
  }));
  return app.listen(0);
};

const call = async (server, path, init = {}) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON — оставляем null */ }
  return { status: res.status, json, text };
};

const validBundle = () => ({
  v: 1, trigger: 'button', diagSessionId: 'sess-1',
  user: { userId: 498, azsId: '548', reportId: 12345 },
  net: [], uploads: [], errors: [], b24: []
});

test('GET /ping отдаёт метку времени и не трогает стор', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/ping');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.t, 'number');
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /echo считает принятые байты и не пишет в стор', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const body = Buffer.alloc(4096, 7);
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.bytes, 4096);
    assert.equal(typeof res.json.serverMs, 'number');
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /report сохраняет бандл и возвращает код', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.code, 'ABCDEF');
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].azsId, '548');
    assert.equal(store.inserted[0].trigger, 'button');
  } finally { server.close(); }
});

test('POST /report отклоняет неизвестную версию с 400', async () => {
  const server = startServer(makeStore());
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBundle(), v: 99 })
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /unsupported_bundle_version/);
  } finally { server.close(); }
});

test('POST /report отвечает 413 на тело сверх лимита', async () => {
  const server = startServer(makeStore());
  try {
    const huge = JSON.stringify({ ...validBundle(), pad: 'x'.repeat(600 * 1024) });
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge
    });
    assert.equal(res.status, 413);
  } finally { server.close(); }
});

test('POST /report: падение стора не отдаёт 500 наружу как краш', async () => {
  const store = makeStore();
  store.insert = async () => { throw new Error('db down'); };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /diag_report_failed/);
  } finally { server.close(); }
});

test('GET /reports/:code отдаёт 404 на неизвестный код', async () => {
  const server = startServer(makeStore());
  try {
    assert.equal((await call(server, '/api/diag/reports/NOPE00')).status, 404);
    assert.equal((await call(server, '/api/diag/reports/A7F3QQ')).status, 200);
  } finally { server.close(); }
});

// --- Fix round 1 (ревью: 5 реальных дефектов из 6 найденных, 1 отклонён) ---

test('POST /report: serverSelfCheck.run() успешен — serverSlice уходит в стор', async () => {
  const store = makeStore();
  const serverSelfCheck = { async run() { return { diskPing: 12, dbPing: 3 }; } };
  const server = startServer(store, { serverSelfCheck });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(store.inserted.length, 1);
    assert.deepEqual(store.inserted[0].serverSlice, { diskPing: 12, dbPing: 3 });
  } finally { server.close(); }
});

test('POST /report: serverSelfCheck.run() падает — бандл всё равно сохраняется, serverSlice = null', async () => {
  const store = makeStore();
  const serverSelfCheck = { async run() { throw new Error('disk unreachable'); } };
  const server = startServer(store, { serverSelfCheck });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].serverSlice, null);
  } finally { server.close(); }
});

test('GET /reports передаёт фильтры в store.list и отдаёт items как есть', async () => {
  const store = makeStore();
  let receivedArgs = null;
  store.list = async (args) => { receivedArgs = args; return [{ id: 1, code: 'A7F3QQ' }]; };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/reports?azsId=548&dateFrom=2026-07-01&dateTo=2026-07-30&limit=10');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, [{ id: 1, code: 'A7F3QQ' }]);
    assert.deepEqual(receivedArgs, { azsId: '548', dateFrom: '2026-07-01', dateTo: '2026-07-30', limit: 10 });
  } finally { server.close(); }
});

test('POST /report: несериализуемый toString в headers/errors не роняет обработчик — редактируется и сохраняется', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const bundle = {
      ...validBundle(),
      net: [{ url: '/x', headers: { 'x-custom': { toString: 'pwned' } } }],
      errors: [{ kind: 'onerror', message: { toString: 'pwned' } }]
    };
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.code, 'string');
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].bundle.net[0].headers['x-custom'], '[unserializable]');
    assert.equal(store.inserted[0].bundle.errors[0].message, '[unserializable]');
  } finally { server.close(); }
});

test('POST /report: несериализуемый toString в net[].url тоже не роняет обработчик (fix round 2: redactUrl тоже безопасен)', async () => {
  // До fix round 2 этот же bundle приводил к 400 diag_bundle_unprocessable —
  // redactUrl ещё бросал TypeError, и ловил его только внешний try/catch
  // роутера. Теперь redactUrl тоже проходит через toSafeString и не бросает
  // вовсе, поэтому запрос успешен, как и для headers/errors.
  const store = makeStore();
  const server = startServer(store);
  try {
    const bundle = { ...validBundle(), net: [{ url: { toString: 'pwned' }, headers: {} }] };
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.code, 'string');
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].bundle.net[0].url, '[unserializable]');
  } finally { server.close(); }
});

test('POST /report: внешний try/catch — если sanitizeBundle или generateDiagCode всё же бросят, роутер отдаёт 400, не HTML-крах', async () => {
  // Все три функции редакции теперь безопасны (toSafeString на обоих слоях),
  // поэтому реального враждебного bundle, роняющего sanitizeBundle, больше
  // нет. Но try/catch в /report оборачивает ещё и generateDiagCode(randomBytes(6))
  // — это законный, не выдуманный способ реально дойти до того же catch и
  // убедиться, что он всё ещё работает как защита от неизвестных будущих сбоев.
  const store = makeStore();
  const throwingRandomBytes = () => { throw new Error('entropy source unavailable'); };
  const server = startServer(store, { randomBytes: throwingRandomBytes });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 400);
    assert.ok(res.json, 'ответ должен быть JSON, а не HTML-страницей краша Express');
    assert.equal(res.json.error, 'diag_bundle_unprocessable');
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /echo: без Content-Type тело не парсится в Buffer — берём Content-Length, не отвечаем нулём', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      body: new Uint8Array(4096)
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.buffered, false);
    assert.equal(res.json.bytes, 4096);
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /report: 500 не отдаёт message клиенту, только стабильный код ошибки', async () => {
  const store = makeStore();
  store.insert = async () => { throw new Error('db down with sensitive connection string'); };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'diag_report_failed');
    assert.equal(res.json.message, undefined);
  } finally { server.close(); }
});

test('GET /reports: 500 не отдаёт message клиенту', async () => {
  const store = makeStore();
  store.list = async () => { throw new Error('relation "diag_report" does not exist'); };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/reports');
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'diag_list_failed');
    assert.equal(res.json.message, undefined);
  } finally { server.close(); }
});

test('GET /reports/:code: 500 не отдаёт message клиенту', async () => {
  const store = makeStore();
  store.getByCode = async () => { throw new Error('connection terminated unexpectedly'); };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/reports/A7F3QQ');
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'diag_get_failed');
    assert.equal(res.json.message, undefined);
  } finally { server.close(); }
});

test('POST /report: коллизия кода — повтор со свежим кодом до успеха', async () => {
  const store = makeStore();
  let insertCalls = 0;
  store.insert = async (row) => {
    insertCalls += 1;
    if (insertCalls === 1) {
      throw new Error('duplicate key value violates unique constraint "diag_report_code_key"');
    }
    store.inserted.push(row);
    return { id: 1, code: row.code, created_at: new Date() };
  };
  let randomCalls = 0;
  const randomBytes = () => {
    randomCalls += 1;
    return randomCalls === 1 ? Buffer.from([0, 1, 2, 3, 4, 5]) : Buffer.from([6, 7, 8, 9, 10, 11]);
  };
  const server = startServer(store, { randomBytes });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(insertCalls, 2);
    assert.notEqual(res.json.code, 'ABCDEF');
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].code, res.json.code);
  } finally { server.close(); }
});

test('POST /report: коллизии кода исчерпаны за 3 попытки — 500 без message', async () => {
  const store = makeStore();
  let insertCalls = 0;
  store.insert = async () => {
    insertCalls += 1;
    throw new Error('duplicate key value violates unique constraint "diag_report_code_key"');
  };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 500);
    assert.equal(insertCalls, 3);
    assert.equal(res.json.error, 'diag_report_failed');
    assert.equal(res.json.message, undefined);
  } finally { server.close(); }
});

// --- Fix round (ревью, BLOCKING 2) ------------------------------------------
//
// GET /reports и GET /reports/:code не проверяли ничего, кроме валидного
// JWT: обычный оператор станции мог перечислить диагностики всех станций и
// прочитать любой бандл целиком (device, тексты ошибок, сетевой лог,
// серверный срез — домен портала, member id, наличие OAuth-токена). Гейт
// добавлен внутри самого роутера (см. diagRoutes.js), а не на уровне
// server.js:683, потому что там же монтируется и POST /report, который
// обязан остаться доступен обычному оператору без capabilities.settings.

const OPERATOR_ACCESS_CONTEXT = { role: 'azs_admin', capabilities: { settings: false, reviewer: false, reports: true }, access: {} };

test('GET /reports: оператор без capabilities.settings получает 403, не список', async () => {
  const store = makeStore();
  const server = startServer(store, { accessContext: OPERATOR_ACCESS_CONTEXT });
  try {
    const res = await call(server, '/api/diag/reports');
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');
  } finally { server.close(); }
});

test('GET /reports/:code: оператор без capabilities.settings получает 403, не бандл', async () => {
  const server = startServer(makeStore(), { accessContext: OPERATOR_ACCESS_CONTEXT });
  try {
    const res = await call(server, '/api/diag/reports/A7F3QQ');
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');
  } finally { server.close(); }
});

test('GET /reports: пользователь с capabilities.settings получает 200', async () => {
  const server = startServer(makeStore(), { accessContext: ADMIN_ACCESS_CONTEXT });
  try {
    const res = await call(server, '/api/diag/reports');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, [{ id: 1, code: 'A7F3QQ' }]);
  } finally { server.close(); }
});

test('GET /reports/:code: пользователь с capabilities.settings получает 200', async () => {
  const server = startServer(makeStore(), { accessContext: ADMIN_ACCESS_CONTEXT });
  try {
    const res = await call(server, '/api/diag/reports/A7F3QQ');
    assert.equal(res.status, 200);
    assert.equal(res.json.item.code, 'A7F3QQ');
  } finally { server.close(); }
});

test('GET /reports: отсутствующий accessContext (attachAccessContext не сработал) — тоже 403, не крах', async () => {
  const server = startServer(makeStore(), { accessContext: null });
  try {
    const res = await call(server, '/api/diag/reports');
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('POST /report: гейт read-роутов не задевает запись — оператор без capabilities.settings всё ещё может сдать бандл', async () => {
  const store = makeStore();
  const server = startServer(store, { accessContext: OPERATOR_ACCESS_CONTEXT });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(store.inserted.length, 1);
  } finally { server.close(); }
});

// --- Task 12: пост в дежурный чат — best-effort, не должен трогать ответ ---

test('POST /report: chatNotifier.notify() отклоняется — ответ всё равно 200 с кодом, бандл всё равно сохранён', async () => {
  const store = makeStore();
  const chatNotifier = { notify: async () => { throw new Error('bitrix down'); } };
  const server = startServer(store, { chatNotifier });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.code, 'string');
    assert.equal(store.inserted.length, 1, 'bundle must still be stored despite the notifier throwing');
    assert.equal(store.inserted[0].azsId, '548');
  } finally { server.close(); }
});

test('POST /report: отклонённый notify() не всплывает unhandledRejection и не меняет тело ответа', async () => {
  const store = makeStore();
  let rejectionSeen = false;
  const onUnhandledRejection = () => { rejectionSeen = true; };
  process.on('unhandledRejection', onUnhandledRejection);

  const chatNotifier = { notify: async () => { throw new Error('bitrix down'); } };
  const server = startServer(store, { chatNotifier });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.deepEqual(Object.keys(res.json).sort(), ['code', 'diagId']);
    // Дать микрозадачам/catch() дозавершиться, прежде чем проверять флаг.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rejectionSeen, false, 'diagRoutes.js обязан гасить отказ notify() своим .catch()');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});

test('POST /report: notify() не блокирует ответ — HTTP-ответ уходит раньше, чем notifier завершает свою работу', async () => {
  const store = makeStore();
  let notifyResolved = false;
  const notifyCalls = [];
  const chatNotifier = {
    notify: async (args) => {
      notifyCalls.push(args);
      // Никогда не резолвится сама в рамках теста — если бы роутер ждал
      // этот промис, запрос ниже завис бы и упал по гонке с таймаутом.
      await new Promise(() => {});
      notifyResolved = true; // unreachable, здесь только для ясности намерения
    }
  };
  const server = startServer(store, { chatNotifier });
  try {
    const res = await Promise.race([
      call(server, '/api/diag/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBundle())
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('response blocked on chatNotifier.notify()')), 500))
    ]);
    assert.equal(res.status, 200);
    assert.equal(store.inserted.length, 1);
    assert.equal(notifyCalls.length, 1, 'notifier must still have been invoked');
    assert.equal(notifyResolved, false, 'sanity: the never-resolving promise really never resolved');
  } finally { server.close(); }
});

test('POST /report: chatNotifier.notify получает ровно тот code/bundle/serverSlice, что были сохранены', async () => {
  const store = makeStore();
  const serverSelfCheck = { async run() { return { disk: { ok: true }, oauth: { hasContext: true } }; } };
  const notifyCalls = [];
  const chatNotifier = { notify: async (args) => { notifyCalls.push(args); } };
  const server = startServer(store, { chatNotifier, serverSelfCheck });
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].code, res.json.code);
    assert.deepEqual(notifyCalls[0].bundle, store.inserted[0].bundle);
    assert.deepEqual(notifyCalls[0].serverSlice, store.inserted[0].serverSlice);
  } finally { server.close(); }
});

test('POST /report: chatNotifier отсутствует (null, как раньше) — запись и ответ работают без него', async () => {
  const store = makeStore();
  const server = startServer(store); // no chatNotifier override → null, как в остальных тестах файла
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(store.inserted.length, 1);
  } finally { server.close(); }
});
