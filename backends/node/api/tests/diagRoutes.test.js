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

const startServer = (store) => {
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 498 }; next(); });
  app.use('/api/diag', createDiagRouter({
    store,
    randomBytes: () => Buffer.from([0, 1, 2, 3, 4, 5]),
    logger: silentLogger
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
