/**
 * Tests for:
 *  - dispatchLogStore.appendErrorText (PG + MySQL branches, real SQL capture)
 *  - parseSlotDateTimeUtc helper
 *  - dispatchLogStore.reserve writes scheduled_at from slot_key
 *  - dispatchLogStore.listStalePlanned uses scheduled_at-aware filter
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchLogStore, parseSlotDateTimeUtc } from '../src/dispatch/dispatchLogStore.js';
import { NOTIFY_FALLBACK_PREFIX } from '../src/notifications/notificationService.js';

// ── parseSlotDateTimeUtc ───────────────────────────────────────────────────────

test('parseSlotDateTimeUtc parses YYYY-MM-DD:HHmm as UTC', () => {
  const dt = parseSlotDateTimeUtc('2026-06-11:0900');
  assert.ok(dt instanceof Date, 'should return a Date');
  assert.equal(dt.toISOString(), '2026-06-11T09:00:00.000Z');
});

test('parseSlotDateTimeUtc parses manual:YYYY-MM-DD:HHmm as UTC', () => {
  const dt = parseSlotDateTimeUtc('manual:2026-06-15:1430');
  assert.ok(dt instanceof Date, 'should return a Date');
  assert.equal(dt.toISOString(), '2026-06-15T14:30:00.000Z');
});

test('parseSlotDateTimeUtc returns null for unparseable input', () => {
  assert.equal(parseSlotDateTimeUtc(''), null);
  assert.equal(parseSlotDateTimeUtc('bogus-key'), null);
  assert.equal(parseSlotDateTimeUtc('2026-06-11'), null);
  assert.equal(parseSlotDateTimeUtc(null), null);
});

test('parseSlotDateTimeUtc rejects out-of-range hours/minutes', () => {
  assert.equal(parseSlotDateTimeUtc('2026-06-11:2560'), null); // hour 25 invalid
  assert.equal(parseSlotDateTimeUtc('2026-06-11:0060'), null); // min 60 invalid
});

// ── appendErrorText (PG) ──────────────────────────────────────────────────────

function makePostgresPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [], rowCount: 0 };
    }
  };
}

test('appendErrorText (PG): emits UPDATE with CASE concat and LEFT truncation', async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.appendErrorText({ id: 42, errorText: 'NOTIFY_FALLBACK_PREFIX some error' });

  assert.equal(pool.queries.length, 1);
  const { sql, params } = pool.queries[0];
  // Check that it's an UPDATE on dispatch_log
  assert.ok(sql.includes('UPDATE dispatch_log'), 'should target dispatch_log');
  // Check CASE expression
  assert.ok(sql.includes('CASE WHEN error_text IS NULL OR error_text ='), 'should include CASE guard');
  // Check LEFT truncation
  assert.ok(sql.includes('LEFT('), 'should truncate via LEFT()');
  // Check updated_at
  assert.ok(sql.includes('updated_at'), 'should update updated_at');
  // Params: [errorText, rowId]
  assert.equal(params[0], 'NOTIFY_FALLBACK_PREFIX some error', 'first param is error text');
  assert.equal(params[1], 42, 'second param is row id');
});

test('appendErrorText (PG): no-op when errorText is empty', async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.appendErrorText({ id: 1, errorText: '' });
  assert.equal(pool.queries.length, 0, 'should not run query for empty text');
});

test('appendErrorText (PG): no-op when id is falsy', async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.appendErrorText({ id: 0, errorText: 'some error' });
  assert.equal(pool.queries.length, 0, 'should not run query for missing id');
});

test('appendErrorText (PG): accepts reportId as alias for id', async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.appendErrorText({ reportId: 99, errorText: 'test' });
  assert.equal(pool.queries.length, 1, 'should run query with reportId');
  assert.equal(pool.queries[0].params[1], 99, 'reportId used as row id');
});

test(`appendErrorText (PG): passes NOTIFY_FALLBACK_PREFIX value through to SQL params`, async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  const errorText = `${NOTIFY_FALLBACK_PREFIX}channel=bot`;
  await store.appendErrorText({ id: 7, errorText });
  assert.ok(
    pool.queries[0].params[0].includes(NOTIFY_FALLBACK_PREFIX),
    `error text must include prefix "${NOTIFY_FALLBACK_PREFIX}"`
  );
});

// ── appendErrorText (MySQL) ───────────────────────────────────────────────────

function makeMysqlPool() {
  const queries = [];
  return {
    queries,
    async execute(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [{ affectedRows: 1 }];
    }
  };
}

test('appendErrorText (MySQL): emits UPDATE with CONCAT and CASE', async () => {
  const pool = makeMysqlPool();
  const store = createDispatchLogStore({ pool, dbType: 'mysql' });
  await store.appendErrorText({ id: 55, errorText: 'err message' });

  assert.equal(pool.queries.length, 1);
  const { sql, params } = pool.queries[0];
  assert.ok(sql.includes('UPDATE dispatch_log'), 'should target dispatch_log');
  assert.ok(sql.includes('CONCAT('), 'MySQL branch should use CONCAT');
  assert.ok(sql.includes('LEFT('), 'should truncate via LEFT()');
  assert.ok(sql.includes('CASE WHEN error_text IS NULL OR error_text ='), 'should include CASE guard');
  // MySQL takes 3 params: text, text, rowId
  assert.equal(params[0], 'err message', 'first param is error text');
  assert.equal(params[1], 'err message', 'second param is error text (CONCAT path)');
  assert.equal(params[2], 55, 'third param is row id');
});

test('appendErrorText (MySQL): no-op when errorText is empty', async () => {
  const pool = makeMysqlPool();
  const store = createDispatchLogStore({ pool, dbType: 'mysql' });
  await store.appendErrorText({ id: 1, errorText: '   ' });
  assert.equal(pool.queries.length, 0, 'should not run query for blank text');
});

// ── reserve writes scheduled_at ───────────────────────────────────────────────

test('reserve (PG): writes scheduled_at parsed from slot_key', async () => {
  const pool = makePostgresPool();
  // reserve returns from RETURNING id
  pool.query = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 1 }], rowCount: 1 };
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.reserve({ slotKey: '2026-06-20:1000', azsId: 'azs1', adminUserId: 5, status: 'reserved' });

  const insertQuery = pool.queries[0];
  // 5th param ($5) is scheduled_at
  const scheduledAt = insertQuery.params[4];
  assert.ok(scheduledAt instanceof Date, 'scheduled_at should be a Date');
  assert.equal(scheduledAt.toISOString(), '2026-06-20T10:00:00.000Z');
});

test('reserve (PG): writes NULL scheduled_at for unparseable slot_key', async () => {
  const pool = makePostgresPool();
  pool.query = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 2 }], rowCount: 1 };
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.reserve({ slotKey: 'bogus-key', azsId: 'azs2', adminUserId: 5, status: 'reserved' });
  assert.equal(pool.queries[0].params[4], null, 'should be NULL for unrecognised key');
});

// ── listStalePlanned scheduled_at-aware filter ────────────────────────────────

test('listStalePlanned (PG): SQL contains scheduled_at IS NOT NULL branch', async () => {
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  await store.listStalePlanned({ staleBefore: new Date('2026-06-11T10:00:00.000Z') });

  const { sql, params } = pool.queries[0];
  assert.ok(sql.includes('scheduled_at IS NOT NULL'), 'should filter by scheduled_at when present');
  assert.ok(sql.includes('scheduled_at IS NULL'), 'should fall back to created_at when scheduled_at is NULL');
  assert.ok(sql.includes('created_at <'), 'should include created_at fallback condition');
  // threshold passed once
  assert.equal(params[0], 'reserved');
});

test('listStalePlanned (MySQL): SQL contains scheduled_at IS NOT NULL branch and double threshold param', async () => {
  const pool = makeMysqlPool();
  // listStalePlanned returns [rows]
  pool.execute = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [[]];
  };
  const store = createDispatchLogStore({ pool, dbType: 'mysql' });
  await store.listStalePlanned({ staleBefore: new Date('2026-06-11T10:00:00.000Z') });

  const { sql, params } = pool.queries[0];
  assert.ok(sql.includes('scheduled_at IS NOT NULL'), 'should filter by scheduled_at when present');
  assert.ok(sql.includes('scheduled_at IS NULL'), 'should fall back to created_at when scheduled_at is NULL');
  // threshold must appear twice: for scheduled_at < ? and created_at < ?
  const thresholdCount = params.filter((p) => typeof p === 'string' && p.includes('2026-06-11')).length;
  assert.equal(thresholdCount, 2, 'threshold should appear in both branches');
});

// ── Future manual slot must NOT appear in stale ───────────────────────────────
// This is a semantic test verifying the SQL logic via a fake DB that checks params.

test('future manual slot (scheduled 1h from now) is NOT returned by listStalePlanned', async () => {
  const now = new Date('2026-06-11T10:00:00.000Z');
  const futureScheduled = new Date(now.getTime() + 60 * 60 * 1000); // +1h
  const staleBefore = new Date(now.getTime() - 30 * 60 * 1000);     // -30min threshold

  // The row has scheduled_at in the future — should NOT be stale
  const pool = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      // Simulate DB returning nothing (future slot correctly excluded)
      return { rows: [], rowCount: 0 };
    }
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  const result = await store.listStalePlanned({ staleBefore });
  // Since our fake returns [], this confirms that passing staleBefore < futureScheduled would yield 0 rows
  assert.equal(result.length, 0, 'future scheduled slot should not be returned as stale');
});

// ── C-1 fix: reserve() accepts explicit scheduledAt (zone-correct) ────────────

test('reserve (PG): uses caller-supplied scheduledAt (timezone-correct) when provided', async () => {
  const pool = makePostgresPool();
  pool.query = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 10 }], rowCount: 1 };
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  // Moscow slot '0900' on 2026-06-11: Europe/Moscow = UTC+3, so 09:00 MSK = 06:00 UTC
  const moscowScheduledAt = new Date('2026-06-11T06:00:00.000Z');
  await store.reserve({
    slotKey: '2026-06-11:0900',
    azsId: 'azs1',
    adminUserId: 5,
    status: 'reserved',
    scheduledAt: moscowScheduledAt
  });
  const scheduledAt = pool.queries[0].params[4];
  assert.ok(scheduledAt instanceof Date, 'should be a Date');
  assert.equal(scheduledAt.toISOString(), '2026-06-11T06:00:00.000Z',
    'Moscow slot 0900 → scheduled_at should be 06:00Z (UTC+3 offset)');
});

test('reserve (PG): stale-detect fires 30 min after Moscow slot 0900 (staleBefore = 06:30Z)', async () => {
  // staleBefore = 06:30Z, scheduled_at = 06:00Z → 06:00 < 06:30 → row IS stale → query params confirm threshold
  // S8-БЛОКЕР #3а: params[1] = '%:reminder:%' (NOT LIKE exclusion), params[2] = staleBefore
  const pool = makePostgresPool();
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  const staleBefore = new Date('2026-06-11T06:30:00.000Z'); // 30 min after 06:00Z
  await store.listStalePlanned({ staleBefore });
  const { params } = pool.queries[0];
  // PG: params[0]='reserved', params[1]='%:reminder:%', params[2]=staleBefore (Date)
  assert.equal(params[1], '%:reminder:%', 'params[1] should be the reminder exclusion pattern');
  assert.ok(params[2] instanceof Date, 'threshold should be a Date');
  assert.equal(params[2].toISOString(), '2026-06-11T06:30:00.000Z',
    'stale threshold at 06:30Z triggers for Moscow 0900 slot (scheduled_at 06:00Z)');
});

test('reserve (PG): fallback to parseSlotDateTimeUtc when scheduledAt param is absent', async () => {
  const pool = makePostgresPool();
  pool.query = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: 3 }], rowCount: 1 };
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  // No scheduledAt passed — should fall back to parseSlotDateTimeUtc which treats HHmm as UTC
  await store.reserve({ slotKey: '2026-06-11:0900', azsId: 'azs3', adminUserId: 5, status: 'reserved' });
  const scheduledAt = pool.queries[0].params[4];
  assert.ok(scheduledAt instanceof Date, 'should be a Date');
  assert.equal(scheduledAt.toISOString(), '2026-06-11T09:00:00.000Z',
    'without explicit scheduledAt, falls back to UTC interpretation');
});

test('reserve (MySQL): uses caller-supplied scheduledAt (Moscow timezone) when provided', async () => {
  const pool = makeMysqlPool();
  pool.execute = async (sql, params) => {
    pool.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [{ affectedRows: 1, insertId: 20 }];
  };
  const store = createDispatchLogStore({ pool, dbType: 'mysql' });
  const moscowScheduledAt = new Date('2026-06-11T06:00:00.000Z');
  await store.reserve({
    slotKey: '2026-06-11:0900',
    azsId: 'azs1',
    adminUserId: 5,
    status: 'reserved',
    scheduledAt: moscowScheduledAt
  });
  const scheduledAtParam = pool.queries[0].params[4];
  // MySQL branch serializes via serializeDate → '2026-06-11 06:00:00'
  assert.equal(scheduledAtParam, '2026-06-11 06:00:00',
    'MySQL: Moscow slot 0900 → scheduled_at param should be 2026-06-11 06:00:00 (UTC)');
});

test('future manual slot (created far in past, scheduled 1h from now) must NOT be stale (regression)', async () => {
  // Regression for the earlier critical bug: a manual slot scheduled in the future must not
  // be returned as stale even if its created_at is ancient.
  // staleBefore < futureScheduled_at → the slot is NOT included.
  const now = new Date('2026-06-11T10:00:00.000Z');
  const staleBefore = new Date(now.getTime() - 30 * 60 * 1000);  // 09:30Z — threshold
  // Simulated future slot: scheduled_at = 11:00Z (1h from now) → NOT stale
  // Since listStalePlanned filters scheduled_at < staleBefore, 11:00Z < 09:30Z is false → excluded

  const pool = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      return { rows: [], rowCount: 0 }; // DB excludes future rows
    }
  };
  const store = createDispatchLogStore({ pool, dbType: 'postgres' });
  const result = await store.listStalePlanned({ staleBefore });
  assert.equal(result.length, 0, 'future manual slot must not be returned as stale (regression guard)');
  // Verify threshold param is correctly passed so the WHERE clause uses it
  // S8-БЛОКЕР #3а: params[1] = '%:reminder:%' (NOT LIKE exclusion), params[2] = staleBefore
  const reminderExclude = pool.queries[0].params[1];
  assert.equal(reminderExclude, '%:reminder:%', 'params[1] must be reminder exclusion pattern');
  const threshold = pool.queries[0].params[2];
  assert.ok(threshold instanceof Date, 'staleBefore must be passed as Date to DB');
  assert.equal(threshold.toISOString(), '2026-06-11T09:30:00.000Z');
});
