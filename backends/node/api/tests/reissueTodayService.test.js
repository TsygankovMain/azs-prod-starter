import test from 'node:test';
import assert from 'node:assert/strict';
import { reissueToday } from '../src/reports/reissueTodayService.js';

const makeDeps = (over = {}) => {
  const notifyCalls = [];
  const genCalls = [];
  const deps = {
    planDate: '2026-06-26',
    reportsStore: {
      async listNotSubmittedForDate() {
        return [
          { id: 1, azsId: '101', adminUserId: 11, reportItemId: null, status: 'new' },
          { id: 2, azsId: '102', adminUserId: 12, reportItemId: null, status: 'reserved' },
          { id: 3, azsId: '101', adminUserId: 11, reportItemId: null, status: 'expired' },
        ];
      },
      async listSubmittedAzsForDate() { return ['103']; },
      async cancelNotSubmittedForDate() { return 3; },
    },
    dispatchPlanStore: {},
    settings: { timezone: 'Europe/Moscow' },
    candidates: [
      { azsId: '101', adminUserId: 11 },
      { azsId: '102', adminUserId: 12 },
      { azsId: '103', adminUserId: 13 },
    ],
    notify: async (a) => { notifyCalls.push(a); },
    notifyContext: { authId: 'x' },
    generateDailyPlan: async (a) => { genCalls.push(a); return { planned: a.candidates.length }; },
    logger: { warn() {} },
    ...over,
  };
  return { deps, notifyCalls, genCalls };
};

test('dryRun: считает, ничего не меняет', async () => {
  let cancelled = false;
  const { deps, notifyCalls, genCalls } = makeDeps({
    reportsStore: {
      async listNotSubmittedForDate() { return [{ id: 1, azsId: '101', adminUserId: 11, reportItemId: null, status: 'new' }]; },
      async listSubmittedAzsForDate() { return ['103']; },
      async cancelNotSubmittedForDate() { cancelled = true; return 1; },
    },
  });
  const r = await reissueToday({ ...deps, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.affected, 1);
  assert.equal(r.azsAffected, 1);
  assert.equal(r.submittedKept, 1);
  assert.equal(r.skippedSubmittedAzs, 1); // 103 уже сдал → не пересоздаём
  assert.equal(r.willRegenerate, 2);      // 101,102
  assert.equal(cancelled, false);
  assert.equal(notifyCalls.length, 0);
  assert.equal(genCalls.length, 0);
});

test('execute: отмена + дедуп-уведомления + пропуск сдавших + регенерация', async () => {
  const { deps, notifyCalls, genCalls } = makeDeps();
  const r = await reissueToday({ ...deps, dryRun: false });
  assert.equal(r.cancelled, 3);
  assert.equal(r.notified, 2);                       // users 11,12 (11 дедуплицирован)
  assert.equal(r.notifyFailed, 0);
  assert.deepEqual(notifyCalls.map((c) => c.userId).sort(), [11, 12]);
  assert.equal(genCalls.length, 1);
  assert.deepEqual(genCalls[0].candidates.map((c) => c.azsId).sort(), ['101', '102']); // без 103
  assert.equal(genCalls[0].regenerate, true);
  assert.equal(r.regenerated, 2);
  assert.equal(r.skippedSubmittedAzs, 1);
});

test('execute: сбой одного уведомления не валит операцию (best-effort)', async () => {
  const { deps } = makeDeps({ notify: async (a) => { if (a.userId === 12) throw new Error('boom'); } });
  const r = await reissueToday({ ...deps, dryRun: false });
  assert.equal(r.notified, 1);
  assert.equal(r.notifyFailed, 1);
  assert.equal(r.regenerated, 2); // регенерация всё равно прошла
});
