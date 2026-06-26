import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

test('cancelPlanned (postgres) updates a planned row to cancelled by id', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rowCount: 1, rows: [] };
    }
  };
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  const res = await store.cancelPlanned({ id: 17 });
  assert.equal(res.cancelled, 1);
  assert.match(queries[0].sql, /UPDATE dispatch_plan SET status='cancelled'/i);
  assert.match(queries[0].sql, /WHERE id=\$1 AND status='planned'/i);
  assert.deepEqual(queries[0].params, [17]);
});

test('cancelPlanned (mysql) updates a planned row to cancelled by id', async () => {
  const queries = [];
  const pool = {
    async execute(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [{ affectedRows: 1 }];
    }
  };
  const store = createDispatchPlanStore({ pool, dbType: 'mysql' });
  const res = await store.cancelPlanned({ id: 8 });
  assert.equal(res.cancelled, 1);
  assert.match(queries[0].sql, /UPDATE dispatch_plan SET status='cancelled'/i);
  assert.match(queries[0].sql, /WHERE id=\? AND status='planned'/i);
  assert.deepEqual(queries[0].params, [8]);
});
