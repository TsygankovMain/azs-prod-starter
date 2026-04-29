import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlotKey,
  pickJitterMinutes,
  createDispatchService
} from '../src/dispatch/dispatchService.js';

const createStoreFake = () => {
  let seq = 10;
  const reservations = new Map();
  const states = new Map();

  return {
    states,
    async reserve({ slotKey, azsId }) {
      const key = `${slotKey}:${azsId}`;
      if (reservations.has(key)) {
        return { reserved: false, id: null };
      }
      seq += 1;
      reservations.set(key, seq);
      states.set(seq, { status: 'reserved' });
      return { reserved: true, id: seq };
    },
    async markDone({ id, reportItemId, jitterMinutes }) {
      states.set(id, { status: 'done', reportItemId, jitterMinutes });
    },
    async markFailed({ id, errorText }) {
      states.set(id, { status: 'failed', errorText });
    }
  };
};

test('pickJitterMinutes returns deterministic range value', () => {
  const value = pickJitterMinutes(10, () => 0);
  assert.equal(value, -10);
});

test('buildSlotKey uses date and normalized HHmm', () => {
  assert.equal(buildSlotKey({ slotDate: '2026-04-28', slotHHmm: '09:30' }), '2026-04-28:0930');
});

test('dispatch service prevents duplicates by slot + azs and applies jitter', async () => {
  const store = createStoreFake();
  const createdReports = [];
  const notifiedUsers = [];

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 15,
            fields: {
              azs: 'UF_AZS',
              admin: 'UF_ADMIN',
              slotTime: 'UF_SLOT',
              scheduledAt: 'UF_SCHEDULED',
              deadlineAt: 'UF_DEADLINE',
              trigger: 'UF_TRIGGER'
            },
            stages: {
              new: 'DT163_1:NEW'
            }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 7001 };
      }
    },
    notificationService: {
      async notifyDispatch(payload) {
        notifiedUsers.push(payload);
      }
    },
    nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
    rng: () => 1
  });

  const candidates = [
    { azsId: 'azs-1', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' },
    { azsId: 'azs-1', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' }
  ];

  const result = await service.dispatchBatch({ candidates, trigger: 'auto' });

  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(createdReports.length, 1);
  assert.equal(notifiedUsers.length, 1);
  assert.equal(notifiedUsers[0].reportId > 0, true);
  assert.equal(result.items[0].jitterMinutes, 15);
});

test('manual trigger does not block auto slot for same azs and hhmm', async () => {
  const store = createStoreFake();
  const createdReports = [];

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 0,
            fields: {
              azs: 'UF_AZS',
              admin: 'UF_ADMIN',
              slotTime: 'UF_SLOT',
              scheduledAt: 'UF_SCHEDULED',
              deadlineAt: 'UF_DEADLINE',
              trigger: 'UF_TRIGGER'
            },
            stages: {
              new: 'DT163_1:NEW'
            }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 7002 + createdReports.length };
      }
    },
    notificationService: {
      async notifyDispatch() {}
    },
    nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
    rng: () => 0.5
  });

  const candidate = { azsId: 'azs-9', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' };

  const manualResult = await service.dispatchBatch({ candidates: [candidate], trigger: 'manual' });
  const autoResult = await service.dispatchBatch({ candidates: [candidate], trigger: 'auto' });

  assert.equal(manualResult.summary.created, 1);
  assert.equal(manualResult.summary.duplicates, 0);
  assert.equal(autoResult.summary.created, 1);
  assert.equal(autoResult.summary.duplicates, 0);
  assert.equal(createdReports.length, 2);
});
