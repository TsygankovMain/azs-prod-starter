import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createDiagRouter from '../src/diag/diagRoutes.js';
// Fix round (ревью, S2): раньше этот файл писал свою копию мидлвари обхода
// парсера — удаление или порча настоящей в server.js оставляла тест зелёным.
// Теперь импортируется тот же код, что использует server.js.
// Fix round (ревью, live-run): то же самое — createDiagErrorHandler теперь
// импортируется отсюда же, а не переписывается в тестах, см. тесты внизу
// файла про битый JSON/лимит размера.
import { createJsonParserBypass, createDiagErrorHandler } from '../src/diag/diagMiddleware.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Собирает приложение так же, как server.js: глобальные парсеры с обходом для
 * диаг-путей, затем роутер, затем обработчик ошибок парсера. Без первого
 * 512 КБ и 1 МБ недостижимы — глобальный express.json() с дефолтным потолком
 * 100 КБ съест тело первым. Без второго ошибки express.json()/express.raw()
 * внутри роутера (битый JSON, тело сверх лимита) долетают до дефолтного
 * HTML-обработчика ошибок Express вместо JSON-контракта диагностики.
 */
const buildApp = () => {
  const app = express();
  app.use(createJsonParserBypass());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.user = { user_id: 498 }; next(); });
  const store = {
    inserted: [],
    async insert(row) { this.inserted.push(row); return { id: 1, code: row.code, created_at: new Date() }; },
    async getByCode() { return null; },
    async list() { return []; }
  };
  app.use('/api/diag', createDiagRouter({ store, logger: silentLogger }));
  app.use('/api/diag', createDiagErrorHandler());
  return { app, store };
};

const call = async (server, path, init) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') };
};

test('бандл на 300 КБ проходит сквозь глобальный парсер', async () => {
  const { app, store } = buildApp();
  const server = app.listen(0);
  try {
    const bundle = {
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: [],
      pad: 'x'.repeat(300 * 1024)
    };
    const body = JSON.stringify(bundle);
    assert.ok(body.length > 200 * 1024, `тело должно превышать дефолтный потолок 100 КБ, получено ${body.length}`);
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    // 300 КБ больше потолка бандла 256 КБ, поэтому ожидаем осмысленный отказ
    // санитизации, а НЕ 413 от глобального парсера.
    assert.notEqual(res.status, 413, 'глобальный парсер не должен перехватывать диаг-путь');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bundle_too_large');
  } finally { server.close(); }
});

test('бандл в пределах потолка сохраняется', async () => {
  const { app, store } = buildApp();
  const server = app.listen(0);
  try {
    const bundle = {
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: [],
      pad: 'x'.repeat(150 * 1024)
    };
    const body = JSON.stringify(bundle);
    assert.ok(body.length > 100 * 1024, 'тело должно превышать дефолтный потолок');
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    assert.equal(res.status, 200, `ожидался 200, получен ${res.status}`);
    assert.equal(store.inserted.length, 1);
  } finally { server.close(); }
});

test('echo получает сырые байты, а не разобранный JSON', async () => {
  const { app } = buildApp();
  const server = app.listen(0);
  try {
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.alloc(200 * 1024, 7)
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.bytes, 200 * 1024);
    assert.equal(res.json.buffered, true, 'echo обязан видеть Buffer, иначе замер врёт');
  } finally { server.close(); }
});

test('остальные маршруты по-прежнему разбираются глобальным парсером', async () => {
  const app = express();
  app.use(createJsonParserBypass());
  app.post('/api/other', (req, res) => res.json({ got: req.body?.a ?? null }));
  const server = app.listen(0);
  try {
    const res = await call(server, '/api/other', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 5 })
    });
    assert.equal(res.json.got, 5, 'обход не должен ломать обычные маршруты');
  } finally { server.close(); }
});

// --- Fix round (ревью, live-run на реальном сервере) ------------------------
//
// Живой прогон против настоящего Postgres нашёл дефект, который не поймал ни
// один тест: битый JSON в POST /api/diag/report возвращал HTML-страницу
// Express со стеком и абсолютными путями сервера, потому что express.json()
// бросает ДО обработчика маршрута — try/catch внутри diagRoutes.js этого не
// видит. NODE_ENV в проекте не задан, а это реальный деплой-дефолт, не
// dev-артефакт — значит и в проде такой ответ уходил бы оператору как есть.

test('POST /report: битый JSON — JSON-ответ без HTML и абсолютных путей, не отвечает стеком', async () => {
  const { app } = buildApp();
  const server = app.listen(0);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'не json вовсе'
    });
    assert.equal(res.status, 400);
    assert.match(res.contentType || '', /^application\/json/, `content-type: ${res.contentType}`);
    assert.ok(res.json, `ответ должен парситься как JSON: ${res.text}`);
    assert.equal(res.json.error, 'invalid_request_body');
    assert.ok(!res.text.includes('<!DOCTYPE'), `HTML-страница вместо JSON: ${res.text}`);
    assert.ok(!res.text.includes('node_modules'), `путь до node_modules утёк в ответ: ${res.text}`);
    assert.ok(!/\/Users\/|\/home\/[a-z0-9_-]+\/|[A-Za-z]:\\/i.test(res.text), `абсолютный путь утёк в ответ: ${res.text}`);
  } finally { server.close(); }
});

test('POST /report: тело сверх лимита 512 КБ — JSON, не HTML (тот же класс дефекта, другой источник — лимит, а не синтаксис)', async () => {
  const { app } = buildApp();
  const server = app.listen(0);
  try {
    const body = JSON.stringify({
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: [],
      pad: 'x'.repeat(700 * 1024) // заведомо больше лимита DIAG_JSON_LIMIT=512kb
    });
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    assert.equal(res.status, 413);
    assert.match(res.contentType || '', /^application\/json/, `content-type: ${res.contentType}`);
    assert.ok(res.json, `ответ должен парситься как JSON: ${res.text}`);
    assert.equal(res.json.error, 'payload_too_large');
    assert.ok(!res.text.includes('<!DOCTYPE'), `HTML-страница вместо JSON: ${res.text}`);
  } finally { server.close(); }
});

test('POST /report: валидный бандл всё ещё проходит — обработчик ошибок не перехватывает штатный путь', async () => {
  const { app, store } = buildApp();
  const server = app.listen(0);
  try {
    const bundle = {
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: []
    };
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle)
    });
    assert.equal(res.status, 200, `ожидался 200, получен ${res.status}: ${res.text}`);
    assert.equal(typeof res.json.code, 'string');
    assert.equal(store.inserted.length, 1);
  } finally { server.close(); }
});
