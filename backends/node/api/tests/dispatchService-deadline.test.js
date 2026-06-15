/**
 * BUG-024: дедлайн = max(плановый, now) + timeout
 *
 * Тесты написаны ДО реализации (TDD / RED-first).
 *
 * Инвариант: deadline должен ВСЕГДА быть не раньше now + timeoutMinutes.
 * При опоздании воркера отчёт не должен рождаться уже просроченным.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchService } from '../src/dispatch/dispatchService.js';

/** Минимальный стор для тестов дедлайна. */
const makeStore = () => {
  let idSeq = 100;
  const markDoneCalls = [];
  return {
    markDoneCalls,
    async reserve() { return { reserved: true, id: ++idSeq }; },
    async markDone(args) { markDoneCalls.push(args); },
    async markFailed() {}
  };
};

/** Минимальные настройки отчёта. */
const makeSettings = (timeoutMinutes = 60) => ({
  report: {
    entityTypeId: 163,
    timeoutMinutes,
    dispatchJitterMinutes: 0,
    fields: {},
    stages: { new: 'DT163_1:NEW' }
  }
});

// ---------------------------------------------------------------------------
// Test A: опоздавший воркер, non-precomputed ветка
// Плановый слот 12:00 UTC, now = 14:00 UTC, timeout = 60 мин.
// BUG: текущий код даст 12:00+60 = 13:00 (прошедшее время).
// FIX: должно быть max(12:00, 14:00)+60 = 14:00+60 = 15:00.
// ---------------------------------------------------------------------------
test('BUG-024-A: late dispatch (non-precomputed) — deadline must be now+timeout, not past', async () => {
  const store = makeStore();
  const now = new Date('2026-06-01T14:00:00.000Z'); // воркер опоздал на 2 ч
  const timeoutMinutes = 60;

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: { async read() { return makeSettings(timeoutMinutes); } },
    bitrixClient: {
      async createReportItem() { return { reportItemId: 5001 }; }
    },
    notificationService: { async notifyDispatch() {} },
    nowFn: () => now,
    rng: () => 0  // jitter = 0 (jitterLimit = 0 by default in makeSettings)
  });

  const candidate = {
    azsId: 'azs-A',
    adminUserId: 1,
    slotDate: '2026-06-01',
    slotHHmm: '1200'   // плановый слот 12:00 UTC
  };

  const settings = makeSettings(timeoutMinutes);
  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'dispatch must succeed');
  assert.equal(store.markDoneCalls.length, 1);

  const { deadlineAt } = store.markDoneCalls[0];
  const expectedDeadline = new Date('2026-06-01T15:00:00.000Z'); // now(14:00) + 60min

  assert.equal(
    deadlineAt.toISOString(),
    expectedDeadline.toISOString(),
    `deadlineAt must be now+timeout (${expectedDeadline.toISOString()}), got ${deadlineAt.toISOString()}`
  );

  // Дополнительная проверка инварианта: дедлайн > now
  assert.ok(
    deadlineAt.getTime() > now.getTime(),
    `deadlineAt (${deadlineAt.toISOString()}) must be after now (${now.toISOString()})`
  );
});

// ---------------------------------------------------------------------------
// Test B: воркер пришёл РАНЬШЕ планового слота — дедлайн = scheduledAt+timeout
// now = 11:00, slot = 12:00, timeout = 60 → deadlineAt = 13:00.
// max(12:00, 11:00) = 12:00; 12:00 + 60 = 13:00.
// ---------------------------------------------------------------------------
test('BUG-024-B: on-time dispatch (non-precomputed) — deadline must be scheduledAt+timeout when slot is future', async () => {
  const store = makeStore();
  const now = new Date('2026-06-01T11:00:00.000Z'); // воркер пришёл до слота
  const timeoutMinutes = 60;

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: { async read() { return makeSettings(timeoutMinutes); } },
    bitrixClient: {
      async createReportItem() { return { reportItemId: 5002 }; }
    },
    notificationService: { async notifyDispatch() {} },
    nowFn: () => now,
    rng: () => 0  // jitter = 0
  });

  const candidate = {
    azsId: 'azs-B',
    adminUserId: 2,
    slotDate: '2026-06-01',
    slotHHmm: '1200'
  };

  const settings = makeSettings(timeoutMinutes);
  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'dispatch must succeed');
  assert.equal(store.markDoneCalls.length, 1);

  const { deadlineAt } = store.markDoneCalls[0];
  const expectedDeadline = new Date('2026-06-01T13:00:00.000Z'); // slot(12:00)+60min

  assert.equal(
    deadlineAt.toISOString(),
    expectedDeadline.toISOString(),
    `deadlineAt must be scheduledAt+timeout (${expectedDeadline.toISOString()}), got ${deadlineAt.toISOString()}`
  );
});

// ---------------------------------------------------------------------------
// Test C: precomputed ветка, scheduledAt в прошлом
// candidate.scheduledAt = 10:00 UTC, now = 14:00 UTC, timeout = 60 мин.
// BUG: текущий код даст 10:00+60 = 11:00 (прошедшее время).
// FIX: max(10:00, 14:00)+60 = 14:00+60 = 15:00.
// ---------------------------------------------------------------------------
test('BUG-024-C: precomputed branch, stale scheduledAt — deadline must be now+timeout, not past', async () => {
  const store = makeStore();
  const now = new Date('2026-06-01T14:00:00.000Z');
  const timeoutMinutes = 60;

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: { async read() { return makeSettings(timeoutMinutes); } },
    bitrixClient: {
      async createReportItem() { return { reportItemId: 5003 }; }
    },
    notificationService: { async notifyDispatch() {} },
    nowFn: () => now,
    rng: () => 0
  });

  const candidate = {
    azsId: 'azs-C',
    adminUserId: 3,
    slotDate: '2026-06-01',
    slotHHmm: '1000',
    scheduledAt: '2026-06-01T10:00:00.000Z',  // в прошлом относительно now
    jitterMinutes: 0
  };

  const settings = makeSettings(timeoutMinutes);
  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'dispatch must succeed');
  assert.equal(store.markDoneCalls.length, 1);

  const { deadlineAt } = store.markDoneCalls[0];
  const expectedDeadline = new Date('2026-06-01T15:00:00.000Z'); // now(14:00)+60min

  assert.equal(
    deadlineAt.toISOString(),
    expectedDeadline.toISOString(),
    `deadlineAt must be now+timeout (${expectedDeadline.toISOString()}), got ${deadlineAt.toISOString()}`
  );

  assert.ok(
    deadlineAt.getTime() > now.getTime(),
    `deadlineAt (${deadlineAt.toISOString()}) must be after now (${now.toISOString()})`
  );
});

// ---------------------------------------------------------------------------
// LOGIC-D2: непредвычисленный dispatch считает слот в таймзоне настроек
//
// Test D: non-precomputed кандидат, timezone='Europe/Moscow' (UTC+3)
// Слот 09:00 по Москве = 06:00 UTC.
// При tz-корректном расчёте scheduledAt/begindate должен быть 06:00 UTC.
// При текущем коде (parseSlotDateTimeUtc) будет 09:00 UTC — БАГ.
// ---------------------------------------------------------------------------
test('LOGIC-D2-D: non-precomputed, timezone=Europe/Moscow → scheduledAt=06:00 UTC (09:00 Moscow)', async () => {
  const markDoneCalls = [];
  const createdReports = [];

  const store = {
    async reserve() { return { reserved: true, id: 200 }; },
    async markDone(args) { markDoneCalls.push(args); },
    async markFailed() {}
  };

  // nowFn is before the slot so effectiveBase = scheduledAt (no late-dispatch distortion)
  const now = new Date('2026-06-10T03:00:00.000Z'); // well before 06:00 UTC
  const timeoutMinutes = 60;

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: { async read() { return {}; } },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 6001 };
      }
    },
    notificationService: { async notifyDispatch() {} },
    nowFn: () => now,
    rng: () => 0 // jitter = 0
  });

  const settings = {
    timezone: 'Europe/Moscow', // UTC+3
    report: {
      entityTypeId: 163,
      timeoutMinutes,
      dispatchJitterMinutes: 0,
      fields: {},
      stages: { new: 'DT163_1:NEW' }
    }
  };

  const candidate = {
    azsId: 'azs-D',
    adminUserId: 10,
    slotDate: '2026-06-10',
    slotHHmm: '0900' // 09:00 Moscow = 06:00 UTC
    // NO scheduledAt → non-precomputed branch
  };

  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'dispatch must succeed');
  assert.equal(markDoneCalls.length, 1);
  assert.equal(createdReports.length, 1);

  // 09:00 Moscow (UTC+3) = 06:00 UTC
  const expectedScheduledAt = '2026-06-10T06:00:00.000Z';
  assert.equal(
    markDoneCalls[0].scheduledAt.toISOString(),
    expectedScheduledAt,
    `scheduledAt must be 06:00 UTC (09:00 Moscow), got ${markDoneCalls[0].scheduledAt.toISOString()}`
  );
  assert.equal(
    createdReports[0].fields.begindate,
    expectedScheduledAt,
    `begindate must be 06:00 UTC (09:00 Moscow), got ${createdReports[0].fields.begindate}`
  );
});

// ---------------------------------------------------------------------------
// Test E: legacy fallback — без timezone (или пустая строка) → поведение UTC
// Слот 09:00, timezone не задан → scheduledAt = 09:00 UTC (прежнее поведение).
// ---------------------------------------------------------------------------
test('LOGIC-D2-E: non-precomputed, no timezone → legacy UTC (scheduledAt=09:00 UTC)', async () => {
  const markDoneCalls = [];
  const createdReports = [];

  const store = {
    async reserve() { return { reserved: true, id: 201 }; },
    async markDone(args) { markDoneCalls.push(args); },
    async markFailed() {}
  };

  const now = new Date('2026-06-10T03:00:00.000Z');

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: { async read() { return {}; } },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 6002 };
      }
    },
    notificationService: { async notifyDispatch() {} },
    nowFn: () => now,
    rng: () => 0
  });

  const settings = {
    // No timezone — legacy UTC path
    report: {
      entityTypeId: 163,
      timeoutMinutes: 60,
      dispatchJitterMinutes: 0,
      fields: {},
      stages: { new: 'DT163_1:NEW' }
    }
  };

  const candidate = {
    azsId: 'azs-E',
    adminUserId: 11,
    slotDate: '2026-06-10',
    slotHHmm: '0900'
    // NO scheduledAt → non-precomputed branch
  };

  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'dispatch must succeed');
  assert.equal(markDoneCalls.length, 1);

  // Without timezone, slot is treated as UTC: 09:00 UTC
  const expectedScheduledAt = '2026-06-10T09:00:00.000Z';
  assert.equal(
    markDoneCalls[0].scheduledAt.toISOString(),
    expectedScheduledAt,
    `scheduledAt must be 09:00 UTC (legacy fallback), got ${markDoneCalls[0].scheduledAt.toISOString()}`
  );
  assert.equal(
    createdReports[0].fields.begindate,
    expectedScheduledAt,
    `begindate must be 09:00 UTC (legacy fallback), got ${createdReports[0].fields.begindate}`
  );
});
