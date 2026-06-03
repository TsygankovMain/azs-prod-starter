import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

// ---------------------------------------------------------------------------
// Fake PG pool — mirrors the style of crmSyncJobStore.test.js
// ---------------------------------------------------------------------------
const createFakePgPool = () => {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.startsWith('CREATE TABLE')) return { rows: [] };
      if (text.startsWith('CREATE INDEX')) return { rows: [] };

      // INSERT INTO dispatch_plan ... ON CONFLICT ... DO NOTHING RETURNING *
      if (text.startsWith('INSERT INTO dispatch_plan')) {
        const key = `${params[0]}|${params[1]}|${params[3]}`; // planDate|azsId|baseTime
        const existing = rows.find(
          (r) => r.plan_date === params[0] && r.azs_id === params[1] && r.base_time === params[3]
        );
        if (existing) {
          // ON CONFLICT DO NOTHING → return empty rows (like real PG)
          return { rows: [] };
        }
        seq += 1;
        const row = {
          id: seq,
          plan_date: params[0],
          azs_id: params[1],
          admin_user_id: params[2],
          base_time: params[3],
          execute_at: params[4],
          jitter_minutes: params[5],
          status: 'planned',
          report_item_id: null,
          error_text: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        rows.push(row);
        return { rows: [row] };
      }

      // SELECT * FROM dispatch_plan WHERE status='planned' AND execute_at <= $1 ORDER BY execute_at ASC
      if (text.startsWith("SELECT * FROM dispatch_plan WHERE status='planned' AND execute_at <=")) {
        const cutoff = new Date(params[0]);
        const due = rows
          .filter((r) => r.status === 'planned' && new Date(r.execute_at) <= cutoff)
          .sort((a, b) => new Date(a.execute_at) - new Date(b.execute_at));
        return { rows: due };
      }

      // markDispatched: UPDATE dispatch_plan SET status='dispatched', report_item_id=$1, updated_at=NOW() WHERE id=$2
      if (text.startsWith("UPDATE dispatch_plan SET status='dispatched'")) {
        const reportItemId = params[0];
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.status = 'dispatched';
          row.report_item_id = reportItemId;
          row.updated_at = new Date();
        }
        return { rows: [] };
      }

      // markFailed: UPDATE dispatch_plan SET status='failed', error_text=$1, updated_at=NOW() WHERE id=$2
      if (text.startsWith("UPDATE dispatch_plan SET status='failed'")) {
        const errorText = params[0];
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.status = 'failed';
          row.error_text = errorText;
          row.updated_at = new Date();
        }
        return { rows: [] };
      }

      // listByDate: SELECT * FROM dispatch_plan WHERE plan_date=$1 ORDER BY execute_at ASC
      if (text.startsWith('SELECT * FROM dispatch_plan WHERE plan_date=')) {
        const planDate = params[0];
        const result = rows
          .filter((r) => r.plan_date === planDate)
          .sort((a, b) => new Date(a.execute_at) - new Date(b.execute_at));
        return { rows: result };
      }

      // deletePlannedForDate: DELETE FROM dispatch_plan WHERE plan_date=$1 AND status='planned'
      if (text.startsWith('DELETE FROM dispatch_plan WHERE plan_date=')) {
        const planDate = params[0];
        const before = rows.length;
        const toRemove = rows
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r.plan_date === planDate && r.status === 'planned')
          .map(({ i }) => i)
          .reverse();
        for (const i of toRemove) rows.splice(i, 1);
        const count = before - rows.length;
        return { rows: [], rowCount: count };
      }

      return { rows: [] };
    },
  };
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
const makeDate = (offsetMs = 0) => new Date(Date.now() + offsetMs);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('ensureSchema + upsertPlanned inserts a planned row with the given fields', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const executeAt = makeDate(-60_000); // 1 min in past
  const row = await store.upsertPlanned({
    planDate: '2026-06-03',
    azsId: 'AZS-01',
    adminUserId: 100,
    baseTime: '08:00',
    executeAt,
    jitterMinutes: 5,
  });

  assert.ok(row, 'should return the inserted row');
  assert.equal(row.plan_date, '2026-06-03');
  assert.equal(row.azs_id, 'AZS-01');
  assert.equal(row.admin_user_id, 100);
  assert.equal(row.base_time, '08:00');
  assert.equal(row.jitter_minutes, 5);
  assert.equal(row.status, 'planned');
  assert.equal(row.report_item_id, null);
});

test('upsertPlanned is idempotent: second call with same key does not create a duplicate', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const executeAt = makeDate(-60_000);
  await store.upsertPlanned({
    planDate: '2026-06-03',
    azsId: 'AZS-01',
    adminUserId: 100,
    baseTime: '08:00',
    executeAt,
    jitterMinutes: 0,
  });
  // Second call with same (planDate, azsId, baseTime)
  await store.upsertPlanned({
    planDate: '2026-06-03',
    azsId: 'AZS-01',
    adminUserId: 100,
    baseTime: '08:00',
    executeAt: makeDate(-30_000),
    jitterMinutes: 3,
  });

  const listed = await store.listByDate({ planDate: '2026-06-03' });
  assert.equal(listed.length, 1, 'still exactly one row after second upsert');
});

test('listDue returns only rows with execute_at <= now and status=planned, ordered by execute_at', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const past1 = makeDate(-120_000);
  const past2 = makeDate(-60_000);
  const future = makeDate(60_000);

  await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-02', adminUserId: 1, baseTime: '09:00', executeAt: past2, jitterMinutes: 0 });
  await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-01', adminUserId: 1, baseTime: '09:00', executeAt: past1, jitterMinutes: 0 });
  await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-03', adminUserId: 1, baseTime: '09:00', executeAt: future, jitterMinutes: 0 });

  const due = await store.listDue({ now: new Date() });
  assert.equal(due.length, 2, 'only past rows returned');
  // ordered by execute_at ASC: past1 first, then past2
  assert.ok(new Date(due[0].execute_at) <= new Date(due[1].execute_at), 'ordered ASC');
  assert.equal(due[0].azs_id, 'AZS-01', 'earliest row first');
  assert.equal(due[1].azs_id, 'AZS-02');
});

test('markDispatched sets status=dispatched + report_item_id; row no longer appears in listDue', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const executeAt = makeDate(-60_000);
  const row = await store.upsertPlanned({
    planDate: '2026-06-03',
    azsId: 'AZS-01',
    adminUserId: 1,
    baseTime: '10:00',
    executeAt,
    jitterMinutes: 0,
  });

  await store.markDispatched({ id: row.id, reportItemId: 999 });

  const listed = await store.listByDate({ planDate: '2026-06-03' });
  assert.equal(listed[0].status, 'dispatched');
  assert.equal(listed[0].report_item_id, 999);

  const due = await store.listDue({ now: new Date() });
  assert.equal(due.length, 0, 'dispatched row should not appear in listDue');
});

test('markFailed sets status=failed + error_text', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const row = await store.upsertPlanned({
    planDate: '2026-06-03',
    azsId: 'AZS-01',
    adminUserId: 1,
    baseTime: '11:00',
    executeAt: makeDate(-60_000),
    jitterMinutes: 0,
  });

  await store.markFailed({ id: row.id, error: 'network timeout' });

  const listed = await store.listByDate({ planDate: '2026-06-03' });
  assert.equal(listed[0].status, 'failed');
  assert.equal(listed[0].error_text, 'network timeout');
});

test('listByDate returns all rows for the date regardless of status, ordered by execute_at', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const t1 = makeDate(-180_000);
  const t2 = makeDate(-120_000);
  const t3 = makeDate(-60_000);

  const r1 = await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-A', adminUserId: 1, baseTime: '07:00', executeAt: t1, jitterMinutes: 0 });
  const r2 = await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-B', adminUserId: 1, baseTime: '08:00', executeAt: t2, jitterMinutes: 0 });
  const r3 = await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-C', adminUserId: 1, baseTime: '09:00', executeAt: t3, jitterMinutes: 0 });

  await store.markDispatched({ id: r1.id, reportItemId: 1 });
  await store.markFailed({ id: r2.id, error: 'oops' });

  const all = await store.listByDate({ planDate: '2026-06-03' });
  assert.equal(all.length, 3, 'all 3 rows returned regardless of status');
  const statuses = all.map((r) => r.status);
  assert.ok(statuses.includes('dispatched'));
  assert.ok(statuses.includes('failed'));
  assert.ok(statuses.includes('planned'));
  // verify ordering
  assert.ok(new Date(all[0].execute_at) <= new Date(all[1].execute_at));
  assert.ok(new Date(all[1].execute_at) <= new Date(all[2].execute_at));
});

test('deletePlannedForDate removes planned rows but keeps dispatched ones; returns count', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const r1 = await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-A', adminUserId: 1, baseTime: '07:00', executeAt: makeDate(-180_000), jitterMinutes: 0 });
  await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-B', adminUserId: 1, baseTime: '08:00', executeAt: makeDate(-120_000), jitterMinutes: 0 });
  await store.upsertPlanned({ planDate: '2026-06-03', azsId: 'AZS-C', adminUserId: 1, baseTime: '09:00', executeAt: makeDate(-60_000), jitterMinutes: 0 });

  // Dispatch r1 — should be preserved
  await store.markDispatched({ id: r1.id, reportItemId: 42 });

  const count = await store.deletePlannedForDate({ planDate: '2026-06-03' });
  assert.equal(count, 2, 'two planned rows deleted');

  const remaining = await store.listByDate({ planDate: '2026-06-03' });
  assert.equal(remaining.length, 1, 'only the dispatched row remains');
  assert.equal(remaining[0].status, 'dispatched');
  assert.equal(remaining[0].azs_id, 'AZS-A');
});
