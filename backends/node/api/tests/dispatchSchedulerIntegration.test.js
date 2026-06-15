/**
 * S8-БЛОКЕР #4 — интеграционный тест планировщика рассылки с профилями.
 *
 * Строит createDispatchScheduler с зависимостями ТОЧНО как в server.js
 * (reportsStore, dispatchLogStore, dispatchPlanStore, settingsStore — реальные
 * интерфейсы, без «всё фейк»).
 *
 * Ловит:
 *   (а) БЛОКЕР #1: reminder по СДАННОМУ отчёту НЕ шлётся
 *       (getActiveReportForAzsOnDate реально вызывается — не null-заглушка)
 *   (б) БЛОКЕР #2: primary режима B получает дедлайн = конец окна (deadlineOverride
 *       проходит от row.deadline_at → candidate.deadlineAt → dispatchCandidate)
 *
 * Тест ДОЛЖЕН ПАДАТЬ на коде до фиксов #1/#2 и проходить после.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchScheduler } from '../src/dispatch/dispatchScheduler.js';

// ---------------------------------------------------------------------------
// Фабрики «максимально близких к реальным» стор-объектов
// Интерфейсы соответствуют createReportsStore / createDispatchLogStore /
// createDispatchPlanStore / createSettingsStore из src/
// ---------------------------------------------------------------------------

/**
 * reportsStore — реальный интерфейс: getActiveReportForAzsOnDate(azsId, planDate).
 * В server.js используется createReportsStore({ pool, dbType }).
 * Здесь — in-memory реализация с той же сигнатурой.
 */
const makeRealishReportsStore = ({ reportsByKey = {} } = {}) => ({
  // Ключ поиска: `${azsId}:${planDate}`
  async getActiveReportForAzsOnDate({ azsId, planDate }) {
    const key = `${azsId}:${planDate}`;
    return reportsByKey[key] ?? null;
  }
});

/**
 * dispatchLogStore — реальный интерфейс: reserve, listStalePlanned, markDone,
 * markFailed, appendErrorText.
 * В server.js используется createDispatchLogStore({ pool, dbType }).
 * Здесь — in-memory с тем же контрактом reserve().
 */
const makeRealishDispatchLogStore = ({ reserveShouldFail = false } = {}) => {
  const slots = new Map(); // slotKey -> { reserved, id }
  let idSeq = 1000;
  return {
    async reserve({ slotKey, azsId, adminUserId, status }) {
      if (reserveShouldFail) {
        throw new Error('reserve: simulated DB error');
      }
      if (slots.has(slotKey)) {
        return { reserved: false, id: null };
      }
      const id = ++idSeq;
      slots.set(slotKey, { id, azsId, adminUserId, status });
      return { reserved: true, id };
    },
    async listStalePlanned() { return []; },
    async markDone() {},
    async markFailed() {}
  };
};

/**
 * dispatchPlanStore — реальный интерфейс: listDue, listByDate, markDispatched,
 * markFailed, ensureSchema.
 * В server.js используется createDispatchPlanStore({ pool, dbType }).
 */
const makeRealishPlanStore = ({ dueRows = [], onMarkDispatched = null, onMarkFailed = null } = {}) => ({
  async ensureSchema() {},
  async listDue() { return dueRows; },
  async listByDate() { return []; },
  async markDispatched(args) { onMarkDispatched?.(args); },
  async markFailed(args) { onMarkFailed?.(args); }
});

/**
 * settingsStore — реальный интерфейс: read().
 * В server.js используется createSettingsStore({ pool, dbType }).
 */
const makeRealishSettingsStore = (settings = {}) => ({
  async read() {
    return {
      timezone: 'Europe/Moscow',
      report: { timeoutMinutes: 60, dispatchJitterMinutes: 0, entityTypeId: 163, fields: {}, stages: { new: 'DT163_1:NEW' } },
      ...settings
    };
  }
});

// ---------------------------------------------------------------------------
// ИНТЕГРАЦИОННЫЙ ТЕСТ А:
// Reminder по СДАННОМУ отчёту НЕ шлётся.
// До фикса #1: reportsStore не передавался в scheduler → reportStatus всегда
// null → reminder всегда шёл, даже когда отчёт уже сдан.
// После фикса #1: getActiveReportForAzsOnDate реально вызывается → status='done'
// → reminder пропускается.
// ---------------------------------------------------------------------------
test('ИНТЕГРАЦИЯ БЛОКЕР #1: reminder + reportsStore.getActiveReportForAzsOnDate реально вызывается — сданный отчёт (done) блокирует уведомление', async () => {
  const notifyCalls = [];
  const markDispatchedArgs = [];

  // Строим «сданный» отчёт в in-memory стор
  const reportsStore = makeRealishReportsStore({
    reportsByKey: {
      'azs-42:2026-06-20': { id: 777, status: 'done', azs_id: 'azs-42', slot_key: '2026-06-20:0730' }
    }
  });

  // Проверяем что getActiveReportForAzsOnDate реально вызывается (не закорочено null-стором)
  const lookupCalls = [];
  const spyReportsStore = {
    async getActiveReportForAzsOnDate(args) {
      lookupCalls.push(args);
      return reportsStore.getActiveReportForAzsOnDate(args);
    }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    // dispatchPlanStore с одной reminder-строкой для azs-42 / 2026-06-20
    dispatchPlanStore: makeRealishPlanStore({
      dueRows: [{
        id: 100,
        azs_id: 'azs-42',
        admin_user_id: 201,
        plan_date: '2026-06-20',
        base_time: '1430',
        execute_at: new Date('2026-06-20T11:30:00.000Z'),
        jitter_minutes: 0,
        entry_type: 'reminder',
        window_index: 1,
        deadline_at: null
      }],
      onMarkDispatched: (a) => markDispatchedArgs.push(a)
    }),
    // КЛЮЧЕВОЙ МОМЕНТ: реальные интерфейсные стор-объекты
    reportsStore: spyReportsStore,
    dispatchLogStore: makeRealishDispatchLogStore(),
    settingsStore: makeRealishSettingsStore(),
    getCandidates: async () => [],
    getRuntimeContext: async () => ({ authId: 'tok-admin', domain: 'test.bitrix24.ru', memberId: 'm1', userId: 1 }),
    notificationService: {
      async notify(args) { notifyCalls.push(args); },
      async notifyDispatch(args) { notifyCalls.push(args); }
    },
    dispatchService: {
      async dispatchBatch() {
        throw new Error('dispatchBatch не должен вызываться для reminder');
      }
    },
    nowFn: () => new Date('2026-06-20T11:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  // КРИТИЧНО: getActiveReportForAzsOnDate должен был быть вызван (не пропущен)
  assert.ok(lookupCalls.length > 0,
    'БЛОКЕР #1: getActiveReportForAzsOnDate должен вызываться — до фикса reportsStore не передавался в scheduler и метод никогда не вызывался');

  // Проверяем что lookup использует правильные параметры (azsId + planDate)
  assert.equal(lookupCalls[0].azsId, 'azs-42', 'lookup передаёт правильный azsId');
  assert.equal(lookupCalls[0].planDate, '2026-06-20', 'lookup передаёт правильный planDate');

  // Отчёт сдан → notify НЕ должен вызываться
  assert.equal(notifyCalls.length, 0,
    `БЛОКЕР #1: notify не должен вызываться когда отчёт сдан (done), но было вызовов: ${notifyCalls.length}`);

  // Reminder-строка должна быть помечена как обработанная (skipped)
  assert.ok(markDispatchedArgs.length > 0,
    'reminder-строка должна быть помечена через markDispatched (skipped)');
  assert.equal(markDispatchedArgs[0].id, 100, 'markDispatched вызван для строки id=100');
});

// ---------------------------------------------------------------------------
// ИНТЕГРАЦИОННЫЙ ТЕСТ Б:
// Primary режима B получает дедлайн = конец окна (deadlineOverride).
// До фикса #2: row.deadline_at не прокидывался в candidate → dispatchCandidate
// использовал max(scheduledAt,now)+timeout → неверный дедлайн для режима B.
// После фикса #2: candidate.deadlineAt = row.deadline_at → dispatchCandidate
// использует его как дедлайн отчёта (watcher бракует не раньше конца окна).
// ---------------------------------------------------------------------------
test('ИНТЕГРАЦИЯ БЛОКЕР #2 (AC-13): primary режима B получает дедлайн = конец последнего окна (deadlineOverride проходит)', async () => {
  const dispatchCandidateCalls = [];
  const markDispatchedArgs = [];

  // deadline_at плановой строки = конец последнего окна эскалации режима B
  // (например: окна 07:30-09:30-11:30, дедлайн = 11:30 → 13:30 UTC в зависимости от TZ)
  const modeBDeadlineAt = new Date('2026-06-20T08:30:00.000Z'); // конец последнего окна

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makeRealishPlanStore({
      dueRows: [{
        id: 50,
        azs_id: 'azs-b',
        admin_user_id: 301,
        plan_date: '2026-06-20',
        base_time: '0730',
        execute_at: new Date('2026-06-20T04:30:00.000Z'),
        jitter_minutes: 0,
        entry_type: 'primary',
        window_index: 0,
        // КЛЮЧЕВОЕ ПОЛЕ: deadline_at из dispatch_plan (конец последнего окна)
        deadline_at: modeBDeadlineAt
      }],
      onMarkDispatched: (a) => markDispatchedArgs.push(a)
    }),
    reportsStore: makeRealishReportsStore(),      // реальный интерфейс
    dispatchLogStore: makeRealishDispatchLogStore(), // реальный интерфейс
    settingsStore: makeRealishSettingsStore(),
    getCandidates: async () => [],
    getRuntimeContext: async () => ({ authId: 'tok-admin', domain: 'test.bitrix24.ru', memberId: 'm1', userId: 1 }),
    notificationService: {
      async notify() {},
      async notifyDispatch() {}
    },
    // dispatchService: шпионим за dispatchCandidate через dispatchBatch
    dispatchService: {
      async dispatchBatch({ candidates, trigger, context }) {
        // Сохраняем кандидатов для проверки
        for (const c of candidates) {
          dispatchCandidateCalls.push(c);
        }
        return {
          summary: { total: 1, created: 1, duplicates: 0, failed: 0 },
          items: [{ ok: true, duplicate: false, reportItemId: 9001 }]
        };
      }
    },
    nowFn: () => new Date('2026-06-20T04:35:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(dispatchCandidateCalls.length > 0,
    'БЛОКЕР #2: dispatchBatch должен быть вызван для primary-строки');

  const candidate = dispatchCandidateCalls[0];

  // КРИТИЧНО: candidate должен нести deadlineAt = row.deadline_at из плана
  // До фикса: deadlineAt не прокидывался → candidate.deadlineAt === undefined
  assert.ok(
    candidate.deadlineAt !== undefined && candidate.deadlineAt !== null,
    `БЛОКЕР #2: candidate.deadlineAt должен быть задан (не undefined/null). Получено: ${candidate.deadlineAt}`
  );

  const passedDeadline = new Date(candidate.deadlineAt);
  assert.equal(
    passedDeadline.toISOString(),
    modeBDeadlineAt.toISOString(),
    `БЛОКЕР #2 (AC-13): candidate.deadlineAt должен = конец последнего окна (${modeBDeadlineAt.toISOString()}), получено ${passedDeadline.toISOString()}`
  );

  // Строка должна быть помечена dispatched
  assert.ok(markDispatchedArgs.length > 0, 'primary-строка помечена через markDispatched');
  assert.equal(markDispatchedArgs[0].id, 50, 'markDispatched вызван для строки id=50');
});

// ---------------------------------------------------------------------------
// ИНТЕГРАЦИОННЫЙ ТЕСТ В:
// Режим A (без deadline_at) — deadlineOverride НЕ применяется, дедлайн = BUG-024.
// Проверяем отсутствие регресса для не-профильных АЗС.
// ---------------------------------------------------------------------------
test('ИНТЕГРАЦИЯ регресс A: primary без deadline_at (режим A) → candidate.deadlineAt = null (прежняя формула BUG-024)', async () => {
  const dispatchCandidateCalls = [];

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: makeRealishPlanStore({
      dueRows: [{
        id: 51,
        azs_id: 'azs-a',
        admin_user_id: 302,
        plan_date: '2026-06-20',
        base_time: '0800',
        execute_at: new Date('2026-06-20T05:00:00.000Z'),
        jitter_minutes: 0,
        entry_type: 'primary',
        window_index: 0,
        deadline_at: null   // режим A — нет переопределения дедлайна
      }],
      onMarkDispatched: () => {}
    }),
    reportsStore: makeRealishReportsStore(),
    dispatchLogStore: makeRealishDispatchLogStore(),
    settingsStore: makeRealishSettingsStore(),
    getCandidates: async () => [],
    getRuntimeContext: async () => ({ authId: 'tok-admin', domain: 'test.bitrix24.ru', memberId: 'm1', userId: 1 }),
    notificationService: { async notify() {}, async notifyDispatch() {} },
    dispatchService: {
      async dispatchBatch({ candidates }) {
        for (const c of candidates) dispatchCandidateCalls.push(c);
        return { summary: { total: 1, created: 1, duplicates: 0, failed: 0 }, items: [{ ok: true, duplicate: false, reportItemId: 9002 }] };
      }
    },
    nowFn: () => new Date('2026-06-20T05:05:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  await scheduler.runOnce();

  assert.ok(dispatchCandidateCalls.length > 0, 'dispatchBatch вызван для режима A');
  const candidate = dispatchCandidateCalls[0];

  // Для режима A: deadline_at=null → candidate.deadlineAt = null → BUG-024 формула в dispatchCandidate
  assert.equal(
    candidate.deadlineAt,
    null,
    `регресс A: candidate.deadlineAt должен быть null для режима A (нет deadline_at в плане). Получено: ${candidate.deadlineAt}`
  );
});
