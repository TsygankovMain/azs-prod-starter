/**
 * S8-A3: Исполнитель напоминаний в dispatchScheduler.js
 *
 * AC-11: не сдан → notificationService.notify (без новой карточки)
 * AC-12: сдан → notify НЕ вызывается
 * AC-14: reserve(reminderSlotKey) повторно → уведомление не шлётся дважды
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchScheduler } from '../src/dispatch/dispatchScheduler.js';

// ---------------------------------------------------------------------------
// Вспомогательные хелперы
// ---------------------------------------------------------------------------

/**
 * Создаёт базовый fakePlanStore с одной due-строкой reminder.
 * По умолчанию: entry_type='reminder', window_index=1
 */
const makeReminderDueRow = (overrides = {}) => ({
  id: 100,
  azs_id: 'azs-b',
  admin_user_id: 201,
  plan_date: '2026-06-20',
  base_time: '1430',
  execute_at: new Date('2026-06-20T11:30:00.000Z'),
  jitter_minutes: 0,
  entry_type: 'reminder',
  window_index: 1,
  ...overrides
});

/**
 * Создаёт fakePlanStore который возвращает указанные due-строки.
 */
const makePlanStore = ({ dueRows = [], ...methods } = {}) => ({
  async listDue() { return dueRows; },
  async listByDate() { return []; },
  async markDispatched(args) { methods.markDispatched?.(args); },
  async markFailed(args) { methods.markFailed?.(args); }
});

/**
 * Создаёт fakeDispatchLogStore с reserve для напоминаний.
 * По умолчанию: reserve всегда возвращает { reserved: true, id: 1 }
 */
const makeLogStore = ({ reserveResult = { reserved: true, id: 1 }, ...methods } = {}) => ({
  async reserve(args) {
    methods.reserveCalls?.push?.(args);
    return reserveResult;
  },
  async markFailed(args) { methods.markFailed?.(args); }
});

/**
 * Создаёт fakeReportsStore с методом getActiveReportForAzsOnDate.
 * S8-A3 БЛОКЕР 2+3: используем РЕАЛЬНЫЙ интерфейс метода (azsId + planDate),
 * а не getBySlotKey(base_time напоминания) — который не существует в prod reportsStore.
 * По умолчанию: статус 'new' (не сдан).
 */
const makeReportsStore = ({ status = 'new', ...methods } = {}) => ({
  async getActiveReportForAzsOnDate(args) {
    methods.getCalls?.push?.(args);
    if (status === null) return null; // нет отчёта
    // Возвращает отчёт по azsId+planDate (не по base_time напоминания!)
    return { id: 1, status, azs_id: args?.azsId, plan_date: args?.planDate };
  }
});

// ---------------------------------------------------------------------------
// AC-11: не сдан → notificationService.notify (без createReportItem)
// ---------------------------------------------------------------------------

test('S8-A3 исполнитель: reminder + отчёт не сдан → notify вызывается без createReportItem', async () => {
  const notifyCalls = [];
  const createItemCalls = [];
  const markDispatchedCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow()],
      markDispatched: (a) => markDispatchedCalls.push(a)
    }),
    dispatchLogStore: makeLogStore({
      reserveCalls: [],
    }),
    reportsStore: makeReportsStore({ status: 'new' }),
    notificationService: {
      async notify(args) { notifyCalls.push(args); },
      async notifyDispatch(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() {
        // не должен вызываться для reminder
        throw new Error('dispatchBatch не должен вызываться для reminder точки');
      }
    },
    bitrixClient: {
      async createReportItem() {
        createItemCalls.push(true);
        throw new Error('createReportItem не должен вызываться для reminder точки');
      }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.equal(createItemCalls.length, 0, 'createReportItem НЕ вызывается для reminder');
  assert.ok(notifyCalls.length > 0, 'notificationService.notify вызван');
  // markDispatched должен быть вызван для reminder строки (или аналогичный механизм)
  assert.ok(markDispatchedCalls.length > 0, 'план строка помечена как обработанная');
});

// ---------------------------------------------------------------------------
// AC-12: сдан → notify НЕ вызывается
// ---------------------------------------------------------------------------

test('S8-A3 исполнитель: reminder + отчёт СДАН (статус done) → notify НЕ вызывается', async () => {
  const notifyCalls = [];
  const markDispatchedCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow()],
      markDispatched: (a) => markDispatchedCalls.push(a)
    }),
    dispatchLogStore: makeLogStore(),
    reportsStore: makeReportsStore({ status: 'done' }),  // отчёт СДАН
    notificationService: {
      async notify(args) { notifyCalls.push(args); },
      async notifyDispatch(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() {
        throw new Error('dispatchBatch не должен вызываться для reminder');
      }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.equal(notifyCalls.length, 0, 'notify НЕ вызывается когда отчёт сдан (done)');
  // Строка всё равно помечается обработанной (skipped)
  assert.ok(markDispatchedCalls.length > 0, 'план строка помечена (skipped reminder)');
});

test('S8-A3 исполнитель: reminder + статус submitted → notify НЕ вызывается', async () => {
  const notifyCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow()],
      markDispatched: () => {}
    }),
    dispatchLogStore: makeLogStore(),
    reportsStore: makeReportsStore({ status: 'submitted' }),  // submitted тоже считается сданным
    notificationService: {
      async notify(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() { throw new Error('не должен вызываться'); }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.equal(notifyCalls.length, 0, 'notify НЕ вызывается при статусе submitted');
});

// ---------------------------------------------------------------------------
// AC-14: reserve(reminderSlotKey) повторно → не шлёт дважды
// ---------------------------------------------------------------------------

test('S8-A3 идемпотентность: reserve(reminderSlotKey) вернул false → notify не шлётся', async () => {
  const notifyCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow()],
      markDispatched: () => {}
    }),
    // reserve возвращает { reserved: false } — уже зарезервировано (дубль тика)
    dispatchLogStore: makeLogStore({ reserveResult: { reserved: false, id: null } }),
    reportsStore: makeReportsStore({ status: 'new' }),
    notificationService: {
      async notify(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() { throw new Error('dispatchBatch не должен вызываться'); }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.equal(notifyCalls.length, 0, 'notify не шлётся при reserve=false (дублирующий тик)');
});

// ---------------------------------------------------------------------------
// reminderSlotKey формат: planDate:baseTimeHHmm:reminder:windowIndex
// ---------------------------------------------------------------------------

test('S8-A3 reminderSlotKey: reserve вызывается с ключом в формате planDate:HHmm:reminder:windowIndex', async () => {
  const reserveCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow({
        plan_date: '2026-06-20',
        base_time: '1430',
        window_index: 1
      })],
      markDispatched: () => {}
    }),
    dispatchLogStore: {
      async reserve(args) {
        reserveCalls.push(args);
        return { reserved: true, id: 42 };
      },
      async markFailed() {}
    },
    reportsStore: makeReportsStore({ status: 'new' }),
    notificationService: {
      async notify() {}
    },
    dispatchService: {
      async dispatchBatch() { throw new Error('не должен вызываться'); }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(reserveCalls.length > 0, 'reserve был вызван для reminder');
  const key = reserveCalls[0]?.slotKey ?? '';
  // Формат: YYYY-MM-DD:HHMM:reminder:N
  assert.ok(
    /^2026-06-20:1430:reminder:1$/.test(key),
    `slotKey='${key}' должен быть '2026-06-20:1430:reminder:1'`
  );
});

// ---------------------------------------------------------------------------
// Primary точка в plan-mode (entry_type='primary') → обычный dispatchBatch
// ---------------------------------------------------------------------------

test('S8-A3 исполнитель: primary-строка → обычный dispatchBatch (создаёт карточку)', async () => {
  const dispatchBatchCalls = [];
  const notifyCalls = [];

  const primaryRow = {
    id: 50,
    azs_id: 'azs-b',
    admin_user_id: 201,
    plan_date: '2026-06-20',
    base_time: '0730',
    execute_at: new Date('2026-06-20T04:30:00.000Z'),
    jitter_minutes: 0,
    entry_type: 'primary',
    window_index: 0
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [primaryRow],
      markDispatched: () => {}
    }),
    dispatchLogStore: makeLogStore(),
    reportsStore: makeReportsStore({ status: 'new' }),
    notificationService: {
      async notify(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch(payload) {
        dispatchBatchCalls.push(payload);
        return {
          summary: { total: 1, created: 1, duplicates: 0, failed: 0 },
          items: [{ ok: true, duplicate: false, reportItemId: 999 }]
        };
      }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T04:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(dispatchBatchCalls.length > 0, 'dispatchBatch вызван для primary точки');
  // notify от dispatchBatch — это обычное уведомление через notificationService внутри dispatchService
  // Здесь тестируем только что dispatchBatch был вызван (без createReportItem в тесте)
});

// ---------------------------------------------------------------------------
// entry_type отсутствует (строки до миграции) → трактуется как 'primary'
// ---------------------------------------------------------------------------

test('S8-A3 совместимость: строка без entry_type (null) трактуется как primary', async () => {
  const dispatchBatchCalls = [];

  const legacyRow = {
    id: 77,
    azs_id: 'azs-legacy',
    admin_user_id: 300,
    plan_date: '2026-06-20',
    base_time: '0900',
    execute_at: new Date('2026-06-20T06:00:00.000Z'),
    jitter_minutes: 0
    // entry_type: undefined/null — нет поля
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [legacyRow],
      markDispatched: () => {}
    }),
    dispatchLogStore: makeLogStore(),
    reportsStore: makeReportsStore({ status: 'new' }),
    notificationService: { async notify() {}, async notifyDispatch() {} },
    dispatchService: {
      async dispatchBatch(payload) {
        dispatchBatchCalls.push(payload);
        return {
          summary: { total: 1, created: 1, duplicates: 0, failed: 0 },
          items: [{ ok: true, duplicate: false, reportItemId: 888 }]
        };
      }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T06:05:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(dispatchBatchCalls.length > 0, 'legacy строка (нет entry_type) → обычный dispatchBatch');
});

// ---------------------------------------------------------------------------
// S8-A3 БЛОКЕР 2+3: проверяем lookup getActiveReportForAzsOnDate
// Ключевой тест: lookup должен использовать azsId+planDate (не base_time напоминания)
// ---------------------------------------------------------------------------

test('S8-A3 БЛОКЕР 2+3: lookup использует azsId+planDate (не base_time), находит отчёт первичной точки', async () => {
  const lookupCalls = [];

  // reminder-строка с base_time='1500' (другой, чем у primary '0730')
  const reminderRow = makeReminderDueRow({
    plan_date: '2026-06-20',
    base_time: '1500',   // время напоминания — ОТЛИЧАЕТСЯ от времени сдачи отчёта
    window_index: 1
  });

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [reminderRow],
      markDispatched: () => {}
    }),
    dispatchLogStore: makeLogStore(),
    // reportsStore: отслеживаем параметры вызова
    reportsStore: {
      async getActiveReportForAzsOnDate({ azsId, planDate }) {
        lookupCalls.push({ azsId, planDate });
        // Возвращаем отчёт co статусом 'new' (не сдан)
        return { id: 10, status: 'new', azs_id: azsId, plan_date: planDate };
      }
    },
    notificationService: {
      async notify() {}
    },
    dispatchService: {
      async dispatchBatch() { throw new Error('не должен вызываться'); }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T12:05:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(lookupCalls.length > 0, 'getActiveReportForAzsOnDate был вызван');
  const call = lookupCalls[0];
  // Lookup должен использовать azs_id и plan_date из строки плана
  assert.equal(call.azsId, 'azs-b', 'lookup передаёт azsId из строки плана');
  assert.equal(call.planDate, '2026-06-20', 'lookup передаёт planDate из строки плана');
  // КРИТИЧНО: lookup НЕ должен использовать base_time напоминания в качестве key
  // (это и был баг — поиск по '1500' вместо поиска отчёта по дате)
});

test('S8-A3 БЛОКЕР 2+3: без reportsStore → fallback к notify (безопасный дефолт)', async () => {
  const notifyCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makePlanStore({
      dueRows: [makeReminderDueRow()],
      markDispatched: () => {}
    }),
    dispatchLogStore: makeLogStore(),
    // reportsStore НЕ передан → безопасный дефолт: считаем не сданным → шлём notify
    reportsStore: null,
    notificationService: {
      async notify(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() { throw new Error('не должен вызываться'); }
    },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  // Без reportsStore статус неизвестен → шлём уведомление (безопасный дефолт)
  assert.ok(notifyCalls.length > 0, 'без reportsStore → notify отправляется (безопасный дефолт)');
});
