import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagStore } from '../src/diag/diagStore.js';

const makePgPool = (rows = []) => ({
  _calls: [],
  async query(sql, params) {
    this._calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  }
});

test('ensureSchema создаёт таблицу и индексы идемпотентно', async () => {
  const pool = makePgPool();
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const sql = pool._calls.map((c) => c.sql).join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS diag_report/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  assert.match(sql, /code TEXT NOT NULL/);
});

test('insert передаёт бандл как параметр, а не склеивает в SQL', async () => {
  const pool = makePgPool([{ id: 1, code: 'A7F3QQ' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  const row = await store.insert({
    code: 'A7F3QQ',
    diagSessionId: 'sess-1',
    userId: 498,
    azsId: '548',
    reportId: 12345,
    trigger: 'button',
    sizeBytes: 2048,
    bundle: { v: 1, note: "it's fine" }
  });
  assert.equal(row.code, 'A7F3QQ');
  const call = pool._calls.at(-1);
  assert.match(call.sql, /INSERT INTO diag_report/);
  assert.equal(call.params[0], 'A7F3QQ');
  assert.equal(call.params[7], JSON.stringify({ v: 1, note: "it's fine" }));
});

test('insert кладёт серверный срез отдельной колонкой', async () => {
  const pool = makePgPool([{ id: 1, code: 'A7F3QQ' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.insert({
    code: 'A7F3QQ', diagSessionId: 's', userId: 1, azsId: '548', reportId: 1,
    trigger: 'button', sizeBytes: 10, bundle: { v: 1 },
    serverSlice: { oauth: { hasContext: true }, disk: { ok: false } }
  });
  const call = pool._calls.at(-1);
  assert.match(call.sql, /server_slice/);
  assert.equal(call.params[8], JSON.stringify({ oauth: { hasContext: true }, disk: { ok: false } }));
});

test('insert без серверного среза кладёт NULL', async () => {
  const pool = makePgPool([{ id: 1, code: 'B' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.insert({
    code: 'B', diagSessionId: 's', userId: 1, azsId: '548', reportId: 1,
    trigger: 'button', sizeBytes: 10, bundle: { v: 1 }
  });
  assert.equal(pool._calls.at(-1).params[8], null);
});

test('getByCode возвращает null, когда ничего не найдено', async () => {
  const store = createDiagStore({ pool: makePgPool([]), dbType: 'postgresql' });
  assert.equal(await store.getByCode('NOPE00'), null);
});

test('list не тянет поле bundle и ограничивает выборку', async () => {
  const pool = makePgPool([{ id: 1 }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.list({ azsId: '548', dateFrom: '2026-07-01', dateTo: '2026-07-30', limit: 20 });
  const call = pool._calls.at(-1);
  assert.ok(!/SELECT \*/.test(call.sql), 'list не должен делать SELECT *');
  assert.ok(!/\bbundle\b/.test(call.sql), 'list не должен выбирать bundle');
  assert.match(call.sql, /LIMIT/);
  assert.ok(call.params.includes('548'));
});

test('deleteOlderThan возвращает число удалённых', async () => {
  const pool = {
    async query() { return { rows: [], rowCount: 7 }; }
  };
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  assert.equal(await store.deleteOlderThan(30), 7);
});

test('mysql не поддерживается и падает с внятной ошибкой', () => {
  assert.throws(
    () => createDiagStore({ pool: makePgPool(), dbType: 'mysql' }),
    /diagStore: only PostgreSQL is supported/
  );
});
