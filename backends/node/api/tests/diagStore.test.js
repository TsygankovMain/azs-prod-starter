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

// Номер плейсхолдера LIMIT обязан совпадать с длиной params при любой
// комбинации фильтров — именно здесь живёт риск off-by-one.
const limitPlaceholder = (sql) => {
  const match = /LIMIT \$(\d+)/.exec(sql);
  return match ? Number(match[1]) : null;
};

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

test('deleteOlderThan удаляет старые строки, а не свежие', async () => {
  const pool = { _calls: [], async query(sql, params) { this._calls.push({ sql, params }); return { rows: [], rowCount: 3 }; } };
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  const removed = await store.deleteOlderThan(30);
  assert.equal(removed, 3);
  const call = pool._calls.at(-1);
  assert.match(call.sql, /DELETE FROM diag_report/);
  assert.match(call.sql, /created_at\s*<\s*NOW\(\)/, 'сравнение должно отсекать СТАРЫЕ строки');
  assert.ok(!/created_at\s*>/.test(call.sql), 'направление сравнения перевёрнуто');
  assert.deepEqual(call.params, ['30'], 'количество дней должно быть параметром, а не в тексте SQL');
});

test('deleteOlderThan не подставляет дни в текст SQL', async () => {
  const pool = { _calls: [], async query(sql, params) { this._calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.deleteOlderThan("7; DROP TABLE diag_report");
  const call = pool._calls.at(-1);
  assert.ok(!call.sql.includes('DROP'), 'значение просочилось в SQL');
});

test('list: плейсхолдер LIMIT совпадает с params при любых фильтрах', async () => {
  const combos = [
    {},
    { azsId: '548' },
    { dateFrom: '2026-07-01', dateTo: '2026-07-30' },
    { azsId: '548', dateFrom: '2026-07-01', dateTo: '2026-07-30' }
  ];
  for (const combo of combos) {
    const pool = makePgPool([{ id: 1 }]);
    const store = createDiagStore({ pool, dbType: 'postgresql' });
    await store.list({ ...combo, limit: 20 });
    const call = pool._calls.at(-1);
    assert.equal(
      limitPlaceholder(call.sql), call.params.length,
      `комбинация ${JSON.stringify(combo)}: LIMIT $${limitPlaceholder(call.sql)} против ${call.params.length} параметров`
    );
    assert.equal(call.params.at(-1), 20, `комбинация ${JSON.stringify(combo)}: limit должен быть последним параметром`);
  }
});

test('list без фильтров не строит WHERE', async () => {
  const pool = makePgPool([{ id: 1 }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.list({ limit: 5 });
  assert.ok(!/WHERE/.test(pool._calls.at(-1).sql), 'без фильтров WHERE не нужен');
});

test('list ограничивает limit сверху', async () => {
  const pool = makePgPool([{ id: 1 }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.list({ limit: 100000 });
  assert.ok(pool._calls.at(-1).params.at(-1) <= 200, 'limit должен быть ограничен');
});

test('getByCode передаёт код параметром и возвращает строку', async () => {
  const row = { id: 9, code: 'A7F3QQ', bundle: { v: 1 }, server_slice: null };
  const pool = makePgPool([row]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  const found = await store.getByCode('A7F3QQ');
  assert.deepEqual(found, row);
  const call = pool._calls.at(-1);
  assert.deepEqual(call.params, ['A7F3QQ'], 'код обязан быть параметром');
  assert.ok(!call.sql.includes('A7F3QQ'), 'код не должен попадать в текст SQL');
});

test('отсутствующий pool падает сразу, а не на первом запросе', () => {
  assert.throws(() => createDiagStore({ pool: null, dbType: 'postgresql' }), /pool is required/);
});

test('mysql не поддерживается и падает с внятной ошибкой', () => {
  assert.throws(
    () => createDiagStore({ pool: makePgPool(), dbType: 'mysql' }),
    /diagStore: only PostgreSQL is supported/
  );
});
