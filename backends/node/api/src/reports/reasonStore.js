const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const toDateSql = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`toDateSql: invalid date: ${date}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------
const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_reason (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        azs_id TEXT NOT NULL,
        admin_user_id BIGINT NOT NULL,
        reason_code TEXT NOT NULL,
        reason_text TEXT NULL,
        source TEXT NOT NULL DEFAULT 'app',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(report_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_report_reason_azs_code
        ON report_reason (azs_id, reason_code, created_at)
    `);
  },

  async upsert({ reportId, azsId, adminUserId, reasonCode, reasonText = null, source = 'app' }) {
    const result = await pool.query(
      `INSERT INTO report_reason (report_id, azs_id, admin_user_id, reason_code, reason_text, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_id) DO UPDATE
         SET azs_id = EXCLUDED.azs_id,
             admin_user_id = EXCLUDED.admin_user_id,
             reason_code = EXCLUDED.reason_code,
             reason_text = EXCLUDED.reason_text,
             source = EXCLUDED.source,
             updated_at = NOW()
       RETURNING *`,
      [reportId, azsId, adminUserId, reasonCode, reasonText ?? null, source]
    );
    return result.rows[0] ?? null;
  },

  async getByReport(reportId) {
    const result = await pool.query(
      'SELECT * FROM report_reason WHERE report_id = $1 LIMIT 1',
      [reportId]
    );
    return result.rows[0] ?? null;
  },

  async countsByCode({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); idx++; }
    if (dateTo) { where.push(`created_at <= $${idx}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); idx++; }
    const normalizedIds = (Array.isArray(azsIds) ? azsIds : []).map(s => String(s || '').trim()).filter(Boolean);
    if (normalizedIds.length === 1) { where.push(`azs_id = $${idx}`); params.push(normalizedIds[0]); idx++; }
    else if (normalizedIds.length > 1) { where.push(`azs_id = ANY($${idx})`); params.push(normalizedIds); idx++; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT reason_code, COUNT(*)::int AS count FROM report_reason ${whereSql} GROUP BY reason_code ORDER BY count DESC`,
      params
    );
    return result.rows;
  },

  async countEmpty() {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM report_reason');
    return Number(result.rows[0]?.count || 0);
  }
});

// ---------------------------------------------------------------------------
// MySQL store
// ---------------------------------------------------------------------------
const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_reason (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        azs_id VARCHAR(64) NOT NULL,
        admin_user_id BIGINT NOT NULL,
        reason_code VARCHAR(64) NOT NULL,
        reason_text LONGTEXT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'app',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_report_reason_report (report_id),
        INDEX ix_report_reason_azs_code (azs_id, reason_code, created_at)
      )
    `);
  },

  async upsert({ reportId, azsId, adminUserId, reasonCode, reasonText = null, source = 'app' }) {
    await pool.execute(
      `INSERT INTO report_reason (report_id, azs_id, admin_user_id, reason_code, reason_text, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         azs_id = VALUES(azs_id),
         admin_user_id = VALUES(admin_user_id),
         reason_code = VALUES(reason_code),
         reason_text = VALUES(reason_text),
         source = VALUES(source)`,
      [reportId, azsId, adminUserId, reasonCode, reasonText ?? null, source]
    );
    const [rows] = await pool.execute(
      'SELECT * FROM report_reason WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    return rows[0] ?? null;
  },

  async getByReport(reportId) {
    const [rows] = await pool.execute(
      'SELECT * FROM report_reason WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    return rows[0] ?? null;
  },

  async countsByCode({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo) { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const normalizedIds = (Array.isArray(azsIds) ? azsIds : []).map(s => String(s || '').trim()).filter(Boolean);
    if (normalizedIds.length === 1) { where.push('azs_id = ?'); params.push(normalizedIds[0]); }
    else if (normalizedIds.length > 1) { where.push(`azs_id IN (${normalizedIds.map(() => '?').join(',')})`); params.push(...normalizedIds); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT reason_code, COUNT(*) AS count FROM report_reason ${whereSql} GROUP BY reason_code ORDER BY count DESC`,
      params
    );
    return rows.map(r => ({ reason_code: r.reason_code, count: Number(r.count) }));
  },

  async countEmpty() {
    const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM report_reason');
    return Number(rows[0]?.count || 0);
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export const createReasonStore = ({ pool, dbType } = {}) => {
  if (!pool) throw new Error('pool is required');
  return isMysql(dbType) ? createMysqlStore(pool) : createPostgresStore(pool);
};

export default createReasonStore;
