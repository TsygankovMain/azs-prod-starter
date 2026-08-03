import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsStore } from '../src/reports/reportsStore.js';

// report_local_state — Task 2 создал таблицу (report_id, operator_completed_at,
// required_photo_codes, created_at, updated_at), но методов доступа к ней не
// было. Эти два метода нужны Task 5: приём фото (POST /:id/photo) читает
// required_photo_codes ЛОКАЛЬНО (без единого вызова Битрикса) — это первый и
// самый частый из трёх уровней; GET /:id его заполняет, когда список получен
// живым Битриксом.
//
// ЛОВУШКА СХЕМЫ (предупреждение ревью): report_local_state.updated_at
// обновляется автоматически ТОЛЬКО в MySQL (ON UPDATE CURRENT_TIMESTAMP), в
// PostgreSQL триггера нет. Каждый тест на запись ниже проверяет, что SQL
// явно проставляет updated_at — не полагаясь на то, что «и так обновится».

const makeFakePool = (responses = []) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return responses[i++] ?? { rows: [], rowCount: 0 };
    }
  };
};

const makeFakeMysqlPool = (responses = []) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return responses[i++] ?? [[]];
    }
  };
};

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

test('PostgreSQL: setRequiredPhotoCodes — upsert по report_id, явный updated_at = NOW()', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.setRequiredPhotoCodes({ reportId: 501, codes: ['42', '43'] });

  assert.equal(pool.calls.length, 1, 'один upsert, не отдельные INSERT/UPDATE');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO report_local_state/);
  assert.match(sql, /ON CONFLICT\s*\(report_id\)\s*DO UPDATE/);
  assert.match(sql, /updated_at = NOW\(\)/,
    'PostgreSQL не имеет ON UPDATE CURRENT_TIMESTAMP — без явного NOW() поле тихо перестанет обновляться в проде');
  assert.equal(params[0], 501);
  assert.deepEqual(JSON.parse(params[1]), ['42', '43']);
});

test('PostgreSQL: setRequiredPhotoCodes сериализует коды строками (число -> "число")', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.setRequiredPhotoCodes({ reportId: 501, codes: [42, 43] });
  const parsed = JSON.parse(pool.calls[0].params[1]);
  assert.deepEqual(parsed, ['42', '43'], 'коды из кэша приходят числами (photoTypeIds), из БД — строками; формат хранения обязан быть единым');
});

test('PostgreSQL: getRequiredPhotoCodes парсит JSON и возвращает массив кодов строками', async () => {
  const pool = makeFakePool([{ rows: [{ required_photo_codes: '["42","43"]' }] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const codes = await store.getRequiredPhotoCodes(501);
  assert.deepEqual(codes, ['42', '43']);
  assert.match(pool.calls[0].sql, /SELECT required_photo_codes FROM report_local_state WHERE report_id = \$1/);
});

test('PostgreSQL: getRequiredPhotoCodes возвращает null, когда строки ещё нет', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const codes = await store.getRequiredPhotoCodes(999);
  assert.equal(codes, null, 'колонка не заполнена — приём фото обязан упасть на следующий уровень (кэш), а не на ошибку');
});

test('PostgreSQL: getRequiredPhotoCodes возвращает null, когда required_photo_codes = NULL', async () => {
  const pool = makeFakePool([{ rows: [{ required_photo_codes: null }] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const codes = await store.getRequiredPhotoCodes(501);
  assert.equal(codes, null);
});

// ---------------------------------------------------------------------------
// setOperatorCompletedAt — Task 8 (чинит CRITICAL Task 5: POST /:id/submit
// проставляет момент, когда ОПЕРАТОР закончил, а не когда фото доехали до
// Битрикса). Тот же upsert-приём и та же ЛОВУШКА СХЕМЫ, что и у
// setRequiredPhotoCodes выше — updated_at в PostgreSQL не обновляется сам.
// ---------------------------------------------------------------------------

test('PostgreSQL: setOperatorCompletedAt — upsert по report_id, явный updated_at = NOW()', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const at = new Date('2026-08-03T09:59:00.000Z');
  await store.setOperatorCompletedAt({ reportId: 501, at });

  assert.equal(pool.calls.length, 1, 'один upsert, не отдельные INSERT/UPDATE');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO report_local_state/);
  assert.match(sql, /operator_completed_at/);
  assert.match(sql, /ON CONFLICT\s*\(report_id\)\s*DO UPDATE/);
  assert.match(sql, /updated_at = NOW\(\)/,
    'PostgreSQL не имеет ON UPDATE CURRENT_TIMESTAMP — без явного NOW() поле тихо перестанет обновляться в проде');
  assert.equal(params[0], 501);
  assert.equal(params[1].toISOString(), at.toISOString());
});

test('PostgreSQL: setOperatorCompletedAt принимает не-Date значение и приводит его к Date', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.setOperatorCompletedAt({ reportId: 501, at: '2026-08-03T09:59:00.000Z' });
  const { params } = pool.calls[0];
  assert.ok(params[1] instanceof Date);
  assert.equal(params[1].toISOString(), '2026-08-03T09:59:00.000Z');
});

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

test('MySQL: setRequiredPhotoCodes — upsert по report_id, явный updated_at = CURRENT_TIMESTAMP', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 1 }]]);
  const store = createReportsStore({ pool, dbType: 'mysql' });
  await store.setRequiredPhotoCodes({ reportId: 501, codes: ['42', '43'] });

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO report_local_state/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql, /updated_at = CURRENT_TIMESTAMP/,
    'MySQL обновляет updated_at и через триггер, но код не должен молчаливо полагаться на асимметрию движков');
  assert.equal(params[0], 501);
  assert.deepEqual(JSON.parse(params[1]), ['42', '43']);
});

test('MySQL: getRequiredPhotoCodes парсит JSON и возвращает массив кодов строками', async () => {
  const pool = makeFakeMysqlPool([[[{ required_photo_codes: '["7","8"]' }]]]);
  const store = createReportsStore({ pool, dbType: 'mysql' });
  const codes = await store.getRequiredPhotoCodes(10);
  assert.deepEqual(codes, ['7', '8']);
  assert.match(pool.calls[0].sql, /SELECT required_photo_codes FROM report_local_state WHERE report_id = \?/);
});

test('MySQL: getRequiredPhotoCodes возвращает null, когда строки ещё нет', async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createReportsStore({ pool, dbType: 'mysql' });
  const codes = await store.getRequiredPhotoCodes(11);
  assert.equal(codes, null);
});

test('MySQL: setOperatorCompletedAt — upsert по report_id, явный updated_at = CURRENT_TIMESTAMP', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 1 }]]);
  const store = createReportsStore({ pool, dbType: 'mysql' });
  const at = new Date('2026-08-03T09:59:00.000Z');
  await store.setOperatorCompletedAt({ reportId: 501, at });

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO report_local_state/);
  assert.match(sql, /operator_completed_at/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql, /updated_at = CURRENT_TIMESTAMP/,
    'MySQL обновляет updated_at и через триггер, но код не должен молчаливо полагаться на асимметрию движков');
  assert.equal(params[0], 501);
  assert.equal(params[1], '2026-08-03 09:59:00');
});
