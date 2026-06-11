/**
 * throttledLogger — deduplicate repeating background-error log lines.
 *
 * createThrottledLog({ intervalMs = 300_000, logger = console })
 *
 * Returns a function:
 *   log(key, level, message, meta = {})
 *
 * Behaviour:
 *   • First occurrence of `key` in a fresh interval → emitted immediately.
 *   • Subsequent occurrences of the same `key` within the interval → suppressed
 *     (count is incremented).
 *   • When the interval expires and the key has been suppressed at least once →
 *     emits a single summary line:
 *       "<message> (repeated N times in last Xm)"
 *     and resets the counter.
 *
 * The timer is started lazily on the first suppressed call and cleared when no
 * pending entries remain, so it is safe to use in long-running processes without
 * leaking timers.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function createThrottledLog({
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console
} = {}) {
  // Map<key, { count: number, level: string, message: string, meta: object, timer: Timeout|null }>
  const pending = new Map();

  const flush = (key) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);

    if (entry.count > 0) {
      const intervalMinutes = Math.round(intervalMs / 60_000);
      const summaryMessage = `${entry.message} (repeated ${entry.count} times in last ${intervalMinutes}m)`;
      const logFn = typeof logger[entry.level] === 'function' ? logger[entry.level] : logger.warn;
      logFn.call(logger, summaryMessage, entry.meta);
    }
  };

  return function log(key, level, message, meta = {}) {
    if (!pending.has(key)) {
      // First occurrence in this interval: emit immediately, open a pending slot.
      const logFn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
      logFn.call(logger, message, meta);

      // Open a slot so future repeats are counted; count starts at 0 (none suppressed yet).
      const timer = setTimeout(() => flush(key), intervalMs);
      // unref() so the timer does not prevent process exit in tests / shutdown.
      if (typeof timer.unref === 'function') timer.unref();

      pending.set(key, { count: 0, level, message, meta, timer });
      return;
    }

    // Subsequent occurrence within the interval: suppress and count.
    const entry = pending.get(key);
    entry.count += 1;
    // Update meta/level to the most-recent values so the summary is fresh.
    entry.level = level;
    entry.meta = meta;
  };
}
