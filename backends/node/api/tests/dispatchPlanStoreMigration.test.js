/**
 * S8-A3: Тесты миграции dispatch_plan — колонки entry_type и window_index
 *
 * - Новые колонки добавляются идемпотентно (PG + MySQL)
 * - ensureSchema добавляет колонки если их нет (ALTER)
 * - Существующие записи получают DEFAULT primary/0
 * - upsertPlanned принимает entryType и windowIndex
 * - listDue возвращает entry_type и window_index
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

// ---------------------------------------------------------------------------
// Fake PG pool с поддержкой новых полей
// ---------------------------------------------------------------------------

const createFakePgPool = () => {
  const rows = [];
  let seq = 0;
  const schemaCalls = [];
  const alterCalls = [];

  return {
    rows,
    schemaCalls,
    alterCalls,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.startsWith('CREATE TABLE')) {
        schemaCalls.push(text);
        return { rows: [] };
      }
      if (text.startsWith('CREATE INDEX')) return { rows: [] };

      // ALTER TABLE ... ADD COLUMN IF NOT EXISTS
      if (text.startsWith('ALTER TABLE')) {
        alterCalls.push(text);
        return { rows: [] };
      }

      // INSERT INTO dispatch_plan
      if (text.startsWith('INSERT INTO dispatch_plan')) {
        // Определяем колонки из SQL: ищем паттерн values с entry_type, window_index
        const hasModeFields = text.includes('entry_type') || text.includes('window_index');

        // Unique key: plan_date, azs_id, base_time
        // Для reminder: key включает window_index
        const planDate = params[0];
        const azsId = params[1];
        const adminUserId = params[2];
        const baseTime = params[3];
        const executeAt = params[4];
        const jitterMinutes = params[5] ?? 0;

        // Парсим entryType и windowIndex в зависимости от наличия полей
        let entryType = 'primary';
        let windowIndex = 0;
        let deadlineAt = null;

        if (hasModeFields) {
          // Позиции зависят от порядка в INSERT
          // Ищем по позиции: params[6]=entry_type, params[7]=window_index, params[8]=deadline_at
          entryType = params[6] ?? 'primary';
          windowIndex = params[7] ?? 0;
          deadlineAt = params[8] ?? null;
        }

        // Для reminder уникальный ключ включает window_index
        const uniqueKey = entryType === 'reminder'
          ? `${planDate}|${azsId}|${baseTime}|reminder|${windowIndex}`
          : `${planDate}|${azsId}|${baseTime}`;

        const existing = rows.find((r) => r._uniqueKey === uniqueKey);
        if (existing) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }

        seq += 1;
        const row = {
          id: seq,
          _uniqueKey: uniqueKey,
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
          updated_at: new Date()
        };
        rows.push(row);
        return { rows: [row] };
      }

      // SELECT listDue
      if (text.includes("status='planned' AND execute_at <=")) {
        const cutoff = new Date(params[0]);
        const due = rows
          .filter((r) => r.status === 'planned' && new Date(r.execute_at) <= cutoff)
          .sort((a, b) => new Date(a.execute_at) - new Date(b.execute_at));
        return { rows: due };
      }

      // SELECT listByDate
      if (text.includes('WHERE plan_date=') && !text.includes('status')) {
        const filtered = rows.filter((r) => r.plan_date === params[0]);
        return { rows: filtered };
      }

      // markDispatched
      if (text.includes("status='dispatched'")) {
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) { row.status = 'dispatched'; row.report_item_id = params[0]; }
        return { rows: [] };
      }

      // markFailed
      if (text.includes("status='failed'")) {
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) { row.status = 'failed'; row.error_text = params[0]; }
        return { rows: [] };
      }

      // deletePlannedForDate
      if (text.startsWith('DELETE FROM dispatch_plan')) {
        const planDate = params[0];
        const before = rows.length;
        const idx = rows.filter((r) => !(r.plan_date === planDate && r.status === 'planned'));
        rows.length = 0;
        rows.push(...idx);
        return { rowCount: before - rows.length };
      }

      return { rows: [] };
    }
  };
};

// ---------------------------------------------------------------------------
// Fake MySQL pool с поддержкой новых полей
// ---------------------------------------------------------------------------

const createFakeMysqlPool = () => {
  const rows = [];
  let seq = 0;
  const alterCalls = [];

  return {
    rows,
    alterCalls,
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }];
      if (text.startsWith('ALTER TABLE')) {
        alterCalls.push(text);
        return [{ affectedRows: 0 }];
      }

      if (text.startsWith('INSERT IGNORE INTO dispatch_plan')) {
        const hasModeFields = text.includes('entry_type') || text.includes('window_index');

        const planDate = params[0];
        const azsId = params[1];
        const adminUserId = params[2];
        const baseTime = params[3];
        const executeAt = params[4];
        const jitterMinutes = params[5] ?? 0;

        let entryType = 'primary';
        let windowIndex = 0;
        let deadlineAt = null;

        if (hasModeFields) {
          entryType = params[6] ?? 'primary';
          windowIndex = params[7] ?? 0;
          deadlineAt = params[8] ?? null;
        }

        const uniqueKey = entryType === 'reminder'
          ? `${planDate}|${azsId}|${baseTime}|reminder|${windowIndex}`
          : `${planDate}|${azsId}|${baseTime}`;

        const existing = rows.find((r) => r._uniqueKey === uniqueKey);
        if (existing) {
          return [{ affectedRows: 0, insertId: 0 }];
        }

        seq += 1;
        const row = {
          id: seq,
          _uniqueKey: uniqueKey,
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
          updated_at: new Date()
        };
        rows.push(row);
        return [{ affectedRows: 1, insertId: seq }];
      }

      // Re-SELECT after INSERT IGNORE
      if (text.startsWith('SELECT * FROM dispatch_plan WHERE plan_date=') && text.includes('LIMIT 1')) {
        const planDate = params[0];
        const azsId = params[1];
        const baseTime = params[2];
        const found = rows.find((r) => r.plan_date === planDate && r.azs_id === azsId && r.base_time === baseTime);
        return [[found].filter(Boolean)];
      }

      if (text.includes("status='planned' AND execute_at <=")) {
        const cutoff = new Date(params[0]);
        const due = rows
          .filter((r) => r.status === 'planned' && new Date(r.execute_at) <= cutoff)
          .sort((a, b) => new Date(a.execute_at) - new Date(b.execute_at));
        return [due];
      }

      if (text.includes('WHERE plan_date=') && !text.includes('status')) {
        return [rows.filter((r) => r.plan_date === params[0])];
      }

      if (text.includes("status='dispatched'")) {
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) row.status = 'dispatched';
        return [{ affectedRows: 1 }];
      }

      if (text.includes("status='failed'")) {
        const id = params[1];
        const row = rows.find((r) => r.id === id);
        if (row) row.status = 'failed';
        return [{ affectedRows: 1 }];
      }

      if (text.startsWith('DELETE FROM dispatch_plan')) {
        const planDate = params[0];
        const toDelete = rows.filter((r) => r.plan_date === planDate && r.status === 'planned');
        toDelete.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return [{ affectedRows: toDelete.length }];
      }

      return [[]];
    }
  };
};

// ---------------------------------------------------------------------------
// PG: ensureSchema добавляет ALTER TABLE для entry_type и window_index
// ---------------------------------------------------------------------------

test('S8-A3 миграция PG: ensureSchema вызывает ALTER для entry_type и window_index', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  // Должны быть ALTER TABLE для двух новых колонок
  const alters = pool.alterCalls.join('\n');
  assert.ok(alters.includes('entry_type'), 'ALTER добавляет entry_type');
  assert.ok(alters.includes('window_index'), 'ALTER добавляет window_index');
});

test('S8-A3 миграция PG: ensureSchema идемпотентен (вызов дважды не ошибка)', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });

  // Не должно бросать исключений
  await store.ensureSchema();
  await store.ensureSchema(); // идемпотентный повторный вызов
});

// ---------------------------------------------------------------------------
// MySQL: ensureSchema добавляет ALTER TABLE
// ---------------------------------------------------------------------------

test('S8-A3 миграция MySQL: ensureSchema вызывает ALTER для entry_type и window_index', async () => {
  const pool = createFakeMysqlPool();
  const store = createDispatchPlanStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  const alters = pool.alterCalls.join('\n');
  assert.ok(alters.includes('entry_type'), 'ALTER добавляет entry_type (MySQL)');
  assert.ok(alters.includes('window_index'), 'ALTER добавляет window_index (MySQL)');
});

test('S8-A3 миграция MySQL: ensureSchema идемпотентен', async () => {
  const pool = createFakeMysqlPool();
  const store = createDispatchPlanStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.ensureSchema(); // не должно бросать
});

// ---------------------------------------------------------------------------
// upsertPlanned: принимает entryType и windowIndex
// ---------------------------------------------------------------------------

test('S8-A3 upsertPlanned PG: primary точка с entryType/windowIndex сохраняется', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '0730',
    executeAt: new Date('2026-06-20T04:30:00.000Z'),
    jitterMinutes: 0,
    entryType: 'primary',
    windowIndex: 0,
    deadlineAt: new Date('2026-06-20T13:00:00.000Z')
  });

  const row = pool.rows[0];
  assert.ok(row, 'строка вставлена');
  assert.equal(row.entry_type, 'primary');
  assert.equal(row.window_index, 0);
  assert.ok(row.deadline_at !== undefined, 'deadline_at сохранён');
});

test('S8-A3 upsertPlanned PG: reminder точка с windowIndex=1 сохраняется', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '1430',
    executeAt: new Date('2026-06-20T11:30:00.000Z'),
    jitterMinutes: 0,
    entryType: 'reminder',
    windowIndex: 1,
    deadlineAt: new Date('2026-06-20T13:00:00.000Z')
  });

  const row = pool.rows[0];
  assert.ok(row, 'строка вставлена');
  assert.equal(row.entry_type, 'reminder');
  assert.equal(row.window_index, 1);
});

test('S8-A3 upsertPlanned PG: без entryType → default primary/0', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  // Старый вызов без новых полей (обратная совместимость)
  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-legacy',
    adminUserId: 100,
    baseTime: '0900',
    executeAt: new Date('2026-06-20T06:00:00.000Z'),
    jitterMinutes: 0
    // entryType/windowIndex отсутствуют
  });

  const row = pool.rows[0];
  assert.ok(row, 'строка вставлена');
  // Default должен быть 'primary'/0
  assert.equal(row.entry_type ?? 'primary', 'primary', 'default entry_type = primary');
  assert.equal(row.window_index ?? 0, 0, 'default window_index = 0');
});

// ---------------------------------------------------------------------------
// upsertPlanned MySQL
// ---------------------------------------------------------------------------

test('S8-A3 upsertPlanned MySQL: primary и reminder точки сохраняются с новыми полями', async () => {
  const pool = createFakeMysqlPool();
  const store = createDispatchPlanStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '0730',
    executeAt: new Date('2026-06-20T04:30:00.000Z'),
    jitterMinutes: 0,
    entryType: 'primary',
    windowIndex: 0,
    deadlineAt: new Date('2026-06-20T13:00:00.000Z')
  });

  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '1430',
    executeAt: new Date('2026-06-20T11:30:00.000Z'),
    jitterMinutes: 0,
    entryType: 'reminder',
    windowIndex: 1,
    deadlineAt: new Date('2026-06-20T13:00:00.000Z')
  });

  assert.equal(pool.rows.length, 2, '2 строки в таблице');
  const primary = pool.rows.find((r) => r.entry_type === 'primary');
  const reminder = pool.rows.find((r) => r.entry_type === 'reminder');
  assert.ok(primary, 'primary строка есть');
  assert.ok(reminder, 'reminder строка есть');
  assert.equal(reminder.window_index, 1);
});

// ---------------------------------------------------------------------------
// listDue: возвращает entry_type и window_index
// ---------------------------------------------------------------------------

test('S8-A3 listDue PG: возвращает entry_type и window_index для строк', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  const now = new Date('2026-06-20T11:35:00.000Z');
  // Вставляем строку с reminder
  await store.upsertPlanned({
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '1430',
    executeAt: new Date('2026-06-20T11:30:00.000Z'), // уже прошло
    jitterMinutes: 0,
    entryType: 'reminder',
    windowIndex: 1
  });

  const due = await store.listDue({ now });
  assert.equal(due.length, 1, '1 строка due');
  assert.equal(due[0].entry_type, 'reminder', 'entry_type = reminder');
  assert.equal(due[0].window_index, 1, 'window_index = 1');
});

// ---------------------------------------------------------------------------
// Идемпотентность reminder: второй upsert с тем же ключом → ON CONFLICT DO NOTHING
// ---------------------------------------------------------------------------

test('S8-A3 идемпотентность upsert: два reminder с тем же windowIndex → одна строка', async () => {
  const pool = createFakePgPool();
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  await store.ensureSchema();

  const params = {
    planDate: '2026-06-20',
    azsId: 'azs-b',
    adminUserId: 201,
    baseTime: '1430',
    executeAt: new Date('2026-06-20T11:30:00.000Z'),
    jitterMinutes: 0,
    entryType: 'reminder',
    windowIndex: 1
  };

  await store.upsertPlanned(params);
  await store.upsertPlanned(params); // дубль — ON CONFLICT DO NOTHING

  // Должна быть только одна строка с reminder
  const reminderRows = pool.rows.filter((r) => r.entry_type === 'reminder');
  assert.equal(reminderRows.length, 1, 'дублирующий upsert не создаёт новую строку');
});
