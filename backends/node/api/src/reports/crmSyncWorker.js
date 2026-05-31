/**
 * CRM Sync Worker
 *
 * Pure scheduling logic with injected dependencies (store, runSync, clock).
 * No direct DB access or real timers in the worker itself — those are injected.
 *
 * Usage:
 *   const worker = createCrmSyncWorker({ store, runSync });
 *   worker.start();   // starts setInterval polling
 *   worker.stop();    // clears interval
 *   await worker.tick();  // one claim→run→done/fail cycle (also usable in tests)
 *   await worker.drain(); // loop tick() until no jobs remain
 */

export const createCrmSyncWorker = ({
  store,
  runSync,
  backoffMs = [800, 1600, 3200],
  pollIntervalMs = 1000,
  now = () => Date.now(),
  logger = console,
  isRetryable = () => true,
} = {}) => {
  if (!store) throw new Error('store is required');
  if (typeof runSync !== 'function') throw new Error('runSync must be a function');

  let timer = null;
  let running = false;

  /**
   * Claim one due job, run sync, then mark done / reschedule / fail.
   * Returns true if a job was claimed, false if the queue was empty.
   */
  const tick = async () => {
    const job = await store.claimNextDue({ now: new Date(now()) });
    if (!job) return false;

    let syncError = null;
    try {
      await runSync(job);
    } catch (err) {
      syncError = err;
    }

    if (!syncError) {
      await store.markDone({ id: job.id });
      return true;
    }

    const attempts = Number(job.attempts || 0);
    const retryable = isRetryable(syncError);
    const maxAttempts = Number(job.max_attempts || backoffMs.length + 1);
    const errorMsg = String(syncError?.message || syncError || '');

    if (retryable && attempts + 1 < maxAttempts) {
      const wait = backoffMs[Math.min(attempts, backoffMs.length - 1)] + Math.floor(Math.random() * 250);
      await store.reschedule({
        id: job.id,
        nextAttemptAt: new Date(now() + wait),
        error: errorMsg,
      });
    } else {
      await store.markFailed({ id: job.id, error: errorMsg });
      logger.error('crm_sync_job_failed', {
        jobId: job.id,
        reportId: job.report_id,
        message: errorMsg,
      });
    }

    return true;
  };

  /**
   * Drain the queue: loop tick() until no jobs remain.
   * Re-entrant guard prevents concurrent drain loops.
   */
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      let worked = true;
      while (worked) {
        worked = await tick();
      }
    } finally {
      running = false;
    }
  };

  /**
   * Start the polling interval. Idempotent — calling start() twice is a no-op.
   */
  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      drain().catch((error) => logger.error('crm_sync_drain_error', { message: String(error?.message || error || '') }));
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  /**
   * Stop the polling interval.
   */
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { tick, drain, start, stop };
};

export default createCrmSyncWorker;
