import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchScheduler, assertDispatchAvailable } from '../src/dispatch/dispatchScheduler.js';

test('dispatch scheduler runs only on configured slot and maps slotDate/slotHHmm', async () => {
  const calls = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false, // legacy slot-dispatch path under test
    dispatchService: {
      async dispatchBatch(payload) {
        calls.push(payload);
        return {
          summary: { total: payload.candidates.length, created: payload.candidates.length, duplicates: 0, failed: 0 },
          items: []
        };
      }
    },
    getCandidates: async () => ([
      { azsId: '2', adminUserId: 11 }
    ]),
    settingsStore: {
      async read() {
        return {
          report: {
            dispatchTimes: ['18:45']
          },
          timezone: 'Europe/Moscow'
        };
      }
    },
    getRuntimeContext: async () => ({
      authId: 'test-access',
      refreshToken: 'test-refresh',
      domain: 'nfr-mainsoft.bitrix24.ru',
      memberId: 'm1',
      userId: 1
    }),
    nowFn: () => new Date('2026-04-30T15:45:00.000Z') // 18:45 MSK
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.created, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].slotHHmm, '1845');
  assert.equal(calls[0].candidates[0].slotDate, '2026-04-30');
});

test('dispatch scheduler can build auto candidates from AZS crm rows with uppercase ID', async () => {
  const calls = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false, // legacy slot-dispatch path under test
    dispatchService: {
      async dispatchBatch(payload) {
        calls.push(payload);
        return {
          summary: { total: payload.candidates.length, created: payload.candidates.length, duplicates: 0, failed: 0 },
          items: []
        };
      }
    },
    getCandidates: async () => [],
    settingsStore: {
      async read() {
        return {
          azs: {
            entityTypeId: 1114,
            fields: {
              admin: 'UF_ADMIN',
              enabled: 'UF_ENABLED'
            }
          },
          report: {
            dispatchTimes: ['18:45']
          },
          timezone: 'Europe/Moscow'
        };
      }
    },
    bitrixClient: {
      async listCrmItems() {
        return [
          { ID: 2, UF_ADMIN: 11, UF_ENABLED: 'Y' }
        ];
      }
    },
    getRuntimeContext: async () => ({
      authId: 'test-access',
      refreshToken: 'test-refresh',
      domain: 'nfr-mainsoft.bitrix24.ru',
      memberId: 'm1',
      userId: 1
    }),
    nowFn: () => new Date('2026-04-30T15:45:00.000Z')
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.created, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].azsId, '2');
  assert.equal(calls[0].candidates[0].adminUserId, 11);
});

test('flag OFF → planStore is never touched even if injected', async () => {
  const planStoreGuard = {
    async ensureSchema() { throw new Error('planStore.ensureSchema must not be called when flag OFF'); },
    async listDue() { throw new Error('planStore.listDue must not be called when flag OFF'); },
    async markDispatched() { throw new Error('planStore.markDispatched must not be called when flag OFF'); },
    async markFailed() { throw new Error('planStore.markFailed must not be called when flag OFF'); }
  };
  const calls = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false,
    dispatchPlanStore: planStoreGuard,
    dispatchService: {
      async dispatchBatch(payload) {
        calls.push(payload);
        return {
          summary: { total: payload.candidates.length, created: payload.candidates.length, duplicates: 0, failed: 0 },
          items: []
        };
      }
    },
    getCandidates: async () => ([{ azsId: '5', adminUserId: 7 }]),
    settingsStore: {
      async read() {
        return { report: { dispatchTimes: ['09:00'] }, timezone: 'UTC' };
      }
    },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-03T09:00:00.000Z')
  });

  const result = await scheduler.runOnce();
  // Old behavior: dispatched at the slot
  assert.equal(result.summary.created, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].slotHHmm, '0900');
  // planStore was never touched (would have thrown above)
});

test('default (env unset) → plan mode is ON; runOnce takes the plan-execute path', async () => {
  const prev = process.env.DISPATCH_PLAN_MODE_ENABLED;
  delete process.env.DISPATCH_PLAN_MODE_ENABLED; // simulate prod with no explicit flag
  try {
    let listDueCalled = false;
    const scheduler = createDispatchScheduler({
      enabled: false,
      // planModeEnabled intentionally NOT passed → falls back to env default (on)
      dispatchPlanStore: {
        async listDue() { listDueCalled = true; return []; },
        async markDispatched() {},
        async markFailed() {}
      },
      dispatchService: {
        async dispatchBatch() { throw new Error('old slot path must not run when plan mode default-on'); }
      },
      getCandidates: async () => { throw new Error('getCandidates (old path) must not run'); },
      settingsStore: { async read() { return { report: { dispatchTimes: ['09:00'] }, timezone: 'UTC' }; } },
      getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
      nowFn: () => new Date('2026-06-03T09:00:00.000Z')
    });

    const result = await scheduler.runOnce();
    // Plan path ran: listDue consulted, no due rows → zero executed, old path untouched
    assert.equal(listDueCalled, true, 'plan executor must run by default');
    assert.equal(result.due, 0);
  } finally {
    if (prev === undefined) delete process.env.DISPATCH_PLAN_MODE_ENABLED;
    else process.env.DISPATCH_PLAN_MODE_ENABLED = prev;
  }
});

test('DISPATCH_PLAN_MODE_ENABLED=false → reverts to legacy slot dispatch', async () => {
  const prev = process.env.DISPATCH_PLAN_MODE_ENABLED;
  process.env.DISPATCH_PLAN_MODE_ENABLED = 'false';
  try {
    const calls = [];
    const scheduler = createDispatchScheduler({
      enabled: false,
      dispatchPlanStore: {
        async listDue() { throw new Error('listDue must not run when explicitly disabled'); },
        async markDispatched() {}, async markFailed() {}
      },
      dispatchService: {
        async dispatchBatch(payload) {
          calls.push(payload);
          return { summary: { total: payload.candidates.length, created: payload.candidates.length, duplicates: 0, failed: 0 }, items: [] };
        }
      },
      getCandidates: async () => ([{ azsId: '5', adminUserId: 7 }]),
      settingsStore: { async read() { return { report: { dispatchTimes: ['09:00'] }, timezone: 'UTC' }; } },
      getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
      nowFn: () => new Date('2026-06-03T09:00:00.000Z')
    });

    const result = await scheduler.runOnce();
    assert.equal(result.summary.created, 1); // legacy path ran
    assert.equal(calls.length, 1);
  } finally {
    if (prev === undefined) delete process.env.DISPATCH_PLAN_MODE_ENABLED;
    else process.env.DISPATCH_PLAN_MODE_ENABLED = prev;
  }
});

test('flag ON → runOnce executes due plans with correct candidate field mapping', async () => {
  const now = new Date('2026-06-03T09:05:00.000Z');

  const dueRows = [
    {
      id: 1,
      azs_id: 'azs-1',
      admin_user_id: 11,
      plan_date: '2026-06-03',
      base_time: '0900',
      execute_at: new Date('2026-06-03T09:03:00.000Z'),
      jitter_minutes: 3
    },
    {
      id: 2,
      azs_id: 'azs-2',
      admin_user_id: 22,
      plan_date: '2026-06-03',
      base_time: '0900',
      execute_at: new Date('2026-06-03T09:04:00.000Z'),
      jitter_minutes: 4
    }
  ];

  const dispatchCalls = [];
  const markDispatchedCalls = [];

  const fakePlanStore = {
    async listDue() { return dueRows; },
    async markDispatched(args) { markDispatchedCalls.push(args); },
    async markFailed() { throw new Error('markFailed should not be called'); }
  };

  const fakeDispatchService = {
    async dispatchBatch(payload) {
      dispatchCalls.push(payload);
      return {
        summary: { total: 1, created: 1, duplicates: 0, failed: 0 },
        items: [{ ok: true, duplicate: false, reportItemId: 999 + payload.candidates[0].azsId.charCodeAt(4) }]
      };
    }
  };

  // getCandidates should NOT be called for slot dispatch in planMode
  const getCandidatesSpy = { called: false };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: fakePlanStore,
    dispatchService: fakeDispatchService,
    getCandidates: async () => { getCandidatesSpy.called = true; return []; },
    settingsStore: { async read() { return {}; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => now
  });

  const result = await scheduler.runOnce();

  // Both due rows dispatched
  assert.equal(dispatchCalls.length, 2, 'dispatchBatch called once per due row');

  // Candidate field mapping verification
  const c0 = dispatchCalls[0].candidates[0];
  assert.equal(c0.azsId, 'azs-1');
  assert.equal(c0.adminUserId, 11);
  assert.equal(c0.slotDate, '2026-06-03', 'slotDate = plan_date (not execute time)');
  assert.equal(c0.slotHHmm, '0900', 'slotHHmm = base_time (not execute time)');
  assert.deepEqual(c0.scheduledAt, dueRows[0].execute_at, 'scheduledAt = execute_at');
  assert.equal(c0.jitterMinutes, 3);

  const c1 = dispatchCalls[1].candidates[0];
  assert.equal(c1.azsId, 'azs-2');
  assert.equal(c1.adminUserId, 22);
  assert.equal(c1.slotDate, '2026-06-03');
  assert.equal(c1.slotHHmm, '0900');
  assert.deepEqual(c1.scheduledAt, dueRows[1].execute_at);
  assert.equal(c1.jitterMinutes, 4);

  // markDispatched called for each
  assert.equal(markDispatchedCalls.length, 2);
  assert.equal(markDispatchedCalls[0].id, 1);
  assert.equal(markDispatchedCalls[1].id, 2);

  // getCandidates was NOT used for slot-dispatch
  assert.equal(getCandidatesSpy.called, false, 'getCandidates must not be used in plan mode dispatch');

  // Summary returned
  assert.equal(result.due, 2);
  assert.equal(result.executed, 2);
  assert.equal(result.failed, 0);
});

test('flag ON → result mapping: failed row calls markFailed, duplicate row calls markDispatched', async () => {
  const now = new Date('2026-06-03T10:00:00.000Z');

  const dueRows = [
    {
      id: 10,
      azs_id: 'azs-10',
      admin_user_id: 5,
      plan_date: '2026-06-03',
      base_time: '1000',
      execute_at: new Date('2026-06-03T09:58:00.000Z'),
      jitter_minutes: -2
    },
    {
      id: 11,
      azs_id: 'azs-11',
      admin_user_id: 6,
      plan_date: '2026-06-03',
      base_time: '1000',
      execute_at: new Date('2026-06-03T09:59:00.000Z'),
      jitter_minutes: -1
    },
    {
      id: 12,
      azs_id: 'azs-12',
      admin_user_id: 7,
      plan_date: '2026-06-03',
      base_time: '1000',
      execute_at: new Date('2026-06-03T10:00:00.000Z'),
      jitter_minutes: 0
    }
  ];

  const markDispatchedCalls = [];
  const markFailedCalls = [];

  const fakePlanStore = {
    async listDue() { return dueRows; },
    async markDispatched(args) { markDispatchedCalls.push(args); },
    async markFailed(args) { markFailedCalls.push(args); }
  };

  // row 10 → ok, duplicate; row 11 → not ok (failed); row 12 → ok, not duplicate
  const responses = {
    'azs-10': { ok: true, duplicate: true },
    'azs-11': { ok: false, duplicate: false, error: 'network error' },
    'azs-12': { ok: true, duplicate: false, reportItemId: 555 }
  };

  const fakeDispatchService = {
    async dispatchBatch({ candidates }) {
      const item = responses[candidates[0].azsId];
      return { summary: {}, items: [item] };
    }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: fakePlanStore,
    dispatchService: fakeDispatchService,
    getCandidates: async () => [],
    settingsStore: { async read() { return {}; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => now
  });

  const result = await scheduler.runOnce();

  // duplicate → markDispatched (id=10, reportItemId=null)
  const dup = markDispatchedCalls.find((c) => c.id === 10);
  assert.ok(dup, 'markDispatched called for duplicate row');
  assert.equal(dup.reportItemId, null);

  // failed → markFailed (id=11, error set)
  assert.equal(markFailedCalls.length, 1);
  assert.equal(markFailedCalls[0].id, 11);
  assert.equal(markFailedCalls[0].error, 'network error');

  // ok, not duplicate → markDispatched (id=12, reportItemId=555)
  const ok = markDispatchedCalls.find((c) => c.id === 12);
  assert.ok(ok, 'markDispatched called for successful row');
  assert.equal(ok.reportItemId, 555);

  assert.equal(result.duplicates, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.executed, 1);
});

test('flag ON → executeBatchLimit caps dispatch to N rows, extra are deferred', async () => {
  const now = new Date('2026-06-03T11:00:00.000Z');

  const dueRows = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    azs_id: `azs-${i + 1}`,
    admin_user_id: i + 1,
    plan_date: '2026-06-03',
    base_time: '1100',
    execute_at: new Date('2026-06-03T10:58:00.000Z'),
    jitter_minutes: 0
  }));

  const dispatchCalls = [];
  const markDispatchedCalls = [];

  const fakePlanStore = {
    async listDue() { return dueRows; },
    async markDispatched(args) { markDispatchedCalls.push(args); },
    async markFailed() {}
  };

  const fakeDispatchService = {
    async dispatchBatch(payload) {
      dispatchCalls.push(payload);
      return { summary: {}, items: [{ ok: true, duplicate: false, reportItemId: 1 }] };
    }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    executeBatchLimit: 20,
    dispatchPlanStore: fakePlanStore,
    dispatchService: fakeDispatchService,
    getCandidates: async () => [],
    settingsStore: { async read() { return {}; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => now
  });

  const result = await scheduler.runOnce();

  assert.equal(dispatchCalls.length, 20, 'only 20 dispatched (limit honored)');
  assert.equal(markDispatchedCalls.length, 20);
  assert.equal(result.due, 25, 'due count reflects full listDue result');
  assert.equal(result.executed, 20);
});

test('flag ON → auth guard: no authId → executeDuePlans skips, no listDue called', async () => {
  let listDueCalled = false;
  let warnLogged = false;

  const fakePlanStore = {
    async listDue() { listDueCalled = true; return []; },
    async markDispatched() {},
    async markFailed() {}
  };

  const fakeDispatchService = {
    async dispatchBatch() { throw new Error('dispatchBatch must not be called'); }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: fakePlanStore,
    dispatchService: fakeDispatchService,
    getCandidates: async () => [],
    settingsStore: { async read() { return {}; } },
    getRuntimeContext: async () => ({}), // no authId
    logger: {
      info() {},
      warn(...args) { warnLogged = true; },
      error() {}
    },
    nowFn: () => new Date('2026-06-03T12:00:00.000Z')
  });

  const result = await scheduler.runOnce();

  assert.equal(listDueCalled, false, 'listDue must not be called without authId');
  assert.equal(warnLogged, true, 'warn must be logged when auth missing');
  // Returns empty-ish summary
  assert.equal(result.due, 0);
  assert.equal(result.executed, 0);
});

test('dispatch scheduler skips run when current time is not in configured slots', async () => {
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false, // legacy slot-dispatch path under test
    dispatchService: {
      async dispatchBatch() {
        throw new Error('should not be called');
      }
    },
    getCandidates: async () => ([
      { azsId: '2', adminUserId: 11 }
    ]),
    settingsStore: {
      async read() {
        return {
          report: {
            dispatchTimes: ['18:45']
          },
          timezone: 'Europe/Moscow'
        };
      }
    },
    getRuntimeContext: async () => ({
      authId: 'test-access',
      refreshToken: 'test-refresh',
      domain: 'nfr-mainsoft.bitrix24.ru',
      memberId: 'm1',
      userId: 1
    }),
    nowFn: () => new Date('2026-04-30T15:44:00.000Z')
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.created, 0);
});

test('resilience: generation works under webhook background context (no admin authId)', async () => {
  const upserts = [];
  const mirrorWrites = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: {
      async listByDate() { return []; },          // no plan yet
      async listDue() { return []; },
      async upsertPlanned(x) { upserts.push(x); return x; },
      async markDispatched() {}, async markFailed() {}
    },
    generateDailyPlan: async ({ planDate, candidates, planStore }) => {
      for (const c of candidates) await planStore.upsertPlanned({ planDate, azsId: c.azsId, adminUserId: c.adminUserId, baseTime: '1200', executeAt: new Date(), jitterMinutes: 0 });
      return { planDate, planned: candidates.length };
    },
    planMirror: { async write(x) { mirrorWrites.push(x); }, async rehydrateIfEmpty() { return 0; } },
    dispatchService: { async dispatchBatch() { return { summary:{}, items:[{ok:true}] }; } },
    getCandidates: async () => ([{ azsId: '5', adminUserId: 7 }]),
    settingsStore: { async read() { return { timezone: 'UTC', report: { dispatchTimes: ['12:00'] } }; } },
    // NO admin context at all:
    getRuntimeContext: async () => ({}),
    // webhook background context (no authId, but isWebhook):
    getBackgroundContext: async () => ({ isWebhook: true, endpoint: 'https://p.bitrix24.ru/rest/1/c' }),
    nowFn: () => new Date('2026-06-03T09:00:00.000Z')
  });

  await scheduler.runOnce();
  // Plan generated under webhook context despite empty admin context
  assert.ok(upserts.length >= 1, 'generation ran under webhook context');
  assert.equal(mirrorWrites.length, 1, 'plan mirrored to Bitrix after generation');
});

test('resilience: alert sent (once) when no plan and no usable context', async () => {
  const notifies = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: {
      async listByDate() { return []; },   // no plan
      async listDue() { return []; },
      async markDispatched() {}, async markFailed() {}
    },
    generateDailyPlan: async () => ({ planned: 0 }),
    planMirror: { async write() {}, async rehydrateIfEmpty() { return 0; } },
    dispatchService: { async dispatchBatch() { return { summary:{}, items:[] }; } },
    getCandidates: async () => ([]),
    settingsStore: { async read() { return { timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({}),          // no admin
    getBackgroundContext: async () => ({}),        // no webhook either
    notificationService: { async notifyDispatch(p) { notifies.push(p); } },
    getReviewerUserIds: async () => [101, 102],
    nowFn: () => new Date('2026-06-03T09:00:00.000Z')
  });

  await scheduler.runOnce();
  await scheduler.runOnce(); // second tick same day — must NOT re-alert
  assert.equal(notifies.length, 2, 'alert sent to both reviewers exactly once (not 4)');
  assert.ok(notifies.every((n) => /не сформирован/i.test(n.message)));
});

test('resilience: rehydrate from mirror counts as plan-exists (no regeneration)', async () => {
  let generated = false;
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: {
      async listByDate() { return []; },   // DB empty
      async listDue() { return []; },
      async markDispatched() {}, async markFailed() {}
    },
    generateDailyPlan: async () => { generated = true; return { planned: 5 }; },
    planMirror: { async write() {}, async rehydrateIfEmpty() { return 7; } }, // mirror restored 7 rows
    dispatchService: { async dispatchBatch() { return { summary:{}, items:[] }; } },
    getCandidates: async () => ([]),
    settingsStore: { async read() { return { timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({ authId: 'tok' }),
    nowFn: () => new Date('2026-06-03T09:00:00.000Z')
  });

  await scheduler.runOnce();
  assert.equal(generated, false, 'rehydrate satisfied plan-exists → no regeneration');
});

// ---------------------------------------------------------------------------
// Overlap guard tests (S1-03)
// ---------------------------------------------------------------------------

test('dispatch.tick_skipped_overlap: second runOnce while first is running returns {skipped:true}', async () => {
  let resolveFirst;
  let runOnceCallCount = 0;
  const firstRunOnceHang = new Promise((resolve) => { resolveFirst = resolve; });

  const warnMessages = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: {
      async listByDate() { return []; },
      async listDue() {
        runOnceCallCount += 1;
        if (runOnceCallCount === 1) {
          await firstRunOnceHang; // hang the first tick
        }
        return [];
      },
      async markDispatched() {}, async markFailed() {}
    },
    dispatchService: { async dispatchBatch() { return { summary:{}, items:[] }; } },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-10T09:00:00.000Z'),
    logger: {
      info() {},
      warn(...args) { warnMessages.push(args.join ? args.join(' ') : String(args[0])); },
      error() {}
    }
  });

  // Start first tick — it will hang inside listDue
  const firstTickPromise = scheduler.runOnce();

  // Yield to allow the first tick to enter its running state
  await new Promise((r) => setImmediate(r));

  // Second tick while first is running → must be skipped
  const secondResult = await scheduler.runOnce();

  assert.deepEqual(secondResult, { skipped: true }, 'overlap tick must return {skipped:true}');

  // Check that the overlap was warned
  const overlapWarn = warnMessages.some((m) => /tick_skipped_overlap|overlap/i.test(m));
  assert.equal(overlapWarn, true, 'overlap skip must produce a warn log with tick_skipped_overlap marker');

  // Let first tick finish
  resolveFirst();
  await firstTickPromise;

  // runOnce was called only once (listDue called once for the actually-running tick)
  assert.equal(runOnceCallCount, 1, 'listDue must be called only once while first tick runs');
});

test('dispatch.tick_skipped_overlap: guard released after first tick; third tick runs normally', async () => {
  let listDueCallCount = 0;

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: true,
    dispatchPlanStore: {
      async listByDate() { return []; },
      async listDue() { listDueCallCount += 1; return []; },
      async markDispatched() {}, async markFailed() {}
    },
    dispatchService: { async dispatchBatch() { return { summary:{}, items:[] }; } },
    getCandidates: async () => [],
    settingsStore: { async read() { return { timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({ authId: 'tok', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => new Date('2026-06-10T09:00:00.000Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  // First tick runs and completes
  await scheduler.runOnce();
  assert.equal(listDueCallCount, 1);

  // Second (sequential) tick after guard is released — must also run
  await scheduler.runOnce();
  assert.equal(listDueCallCount, 2, 'after guard released, subsequent sequential tick must run normally');
});

// ---------------------------------------------------------------------------
// W1-3: stale-planned slot finisher (BUG-009)
// ---------------------------------------------------------------------------

test('W1-3: stale planned slot + live context → executed via dispatchBatch', async () => {
  const now = new Date('2026-06-11T16:00:00.000Z');
  // Slot was created 60 min ago (> default 30 min threshold)
  const staleCreatedAt = new Date(now.getTime() - 60 * 60 * 1000);

  const markFailedCalls = [];
  const dispatchCalls = [];

  const fakeDispatchLogStore = {
    async listStalePlanned() {
      return [{
        id: 42,
        slot_key: '2026-06-11:1320',
        azs_id: 'azs-7',
        admin_user_id: 5,
        status: 'reserved',
        created_at: staleCreatedAt
      }];
    },
    async markFailed(args) { markFailedCalls.push(args); }
  };

  const fakeDispatchService = {
    async dispatchBatch(payload) {
      dispatchCalls.push(payload);
      return {
        summary: { total: 1, created: 1, duplicates: 0, failed: 0 },
        items: [{ ok: true, duplicate: false, reportItemId: 777 }]
      };
    }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false,
    dispatchLogStore: fakeDispatchLogStore,
    dispatchService: fakeDispatchService,
    stalePlannedMinutes: 30,
    getCandidates: async () => [],
    settingsStore: { async read() { return { report: { dispatchTimes: [] }, timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({ authId: 'live-token', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => now,
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await scheduler.finishStalePlannedSlots();

  assert.equal(result.stale, 1, 'one stale slot found');
  assert.equal(result.executed, 1, 'stale slot executed via dispatchBatch');
  assert.equal(result.failed, 0, 'no failures');
  assert.equal(markFailedCalls.length, 0, 'markFailed not called when context live');
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].candidates[0].azsId, 'azs-7');
  assert.equal(dispatchCalls[0].candidates[0].adminUserId, 5);
});

test('W1-3: stale planned slot + dead context → marked failed with exact error_text', async () => {
  const now = new Date('2026-06-11T16:00:00.000Z');
  const staleCreatedAt = new Date(now.getTime() - 60 * 60 * 1000);

  const markFailedCalls = [];
  const dispatchCalls = [];

  const fakeDispatchLogStore = {
    async listStalePlanned() {
      return [{
        id: 99,
        slot_key: 'manual:2026-06-11:1320',
        azs_id: 'azs-3',
        admin_user_id: 7,
        status: 'reserved',
        created_at: staleCreatedAt
      }];
    },
    async markFailed(args) { markFailedCalls.push(args); }
  };

  const fakeDispatchService = {
    async dispatchBatch() {
      dispatchCalls.push(true);
      throw new Error('dispatchBatch must not be called with dead context');
    }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false,
    dispatchLogStore: fakeDispatchLogStore,
    dispatchService: fakeDispatchService,
    stalePlannedMinutes: 30,
    getCandidates: async () => [],
    settingsStore: { async read() { return { report: { dispatchTimes: [] }, timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({}), // no authId → dead context
    nowFn: () => now,
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await scheduler.finishStalePlannedSlots();

  assert.equal(result.stale, 1, 'one stale slot found');
  assert.equal(result.executed, 0, 'not executed — dead context');
  assert.equal(result.failed, 1, 'marked failed');
  assert.equal(dispatchCalls.length, 0, 'dispatchBatch not called');
  assert.equal(markFailedCalls.length, 1);
  assert.equal(markFailedCalls[0].id, 99);
  assert.equal(markFailedCalls[0].errorText, 'skipped: no auth context at send time',
    'error_text must match exact spec string');
});

test('W1-3: fresh reserved slot (within threshold) → not touched', async () => {
  const now = new Date('2026-06-11T16:00:00.000Z');
  // Created only 5 minutes ago — within 30-min threshold
  const freshCreatedAt = new Date(now.getTime() - 5 * 60 * 1000);

  const markFailedCalls = [];
  const dispatchCalls = [];

  const fakeDispatchLogStore = {
    // Simulate DB returning no rows (because freshCreatedAt > staleBefore)
    async listStalePlanned({ staleBefore }) {
      // The query filters created_at < staleBefore; fresh row is NOT included
      if (freshCreatedAt < staleBefore) {
        return [{ id: 1, slot_key: '2026-06-11:1555', azs_id: 'azs-1', admin_user_id: 1, status: 'reserved', created_at: freshCreatedAt }];
      }
      return [];
    },
    async markFailed(args) { markFailedCalls.push(args); }
  };

  const fakeDispatchService = {
    async dispatchBatch() { dispatchCalls.push(true); return { summary: {}, items: [{ ok: true }] }; }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false,
    dispatchLogStore: fakeDispatchLogStore,
    dispatchService: fakeDispatchService,
    stalePlannedMinutes: 30,
    getCandidates: async () => [],
    settingsStore: { async read() { return { report: { dispatchTimes: [] }, timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({ authId: 'live', domain: 'd', memberId: 'm', userId: 1 }),
    nowFn: () => now,
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await scheduler.finishStalePlannedSlots();

  assert.equal(result.stale, 0, 'fresh slot is below threshold → listStalePlanned returns empty');
  assert.equal(result.executed, 0);
  assert.equal(result.failed, 0);
  assert.equal(markFailedCalls.length, 0);
  assert.equal(dispatchCalls.length, 0);
});

test('W1-3: idempotent — second call on already-processed slot does nothing', async () => {
  const now = new Date('2026-06-11T16:00:00.000Z');

  let callCount = 0;
  const markFailedCalls = [];

  const fakeDispatchLogStore = {
    // First call returns stale row; second returns nothing (row is done/failed)
    async listStalePlanned() {
      callCount += 1;
      if (callCount === 1) {
        return [{
          id: 55,
          slot_key: '2026-06-11:1200',
          azs_id: 'azs-5',
          admin_user_id: 3,
          status: 'reserved',
          created_at: new Date(now.getTime() - 60 * 60 * 1000)
        }];
      }
      return []; // second call: row is already processed
    },
    async markFailed(args) { markFailedCalls.push(args); }
  };

  const scheduler = createDispatchScheduler({
    enabled: false,
    planModeEnabled: false,
    dispatchLogStore: fakeDispatchLogStore,
    dispatchService: {
      async dispatchBatch() { return { summary: {}, items: [{ ok: false, error: 'gone' }] }; }
    },
    stalePlannedMinutes: 30,
    getCandidates: async () => [],
    settingsStore: { async read() { return { report: { dispatchTimes: [] }, timezone: 'UTC' }; } },
    getRuntimeContext: async () => ({}), // dead context → markFailed on first call
    nowFn: () => now,
    logger: { info() {}, warn() {}, error() {} }
  });

  const first = await scheduler.finishStalePlannedSlots();
  const second = await scheduler.finishStalePlannedSlots();

  assert.equal(first.stale, 1, 'first call found the row');
  assert.equal(first.failed, 1);
  assert.equal(second.stale, 0, 'second call: row no longer in stale list');
  assert.equal(second.failed, 0);
  assert.equal(markFailedCalls.length, 1, 'markFailed called exactly once (idempotent)');
});

// ---------------------------------------------------------------------------
// W1-3: assertDispatchAvailable — manual dispatch guard
// ---------------------------------------------------------------------------

test('W1-3: assertDispatchAvailable resolves when admin session context is live', async () => {
  await assert.doesNotReject(
    () => assertDispatchAvailable({
      getRuntimeContext: async () => ({ authId: 'live-tok', domain: 'x.bitrix24.ru' })
    }),
    'should not throw when authId is set'
  );
});

test('W1-3: assertDispatchAvailable resolves when webhook background context is live', async () => {
  await assert.doesNotReject(
    () => assertDispatchAvailable({
      getRuntimeContext: async () => ({}), // no admin session
      getBackgroundContext: async () => ({ isWebhook: true, endpoint: 'https://p.b24.ru/rest/1/hook' })
    }),
    'should not throw when webhook context is available'
  );
});

test('W1-3: assertDispatchAvailable throws BOT_UNAVAILABLE when no context', async () => {
  let err;
  try {
    await assertDispatchAvailable({
      getRuntimeContext: async () => ({}),
      getBackgroundContext: async () => ({})
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should throw');
  assert.equal(err.code, 'BOT_UNAVAILABLE');
  assert.equal(err.statusCode, 503);
});

test('W1-3: assertDispatchAvailable throws BOT_UNAVAILABLE when getRuntimeContext returns null', async () => {
  let err;
  try {
    await assertDispatchAvailable({
      getRuntimeContext: async () => null
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should throw when context is null');
  assert.equal(err.code, 'BOT_UNAVAILABLE');
  assert.equal(err.statusCode, 503);
});

test('W1-3: assertDispatchAvailable — no slot created when context unavailable (route-level integration)', async () => {
  // Simulates the reportsRoutes /manual handler: when assertDispatchAvailable
  // throws, the try/catch in the route must propagate 503 BOT_UNAVAILABLE
  // and dispatchBatch must NOT be called.
  let dispatchCalled = false;

  const simulateManualRoute = async ({ getLastAdminContext }) => {
    try {
      await assertDispatchAvailable({
        getRuntimeContext: async () => {
          const entry = await getLastAdminContext();
          return entry?.context ?? {};
        }
      });
      // If we reach here context is live — dispatch would happen
      dispatchCalled = true;
      return { status: 200, body: { summary: { created: 1 } } };
    } catch (error) {
      return {
        status: error.statusCode || 500,
        body: {
          error: error.code || 'manual_report_failed',
          errorCode: error.code === 'BOT_UNAVAILABLE' ? 'BOT_UNAVAILABLE' : undefined,
          message: error.message
        }
      };
    }
  };

  // Case 1: unavailable context → 503, no dispatch
  const unavailableRes = await simulateManualRoute({
    getLastAdminContext: async () => null
  });
  assert.equal(unavailableRes.status, 503, '503 returned when context unavailable');
  assert.equal(unavailableRes.body.errorCode, 'BOT_UNAVAILABLE');
  assert.equal(dispatchCalled, false, 'dispatch must NOT be called when context unavailable');

  // Case 2: available context → 200, dispatch happens
  const availableRes = await simulateManualRoute({
    getLastAdminContext: async () => ({ key: 'k', context: { authId: 'live-tok', domain: 'd' } })
  });
  assert.equal(availableRes.status, 200, '200 returned when context available');
  assert.equal(dispatchCalled, true, 'dispatch was called when context available');
});
