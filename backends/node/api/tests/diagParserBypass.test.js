import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createDiagRouter from '../src/diag/diagRoutes.js';
// Fix round (ревью, S2): раньше этот файл писал свою копию мидлвари обхода
// парсера — удаление или порча настоящей в server.js оставляла тест зелёным.
// Теперь импортируется тот же код, что использует server.js.
import { createJsonParserBypass } from '../src/diag/diagMiddleware.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Собирает приложение так же, как server.js: глобальные парсеры с обходом для
 * диаг-путей, затем роутер. Без этого 512 КБ и 1 МБ недостижимы — глобальный
 * express.json() с дефолтным потолком 100 КБ съест тело первым.
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
  return { app, store };
};

const call = async (server, path, init) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
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
