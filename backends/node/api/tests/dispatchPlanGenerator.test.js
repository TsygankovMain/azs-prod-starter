import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExecuteAt,
  normalizeBaseTimes,
  generateDailyPlan
} from '../src/dispatch/dispatchPlanGenerator.js';

// ---------------------------------------------------------------------------
// computeExecuteAt — pure UTC-based time arithmetic
// ---------------------------------------------------------------------------

test('computeExecuteAt: base 09:00 + jitter -143 = 06:37 (no window)', () => {
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: -143,
    workWindow: undefined,
    timezone: 'Europe/Moscow'
  });
  // base = 2026-06-03T09:00:00.000Z, minus 143 min = 2026-06-03T06:37:00.000Z
  assert.equal(executeAt.getUTCHours(), 6);
  assert.equal(executeAt.getUTCMinutes(), 37);
  assert.equal(executeAt.getUTCFullYear(), 2026);
  assert.equal(executeAt.getUTCMonth(), 5); // June
  assert.equal(executeAt.getUTCDate(), 3);
});

test('computeExecuteAt: base 09:00 + jitter +200 = 12:20 (no window)', () => {
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: 200,
    workWindow: undefined,
    timezone: 'Europe/Moscow'
  });
  // base = 2026-06-03T09:00:00.000Z, plus 200 min = 2026-06-03T12:20:00.000Z
  assert.equal(executeAt.getUTCHours(), 12);
  assert.equal(executeAt.getUTCMinutes(), 20);
});

// ---------------------------------------------------------------------------
// computeExecuteAt — window clamping
// ---------------------------------------------------------------------------

test('computeExecuteAt: jitter pushes below window start → clamped to start', () => {
  // base 09:00 + jitter -240 = 05:00, window start 07:00 → clamp to 07:00
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: -240,
    workWindow: { start: '07:00', end: '12:00' },
    timezone: 'Europe/Moscow'
  });
  assert.equal(executeAt.getUTCHours(), 7);
  assert.equal(executeAt.getUTCMinutes(), 0);
});

test('computeExecuteAt: jitter pushes above window end → clamped to end', () => {
  // base 09:00 + jitter +240 = 13:00, window end 12:00 → clamp to 12:00
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: 240,
    workWindow: { start: '07:00', end: '12:00' },
    timezone: 'Europe/Moscow'
  });
  assert.equal(executeAt.getUTCHours(), 12);
  assert.equal(executeAt.getUTCMinutes(), 0);
});

test('computeExecuteAt: within window is unchanged', () => {
  // base 09:00 + jitter +30 = 09:30, inside [07:00, 12:00]
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: 30,
    workWindow: { start: '07:00', end: '12:00' },
    timezone: 'Europe/Moscow'
  });
  assert.equal(executeAt.getUTCHours(), 9);
  assert.equal(executeAt.getUTCMinutes(), 30);
});

test('computeExecuteAt: no workWindow → no clamping even at extremes', () => {
  const { executeAt } = computeExecuteAt({
    planDate: '2026-06-03',
    baseTime: '0900',
    jitterMinutes: -600,
    workWindow: undefined,
    timezone: 'Europe/Moscow'
  });
  // 09:00 - 600 min = -1:00 → prev day 23:00 UTC
  assert.equal(executeAt.getUTCHours(), 23);
  assert.equal(executeAt.getUTCDate(), 2);
});

// ---------------------------------------------------------------------------
// normalizeBaseTimes
// ---------------------------------------------------------------------------

test('normalizeBaseTimes: parses HH:MM array → HHMM strings', () => {
  const result = normalizeBaseTimes(['09:00', '12:30']);
  assert.deepEqual(result, ['0900', '1230']);
});

test('normalizeBaseTimes: drops invalid/empty entries', () => {
  const result = normalizeBaseTimes(['09:00', 'not-valid', '', '25:00', '12:30']);
  assert.deepEqual(result, ['0900', '1230']);
});

test('normalizeBaseTimes: handles single-digit hours', () => {
  const result = normalizeBaseTimes(['9:05', '8:00']);
  assert.deepEqual(result, ['0800', '0905']);
});

test('normalizeBaseTimes: deduplicates', () => {
  const result = normalizeBaseTimes(['09:00', '09:00', '12:00']);
  assert.deepEqual(result, ['0900', '1200']);
});

test('normalizeBaseTimes: empty input returns empty array', () => {
  assert.deepEqual(normalizeBaseTimes([]), []);
  assert.deepEqual(normalizeBaseTimes(undefined), []);
});

// ---------------------------------------------------------------------------
// generateDailyPlan
// ---------------------------------------------------------------------------

const makeFakePlanStore = () => ({
  calls: [],
  deleted: null,
  async upsertPlanned(x) {
    this.calls.push({ ...x });
    return x;
  },
  async deletePlannedForDate(x) {
    this.deleted = { ...x };
    return 0;
  }
});

const makeSettings = (overrides = {}) => ({
  timezone: 'Europe/Moscow',
  report: {
    dispatchTimes: ['09:00', '12:00'],
    dispatchJitterMinutes: 15,
    workWindow: { start: '07:00', end: '14:00' },
    ...overrides.report
  },
  ...overrides
});

const candidates2 = [
  { azsId: 'azs-1', adminUserId: 101 },
  { azsId: 'azs-2', adminUserId: 102 }
];

test('generateDailyPlan: 2 candidates × 2 baseTimes → 4 upserts', async () => {
  const store = makeFakePlanStore();
  const summary = await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: candidates2,
    settings: makeSettings(),
    planStore: store
  });
  assert.equal(store.calls.length, 4);
  assert.equal(summary.planned, 4);
  assert.equal(summary.azsCount, 2);
  assert.deepEqual(summary.baseTimes, ['0900', '1200']);
  assert.equal(summary.planDate, '2026-06-03');
});

test('generateDailyPlan: each upsert has correct planDate, azsId, baseTime', async () => {
  const store = makeFakePlanStore();
  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: candidates2,
    settings: makeSettings(),
    planStore: store
  });

  for (const call of store.calls) {
    assert.equal(call.planDate, '2026-06-03');
    assert.ok(['azs-1', 'azs-2'].includes(call.azsId));
    assert.ok(['0900', '1200'].includes(call.baseTime));
    assert.ok(call.executeAt instanceof Date, 'executeAt must be a Date');
    assert.ok(Number.isInteger(call.jitterMinutes), 'jitterMinutes must be integer');
    assert.ok(call.jitterMinutes >= -15 && call.jitterMinutes <= 15, 'jitterMinutes within [-N,+N]');
  }
});

test('generateDailyPlan: deterministic rng advances per call → different candidates get different jitter', async () => {
  const store = makeFakePlanStore();
  // Produce a sequence 0.1, 0.3, 0.5, 0.7 for four calls
  const sequence = [0.1, 0.3, 0.5, 0.7];
  let idx = 0;
  const rng = () => sequence[idx++];

  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: candidates2,
    settings: makeSettings({ report: { dispatchTimes: ['09:00'], dispatchJitterMinutes: 15 } }),
    planStore: store,
    rng
  });

  assert.equal(store.calls.length, 2);
  // All jitter values come from rng, they must not all be identical given distinct rng outputs
  const jitters = store.calls.map((c) => c.jitterMinutes);
  // With different rng values (0.1 vs 0.3) the jitters differ
  assert.notEqual(jitters[0], jitters[1]);
});

test('generateDailyPlan: regenerate=true calls deletePlannedForDate before upserts', async () => {
  const store = makeFakePlanStore();
  const deleteOrder = [];
  const upsertOrder = [];

  const trackingStore = {
    calls: [],
    deleted: null,
    async upsertPlanned(x) {
      upsertOrder.push('upsert');
      this.calls.push({ ...x });
      return x;
    },
    async deletePlannedForDate(x) {
      deleteOrder.push('delete');
      this.deleted = { ...x };
      return 0;
    }
  };

  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: [{ azsId: 'azs-1', adminUserId: 101 }],
    settings: makeSettings({ report: { dispatchTimes: ['09:00'], dispatchJitterMinutes: 0 } }),
    planStore: trackingStore,
    regenerate: true
  });

  assert.ok(trackingStore.deleted !== null, 'deletePlannedForDate was called');
  assert.equal(trackingStore.deleted.planDate, '2026-06-03');
  // delete happened before upserts
  assert.equal(deleteOrder[0], 'delete');
  assert.equal(upsertOrder[0], 'upsert');
});

test('generateDailyPlan: regenerate=false does NOT call deletePlannedForDate', async () => {
  const store = makeFakePlanStore();
  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: candidates2,
    settings: makeSettings(),
    planStore: store,
    regenerate: false
  });
  assert.equal(store.deleted, null);
});

test('generateDailyPlan: candidate with adminUserId=0 is skipped', async () => {
  const store = makeFakePlanStore();
  const warnings = [];
  const logger = {
    warn(...args) { warnings.push(args); },
    info() {},
    error() {}
  };

  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: [
      { azsId: 'azs-1', adminUserId: 0 },   // invalid
      { azsId: 'azs-2', adminUserId: 102 }   // valid
    ],
    settings: makeSettings({ report: { dispatchTimes: ['09:00'], dispatchJitterMinutes: 0 } }),
    planStore: store,
    logger
  });

  // Only azs-2 was upserted
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].azsId, 'azs-2');
  // A warning was logged
  assert.ok(warnings.length > 0, 'should have logged a warning for invalid candidate');
});

test('generateDailyPlan: candidate without azsId is skipped', async () => {
  const store = makeFakePlanStore();
  const warnings = [];
  const logger = {
    warn(...args) { warnings.push(args); },
    info() {},
    error() {}
  };

  await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: [
      { azsId: '', adminUserId: 101 },        // missing azsId
      { azsId: 'azs-2', adminUserId: 102 }    // valid
    ],
    settings: makeSettings({ report: { dispatchTimes: ['09:00'], dispatchJitterMinutes: 0 } }),
    planStore: store,
    logger
  });

  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].azsId, 'azs-2');
  assert.ok(warnings.length > 0);
});

test('generateDailyPlan: no baseTimes → 0 upserts, empty baseTimes in summary', async () => {
  const store = makeFakePlanStore();
  const summary = await generateDailyPlan({
    planDate: '2026-06-03',
    candidates: candidates2,
    settings: makeSettings({ report: { dispatchTimes: [], dispatchJitterMinutes: 0 } }),
    planStore: store
  });
  assert.equal(store.calls.length, 0);
  assert.equal(summary.planned, 0);
  assert.deepEqual(summary.baseTimes, []);
});
