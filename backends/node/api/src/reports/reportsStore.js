const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const normalizeDate = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toISOString();
};

const toViewModel = (row) => ({
  id: Number(row.id),
  slotKey: row.slot_key,
  azsId: row.azs_id,
  adminUserId: Number(row.admin_user_id),
  status: row.status,
  reportItemId: row.report_item_id ? Number(row.report_item_id) : null,
  jitterMinutes: row.jitter_minutes === null || row.jitter_minutes === undefined
    ? null
    : Number(row.jitter_minutes),
  scheduledAt: normalizeDate(row.scheduled_at),
  deadlineAt: normalizeDate(row.deadline_at),
  errorText: row.error_text || null,
  createdAt: normalizeDate(row.created_at),
  updatedAt: normalizeDate(row.updated_at)
});

const createPostgresStore = (pool) => ({
  async list({ dateFrom, dateTo, status, azsId, limit = 200 } = {}) {
    const where = [];
    const params = [];
    let idx = 1;

    if (dateFrom) {
      where.push(`created_at >= $${idx}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
      idx += 1;
    }
    if (dateTo) {
      where.push(`created_at <= $${idx}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
      idx += 1;
    }
    if (status) {
      where.push(`status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (azsId) {
      where.push(`azs_id = $${idx}`);
      params.push(azsId);
      idx += 1;
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT *
      FROM dispatch_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT $${idx}
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(toViewModel);
  },

  async getById(id) {
    const result = await pool.query('SELECT * FROM dispatch_log WHERE id = $1 LIMIT 1', [id]);
    if (!result.rows.length) {
      return null;
    }
    return toViewModel(result.rows[0]);
  }
});

const createMysqlStore = (pool) => ({
  async list({ dateFrom, dateTo, status, azsId, limit = 200 } = {}) {
    const where = [];
    const params = [];

    if (dateFrom) {
      where.push('created_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('created_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (azsId) {
      where.push('azs_id = ?');
      params.push(azsId);
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT *
      FROM dispatch_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(toViewModel);
  },

  async getById(id) {
    const [rows] = await pool.execute('SELECT * FROM dispatch_log WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return null;
    }
    return toViewModel(rows[0]);
  }
});

export const createReportsStore = ({ pool, dbType }) => {
  if (!pool) {
    throw new Error('pool is required');
  }
  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }
  return createPostgresStore(pool);
};

export default createReportsStore;

