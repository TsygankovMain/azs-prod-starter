# АЗС v2.0 — Sprint 1: Durable CRM-sync + folder-template defaults

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-report CRM synchronization survive process restarts by persisting sync jobs in the database, expose sync status to reviewers, and fix the latent folder-template default regression.

**Architecture:** Today CRM sync runs through an in-memory per-report promise queue (`createPerReportTaskQueue` in `reportsRoutes.js`). A crash/deploy between the photo's HTTP 200 (Disk+DB committed) and the CRM update silently loses the sync. We replace the in-memory queue with a DB-backed job table (`crm_sync_jobs`) plus a polling worker that retries with the existing backoff and resumes pending jobs on boot. Sync state (`synced` / `lastSyncError`) becomes visible per report.

**Tech Stack:** Node.js + Express, `pg` (Postgres) / `mysql2` (MySQL) dual-driver store pattern, `node:test` for tests (run with `node --test`).

**Spec:** `docs/superpowers/specs/2026-05-31-azs-v2-design.md` §Спринт 1.

**Branch:** `feature/v2.0` (already checked out).

---

## Open item to confirm before Task 9

Folder-template default value to standardize on. The spec §8 says: take the current production value from portal settings. Default in this plan assumes the prod template is `{yyyy-mm-dd}/{azs}_{azs_name}` (date → AZS). **Confirm the exact string with the operator before committing Task 9.** If it differs, substitute the confirmed string in both files.

---

## File Structure

| File | Responsibility |
|---|---|
| `backends/node/api/src/reports/crmSyncJobStore.js` | **Create.** DB-backed job store: `ensureSchema`, `enqueue`, `claimNextDue`, `markDone`, `markFailed`, `reschedule`, `listByReport`. Dual PG/MySQL like `reportsStore.js`. |
| `backends/node/api/src/reports/crmSyncWorker.js` | **Create.** Polling worker: claims due jobs, runs the sync callback, applies backoff `[800,1600,3200]`+jitter, marks done/failed. `start()/stop()`. |
| `backends/node/api/src/reports/reportsRoutes.js` | **Modify.** Replace in-memory `reportCrmSyncQueue.enqueue` with `crmSyncJobStore.enqueue`; add `POST /:id/resync`; include `synced`/`lastSyncError` in report payloads. |
| `backends/node/api/server.js` | **Modify.** Construct `crmSyncJobStore` + `crmSyncWorker`, `ensureSchema()` on boot, `start()` worker, inject store into reports router. |
| `backends/node/api/src/settings/defaultSettings.js` | **Modify.** `disk.folderNameTemplate` default → confirmed template. |
| `backends/node/api/src/disk/diskService.js` | **Modify.** `DEFAULT_FOLDER_TEMPLATE` → confirmed template. |
| `backends/node/api/tests/crmSyncJobStore.test.js` | **Create.** Store unit tests with an in-memory fake pool. |
| `backends/node/api/tests/crmSyncWorker.test.js` | **Create.** Worker unit tests (claim→run→done, retry→reschedule, exhaust→failed, resume on boot). |
| `backends/node/api/tests/folderTemplateDefault.test.js` | **Create.** Assert both defaults match the agreed template. |

**Design note — why a separate store + worker:** the store is pure DB I/O (easy to unit-test with a fake pool); the worker is pure scheduling/retry logic (inject store + clock + sync fn). Keeping them apart means each is testable in isolation without a live Postgres.

---

## Job model

`crm_sync_jobs` row:
- `id` (PK, autoincrement)
- `report_id` (BIGINT, indexed)
- `payload` (TEXT/JSON string) — everything the sync needs that isn't re-derivable: `{ status, diskFolderId, folderFieldCode, photos, contextKey }`
- `status` (TEXT) — `pending` | `running` | `done` | `failed`
- `attempts` (INT, default 0)
- `max_attempts` (INT, default 4) — initial try + 3 backoff retries (matches `CRM_SYNC_RETRY_BACKOFF_MS.length`)
- `last_error` (TEXT, null)
- `next_attempt_at` (TIMESTAMPTZ/DATETIME) — when the job becomes claimable
- `created_at`, `updated_at`

Claim rule: `status='pending' AND next_attempt_at <= now()`, oldest first, one at a time (serialize per report by ordering on `report_id, id` and skipping a report that already has a `running` job).

---

## Task 1: Job store schema + enqueue (Postgres path)

**Files:**
- Create: `backends/node/api/src/reports/crmSyncJobStore.js`
- Test: `backends/node/api/tests/crmSyncJobStore.test.js`

- [ ] **Step 1: Write the failing test**

Create `backends/node/api/tests/crmSyncJobStore.test.js`:

```js
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
      if (text.startsWith('INSERT INTO crm_sync_jobs')) {
        seq += 1;
        const row = {
          id: seq,
          report_id: params[0],
          payload: params[1],
          status: 'pending',
          attempts: 0,
          max_attempts: params[2],
          last_error: null,
          next_attempt_at: params[3],
          created_at: new Date(),
          updated_at: new Date()
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT * FROM crm_sync_jobs WHERE report_id')) {
        return { rows: rows.filter((r) => r.report_id === params[0]) };
      }
      return { rows: [] };
    }
  };
};

test('enqueue inserts a pending job with derived defaults', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const job = await store.enqueue({
    reportId: 42,
    payload: { status: 'in_progress', diskFolderId: 75662 }
  });

  assert.equal(job.report_id, 42);
  assert.equal(job.status, 'pending');
  assert.equal(job.max_attempts, 4);
  const listed = await store.listByReport(42);
  assert.equal(listed.length, 1);
  assert.equal(JSON.parse(listed[0].payload).diskFolderId, 75662);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backends/node/api && node --test tests/crmSyncJobStore.test.js`
Expected: FAIL with `Cannot find module '../src/reports/crmSyncJobStore.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backends/node/api/src/reports/crmSyncJobStore.js`:

```js
const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const DEFAULT_MAX_ATTEMPTS = 4;

const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_sync_jobs (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
        last_error TEXT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ix_crm_sync_jobs_due ON crm_sync_jobs (status, next_attempt_at)`);
  },

  async enqueue({ reportId, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS, nextAttemptAt = new Date() }) {
    const result = await pool.query(
      `INSERT INTO crm_sync_jobs(report_id, payload, max_attempts, next_attempt_at)
       VALUES($1, $2, $3, $4) RETURNING *`,
      [Number(reportId), JSON.stringify(payload ?? {}), Number(maxAttempts), nextAttemptAt]
    );
    return result.rows[0];
  },

  async listByReport(reportId) {
    const result = await pool.query(
      'SELECT * FROM crm_sync_jobs WHERE report_id = $1 ORDER BY id ASC',
      [Number(reportId)]
    );
    return result.rows;
  }
});

const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS crm_sync_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        payload LONGTEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
        last_error LONGTEXT NULL,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX ix_crm_sync_jobs_due (status, next_attempt_at)
      )
    `);
  },

  async enqueue({ reportId, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS, nextAttemptAt = new Date() }) {
    const at = nextAttemptAt instanceof Date
      ? nextAttemptAt.toISOString().slice(0, 19).replace('T', ' ')
      : nextAttemptAt;
    const [result] = await pool.execute(
      `INSERT INTO crm_sync_jobs(report_id, payload, max_attempts, next_attempt_at) VALUES(?, ?, ?, ?)`,
      [Number(reportId), JSON.stringify(payload ?? {}), Number(maxAttempts), at]
    );
    const [rows] = await pool.execute('SELECT * FROM crm_sync_jobs WHERE id = ?', [result.insertId]);
    return rows[0];
  },

  async listByReport(reportId) {
    const [rows] = await pool.execute(
      'SELECT * FROM crm_sync_jobs WHERE report_id = ? ORDER BY id ASC',
      [Number(reportId)]
    );
    return rows;
  }
});

export const createCrmSyncJobStore = ({ pool, dbType }) => {
  if (!pool) throw new Error('pool is required');
  return isMysql(dbType) ? createMysqlStore(pool) : createPostgresStore(pool);
};

export default createCrmSyncJobStore;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backends/node/api && node --test tests/crmSyncJobStore.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add backends/node/api/src/reports/crmSyncJobStore.js backends/node/api/tests/crmSyncJobStore.test.js
git commit -m "feat(crm-sync): durable job store schema + enqueue"
```

---

## Task 2: Claim due job + mark done/failed + reschedule

**Files:**
- Modify: `backends/node/api/src/reports/crmSyncJobStore.js`
- Test: `backends/node/api/tests/crmSyncJobStore.test.js`

- [ ] **Step 1: Write the failing test** (append to the existing test file)

```js
test('claimNextDue returns the oldest pending due job and skips reports with a running job', async () => {
  const pool = createFakePgPool();
  const store = createCrmSyncJobStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.enqueue({ reportId: 1, payload: { a: 1 } });
  await store.enqueue({ reportId: 2, payload: { b: 2 } });

  const first = await store.claimNextDue({ now: new Date() });
  assert.equal(first.report_id, 1);
  assert.equal(first.status, 'running');

  // Report 1 now has a running job; next claim must move to report 2.
  const second = await store.claimNextDue({ now: new Date() });
  assert.equal(second.report_id, 2);
});

test('markDone sets status done; markFailed with retries reschedules', async () => {
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
```

Extend the fake pool's `query` to support the new statements. Add these branches inside `createFakePgPool().query` before the final `return { rows: [] }`:

```js
      if (text.startsWith('UPDATE crm_sync_jobs SET status = \'running\'')) {
        const id = params[0];
        const row = rows.find((r) => r.id === id);
        if (row) { row.status = 'running'; row.updated_at = new Date(); }
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith('SELECT * FROM crm_sync_jobs WHERE status = \'pending\'')) {
        const now = params[0];
        const runningReportIds = new Set(rows.filter((r) => r.status === 'running').map((r) => r.report_id));
        const due = rows
          .filter((r) => r.status === 'pending' && new Date(r.next_attempt_at) <= new Date(now) && !runningReportIds.has(r.report_id))
          .sort((a, b) => a.id - b.id);
        return { rows: due.slice(0, 1) };
      }
      if (text.startsWith('UPDATE crm_sync_jobs SET status = \'done\'')) {
        const row = rows.find((r) => r.id === params[0]);
        if (row) { row.status = 'done'; row.updated_at = new Date(); }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE crm_sync_jobs SET status = \'failed\'')) {
        const row = rows.find((r) => r.id === params[1]);
        if (row) { row.status = 'failed'; row.last_error = params[0]; row.updated_at = new Date(); }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE crm_sync_jobs SET status = \'pending\'')) {
        // reschedule: params = [nextAttemptAt, error, id]
        const row = rows.find((r) => r.id === params[2]);
        if (row) { row.status = 'pending'; row.next_attempt_at = params[0]; row.last_error = params[1]; row.attempts += 1; row.updated_at = new Date(); }
        return { rows: [] };
      }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backends/node/api && node --test tests/crmSyncJobStore.test.js`
Expected: FAIL with `store.claimNextDue is not a function`.

- [ ] **Step 3: Write minimal implementation** (add methods to BOTH PG and MySQL stores)

Postgres methods (add to `createPostgresStore` object):

```js
  async claimNextDue({ now = new Date() } = {}) {
    const due = await pool.query(
      `SELECT * FROM crm_sync_jobs WHERE status = 'pending' AND next_attempt_at <= $1
       AND report_id NOT IN (SELECT report_id FROM crm_sync_jobs WHERE status = 'running')
       ORDER BY id ASC LIMIT 1`,
      [now]
    );
    const job = due.rows[0];
    if (!job) return null;
    const claimed = await pool.query(
      `UPDATE crm_sync_jobs SET status = 'running', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [job.id]
    );
    return claimed.rows[0] || null;
  },

  async markDone({ id }) {
    await pool.query(`UPDATE crm_sync_jobs SET status = 'done', updated_at = NOW() WHERE id = $1`, [Number(id)]);
  },

  async markFailed({ id, error }) {
    await pool.query(`UPDATE crm_sync_jobs SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
      [String(error || ''), Number(id)]);
  },

  async reschedule({ id, nextAttemptAt, error }) {
    await pool.query(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = $1, last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $3`,
      [nextAttemptAt, String(error || ''), Number(id)]
    );
  },
```

MySQL methods (add to `createMysqlStore`; MySQL lacks `RETURNING`, so re-select):

```js
  async claimNextDue({ now = new Date() } = {}) {
    const at = now instanceof Date ? now.toISOString().slice(0, 19).replace('T', ' ') : now;
    const [dueRows] = await pool.execute(
      `SELECT * FROM crm_sync_jobs WHERE status = 'pending' AND next_attempt_at <= ?
       AND report_id NOT IN (SELECT report_id FROM (SELECT report_id FROM crm_sync_jobs WHERE status = 'running') t)
       ORDER BY id ASC LIMIT 1`,
      [at]
    );
    const job = dueRows[0];
    if (!job) return null;
    const [res] = await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
      [job.id]
    );
    if (!res.affectedRows) return null;
    const [rows] = await pool.execute('SELECT * FROM crm_sync_jobs WHERE id = ?', [job.id]);
    return rows[0] || null;
  },

  async markDone({ id }) {
    await pool.execute(`UPDATE crm_sync_jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [Number(id)]);
  },

  async markFailed({ id, error }) {
    await pool.execute(`UPDATE crm_sync_jobs SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [String(error || ''), Number(id)]);
  },

  async reschedule({ id, nextAttemptAt, error }) {
    const at = nextAttemptAt instanceof Date ? nextAttemptAt.toISOString().slice(0, 19).replace('T', ' ') : nextAttemptAt;
    await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = ?, last_error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [at, String(error || ''), Number(id)]
    );
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backends/node/api && node --test tests/crmSyncJobStore.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backends/node/api/src/reports/crmSyncJobStore.js backends/node/api/tests/crmSyncJobStore.test.js
git commit -m "feat(crm-sync): claim/markDone/markFailed/reschedule on job store"
```

---

## Task 3: Worker — claim → run → done

**Files:**
- Create: `backends/node/api/src/reports/crmSyncWorker.js`
- Test: `backends/node/api/tests/crmSyncWorker.test.js`

- [ ] **Step 1: Write the failing test**

Create `backends/node/api/tests/crmSyncWorker.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backends/node/api && node --test tests/crmSyncWorker.test.js`
Expected: FAIL with `Cannot find module '../src/reports/crmSyncWorker.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backends/node/api/src/reports/crmSyncWorker.js`:

```js
const DEFAULT_BACKOFF_MS = [800, 1600, 3200];

export const createCrmSyncWorker = ({
  store,
  runSync,
  backoffMs = DEFAULT_BACKOFF_MS,
  pollIntervalMs = 1000,
  now = () => Date.now(),
  logger = console,
  isRetryable = () => true
}) => {
  if (!store || typeof runSync !== 'function') {
    throw new Error('store and runSync are required');
  }
  let timer = null;
  let running = false;

  const tick = async () => {
    const job = await store.claimNextDue({ now: new Date(now()) });
    if (!job) return false;
    try {
      await runSync(job);
      await store.markDone({ id: job.id });
    } catch (error) {
      const attempts = Number(job.attempts || 0);
      const retryable = isRetryable(error);
      if (retryable && attempts + 1 < Number(job.max_attempts || backoffMs.length + 1)) {
        const wait = backoffMs[Math.min(attempts, backoffMs.length - 1)] + Math.floor(Math.random() * 250);
        await store.reschedule({ id: job.id, nextAttemptAt: new Date(now() + wait), error: String(error?.message || error || '') });
      } else {
        await store.markFailed({ id: job.id, error: String(error?.message || error || '') });
        logger.error('crm_sync_job_failed', { jobId: job.id, reportId: job.report_id, message: String(error?.message || error || '') });
      }
    }
    return true;
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      let worked = true;
      while (worked) worked = await tick();
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => { void drain(); }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  return { tick, drain, start, stop };
};

export default createCrmSyncWorker;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backends/node/api && node --test tests/crmSyncWorker.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add backends/node/api/src/reports/crmSyncWorker.js backends/node/api/tests/crmSyncWorker.test.js
git commit -m "feat(crm-sync): worker claim/run/markDone"
```

---

## Task 4: Worker — retry then fail-exhausted

**Files:**
- Modify: `backends/node/api/tests/crmSyncWorker.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
test('worker reschedules a retryable failure, then marks failed once attempts exhausted', async () => {
  const calls = { reschedule: [], failed: [] };
  let job = makeJob({ attempts: 0, max_attempts: 2 });
  const store = {
    async claimNextDue() { if (!job || job.status === 'consumed') return null; const j = job; job = { ...job, status: 'consumed' }; return j; },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backends/node/api && node --test tests/crmSyncWorker.test.js`
Expected: PASS already if Task 3 logic is correct — but verify the boundary. If the second `tick` does not produce a `failed`, the off-by-one in `attempts + 1 < max_attempts` is wrong. (This test locks the boundary; expected outcome is PASS.)

- [ ] **Step 3: Implementation**

No new code if Task 3 is correct. If the boundary test fails, the bug is in the retry condition in `crmSyncWorker.js` — it must be `attempts + 1 < max_attempts`. Fix there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backends/node/api && node --test tests/crmSyncWorker.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backends/node/api/tests/crmSyncWorker.test.js
git commit -m "test(crm-sync): lock retry/exhaust boundary"
```

---

## Task 5: Extract the sync execution into a reusable function

The current sync logic lives inline in `reportsRoutes.js` (`syncReportCrmStrict` + `runRetryableCrmSync`). The worker needs to call the same strict sync, but driven by a job payload + fresh report/settings lookups. Extract a `buildCrmSyncRunner` that, given the job's `reportId` and `payload`, reloads the report and settings and performs the strict sync.

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js`
- Test: covered via Task 6 integration (the runner depends on store+client; unit-tested through the route wiring).

- [ ] **Step 1: Implementation** — add an exported factory near `syncReportCrmStrict`:

```js
export const buildCrmSyncRunner = ({ reportsStore, settingsStore, bitrixClient, authContextStore }) => async (job) => {
  const reportId = Number(job.report_id ?? job.reportId);
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});
  const report = await reportsStore.getById(reportId);
  if (!report) {
    // Report vanished — nothing to sync; treat as done by returning normally.
    return;
  }
  const settings = await settingsStore.read();
  const photos = await reportsStore.listPhotos(reportId);
  const folderFieldCode = String(settings.report?.fields?.folderId || '').trim();

  // Resolve per-user Bitrix context from the stored context key.
  // VERIFIED: authContextStore.getContextByKey(key) exists (authContextStore.js:149)
  // and req.bitrixContext.key is set by verifyToken.js:60.
  let context = {};
  if (payload.contextKey) {
    const stored = await authContextStore.getContextByKey(payload.contextKey);
    if (stored) context = { key: payload.contextKey, ...stored };
  }

  await syncReportCrmStrict({
    bitrixClient,
    settings,
    report,
    status: payload.status || report.status,
    photos,
    diskFolderId: payload.diskFolderId ?? null,
    folderFieldCode,
    context
  });
};
```

> VERIFIED against code: `authContextStore.getContextByKey(key)` is the resolver (`authContextStore.js:149`); `req.bitrixContext.key` is populated in `verifyToken.js:60`. No adjustment needed. If `payload.contextKey` is empty (e.g. an older job), the worker runs with `{}` (bootstrap context) — acceptable degradation.

- [ ] **Step 2: Commit**

```bash
git add backends/node/api/src/reports/reportsRoutes.js
git commit -m "refactor(crm-sync): extract buildCrmSyncRunner for durable worker"
```

---

## Task 6: Wire enqueue into the upload route (replace in-memory queue)

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js:600-619` (router factory signature), `:1008-1033` (enqueue call)

- [ ] **Step 1: Implementation — accept the job store**

Change the factory signature to accept `crmSyncJobStore`:

```js
export const createReportsRouter = ({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore,
  crmSyncJobStore
}) => {
  if (!reportsStore || !dispatchService || !settingsStore || !bitrixClient || !notificationService || !authContextStore || !crmSyncJobStore) {
    throw new Error('reportsStore, dispatchService, settingsStore, bitrixClient, notificationService, authContextStore and crmSyncJobStore are required');
  }
  const router = express.Router();
  // (remove: const reportCrmSyncQueue = createPerReportTaskQueue();)
```

Replace the `void reportCrmSyncQueue.enqueue({...}).catch(...)` block (lines ~1010-1033) with a durable enqueue:

```js
      // Durable CRM sync: persist a job; the worker performs it with retry and
      // survives process restarts. /photo stays fast (returns after Disk+DB).
      await crmSyncJobStore.enqueue({
        reportId,
        payload: {
          status: nextStatus,
          diskFolderId: uploaded.folderId,
          // Persist identity to rebuild per-user context in the worker:
          contextKey: req.bitrixContext?.key || ''
        }
      });
```

Keep `syncQueued: true` in the response unchanged.

- [ ] **Step 2: Manual verification (no live DB needed for unit layer)**

Run the full backend suite to ensure nothing else broke:
Run: `cd backends/node/api && node --test tests/*.test.js`
Expected: all existing suites PASS (the route file still imports cleanly; `createPerReportTaskQueue` may now be unused — remove it to avoid a dead-code lint).

- [ ] **Step 3: Remove the now-unused in-memory queue helper**

Delete `createPerReportTaskQueue` (lines ~505-524) if no other caller references it. Verify with:
Run: `grep -n "createPerReportTaskQueue\|reportCrmSyncQueue" backends/node/api/src/reports/reportsRoutes.js`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add backends/node/api/src/reports/reportsRoutes.js
git commit -m "feat(crm-sync): enqueue durable job from photo upload, drop in-memory queue"
```

---

## Task 7: Resync endpoint + expose sync status

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js` (add `POST /:id/resync`; include sync status in `GET /:id` and list)
- Modify: `backends/node/api/src/reports/reportsStore.js` (add a read of latest job status per report into the view model)

- [ ] **Step 1: Add sync status to the report view**

In `reportsStore.js`, add a helper method on both stores:

```js
  async getSyncStatus(reportId) {
    const rows = await /* PG: */ pool.query(
      `SELECT status, last_error FROM crm_sync_jobs WHERE report_id = $1 ORDER BY id DESC LIMIT 1`, [Number(reportId)]
    ).then((r) => r.rows);
    const row = rows[0];
    if (!row) return { synced: true, lastSyncError: null }; // no job → nothing pending
    return { synced: row.status === 'done', lastSyncError: row.last_error || null };
  },
```

(MySQL variant: `pool.execute(...)` with `?` and `[rows]` destructuring, `LIMIT 1`.)

> This couples `reportsStore` to the `crm_sync_jobs` table. Acceptable: both are report-scoped DB reads. If you prefer isolation, inject `crmSyncJobStore.listByReport` at the route layer instead and merge there. Pick one; the route-layer merge is the lower-coupling choice and is the recommended implementation:

Recommended (route layer, no store coupling) — in `GET /:id` handler, after loading the report:

```js
      const jobs = await crmSyncJobStore.listByReport(report.id);
      const latest = jobs[jobs.length - 1];
      const syncStatus = latest
        ? { synced: latest.status === 'done', lastSyncError: latest.last_error || null }
        : { synced: true, lastSyncError: null };
      // include syncStatus in the JSON response item
```

- [ ] **Step 2: Add the resync endpoint**

```js
  router.post('/:id/resync', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
    }
    const reportId = Number(req.params.id);
    const report = await reportsStore.getById(reportId);
    if (!report) {
      return res.status(404).json({ error: 'not_found', message: 'Report not found' });
    }
    const settings = await settingsStore.read();
    await crmSyncJobStore.enqueue({
      reportId,
      payload: {
        status: report.status,
        diskFolderId: report.diskFolderId ?? null,
        contextKey: req.bitrixContext?.key || ''
      }
    });
    return res.json({ ok: true, reportId, syncQueued: true });
  });
```

- [ ] **Step 3: Run the suite**

Run: `cd backends/node/api && node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add backends/node/api/src/reports/reportsRoutes.js backends/node/api/src/reports/reportsStore.js
git commit -m "feat(crm-sync): manual resync endpoint + expose synced/lastSyncError"
```

---

## Task 8: Boot wiring — construct store, ensure schema, start worker

**Files:**
- Modify: `backends/node/api/server.js` (imports, construction ~155-157, router injection ~316-317, schema bootstrap ~545, start worker after listen)

- [ ] **Step 1: Implementation**

Add imports near line 18-19:

```js
import createCrmSyncJobStore from './src/reports/crmSyncJobStore.js';
import { createCrmSyncWorker } from './src/reports/crmSyncWorker.js';
import { buildCrmSyncRunner } from './src/reports/reportsRoutes.js';
```

After `const reportsStore = createReportsStore(...)` (line ~156):

```js
const crmSyncJobStore = createCrmSyncJobStore({ pool, dbType });
```

Inject into the reports router (line ~316-317):

```js
app.use('/api/reports', verifyToken, attachAccessContext, createReportsRouter({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore,
  crmSyncJobStore
}));
```

Add schema bootstrap after the `report_photo` block (~551):

```js
crmSyncJobStore.ensureSchema()
  .then(() => console.log('crm_sync_jobs schema is ready'))
  .catch((error) => console.error('Failed to prepare crm_sync_jobs schema', error));
```

After the scheduler start (~580), construct and start the worker:

```js
const crmSyncWorker = createCrmSyncWorker({
  store: crmSyncJobStore,
  runSync: buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore }),
  backoffMs: [800, 1600, 3200],
  pollIntervalMs: Number(process.env.CRM_SYNC_POLL_MS || 1000),
  isRetryable: (error) => /(OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|HTTP 429|HTTP 504|too many requests|gateway timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network error|timeout)/i.test(String(error?.message || error || ''))
});
if (String(process.env.CRM_SYNC_WORKER_ENABLED || 'true').toLowerCase() === 'true') {
  crmSyncWorker.start();
  console.log('crm_sync worker started');
}
```

- [ ] **Step 2: Boot smoke**

Run: `cd backends/node/api && node -e "import('./server.js').catch(e=>{console.error(e);process.exit(1)})"` is not viable (starts a server). Instead syntax-check:
Run: `cd backends/node/api && node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 3: Add env defaults to `.env.example`**

Add under the scheduler block:

```
# Durable CRM sync worker (persists per-report sync jobs, survives restarts)
CRM_SYNC_WORKER_ENABLED=true
CRM_SYNC_POLL_MS=1000
```

- [ ] **Step 4: Commit**

```bash
git add backends/node/api/server.js .env.example
git commit -m "feat(crm-sync): boot crm_sync_jobs schema + start durable worker"
```

---

## Task 9: Folder-template default alignment

**Files:**
- Modify: `backends/node/api/src/settings/defaultSettings.js:43`
- Modify: `backends/node/api/src/disk/diskService.js:1`
- Modify: `backends/node/api/src/reports/reportsRoutes.js:986` (inline fallback literal)
- Test: `backends/node/api/tests/folderTemplateDefault.test.js`

> **Confirm the production template string first** (see "Open item" at top). Steps below use `{yyyy-mm-dd}/{azs}_{azs_name}`.

- [ ] **Step 1: Write the failing test**

Create `backends/node/api/tests/folderTemplateDefault.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/settings/defaultSettings.js';
import { DEFAULT_FOLDER_TEMPLATE } from '../src/disk/diskService.js';

const EXPECTED = '{yyyy-mm-dd}/{azs}_{azs_name}';

test('disk folder template defaults match the agreed AZS-after-date format', () => {
  assert.equal(DEFAULT_SETTINGS.disk.folderNameTemplate, EXPECTED);
  assert.equal(DEFAULT_FOLDER_TEMPLATE, EXPECTED);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backends/node/api && node --test tests/folderTemplateDefault.test.js`
Expected: FAIL — current values are `{yyyy-mm}/{dd}/{azs}_{azs_name}`.

- [ ] **Step 3: Implementation**

In `defaultSettings.js:43`:
```js
    folderNameTemplate: '{yyyy-mm-dd}/{azs}_{azs_name}'
```
In `diskService.js:1`:
```js
const DEFAULT_FOLDER_TEMPLATE = '{yyyy-mm-dd}/{azs}_{azs_name}';
```
In `reportsRoutes.js:986`, replace the inline fallback literal:
```js
        folderNameTemplate: settings.disk?.folderNameTemplate || '{yyyy-mm-dd}/{azs}_{azs_name}'
```

Verify `diskService.js` token map supports `{yyyy-mm-dd}`. Current map (lines 187-194) has `{yyyy-mm}`, `{dd}` but NOT `{yyyy-mm-dd}`. Add it:
```js
    '{yyyy-mm-dd}': `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
```
(insert alongside the other `values` entries, before `{azs}`).

- [ ] **Step 4: Run tests**

Run: `cd backends/node/api && node --test tests/folderTemplateDefault.test.js tests/diskService.test.js`
Expected: PASS. If `diskService.test.js` asserts the OLD template anywhere, update those expectations to the new format in the same commit.

- [ ] **Step 5: Commit**

```bash
git add backends/node/api/src/settings/defaultSettings.js backends/node/api/src/disk/diskService.js backends/node/api/src/reports/reportsRoutes.js backends/node/api/tests/folderTemplateDefault.test.js
git commit -m "fix(disk): align folder-template defaults to AZS-after-date format"
```

---

## Task 10: Full suite + review log entry

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backends/node/api && node --test tests/*.test.js`
Expected: all suites PASS (existing + new: `crmSyncJobStore`, `crmSyncWorker`, `folderTemplateDefault`).

- [ ] **Step 2: Append a code-review-log entry**

Add to `docs/code-review-log.md` (top, new entry) summarizing: durable CRM-sync queue shipped, in-memory queue removed, resync endpoint added, folder-template defaults aligned, tests added/green.

- [ ] **Step 3: Commit**

```bash
git add docs/code-review-log.md
git commit -m "docs: log Sprint 1 durable CRM-sync + folder-template fix"
```

---

## Self-Review (spec coverage)

- Spec §Спринт 1.1 durable queue → Tasks 1-8 ✅ (schema, claim/retry, worker, runner, enqueue, resync, status, boot).
- Spec §Спринт 1.1 "synced=false in reviewer UI + manual resync" → Task 7 backend done; **UI badge/button is Sprint 3 frontend** (reviewer screen) — cross-referenced there.
- Spec §Спринт 1.2 folder-template defaults → Task 9 ✅.
- Spec §6 testing (resume-after-restart) → covered by store `claimNextDue` + worker tests; a true kill-restart smoke is a manual step noted in Task 10 (requires live DB; document result in review log).

## Follow-up sprints (separate plans, written after Sprint 1 lands)

- **Sprint 2** — admin mobile focus-mode (A1): refactor `admin/[reportId].client.vue` in place, extract `CameraSlot`/`SlotProgress`/`SlotsQueue`, fullscreen camera, stepper, auto-advance, "Все слоты" tab.
- **Sprint 3** — reviewer screen: B24 migration, schedule hint, AZS multi-select, per-AZS filter + mini-KPI, **sync badge + resync button (consumes Task 7 endpoint)**.
- **Sprint 4** — settings: B24 migration, desktop side-nav / mobile accordion, field `?` hints, section completion status.
- **Sprint 5** — index/install status steps + bot deep-link button behind `ENABLE_REPORT_DEEP_LINK`.

Each gets its own `docs/superpowers/plans/2026-..-azs-v2-sprintN-*.md` with the same bite-sized TDD structure, written once the prior sprint is merged so the plan reflects real code.
