import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchScheduler } from '../src/dispatch/dispatchScheduler.js';

test('dispatch scheduler runs only on configured slot and maps slotDate/slotHHmm', async () => {
  const calls = [];
  const scheduler = createDispatchScheduler({
    enabled: false,
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
    nowFn: () => new Date('2026-04-30T15:45:00.000Z')
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.created, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].azsId, '2');
  assert.equal(calls[0].candidates[0].adminUserId, 11);
});

test('dispatch scheduler skips run when current time is not in configured slots', async () => {
  const scheduler = createDispatchScheduler({
    enabled: false,
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
    nowFn: () => new Date('2026-04-30T15:44:00.000Z')
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.created, 0);
});
