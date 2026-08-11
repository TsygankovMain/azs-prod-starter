/**
 * Экран оператора «мои отчёты» показывал строки напоминаний.
 *
 * Исполнитель напоминаний резервирует строку в dispatch_log перед отправкой
 * (dispatchScheduler.js), но её статус потом не меняет — она навсегда остаётся
 * 'reserved', без report_item_id и без дедлайна. Такие строки попадали в
 * listActiveByAdminUserId и накапливались: на проде 339 штук на 70 АЗС.
 * Фронт берёт первый элемент списка и сразу открывает его (index.client.vue),
 * поэтому оператор попадал на отчёт, в который нечего загружать.
 *
 * Второй симптом: просроченный отчёт исчезал с экрана совсем — статуса
 * 'expired' не было в выборке. Зашедший после дедлайна оператор не видел
 * ничего, кроме тех самых пустышек.
 *
 * Здесь проверяется SQL, который store отдаёт в пул: строки напоминаний
 * отфильтрованы, свежий просроченный отчёт показывается и стоит в очереди
 * после активных.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsStore } from '../src/reports/reportsStore.js';

// Пул, запоминающий последний SQL и параметры
function spyPool(rows = []) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve({ rows });
    },
    execute(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve([rows]);
    }
  };
}

const lastSql = (pool) => pool.calls.at(-1).sql;

test('postgres: строки напоминаний исключены из активных отчётов оператора', async () => {
  const pool = spyPool();
  const store = createReportsStore({ pool, dbType: 'postgres' });

  await store.listActiveByAdminUserId({ adminUserId: 238 });

  assert.match(
    lastSql(pool),
    /slot_key NOT LIKE/,
    'выборка должна отсекать slot_key вида %:reminder:%'
  );
});

test('postgres: просроченный отчёт показывается оператору', async () => {
  const pool = spyPool();
  const store = createReportsStore({ pool, dbType: 'postgres' });

  await store.listActiveByAdminUserId({ adminUserId: 238 });

  assert.match(lastSql(pool), /'expired'/, "статус 'expired' должен попадать в выборку");
});

test('postgres: просроченный отчёт стоит после активных', async () => {
  const pool = spyPool();
  const store = createReportsStore({ pool, dbType: 'postgres' });

  await store.listActiveByAdminUserId({ adminUserId: 238 });

  const sql = lastSql(pool);
  const orderBy = sql.slice(sql.indexOf('ORDER BY'));
  const weight = (status) => {
    const m = orderBy.match(new RegExp(`WHEN '${status}' THEN (\\d+)`));
    return m ? Number(m[1]) : null;
  };

  assert.ok(weight('expired') !== null, "'expired' должен участвовать в сортировке");
  assert.ok(
    weight('expired') > weight('new') && weight('expired') > weight('in_progress'),
    'просроченный отчёт не должен опережать активный — фронт открывает первый элемент'
  );
});

test('postgres: показывается только свежий просроченный, не вся история', async () => {
  const pool = spyPool();
  const store = createReportsStore({ pool, dbType: 'postgres' });

  await store.listActiveByAdminUserId({ adminUserId: 238 });

  assert.match(
    lastSql(pool),
    /deadline_at\s*>\s*NOW\(\)\s*-\s*INTERVAL/i,
    'выборка просроченных должна быть ограничена по дедлайну, иначе накопится история за недели'
  );
});

test('mysql: строки напоминаний исключены и просроченный показывается', async () => {
  const pool = spyPool();
  const store = createReportsStore({ pool, dbType: 'mysql' });

  await store.listActiveByAdminUserId({ adminUserId: 238 });

  const sql = lastSql(pool);
  assert.match(sql, /slot_key NOT LIKE/, 'mysql-ветка должна отсекать напоминания');
  assert.match(sql, /'expired'/, 'mysql-ветка должна показывать просроченный отчёт');
});
