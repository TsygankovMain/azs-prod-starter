import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanMirror } from '../src/reports/dispatchPlanMirror.js';

const createFakeBitrix = () => {
  const store = {}; // optionKey -> JSON string
  const calls = [];
  return {
    calls,
    store,
    async callMethod(method, params, context) {
      calls.push({ method, params, context });
      if (method === 'app.option.set') {
        Object.assign(store, params.options);
        return {};
      }
      if (method === 'app.option.get') {
        const k = params.option;
        return k in store ? { [k]: store[k] } : {};
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
};

const createFakePlanStore = (initialRows = []) => {
  const rows = [...initialRows];
  return {
    rows,
    async listByDate({ planDate }) { return rows.filter((r) => r.plan_date === planDate); },
    async upsertPlanned(x) { rows.push({ plan_date: x.planDate, azs_id: x.azsId, admin_user_id: x.adminUserId, base_time: x.baseTime, execute_at: x.executeAt, jitter_minutes: x.jitterMinutes, status: 'planned' }); return x; }
  };
};

test('write stores normalized plan JSON in app.option', async () => {
  const bitrix = createFakeBitrix();
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore: createFakePlanStore() });
  await mirror.write({
    planDate: '2026-06-05',
    now: new Date('2026-06-05T00:01:00.000Z'),
    rows: [
      { azs_id: '16', admin_user_id: 11, base_time: '1200', execute_at: new Date('2026-06-05T05:01:00.000Z'), jitter_minutes: -239, status: 'planned' }
    ]
  });
  const saved = JSON.parse(bitrix.store['azs_dispatch_plan_v1']);
  assert.equal(saved.planDate, '2026-06-05');
  assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].azsId, '16');
  assert.equal(saved.rows[0].executeAt, '2026-06-05T05:01:00.000Z');
});

test('read parses the mirror back', async () => {
  const bitrix = createFakeBitrix();
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore: createFakePlanStore() });
  await mirror.write({ planDate: '2026-06-05', rows: [{ azsId: '1', adminUserId: 7, baseTime: '0900', executeAt: '2026-06-05T06:00:00.000Z', jitterMinutes: 0 }] });
  const got = await mirror.read({});
  assert.equal(got.planDate, '2026-06-05');
  assert.equal(got.rows[0].azsId, '1');
});

test('rehydrateIfEmpty restores DB rows from mirror when DB is empty', async () => {
  const bitrix = createFakeBitrix();
  const planStore = createFakePlanStore([]); // empty DB
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore });
  await mirror.write({
    planDate: '2026-06-05',
    rows: [
      { azsId: '16', adminUserId: 11, baseTime: '1200', executeAt: '2026-06-05T05:01:00.000Z', jitterMinutes: -239 },
      { azsId: '28', adminUserId: 22, baseTime: '1200', executeAt: '2026-06-05T05:32:00.000Z', jitterMinutes: -208 }
    ]
  });

  const restored = await mirror.rehydrateIfEmpty({ planDate: '2026-06-05' });
  assert.equal(restored, 2);
  const dbNow = await planStore.listByDate({ planDate: '2026-06-05' });
  assert.equal(dbNow.length, 2);
  assert.equal(dbNow[0].azs_id, '16');
});

test('rehydrateIfEmpty is a no-op when DB already has the plan', async () => {
  const bitrix = createFakeBitrix();
  const planStore = createFakePlanStore([
    { plan_date: '2026-06-05', azs_id: '99', admin_user_id: 1, base_time: '1200', execute_at: '2026-06-05T09:00:00.000Z', jitter_minutes: 0, status: 'planned' }
  ]);
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore });
  await mirror.write({ planDate: '2026-06-05', rows: [{ azsId: '16', adminUserId: 11, baseTime: '1200', executeAt: '2026-06-05T05:01:00.000Z', jitterMinutes: -239 }] });

  const restored = await mirror.rehydrateIfEmpty({ planDate: '2026-06-05' });
  assert.equal(restored, 0); // DB had rows → no restore
  assert.equal((await planStore.listByDate({ planDate: '2026-06-05' })).length, 1);
});

test('rehydrateIfEmpty no-op when mirror missing or for a different date', async () => {
  const bitrix = createFakeBitrix();
  const planStore = createFakePlanStore([]);
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore });
  // no mirror written yet
  assert.equal(await mirror.rehydrateIfEmpty({ planDate: '2026-06-05' }), 0);
  // mirror for a different date
  await mirror.write({ planDate: '2026-06-04', rows: [{ azsId: '1', adminUserId: 7, baseTime: '0900', executeAt: '2026-06-04T06:00:00.000Z', jitterMinutes: 0 }] });
  assert.equal(await mirror.rehydrateIfEmpty({ planDate: '2026-06-05' }), 0);
});

test('rehydrateIfEmpty skips cancelled rows from the mirror', async () => {
  const bitrix = createFakeBitrix();
  const upserts = [];
  const planStore = {
    async listByDate() { return []; }, // DB empty for the date
    async upsertPlanned(x) { upserts.push(x); return x; }
  };
  const mirror = createDispatchPlanMirror({ bitrixClient: bitrix, planStore });
  // Mirror has two rows for the date: one planned, one cancelled.
  await mirror.write({
    planDate: '2026-06-05',
    rows: [
      { azsId: '16', adminUserId: 11, baseTime: '1200', executeAt: '2026-06-05T05:01:00.000Z', jitterMinutes: -239, status: 'planned' },
      { azsId: '28', adminUserId: 22, baseTime: '1200', executeAt: '2026-06-05T05:32:00.000Z', jitterMinutes: -208, status: 'cancelled' }
    ]
  });

  const restored = await mirror.rehydrateIfEmpty({ planDate: '2026-06-05' });
  // Only the planned row is restored; the cancelled one is skipped.
  assert.equal(restored, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].azsId, '16');
});
