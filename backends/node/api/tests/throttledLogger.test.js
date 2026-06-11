import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createThrottledLog } from '../src/shared/throttledLogger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake logger that records calls. */
function makeLogger() {
  const calls = { warn: [], error: [], info: [] };
  return {
    calls,
    warn(...args) { calls.warn.push(args); },
    error(...args) { calls.error.push(args); },
    info(...args) { calls.info.push(args); }
  };
}

// ---------------------------------------------------------------------------
// Basic: first call is emitted immediately
// ---------------------------------------------------------------------------

test('throttledLogger: first occurrence of a key is emitted immediately', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const log = createThrottledLog({ intervalMs: 300_000, logger });

    log('key1', 'warn', 'something bad', { count: 1 });

    assert.equal(logger.calls.warn.length, 1, 'warn called once immediately');
    assert.equal(logger.calls.warn[0][0], 'something bad');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Suppression: second call within interval is suppressed
// ---------------------------------------------------------------------------

test('throttledLogger: second occurrence within interval is suppressed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const log = createThrottledLog({ intervalMs: 300_000, logger });

    log('key1', 'warn', 'error happened', { n: 1 });
    log('key1', 'warn', 'error happened', { n: 2 }); // suppressed
    log('key1', 'warn', 'error happened', { n: 3 }); // suppressed

    assert.equal(logger.calls.warn.length, 1, 'only first call emitted in-window');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Summary after interval: repeated N times
// ---------------------------------------------------------------------------

test('throttledLogger: after interval expires, summary with count is emitted', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const intervalMs = 300_000;
    const log = createThrottledLog({ intervalMs, logger });

    log('key1', 'warn', 'error happened', {});
    log('key1', 'warn', 'error happened', {});
    log('key1', 'warn', 'error happened', {});

    assert.equal(logger.calls.warn.length, 1, 'only first call before tick');

    // Advance timers past the interval.
    mock.timers.tick(intervalMs + 1);

    assert.equal(logger.calls.warn.length, 2, 'summary emitted after interval');
    const summaryMsg = logger.calls.warn[1][0];
    assert.ok(
      summaryMsg.includes('repeated 2 times'),
      `summary must say "repeated 2 times", got: "${summaryMsg}"`
    );
    assert.ok(
      summaryMsg.includes('in last 5m'),
      `summary must include "in last 5m", got: "${summaryMsg}"`
    );
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// No summary when no repeats occurred (count=0 → timer fires but no extra log)
// ---------------------------------------------------------------------------

test('throttledLogger: no summary emitted when key was seen only once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const intervalMs = 300_000;
    const log = createThrottledLog({ intervalMs, logger });

    log('key1', 'warn', 'error happened', {});
    // No additional calls.

    assert.equal(logger.calls.warn.length, 1, 'one call before tick');
    mock.timers.tick(intervalMs + 1);
    // Still only 1 — no summary because count was 0.
    assert.equal(logger.calls.warn.length, 1, 'no extra summary when seen only once');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// After interval, a new call is emitted immediately again
// ---------------------------------------------------------------------------

test('throttledLogger: after interval resets, next call is emitted immediately again', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const intervalMs = 300_000;
    const log = createThrottledLog({ intervalMs, logger });

    // First window.
    log('key1', 'warn', 'error happened', {});
    log('key1', 'warn', 'error happened', {});
    mock.timers.tick(intervalMs + 1); // flush summary

    const countAfterFlush = logger.calls.warn.length; // 2

    // New call after interval reset — should be emitted immediately.
    log('key1', 'warn', 'error happened again', {});
    assert.equal(logger.calls.warn.length, countAfterFlush + 1, 'new call after reset is immediate');
    assert.equal(logger.calls.warn[countAfterFlush][0], 'error happened again');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Different keys are tracked independently
// ---------------------------------------------------------------------------

test('throttledLogger: different keys do not interfere with each other', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const log = createThrottledLog({ intervalMs: 300_000, logger });

    log('keyA', 'warn', 'error A', {});
    log('keyB', 'warn', 'error B', {});
    log('keyA', 'warn', 'error A', {}); // suppressed for A
    log('keyB', 'warn', 'error B', {}); // suppressed for B

    assert.equal(logger.calls.warn.length, 2, 'one immediate log per unique key');
    assert.equal(logger.calls.warn[0][0], 'error A');
    assert.equal(logger.calls.warn[1][0], 'error B');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Level routing: error-level logs route through logger.error
// ---------------------------------------------------------------------------

test('throttledLogger: error level routes to logger.error', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const log = createThrottledLog({ intervalMs: 300_000, logger });

    log('err-key', 'error', 'fatal error', { code: 500 });

    assert.equal(logger.calls.error.length, 1, 'error-level call routes to logger.error');
    assert.equal(logger.calls.warn.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('throttledLogger: error-level summary routes to logger.error after interval', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const logger = makeLogger();
    const intervalMs = 300_000;
    const log = createThrottledLog({ intervalMs, logger });

    log('err-key', 'error', 'fatal error', {});
    log('err-key', 'error', 'fatal error', {});

    mock.timers.tick(intervalMs + 1);

    assert.equal(logger.calls.error.length, 2, 'first + summary both routed to error');
    assert.ok(logger.calls.error[1][0].includes('repeated 1 times'));
  } finally {
    mock.timers.reset();
  }
});
