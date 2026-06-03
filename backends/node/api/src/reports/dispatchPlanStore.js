const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

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
      CREATE TABLE IF NOT EXISTS dispatch_plan (
        id BIGSERIAL PRIMARY KEY,
        plan_date TEXT NOT NULL,
        azs_id TEXT NOT NULL,
        admin_user_id BIGINT NOT NULL,
        base_time TEXT NOT NULL,
        execute_at TIMESTAMPTZ NOT NULL,
        jitter_minutes INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'planned',
        report_item_id BIGINT NULL,
        error_text TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(plan_date, azs_id, base_time)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_dispatch_plan_due ON dispatch_plan (status, execute_at)
    `);
  },

  async upsertPlanned({ planDate, azsId, adminUserId, baseTime, executeAt, jitterMinutes = 0 } = {}) {
    const result = await pool.query(
      `INSERT INTO dispatch_plan (plan_date, azs_id, admin_user_id, base_time, execute_at, jitter_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_date, azs_id, base_time) DO NOTHING RETURNING *`,
      [planDate, azsId, adminUserId, baseTime, executeAt, jitterMinutes]
    );
    return result.rows[0] ?? null;
  },

  async listDue({ now = new Date() } = {}) {
    const result = await pool.query(
      `SELECT * FROM dispatch_plan WHERE status='planned' AND execute_at <= $1 ORDER BY execute_at ASC`,
      [now]
    );
    return result.rows;
  },

  async markDispatched({ id, reportItemId }) {
    await pool.query(
      `UPDATE dispatch_plan SET status='dispatched', report_item_id=$1, updated_at=NOW() WHERE id=$2`,
      [reportItemId, id]
    );
  },

  async markFailed({ id, error }) {
    await pool.query(
      `UPDATE dispatch_plan SET status='failed', error_text=$1, updated_at=NOW() WHERE id=$2`,
      [error, id]
    );
  },

  async listByDate({ planDate }) {
    const result = await pool.query(
      `SELECT * FROM dispatch_plan WHERE plan_date=$1 ORDER BY execute_at ASC`,
      [planDate]
    );
    return result.rows;
  },

  async deletePlannedForDate({ planDate }) {
    const result = await pool.query(
      `DELETE FROM dispatch_plan WHERE plan_date=$1 AND status='planned'`,
      [planDate]
    );
    return result.rowCount ?? 0;
  },
});

// ---------------------------------------------------------------------------
// MySQL store
// ---------------------------------------------------------------------------

const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS dispatch_plan (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        plan_date VARCHAR(16) NOT NULL,
        azs_id VARCHAR(64) NOT NULL,
        admin_user_id BIGINT NOT NULL,
        base_time VARCHAR(8) NOT NULL,
        execute_at DATETIME NOT NULL,
        jitter_minutes INT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'planned',
        report_item_id BIGINT NULL,
        error_text LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_dispatch_plan (plan_date, azs_id, base_time),
        INDEX ix_dispatch_plan_due (status, execute_at)
      )
    `);
  },

  async upsertPlanned({ planDate, azsId, adminUserId, baseTime, executeAt, jitterMinutes = 0 } = {}) {
    const executeAtSql = toDateSql(executeAt);
    const [result] = await pool.execute(
      `INSERT IGNORE INTO dispatch_plan (plan_date, azs_id, admin_user_id, base_time, execute_at, jitter_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [planDate, azsId, adminUserId, baseTime, executeAtSql, jitterMinutes]
    );
    // Re-SELECT by unique key regardless of whether it was inserted or already existed
    const [rows] = await pool.execute(
      `SELECT * FROM dispatch_plan WHERE plan_date=? AND azs_id=? AND base_time=? LIMIT 1`,
      [planDate, azsId, baseTime]
    );
    return rows[0] ?? null;
  },

  async listDue({ now = new Date() } = {}) {
    const nowSql = toDateSql(now);
    const [rows] = await pool.execute(
      `SELECT * FROM dispatch_plan WHERE status='planned' AND execute_at <= ? ORDER BY execute_at ASC`,
      [nowSql]
    );
    return rows;
  },

  async markDispatched({ id, reportItemId }) {
    await pool.execute(
      `UPDATE dispatch_plan SET status='dispatched', report_item_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [reportItemId, id]
    );
  },

  async markFailed({ id, error }) {
    await pool.execute(
      `UPDATE dispatch_plan SET status='failed', error_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [error, id]
    );
  },

  async listByDate({ planDate }) {
    const [rows] = await pool.execute(
      `SELECT * FROM dispatch_plan WHERE plan_date=? ORDER BY execute_at ASC`,
      [planDate]
    );
    return rows;
  },

  async deletePlannedForDate({ planDate }) {
    const [result] = await pool.execute(
      `DELETE FROM dispatch_plan WHERE plan_date=? AND status='planned'`,
      [planDate]
    );
    return result?.affectedRows ?? 0;
  },
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createDispatchPlanStore = ({ pool, dbType } = {}) => {
  if (!pool) {
    throw new Error('pool is required');
  }
  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }
  return createPostgresStore(pool);
};

export default createDispatchPlanStore;
