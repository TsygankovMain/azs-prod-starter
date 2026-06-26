import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDailyPlan } from '../src/dispatch/dispatchPlanGenerator.js';

const makeStore = () => {
  const rows = [];
  return {
    rows,
    async deletePlannedForDate() {},
    async upsertPlanned(row) { rows.push(row); return { id: rows.length }; },
  };
};

const hhmmToMin = (s) => { const t = String(s).replace(':',''); return Number(t.slice(0,2))*60 + Number(t.slice(2)); };

test('window-only mode: no dispatchTimes + valid workWindow → one random-in-window row per AZS', async () => {
  const store = makeStore();
  const settings = { timezone: 'Europe/Moscow', report: { dispatchTimes: [], workWindow: { start: '06:00', end: '09:00' } } };
  const candidates = [
    { azsId: 'a1', adminUserId: 11 },
    { azsId: 'a2', adminUserId: 12 },
  ];
  const res = await generateDailyPlan({ planDate: '2026-06-27', candidates, settings, planStore: store, regenerate: true });
  assert.equal(res.planned, 2);
  assert.equal(store.rows.length, 2);
  for (const row of store.rows) {
    const m = hhmmToMin(row.baseTime);
    assert.ok(m >= hhmmToMin('06:00') && m <= hhmmToMin('09:00'), `baseTime ${row.baseTime} must be within 06:00-09:00`);
    assert.ok(row.executeAt, 'executeAt present');
  }
  // deterministic per AZS: same AZS → same moment on regeneration
  const store2 = makeStore();
  await generateDailyPlan({ planDate: '2026-06-27', candidates, settings, planStore: store2, regenerate: true });
  assert.equal(store2.rows[0].baseTime, store.rows[0].baseTime);
});

test('backward compatible: dispatchTimes present → fixed-times behavior (window-mode NOT used)', async () => {
  const store = makeStore();
  const settings = { timezone: 'Europe/Moscow', report: { dispatchTimes: ['06:00','12:00'], dispatchJitterMinutes: 0, workWindow: { start: '06:00', end: '23:00' } } };
  const candidates = [{ azsId: 'a1', adminUserId: 11 }];
  const res = await generateDailyPlan({ planDate: '2026-06-27', candidates, settings, planStore: store, regenerate: true });
  // two fixed times → two rows (existing behavior)
  assert.equal(res.planned, 2);
});

test('window-only with no workWindow and no times → zero rows (no crash)', async () => {
  const store = makeStore();
  const settings = { timezone: 'Europe/Moscow', report: { dispatchTimes: [], workWindow: undefined } };
  const res = await generateDailyPlan({ planDate: '2026-06-27', candidates: [{ azsId: 'a1', adminUserId: 11 }], settings, planStore: store, regenerate: true });
  assert.equal(res.planned, 0);
});
