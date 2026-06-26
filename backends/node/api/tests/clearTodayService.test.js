import test from 'node:test';
import assert from 'node:assert/strict';
import { clearToday } from '../src/reports/clearTodayService.js';

const makeDeps = (overrides = {}) => ({
  planDate: '2026-06-26',
  reportsStore: {
    async listNotSubmittedForDate(){ return [{ azsId: 'a1', adminUserId: 11 }, { azsId: 'a2', adminUserId: 12 }]; },
    async cancelNotSubmittedForDate(){ return 2; },
  },
  dispatchPlanStore: { async cancelPlannedForDate(){ return { cancelled: 4 }; } },
  notify: async ({ userId }) => userId === 11 ? { delivered: false, channel: 'undelivered' } : { delivered: true, channel: 'bot' },
  notifyContext: {},
  notifyMessage: 'Задание на фотоотчёт на сегодня отменено.',
  logger: { warn(){}, info(){} },
  ...overrides,
});

test('clearToday cancels reports + slots, notifies, counts delivered correctly, no regenerate', async () => {
  const res = await clearToday(makeDeps());
  assert.equal(res.cancelledReports, 2);
  assert.equal(res.cancelledSlots, 4);
  assert.equal(res.notified, 1);
  assert.equal(res.notifyFailed, 1);
  assert.equal(res.affected, 2);
});

test('clearToday throws without planDate', async () => {
  await assert.rejects(() => clearToday(makeDeps({ planDate: '' })));
});

test('clearToday tolerates missing cancelPlannedForDate (cancelledSlots=0)', async () => {
  const res = await clearToday(makeDeps({ dispatchPlanStore: {} }));
  assert.equal(res.cancelledSlots, 0);
});
