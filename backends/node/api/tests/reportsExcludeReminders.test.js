import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsStore } from '../src/reports/analyticsStore.js';
import { createReportsStore } from '../src/reports/reportsStore.js';

// Служебные строки напоминаний режима B лежат в dispatch_log рядом с заданиями.
// Отчёты не должны их считать: иначе на 69 АЗС в сводке выходило «из 137».

const REMINDER_FILTER = "slot_key NOT LIKE '%:reminder:%'";

// Пул, который запоминает SQL и отдаёт строки по подстроке запроса.
const recordingPool = (dbType, rowsByPattern = []) => {
  const seen = [];
  const answer = (sql) => {
    seen.push(sql);
    for (const [pattern, rows] of rowsByPattern) {
      if (sql.includes(pattern)) return rows;
    }
    return [];
  };
  const pool = dbType === 'mysql'
    ? { execute: async (sql) => [answer(sql)] }
    : { query: async (sql) => ({ rows: answer(sql) }) };
  return { pool, seen };
};

for (const dbType of ['postgres', 'mysql']) {
  test(`${dbType}: рейтинг и динамика не считают напоминания и отменённые задания`, async () => {
    const { pool, seen } = recordingPool(dbType);
    const store = createAnalyticsStore({ pool, dbType });
    await store.getRating({ dateFrom: '2026-09-29', dateTo: '2026-09-29' });
    await store.getTrend({});
    assert.equal(seen.length, 2);
    for (const sql of seen) {
      assert.ok(sql.includes(REMINDER_FILTER), sql);
      assert.ok(sql.includes("status <> 'cancelled'"), sql);
    }
  });

  test(`${dbType}: список отчётов не показывает напоминания`, async () => {
    const { pool, seen } = recordingPool(dbType);
    const store = createReportsStore({ pool, dbType });
    await store.list({});
    assert.ok(seen[0].includes(REMINDER_FILTER), seen[0]);
  });

  test(`${dbType}: сводка без напоминаний, отменённые не входят в итог`, async () => {
    const { pool, seen } = recordingPool(dbType, [
      ['GROUP BY status', [
        { status: 'done', count: 60 },
        { status: 'expired', count: 9 },
        { status: 'cancelled', count: 5 }
      ]]
    ]);
    const store = createReportsStore({ pool, dbType });
    const summary = await store.getSummary({ dateFrom: '2026-09-29', dateTo: '2026-09-29' });
    assert.equal(summary.total, 69);
    assert.equal(summary.done, 60);
    assert.equal(summary.byStatus.cancelled, 5);
    assert.ok(seen.every((sql) => sql.includes(REMINDER_FILTER)), seen.join('\n'));
  });
}
