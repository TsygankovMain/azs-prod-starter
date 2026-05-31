import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmSyncJobStore } from '../src/reports/crmSyncJobStore.js';

// The MySQL store serializes timestamps via toDateSql (a UTC ISO slice with a
// space). Re-parsing such a string with `new Date()` would treat it as LOCAL
// time and drift by the host offset, so parse it back as UTC explicitly.
const parseSqlUtc = (value) => {
  if (value instanceof Date) return value;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? new Date(`${s.replace(' ', 'T')}Z`)
    : new Date(s);
};

// Minimal in-memory fake of a pg Pool: records SQL, serves canned rows.
const createFakePgPool = () => {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE')) return { rows: [] };
      if (text.startsWith('CREATE INDEX')) return { rows: [] };
      if (text.startsWith('INSERT INTO crm_sync_jobs')) {
        seq += 1;
        const row = {
          id: seq, report_id: params[0], payload: params[1], status: 'pending',
          attempts: 0, max_attempts: params[2], last_error: null,
          next_attempt_at: params[3], created_at: new Date(), updated_at: new Date()
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT * FROM crm_sync_jobs WHERE report_id')) {
        return { rows: rows.filter((r) => r.report_id === params[0]) };
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'running'")) {
        const row = rows.find((r) => r.id === params[0]);
        if (row) { row.status = 'running'; row.updated_at = new Date(); }
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith("SELECT * FROM crm_sync_jobs WHERE status = 'pending'")) {
        const now = params[0];
        const runningReportIds = new Set(rows.filter((r) => r.status === 'running').map((r) => r.report_id));
        const due = rows.filter((r) => r.status === 'pending' && new Date(r.next_attempt_at) <= new Date(now) && !runningReportIds.has(r.report_id)).sort((a, b) => a.id - b.id);
        return { rows: due.slice(0, 1) };
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'done'")) {
        const row = rows.find((r) => r.id === params[0]);
        if (row) { row.status = 'done'; row.updated_at = new Date(); }
        return { rows: [] };
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'failed'")) {
        const row = rows.find((r) => r.id === params[1]);
        if (row) { row.status = 'failed'; row.last_error = params[0]; row.updated_at = new Date(); }
        return { rows: [] };
      }
      // reclaimStale: move stuck 'running' jobs back to 'pending'.
      // Two shapes: with a WHERE updated_at < $1 cutoff (params[0]) or unconditional.
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = NOW()")) {
        const cutoff = text.includes('AND updated_at <') ? new Date(params[0]) : null;
        let count = 0;
        for (const row of rows) {
          if (row.status !== 'running') continue;
          if (cutoff && !(new Date(row.updated_at) < cutoff)) continue;
          row.status = 'pending';
          row.next_attempt_at = new Date();
          row.updated_at = new Date();
          count += 1;
        }
        return { rows: [], rowCount: count };
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'pending'")) {
        const row = rows.find((r) => r.id === params[2]);
        if (row) { row.status = 'pending'; row.next_attempt_at = params[0]; row.last_error = params[1]; row.attempts += 1; row.updated_at = new Date(); }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
};

test('enqueue inserts a pending job with derived defaults', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const job = await store.enqueue({ reportId: 42, payload: { status: 'in_progress', diskFolderId: 75662 } });
  assert.equal(job.report_id, 42);
  assert.equal(job.status, 'pending');
  assert.equal(job.max_attempts, 4);
  const listed = await store.listByReport(42);
  assert.equal(listed.length, 1);
  assert.equal(JSON.parse(listed[0].payload).diskFolderId, 75662);
});

test('claimNextDue returns the oldest pending due job and skips reports with a running job', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 1, payload: { a: 1 } });
  await store.enqueue({ reportId: 2, payload: { b: 2 } });
  const first = await store.claimNextDue({ now: new Date() });
  assert.equal(first.report_id, 1);
  assert.equal(first.status, 'running');
  const second = await store.claimNextDue({ now: new Date() });
  assert.equal(second.report_id, 2);
});

test('markDone sets status done; reschedule bumps attempts and keeps pending', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const job = await store.enqueue({ reportId: 7, payload: {} });
  const claimed = await store.claimNextDue({ now: new Date() });
  await store.reschedule({ id: claimed.id, nextAttemptAt: new Date(Date.now() + 800), error: 'boom' });
  const afterRetry = (await store.listByReport(7))[0];
  assert.equal(afterRetry.status, 'pending');
  assert.equal(afterRetry.attempts, 1);
  assert.equal(afterRetry.last_error, 'boom');
  await store.markDone({ id: job.id });
  const done = (await store.listByReport(7))[0];
  assert.equal(done.status, 'done');
});

// ---------------------------------------------------------------------------
// MySQL fake pool + tests
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mysql2-style fake pool.
 * execute(sql, params) returns [rowsOrResult, fields].
 * Call sequence is tracked via `calls` to serve canned responses per invocation.
 */
const createFakeMysqlPool = ({ affectedRowsOnUpdate = 1 } = {}) => {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }];
      if (text.startsWith('INSERT INTO crm_sync_jobs')) {
        seq += 1;
        const row = {
          id: seq, report_id: params[0], payload: params[1], status: 'pending',
          attempts: 0, max_attempts: params[2], last_error: null,
          next_attempt_at: params[3], created_at: new Date(), updated_at: new Date()
        };
        rows.push(row);
        return [{ insertId: seq }];
      }
      if (text.startsWith('SELECT * FROM crm_sync_jobs WHERE id = ?')) {
        const id = params[0];
        return [[rows.find((r) => r.id === id)]];
      }
      if (text.startsWith('SELECT * FROM crm_sync_jobs WHERE report_id = ?')) {
        return [rows.filter((r) => r.report_id === params[0])];
      }
      if (text.startsWith("SELECT * FROM crm_sync_jobs WHERE status = 'pending'")) {
        const nowVal = params[0];
        const runningIds = new Set(rows.filter((r) => r.status === 'running').map((r) => r.report_id));
        const due = rows.filter((r) => r.status === 'pending' && r.next_attempt_at <= nowVal && !runningIds.has(r.report_id)).sort((a, b) => a.id - b.id);
        return [due.slice(0, 1)];
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'running'")) {
        const id = params[0];
        const row = rows.find((r) => r.id === id && r.status === 'pending');
        if (row && affectedRowsOnUpdate > 0) { row.status = 'running'; row.updated_at = new Date(); }
        return [{ affectedRows: affectedRowsOnUpdate }];
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'done'")) {
        const row = rows.find((r) => r.id === params[0]);
        if (row) { row.status = 'done'; row.updated_at = new Date(); }
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'failed'")) {
        const row = rows.find((r) => r.id === params[1]);
        if (row) { row.status = 'failed'; row.last_error = params[0]; row.updated_at = new Date(); }
        return [{ affectedRows: 1 }];
      }
      // reclaimStale: move stuck 'running' jobs back to 'pending'.
      // Store next_attempt_at as the same SQL-string shape enqueue uses so the
      // subsequent claimNextDue (which compares against a SQL-string `now`) works.
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP")) {
        const cutoff = text.includes('AND updated_at <') ? parseSqlUtc(params[0]) : null;
        const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let count = 0;
        for (const row of rows) {
          if (row.status !== 'running') continue;
          if (cutoff && !(new Date(row.updated_at) < cutoff)) continue;
          row.status = 'pending';
          row.next_attempt_at = nowSql;
          row.updated_at = new Date();
          count += 1;
        }
        return [{ affectedRows: count }];
      }
      if (text.startsWith("UPDATE crm_sync_jobs SET status = 'pending'")) {
        const row = rows.find((r) => r.id === params[2]);
        if (row) { row.status = 'pending'; row.next_attempt_at = params[0]; row.last_error = params[1]; row.attempts += 1; row.updated_at = new Date(); }
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
  };
};

test('MySQL: enqueue returns the inserted row', async () => {
  const pool = createFakeMysqlPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const job = await store.enqueue({ reportId: 10, payload: { key: 'val' } });
  assert.equal(job.report_id, 10);
  assert.equal(job.status, 'pending');
  assert.equal(job.id, 1);
});

test('MySQL: claimNextDue returns the job when affectedRows=1', async () => {
  const pool = createFakeMysqlPool({ affectedRowsOnUpdate: 1 });
  const store = createCrmSyncJobStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 20, payload: { x: 1 } });
  const claimed = await store.claimNextDue({ now: new Date() });
  assert.ok(claimed, 'should return the job');
  assert.equal(claimed.report_id, 20);
  assert.equal(claimed.status, 'running');
});

test('MySQL: claimNextDue returns null when affectedRows=0 (double-claim guard)', async () => {
  const pool = createFakeMysqlPool({ affectedRowsOnUpdate: 0 });
  const store = createCrmSyncJobStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 30, payload: { y: 2 } });
  const claimed = await store.claimNextDue({ now: new Date() });
  assert.equal(claimed, null, 'loser worker must get null, not a double-claimed row');
});

test('PG: markFailed sets status failed and records last_error', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const job = await store.enqueue({ reportId: 5, payload: { z: 3 } });
  const claimed = await store.claimNextDue({ now: new Date() });
  await store.markFailed({ id: claimed.id, error: 'network timeout' });
  const listed = await store.listByReport(5);
  assert.equal(listed[0].status, 'failed');
  assert.equal(listed[0].last_error, 'network timeout');
});

// ---------------------------------------------------------------------------
// C1: reclaimStale — orphaned 'running' jobs must be rescuable on boot
// ---------------------------------------------------------------------------

test('PG: reclaimStale resets a running job back to pending so it can be reclaimed', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 9, payload: { a: 1 } });
  const claimed = await store.claimNextDue({ now: new Date() });
  assert.equal(claimed.status, 'running');
  // The report is now skipped by claimNextDue (has a running job).
  assert.equal(await store.claimNextDue({ now: new Date() }), null);

  const reclaimed = await store.reclaimStale();
  assert.equal(reclaimed, 1, 'reclaimStale returns the reclaimed count');

  const afterReclaim = (await store.listByReport(9))[0];
  assert.equal(afterReclaim.status, 'pending', 'running job is pending again');

  const reclaimedAgain = await store.claimNextDue({ now: new Date() });
  assert.ok(reclaimedAgain, 'the previously-orphaned job is claimable once more');
  assert.equal(reclaimedAgain.report_id, 9);
});

test('PG: reclaimStale with runningTimeoutMs only resets rows older than the cutoff', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 11, payload: { a: 1 } });
  await store.claimNextDue({ now: new Date() }); // → running, updated_at = now

  // Large timeout → cutoff far in the past → recent running row NOT reclaimed.
  const none = await store.reclaimStale({ runningTimeoutMs: 60 * 60 * 1000 });
  assert.equal(none, 0, 'recent running row is not reclaimed under a large timeout');
  assert.equal((await store.listByReport(11))[0].status, 'running');

  // Negative timeout → cutoff is in the future → every running row IS reclaimed.
  const some = await store.reclaimStale({ runningTimeoutMs: -1000 });
  assert.equal(some, 1, 'row is reclaimed when the cutoff is in the future');
  assert.equal((await store.listByReport(11))[0].status, 'pending');
});

test('MySQL: reclaimStale resets running jobs back to pending and returns affectedRows', async () => {
  const pool = createFakeMysqlPool({ affectedRowsOnUpdate: 1 });
  const store = createCrmSyncJobStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 21, payload: { a: 1 } });
  const claimed = await store.claimNextDue({ now: new Date() });
  assert.equal(claimed.status, 'running');

  const reclaimed = await store.reclaimStale();
  assert.equal(reclaimed, 1);
  assert.equal((await store.listByReport(21))[0].status, 'pending');

  const reclaimedAgain = await store.claimNextDue({ now: new Date() });
  assert.ok(reclaimedAgain);
  assert.equal(reclaimedAgain.report_id, 21);
});

test('MySQL: reclaimStale with runningTimeoutMs respects the cutoff', async () => {
  const pool = createFakeMysqlPool({ affectedRowsOnUpdate: 1 });
  const store = createCrmSyncJobStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 22, payload: { a: 1 } });
  await store.claimNextDue({ now: new Date() });

  const none = await store.reclaimStale({ runningTimeoutMs: 60 * 60 * 1000 });
  assert.equal(none, 0);
  assert.equal((await store.listByReport(22))[0].status, 'running');

  const some = await store.reclaimStale({ runningTimeoutMs: -1000 });
  assert.equal(some, 1);
  assert.equal((await store.listByReport(22))[0].status, 'pending');
});
