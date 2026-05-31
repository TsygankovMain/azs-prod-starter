import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmSyncJobStore } from '../src/reports/crmSyncJobStore.js';

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
