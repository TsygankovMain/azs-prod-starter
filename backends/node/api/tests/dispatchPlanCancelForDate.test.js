import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

test('cancelPlannedForDate (postgres) cancels all planned rows for the date', async () => {
  const q = [];
  const pool = { async query(sql, params){ q.push({ sql: sql.replace(/\s+/g,' ').trim(), params }); return { rowCount: 3 }; } };
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  const res = await store.cancelPlannedForDate({ planDate: '2026-06-26' });
  assert.equal(res.cancelled, 3);
  assert.match(q[0].sql, /UPDATE dispatch_plan SET status='cancelled'/i);
  assert.match(q[0].sql, /WHERE plan_date=\$1 AND status='planned'/i);
  assert.deepEqual(q[0].params, ['2026-06-26']);
});

test('cancelPlannedForDate (mysql) cancels all planned rows for the date', async () => {
  const q = [];
  const pool = { async execute(sql, params){ q.push({ sql: sql.replace(/\s+/g,' ').trim(), params }); return [{ affectedRows: 2 }]; } };
  const store = createDispatchPlanStore({ pool, dbType: 'mysql' });
  const res = await store.cancelPlannedForDate({ planDate: '2026-06-26' });
  assert.equal(res.cancelled, 2);
  assert.match(q[0].sql, /WHERE plan_date=\? AND status='planned'/i);
  assert.deepEqual(q[0].params, ['2026-06-26']);
});
