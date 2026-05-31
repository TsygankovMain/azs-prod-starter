import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmSyncWorker } from '../src/reports/crmSyncWorker.js';

const makeJob = (over = {}) => ({ id: 1, report_id: 5, payload: JSON.stringify({ status: 'in_progress' }), attempts: 0, max_attempts: 4, ...over });

test('worker runs the sync fn for a claimed job and marks it done', async () => {
  let claimed = makeJob();
  const calls = { done: [], failed: [], reschedule: [], ran: [] };
  const store = {
    async claimNextDue() { const j = claimed; claimed = null; return j; },
    async markDone({ id }) { calls.done.push(id); },
    async markFailed(x) { calls.failed.push(x); },
    async reschedule(x) { calls.reschedule.push(x); }
  };
  const runSync = async (job) => { calls.ran.push(job.report_id); };
  const worker = createCrmSyncWorker({ store, runSync, backoffMs: [10, 20, 40], now: () => Date.now() });
  await worker.tick();
  assert.deepEqual(calls.ran, [5]);
  assert.deepEqual(calls.done, [1]);
  assert.equal(calls.failed.length, 0);
});

test('worker reschedules a retryable failure, then marks failed once attempts exhausted', async () => {
  const calls = { reschedule: [], failed: [] };
  let job = makeJob({ attempts: 0, max_attempts: 2 });
  const store = {
    async claimNextDue() { if (!job || job._consumed) return null; const j = job; job = { ...job, _consumed: true }; return j; },
    async markDone() {},
    async markFailed(x) { calls.failed.push(x); },
    async reschedule(x) { calls.reschedule.push(x); }
  };
  const runSync = async () => { throw new Error('OPERATION_TIME_LIMIT'); };
  const worker = createCrmSyncWorker({ store, runSync, backoffMs: [10], now: () => 1000, isRetryable: () => true });
  // attempt 0 → reschedule (0+1 < 2)
  await worker.tick();
  assert.equal(calls.reschedule.length, 1);
  assert.equal(calls.failed.length, 0);
  // attempt 1 → exhausted (1+1 == 2) → failed
  job = makeJob({ attempts: 1, max_attempts: 2 });
  await worker.tick();
  assert.equal(calls.failed.length, 1);
});
