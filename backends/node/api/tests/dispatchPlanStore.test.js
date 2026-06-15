import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

// ---------------------------------------------------------------------------
// Fake PG pool — mirrors the style of crmSyncJobStore.test.js
// S8-A3: уникальный ключ по 5 полям (plan_date, azs_id, base_time, entry_type, window_index)
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
      if (text.startsWith('ALTER TABLE')) return { rows: [] };
      // DO $$ блок для миграции UNIQUE ключа
      if (text.startsWith('DO $$') || text.startsWith('DO $')) return { rows: [] };

      // INSERT INTO dispatch_plan ... ON CONFLICT (plan_date, azs_id, base_time, entry_type, window_index) DO NOTHING RETURNING *
      if (text.startsWith('INSERT INTO dispatch_plan')) {
        // params: planDate[0], azsId[1], adminUserId[2], baseTime[3], executeAt[4],
        //         jitterMinutes[5], entryType[6], windowIndex[7], deadlineAt[8]
        const planDate = params[0];
        const azsId = params[1];
        const adminUserId = params[2];
        const baseTime = params[3];
        const executeAt = params[4];
        const jitterMinutes = params[5] ?? 0;
        const entryType = params[6] ?? 'primary';
        const windowIndex = params[7] ?? 0;
        const deadlineAt = params[8] ?? null;

        // S8-A3: уникальный ключ по 5 полям
        const existing = rows.find(
          (r) => r.plan_date === planDate && r.azs_id === azsId && r.base_time === baseTime
               && r.entry_type === entryType && r.window_index === windowIndex
        );
        if (existing) {
          // ON CONFLICT DO NOTHING → return empty rows (like real PG)
          return { rows: [] };
        }
        seq += 1;
        const row = {
          id: seq,
          plan_date: planDate,
          azs_id: azsId,
          admin_user_id: adminUserId,
          base_time: baseTime,
          execute_at: executeAt,
          jitter_minutes: jitterMinutes,
          entry_type: entryType,
          window_index: windowIndex,
          deadline_at: deadlineAt,
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

// ---------------------------------------------------------------------------
// S8-A3 БЛОКЕР 1: тест коллизии — primary и reminder с ОДИНАКОВЫМ base_time
// Проверяем, что обе строки сосуществуют (ранее замаскированный сценарий)
// ---------------------------------------------------------------------------

test('S8-A3: primary и reminder с одинаковым base_time для одной АЗС/даты — обе строки сосуществуют', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const sameBaseTime = '0730'; // одинаковое базовое время!
  const planDate = '2026-06-20';
  const azsId = 'AZS-01';

  // primary-точка (windowIndex=0)
  const primaryRow = await store.upsertPlanned({
    planDate,
    azsId,
    adminUserId: 100,
    baseTime: sameBaseTime,
    executeAt: makeDate(-120_000),
    jitterMinutes: 0,
    entryType: 'primary',
    windowIndex: 0
  });

  // reminder-точка (windowIndex=1) с ТЕМ ЖЕ base_time — раньше вызывала коллизию!
  const reminderRow = await store.upsertPlanned({
    planDate,
    azsId,
    adminUserId: 100,
    baseTime: sameBaseTime,
    executeAt: makeDate(-60_000),
    jitterMinutes: 0,
    entryType: 'reminder',
    windowIndex: 1
  });

  // Обе строки должны существовать (уникальность по 5 полям: entry_type/window_index различаются)
  assert.ok(primaryRow, 'primary-строка вставлена');
  assert.ok(reminderRow, 'reminder-строка вставлена (НЕ потеряна из-за коллизии base_time)');
  assert.notEqual(primaryRow.id, reminderRow.id, 'строки имеют разные id');

  const all = await store.listByDate({ planDate });
  assert.equal(all.length, 2, 'обе строки (primary + reminder) в таблице — коллизии нет');

  const primary = all.find((r) => r.entry_type === 'primary' || r.entry_type === undefined);
  const reminder = all.find((r) => r.entry_type === 'reminder');
  assert.ok(primary, 'primary-строка в listByDate');
  assert.ok(reminder, 'reminder-строка в listByDate');
});

test('S8-A3: повторный upsert primary с теми же 5 полями — идемпотентен (ON CONFLICT DO NOTHING)', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  await store.upsertPlanned({
    planDate: '2026-06-20', azsId: 'AZS-01', adminUserId: 100,
    baseTime: '0730', executeAt: makeDate(-60_000),
    jitterMinutes: 0, entryType: 'primary', windowIndex: 0
  });
  // повторный вызов с теми же 5 ключевыми полями
  const dup = await store.upsertPlanned({
    planDate: '2026-06-20', azsId: 'AZS-01', adminUserId: 100,
    baseTime: '0730', executeAt: makeDate(-30_000),
    jitterMinutes: 3, entryType: 'primary', windowIndex: 0
  });

  // PG: ON CONFLICT DO NOTHING → null (строка не создана повторно)
  assert.equal(dup, null, 'дублирующий upsert возвращает null (ON CONFLICT DO NOTHING)');
  const all = await store.listByDate({ planDate: '2026-06-20' });
  assert.equal(all.length, 1, 'только одна строка в таблице после дублирующего upsert');
});
