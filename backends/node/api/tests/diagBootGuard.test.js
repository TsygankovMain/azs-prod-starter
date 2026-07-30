import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDiagStore } from '../src/diag/diagStore.js';
// Fix round (ревью, S2): раньше этот файл писал свою копию 503-фолбэка —
// удаление или порча настоящего в server.js оставляла тест зелёным. Теперь
// импортируется тот же код, что использует server.js.
import { createDiagUnavailableHandler } from '../src/diag/diagMiddleware.js';

test('createDiagStore отвергает не-PostgreSQL', () => {
  assert.throws(() => createDiagStore({ pool: { query() {} }, dbType: 'mysql' }), /only PostgreSQL/);
});

test('отказ стора не должен ронять старт: try/catch отдаёт null', () => {
  // Повторяет форму защиты из server.js: приложение обязано подняться,
  // потеряв диагностику, а не упасть целиком.
  let diagStore = null;
  let logged = null;
  try {
    diagStore = createDiagStore({ pool: { query() {} }, dbType: 'mysql' });
  } catch (error) {
    logged = error.message;
  }
  assert.equal(diagStore, null);
  assert.match(logged, /only PostgreSQL/);
});

test('на PostgreSQL стор создаётся нормально', () => {
  const store = createDiagStore({ pool: { query() {} }, dbType: 'postgresql' });
  assert.equal(typeof store.ensureSchema, 'function');
  assert.equal(typeof store.insert, 'function');
});

// --- Fallback на диагностику, когда diagStore === null --------------------
//
// Без него /api/diag/* на неподдерживаемой СУБД проваливается сквозь все
// app.use() и падает на голый Express-404: text/html с телом
// «<pre>Cannot GET /api/diag/ping</pre>». Остальное приложение всегда отвечает
// JSON-ошибкой ({"error": "..."}), поэтому фронтенд, вызывающий res.json() на
// таком ответе, ловит SyntaxError — оператор видит сбой, а не понятный отказ.

const startBareApp = () => {
  // Ничего не смонтировано на /api/diag — воспроизводит поведение Express до
  // фикса, когда diagStore === null и роутер не подключён вовсе.
  const app = express();
  return app.listen(0);
};

const startGuardedApp = () => {
  const app = express();
  const diagStore = null;
  // Тот же код, что и в server.js (createDiagUnavailableHandler,
  // src/diag/diagMiddleware.js): монтируется ПОСЛЕ условного реального
  // монтирования и срабатывает только когда diagStore === null.
  if (!diagStore) {
    app.use('/api/diag', createDiagUnavailableHandler());
  }
  return app.listen(0);
};

const get = async (server, path) => {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`);
};

test('без fallback-мидлвари голый Express отвечает HTML-404 (воспроизводит баг)', async () => {
  const server = startBareApp();
  try {
    const res = await get(server, '/api/diag/ping');
    assert.equal(res.status, 404);
    assert.match(String(res.headers.get('content-type')), /html/);
    const text = await res.text();
    assert.match(text, /<pre>/);
  } finally {
    server.close();
  }
});

test('diagStore === null: /api/diag/* отвечает 503 в JSON-контракте приложения, не HTML', async () => {
  const server = startGuardedApp();
  try {
    const res = await get(server, '/api/diag/ping');
    assert.equal(res.status, 503);
    assert.match(String(res.headers.get('content-type')), /application\/json/);
    const text = await res.text();
    assert.ok(!text.includes('<pre>'), text);
    const body = JSON.parse(text);
    assert.deepEqual(body, { error: 'diag_unavailable' });
  } finally {
    server.close();
  }
});

test('diagStore === null: fallback накрывает весь префикс /api/diag, а не один путь', async () => {
  const server = startGuardedApp();
  try {
    const res = await get(server, '/api/diag/reports/A7F3QQ');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'diag_unavailable' });
  } finally {
    server.close();
  }
});
