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
  async ensurePhotoSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_photo (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        photo_code TEXT NOT NULL,
        file_id BIGINT NULL,
        file_name TEXT NULL,
        disk_folder_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at TIMESTAMPTZ NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(report_id, photo_code)
      )
    `);
  },

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
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    uploadedBy,
    exifAt
  }) {
    await pool.query(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, uploaded_by, exif_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(report_id, photo_code) DO UPDATE
       SET file_id = EXCLUDED.file_id,
           file_name = EXCLUDED.file_name,
           disk_folder_id = EXCLUDED.disk_folder_id,
           uploaded_by = EXCLUDED.uploaded_by,
           exif_at = EXCLUDED.exif_at,
           uploaded_at = NOW(),
           updated_at = NOW()`,
      [reportId, photoCode, fileId, fileName, diskFolderId, uploadedBy, exifAt ?? null]
    );
  },

  async listPhotos(reportId) {
    const result = await pool.query(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = $1 ORDER BY photo_code ASC',
      [reportId]
    );
    return result.rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      uploadedBy: Number(row.uploaded_by),
      exifAt: normalizeDate(row.exif_at),
      uploadedAt: normalizeDate(row.uploaded_at)
    }));
  },

  async setReportStatus({ reportId, status }) {
    await pool.query(
      'UPDATE dispatch_log SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, reportId]
    );
  },

  async listOverdueReports({ now = new Date(), limit = 200 } = {}) {
    const result = await pool.query(
      `SELECT *
       FROM dispatch_log
       WHERE deadline_at IS NOT NULL
         AND deadline_at < $1
         AND status NOT IN ('done', 'expired')
       ORDER BY deadline_at ASC
       LIMIT $2`,
      [new Date(now), Math.min(Number(limit) || 200, 500)]
    );
    return result.rows.map(toViewModel);
  },

  async getSummary({ dateFrom, dateTo, azsId, now = new Date() } = {}) {
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
    if (azsId) {
      where.push(`azs_id = $${idx}`);
      params.push(azsId);
      idx += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const statusResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM dispatch_log ${whereSql} GROUP BY status`,
      params
    );

    const byStatus = {};
    let total = 0;
    for (const row of statusResult.rows) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    const overdueWhere = [...where, `deadline_at IS NOT NULL`, `deadline_at < $${idx}`, `status NOT IN ('done', 'expired')`];
    const overdueParams = [...params, new Date(now)];
    const overdueResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM dispatch_log WHERE ${overdueWhere.join(' AND ')}`,
      overdueParams
    );
    const overdue = Number(overdueResult.rows[0]?.count || 0);

    const open = Number(byStatus.new || 0) + Number(byStatus.in_progress || 0) + Number(byStatus.reserved || 0);
    const done = Number(byStatus.done || 0);
    const expired = Number(byStatus.expired || 0);
    const failed = Number(byStatus.failed || 0);

    return {
      total,
      overdue,
      open,
      done,
      expired,
      failed,
      byStatus
    };
  }
});

const createMysqlStore = (pool) => ({
  async ensurePhotoSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_photo (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        photo_code VARCHAR(191) NOT NULL,
        file_id BIGINT NULL,
        file_name VARCHAR(255) NULL,
        disk_folder_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at DATETIME NULL,
        uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_report_photo_report_code (report_id, photo_code)
      )
    `);
  },

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
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    uploadedBy,
    exifAt
  }) {
    await pool.execute(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, uploaded_by, exif_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_id = VALUES(file_id),
         file_name = VALUES(file_name),
         disk_folder_id = VALUES(disk_folder_id),
         uploaded_by = VALUES(uploaded_by),
         exif_at = VALUES(exif_at),
         uploaded_at = CURRENT_TIMESTAMP`,
      [
        reportId,
        photoCode,
        fileId ?? null,
        fileName ?? null,
        diskFolderId ?? null,
        uploadedBy,
        exifAt ? exifAt.toISOString().slice(0, 19).replace('T', ' ') : null
      ]
    );
  },

  async listPhotos(reportId) {
    const [rows] = await pool.execute(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = ? ORDER BY photo_code ASC',
      [reportId]
    );
    return rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      uploadedBy: Number(row.uploaded_by),
      exifAt: normalizeDate(row.exif_at),
      uploadedAt: normalizeDate(row.uploaded_at)
    }));
  },

  async setReportStatus({ reportId, status }) {
    await pool.execute(
      'UPDATE dispatch_log SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, reportId]
    );
  },

  async listOverdueReports({ now = new Date(), limit = 200 } = {}) {
    const dt = new Date(now);
    const sqlDate = Number.isNaN(dt.getTime())
      ? new Date().toISOString().slice(0, 19).replace('T', ' ')
      : dt.toISOString().slice(0, 19).replace('T', ' ');
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE deadline_at IS NOT NULL
         AND deadline_at < ?
         AND status NOT IN ('done', 'expired')
       ORDER BY deadline_at ASC
       LIMIT ?`,
      [sqlDate, Math.min(Number(limit) || 200, 500)]
    );
    return rows.map(toViewModel);
  },

  async getSummary({ dateFrom, dateTo, azsId, now = new Date() } = {}) {
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
    if (azsId) {
      where.push('azs_id = ?');
      params.push(azsId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [statusRows] = await pool.execute(
      `SELECT status, COUNT(*) AS count FROM dispatch_log ${whereSql} GROUP BY status`,
      params
    );

    const byStatus = {};
    let total = 0;
    for (const row of statusRows) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    const dt = new Date(now);
    const nowSql = Number.isNaN(dt.getTime())
      ? new Date().toISOString().slice(0, 19).replace('T', ' ')
      : dt.toISOString().slice(0, 19).replace('T', ' ');
    const overdueWhere = [...where, 'deadline_at IS NOT NULL', 'deadline_at < ?', "status NOT IN ('done', 'expired')"];
    const overdueParams = [...params, nowSql];
    const [overdueRows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM dispatch_log WHERE ${overdueWhere.join(' AND ')}`,
      overdueParams
    );
    const overdue = Number(overdueRows[0]?.count || 0);

    const open = Number(byStatus.new || 0) + Number(byStatus.in_progress || 0) + Number(byStatus.reserved || 0);
    const done = Number(byStatus.done || 0);
    const expired = Number(byStatus.expired || 0);
    const failed = Number(byStatus.failed || 0);

    return {
      total,
      overdue,
      open,
      done,
      expired,
      failed,
      byStatus
    };
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
