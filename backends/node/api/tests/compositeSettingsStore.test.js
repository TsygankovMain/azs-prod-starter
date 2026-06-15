/**
 * TDD tests for compositeSettingsStore.write() BUG-A3 retry resilience.
 *
 * Construct store with writeRetryDelayMs:0 so tests are instant.
 * All fakes are plain objects — no mocking framework needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompositeSettingsStore } from '../src/settings/compositeSettingsStore.js';

const NORMALIZED = { report: { fields: { folderId: 'UF_CRM_1' } }, timezone: 'Europe/Moscow' };

const makeLogger = () => {
  const calls = [];
  return {
    calls,
    warn: (event, meta) => calls.push({ event, meta }),
    info: () => {},
    error: () => {}
  };
};

// ---------------------------------------------------------------------------
// Test 1 — retry then success
// First call rejects, second resolves → write() resolves, dbStore.write called once
// ---------------------------------------------------------------------------
test('compositeSettingsStore.write: retries on transient Bitrix failure (1 fail then success)', async () => {
  let bitrixCalls = 0;
  let dbCalls = 0;

  const bitrixStore = {
    async read() { return null; },
    async write(_settings, _opts) {
      bitrixCalls += 1;
      if (bitrixCalls === 1) throw new Error('transient network error');
      return NORMALIZED;
    }
  };
  const dbStore = {
    async read() { return null; },
    async write(_settings, _opts) {
      dbCalls += 1;
    }
  };

  const logger = makeLogger();
  const store = createCompositeSettingsStore({
    bitrixStore,
    dbStore,
    logger,
    maxWriteAttempts: 3,
    writeRetryDelayMs: 0
  });

  const result = await store.write({ report: { fields: { folderId: 'UF_CRM_1' } } }, { context: {} });

  assert.deepEqual(result, NORMALIZED, 'should return normalized settings from bitrix');
  assert.equal(bitrixCalls, 2, 'bitrixStore.write must have been called twice (1 fail + 1 success)');
  assert.equal(dbCalls, 1, 'dbStore.write must be called once after successful bitrix write');
  // Retry warning must have been logged for the first failure
  const retryWarn = logger.calls.find((c) => c.event === 'settings.bitrix_write_retry');
  assert.ok(retryWarn, 'must log settings.bitrix_write_retry on first failure');
  assert.equal(retryWarn.meta.attempt, 1, 'logged attempt should be 1');
});

// ---------------------------------------------------------------------------
// Test 2 — all attempts fail → typed error thrown, DB NOT written
// ---------------------------------------------------------------------------
test('compositeSettingsStore.write: throws typed error when all Bitrix write attempts fail', async () => {
  let dbCalls = 0;
  const rootCause = new Error('bitrix completely down');

  const bitrixStore = {
    async read() { return null; },
    async write() { throw rootCause; }
  };
  const dbStore = {
    async read() { return null; },
    async write() { dbCalls += 1; }
  };

  const logger = makeLogger();
  const store = createCompositeSettingsStore({
    bitrixStore,
    dbStore,
    logger,
    maxWriteAttempts: 3,
    writeRetryDelayMs: 0
  });

  await assert.rejects(
    () => store.write({ report: { fields: { folderId: 'UF_CRM_1' } } }, { context: {} }),
    (err) => {
      assert.equal(err.code, 'settings_bitrix_write_failed', 'error.code must be settings_bitrix_write_failed');
      assert.ok(err.message.includes('Не удалось сохранить'), 'message must mention inability to save');
      assert.equal(err.cause, rootCause, 'err.cause must be the last underlying error');
      return true;
    }
  );

  assert.equal(dbCalls, 0, 'dbStore.write must NOT be called when all Bitrix attempts fail');
});

// ---------------------------------------------------------------------------
// Test 3 — success on first try (regression: happy path still works)
// ---------------------------------------------------------------------------
test('compositeSettingsStore.write: succeeds on first attempt (happy path unchanged)', async () => {
  let bitrixCalls = 0;
  let dbCalls = 0;

  const bitrixStore = {
    async read() { return null; },
    async write(_settings, _opts) {
      bitrixCalls += 1;
      return NORMALIZED;
    }
  };
  const dbStore = {
    async read() { return null; },
    async write(_settings, _opts) {
      dbCalls += 1;
    }
  };

  const logger = makeLogger();
  const store = createCompositeSettingsStore({
    bitrixStore,
    dbStore,
    logger,
    maxWriteAttempts: 3,
    writeRetryDelayMs: 0
  });

  const result = await store.write({ report: { fields: { folderId: 'UF_CRM_1' } } }, { context: {} });

  assert.deepEqual(result, NORMALIZED, 'should return normalized settings');
  assert.equal(bitrixCalls, 1, 'bitrixStore.write must be called exactly once on success');
  assert.equal(dbCalls, 1, 'dbStore.write must be called exactly once (best-effort sync)');
  // No retry warnings on clean success
  const retryWarn = logger.calls.find((c) => c.event === 'settings.bitrix_write_retry');
  assert.equal(retryWarn, undefined, 'no retry warnings on clean success');
});

// ---------------------------------------------------------------------------
// Test 4 — DB sync failure is swallowed (best-effort preserved)
// ---------------------------------------------------------------------------
test('compositeSettingsStore.write: DB sync failure does not fail the save (best-effort)', async () => {
  const bitrixStore = {
    async read() { return null; },
    async write() { return NORMALIZED; }
  };
  const dbStore = {
    async read() { return null; },
    async write() { throw new Error('db is down'); }
  };

  const logger = makeLogger();
  const store = createCompositeSettingsStore({
    bitrixStore,
    dbStore,
    logger,
    maxWriteAttempts: 3,
    writeRetryDelayMs: 0
  });

  // Must not throw even though dbStore.write fails
  const result = await store.write({ report: { fields: { folderId: 'UF_CRM_1' } } }, { context: {} });

  assert.deepEqual(result, NORMALIZED, 'write() must resolve with normalized settings');
  // DB failure must be logged as a warning
  const dbWarn = logger.calls.find((c) => c.event === 'settings.db_write_failed');
  assert.ok(dbWarn, 'must log settings.db_write_failed when DB sync fails');
  assert.match(dbWarn.meta.message, /db is down/i);
});
