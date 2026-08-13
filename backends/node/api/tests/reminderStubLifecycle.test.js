/**
 * Строки напоминаний копились в dispatch_log навсегда.
 *
 * Исполнитель напоминаний резервирует строку перед отправкой, но закрывает
 * потом только точку плана — сама строка остаётся 'reserved' без карточки
 * смарт-процесса. На проде их накопилось 336 на 70 АЗС за шесть дней, и
 * оператор видел их вместо своего отчёта: 6 и 9 августа на АЗС 33231 в такую
 * пустышку загрузили по 29 фото, синхронизация с CRM упала с
 * «reportItemId is missing or invalid», отчёт до проверяющего не дошёл.
 *
 * Строку нельзя удалять — она держит идемпотентность: reserve() по тому же
 * slot_key должен не пройти, иначе напоминание уйдёт повторно. Поэтому после
 * обработки она переводится в терминальный статус: 'cancelled' при штатной
 * отправке и при пропуске, 'failed' с текстом ошибки при сорванной отправке.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchScheduler } from '../src/dispatch/dispatchScheduler.js';


const reminderRow = {
  id: 100,
  azs_id: 'azs-b',
  admin_user_id: 201,
  plan_date: '2026-06-20',
  base_time: '1430',
  execute_at: new Date('2026-06-20T11:30:00.000Z'),
  jitter_minutes: 0,
  entry_type: 'reminder',
  window_index: 1
};

const makeScheduler = ({ reportStatus, cancelledCalls }) => createDispatchScheduler({
  dispatchService: { async dispatchBatch() { return { items: [{ ok: true }] }; } },
  getCandidates: async () => [],
  settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
  getRuntimeContext: async () => ({ authId: 'tok' }),
  getBackgroundContext: async () => ({ authId: 'tok' }),
  dispatchPlanStore: {
    async listDue() { return [reminderRow]; },
    async listByDate() { return [{ id: 1 }]; },
    async markDispatched() {},
    async markFailed() {},
    async ensureSchema() {}
  },
  dispatchLogStore: {
    async reserve() { return { reserved: true, id: 555 }; },
    async markFailed() {},
    async markCancelled(args) { cancelledCalls.push(args); },
    async listStalePlanned() { return []; }
  },
  reportsStore: {
    async getActiveReportForAzsOnDate() { return { status: reportStatus }; }
  },
  notificationService: { async notify() {}, async notifyDispatch() {} },
  generateDailyPlan: async () => ({ planned: 0 })
});

test('после отправки напоминания его строка в журнале закрывается', async () => {
  const cancelledCalls = [];
  const scheduler = makeScheduler({ reportStatus: 'new', cancelledCalls });

  await scheduler.runOnce();

  assert.equal(cancelledCalls.length, 1, 'строка напоминания должна закрываться, иначе копится в reserved');
  assert.equal(cancelledCalls[0].id, 555);
});

test('после пропуска напоминания (отчёт сдан) его строка тоже закрывается', async () => {
  const cancelledCalls = [];
  const scheduler = makeScheduler({ reportStatus: 'done', cancelledCalls });

  await scheduler.runOnce();

  assert.equal(cancelledCalls.length, 1, 'пропущенное напоминание оставляло строку в reserved навсегда');
});

test('сорванная отправка напоминания тоже не оставляет строку в reserved', async () => {
  const failedCalls = [];
  const scheduler = createDispatchScheduler({
    dispatchService: { async dispatchBatch() { return { items: [{ ok: true }] }; } },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'Europe/Moscow' }; } },
    getRuntimeContext: async () => ({ authId: 'tok' }),
    getBackgroundContext: async () => ({ authId: 'tok' }),
    dispatchPlanStore: {
      async listDue() { return [reminderRow]; },
      async listByDate() { return [{ id: 1 }]; },
      async markDispatched() {},
      async markFailed() {},
      async ensureSchema() {}
    },
    dispatchLogStore: {
      async reserve() { return { reserved: true, id: 777 }; },
      async markFailed(args) { failedCalls.push(args); },
      async markCancelled() {},
      async listStalePlanned() { return []; }
    },
    reportsStore: { async getActiveReportForAzsOnDate() { return { status: 'new' }; } },
    notificationService: {
      async notify() { throw new Error('bot unavailable'); },
      async notifyDispatch() {}
    },
    generateDailyPlan: async () => ({ planned: 0 })
  });

  await scheduler.runOnce();

  assert.equal(failedCalls.length, 1, 'при сбое отправки строка журнала должна закрываться как failed');
  assert.equal(failedCalls[0].id, 777);
});
