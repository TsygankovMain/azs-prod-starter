const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const DEFAULT_MAX_ATTEMPTS = 4;

const toDateSql = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`toDateSql: invalid date value: ${date}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_sync_jobs (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 4,
        last_error TEXT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_crm_sync_jobs_due ON crm_sync_jobs (status, next_attempt_at)
    `);
  },

  async enqueue({ reportId, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS, nextAttemptAt = new Date() } = {}) {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const result = await pool.query(
      `INSERT INTO crm_sync_jobs (report_id, payload, max_attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [reportId, payloadStr, maxAttempts, nextAttemptAt]
    );
    return result.rows[0];
  },

  async listByReport(reportId) {
    const result = await pool.query(
      `SELECT * FROM crm_sync_jobs WHERE report_id = $1 ORDER BY id ASC`,
      [reportId]
    );
    return result.rows;
  },

  async claimNextDue({ now = new Date() } = {}) {
    // Find the oldest pending due job that has no sibling already running
    const selectResult = await pool.query(
      `SELECT * FROM crm_sync_jobs WHERE status = 'pending' AND next_attempt_at <= $1 AND report_id NOT IN (SELECT report_id FROM crm_sync_jobs WHERE status = 'running') ORDER BY id ASC LIMIT 1`,
      [now]
    );
    const candidate = selectResult.rows[0];
    if (!candidate) return null;

    const updateResult = await pool.query(
      `UPDATE crm_sync_jobs SET status = 'running', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [candidate.id]
    );
    return updateResult.rows[0] ?? null;
  },

  async reclaimStale({ runningTimeoutMs } = {}) {
    // Re-queue orphaned 'running' jobs (e.g. a process that crashed mid-run).
    // With no timeout: reset ALL 'running' rows — correct for the single-worker-
    // per-process model, where the worker only calls this at startup (so any
    // 'running' row is by definition orphaned). With a timeout: only rows whose
    // updated_at predates the cutoff, so future multi-worker setups stay safe.
    if (Number.isFinite(runningTimeoutMs)) {
      const cutoff = new Date(Date.now() - Number(runningTimeoutMs));
      const result = await pool.query(
        `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW() WHERE status = 'running' AND updated_at < $1`,
        [cutoff]
      );
      return result.rowCount ?? 0;
    }
    const result = await pool.query(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW() WHERE status = 'running'`
    );
    return result.rowCount ?? 0;
  },

  async markDone({ id }) {
    await pool.query(
      `UPDATE crm_sync_jobs SET status = 'done', updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  async markFailed({ id, error }) {
    await pool.query(
      `UPDATE crm_sync_jobs SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
      [error, id]
    );
  },

  async reschedule({ id, nextAttemptAt, error = null }) {
    await pool.query(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = $1, last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $3`,
      [nextAttemptAt, error, id]
    );
  }
});

// ---------------------------------------------------------------------------
// MySQL store
// ---------------------------------------------------------------------------

const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS crm_sync_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        payload LONGTEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 4,
        last_error LONGTEXT NULL,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX ix_crm_sync_jobs_due (status, next_attempt_at)
      )
    `);
  },

  async enqueue({ reportId, payload, maxAttempts = DEFAULT_MAX_ATTEMPTS, nextAttemptAt = new Date() } = {}) {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const nextAttemptSql = toDateSql(nextAttemptAt);
    const [result] = await pool.execute(
      `INSERT INTO crm_sync_jobs (report_id, payload, max_attempts, next_attempt_at)
       VALUES (?, ?, ?, ?)`,
      [reportId, payloadStr, maxAttempts, nextAttemptSql]
    );
    const [rows] = await pool.execute(
      `SELECT * FROM crm_sync_jobs WHERE id = ? LIMIT 1`,
      [result.insertId]
    );
    return rows[0];
  },

  async listByReport(reportId) {
    const [rows] = await pool.execute(
      `SELECT * FROM crm_sync_jobs WHERE report_id = ? ORDER BY id ASC`,
      [reportId]
    );
    return rows;
  },

  async claimNextDue({ now = new Date() } = {}) {
    const nowSql = toDateSql(now);
    // MySQL requires the NOT IN subquery to be wrapped to avoid "can't reopen table" error
    const [candidates] = await pool.execute(
      `SELECT * FROM crm_sync_jobs WHERE status = 'pending' AND next_attempt_at <= ? AND report_id NOT IN (SELECT report_id FROM (SELECT report_id FROM crm_sync_jobs WHERE status = 'running') t) ORDER BY id ASC LIMIT 1`,
      [nowSql]
    );
    const candidate = candidates[0];
    if (!candidate) return null;

    const [updateResult] = await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
      [candidate.id]
    );
    if (!updateResult || updateResult.affectedRows === 0) return null;
    const [rows] = await pool.execute(
      `SELECT * FROM crm_sync_jobs WHERE id = ? LIMIT 1`,
      [candidate.id]
    );
    return rows[0] ?? null;
  },

  async reclaimStale({ runningTimeoutMs } = {}) {
    // See PG impl above for semantics. Returns affectedRows.
    if (Number.isFinite(runningTimeoutMs)) {
      const cutoffSql = toDateSql(new Date(Date.now() - Number(runningTimeoutMs)));
      const [result] = await pool.execute(
        `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE status = 'running' AND updated_at < ?`,
        [cutoffSql]
      );
      return result?.affectedRows ?? 0;
    }
    const [result] = await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE status = 'running'`
    );
    return result?.affectedRows ?? 0;
  },

  async markDone({ id }) {
    await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
  },

  async markFailed({ id, error }) {
    await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [error, id]
    );
  },

  async reschedule({ id, nextAttemptAt, error = null }) {
    const nextAttemptSql = toDateSql(nextAttemptAt);
    await pool.execute(
      `UPDATE crm_sync_jobs SET status = 'pending', next_attempt_at = ?, last_error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextAttemptSql, error, id]
    );
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** NOTE: payload is JSON.stringified on write and returned as a raw JSON string on read — caller must JSON.parse. */
export const createCrmSyncJobStore = ({ pool, dbType } = {}) => {
  if (!pool) {
    throw new Error('pool is required');
  }
  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }
  return createPostgresStore(pool);
};

export default createCrmSyncJobStore;
