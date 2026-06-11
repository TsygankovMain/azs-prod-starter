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

test('worker marks failed immediately on non-retryable error', async () => {
  const calls = { failed: [], reschedule: [] };
  let job = makeJob({ attempts: 0, max_attempts: 4 });
  const store = {
    async claimNextDue() { const j = job; job = null; return j; },
    async markDone() {},
    async markFailed(x) { calls.failed.push(x); },
    async reschedule(x) { calls.reschedule.push(x); }
  };
  const runSync = async () => { throw new Error('VALIDATION_ERROR'); };
  const worker = createCrmSyncWorker({ store, runSync, backoffMs: [10], now: () => 1000, isRetryable: () => false });
  await worker.tick();
  assert.equal(calls.failed.length, 1);
  assert.equal(calls.reschedule.length, 0);
});

test('recover() reclaims stale running jobs and returns the count when the store supports it', async () => {
  const calls = { reclaim: [] };
  const store = {
    async claimNextDue() { return null; },
    async markDone() {}, async markFailed() {}, async reschedule() {},
    async reclaimStale(args) { calls.reclaim.push(args); return 3; }
  };
  const logs = [];
  const worker = createCrmSyncWorker({
    store,
    runSync: async () => {},
    logger: { error() {}, log: (...a) => logs.push(a) }
  });
  const n = await worker.recover();
  assert.equal(n, 3, 'recover returns the reclaimed count');
  assert.equal(calls.reclaim.length, 1, 'reclaimStale called exactly once');
});

test('recover() resolves to 0 without throwing when the store lacks reclaimStale', async () => {
  const store = {
    async claimNextDue() { return null; },
    async markDone() {}, async markFailed() {}, async reschedule() {}
    // no reclaimStale
  };
  const worker = createCrmSyncWorker({ store, runSync: async () => {} });
  const n = await worker.recover();
  assert.equal(n, 0, 'recover is a safe no-op when reclaimStale is absent');
});

test('recover() passes runningTimeoutMs > 0 to reclaimStale (scoped claim)', async () => {
  const calls = { reclaim: [] };
  const store = {
    async claimNextDue() { return null; },
    async markDone() {}, async markFailed() {}, async reschedule() {},
    async reclaimStale(args) { calls.reclaim.push(args); return 0; }
  };
  const worker = createCrmSyncWorker({ store, runSync: async () => {} });
  await worker.recover();
  assert.equal(calls.reclaim.length, 1, 'reclaimStale called exactly once');
  const arg = calls.reclaim[0];
  assert.ok(arg !== undefined && arg !== null, 'reclaimStale called with an argument object');
  assert.ok(
    typeof arg?.runningTimeoutMs === 'number' && arg.runningTimeoutMs > 0,
    `runningTimeoutMs must be a positive number, got: ${JSON.stringify(arg)}`
  );
});

test('worker does not misclassify a markDone failure as a sync failure', async () => {
  const calls = { failed: [], reschedule: [] };
  let job = makeJob({ attempts: 0, max_attempts: 4 });
  const store = {
    async claimNextDue() { const j = job; job = null; return j; },
    async markDone() { throw new Error('db down'); },
    async markFailed(x) { calls.failed.push(x); },
    async reschedule(x) { calls.reschedule.push(x); }
  };
  const runSync = async () => {}; // sync SUCCEEDS
  const worker = createCrmSyncWorker({ store, runSync, backoffMs: [10], now: () => 1000 });
  await assert.rejects(() => worker.tick(), /db down/);
  assert.equal(calls.failed.length, 0);
  assert.equal(calls.reschedule.length, 0);
});
