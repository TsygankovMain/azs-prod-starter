const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

// ---------------------------------------------------------------------------
// Photo-feed cursor helpers  (keyset по uploaded_at DESC, rp.id DESC)
// ---------------------------------------------------------------------------

const encodeFeedCursor = (uploadedAt, id) =>
  Buffer.from(JSON.stringify({ ua: uploadedAt, id: Number(id) })).toString('base64');

const decodeFeedCursor = (cursor) => {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    const ua = String(raw.ua || '').trim();
    const id = Number(raw.id);
    if (!ua || !Number.isFinite(id)) return null;
    return { uploadedAt: ua, id };
  } catch {
    return null;
  }
};

const toFeedItemViewModel = (row) => ({
  reportId: Number(row.report_id),
  azsId: String(row.azs_id || ''),
  azsTitle: row.azs_title || null,
  photoCode: row.photo_code,
  exifAt: row.exif_at ? new Date(row.exif_at).toISOString() : null,
  uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
  photoRowId: Number(row.photo_row_id || row.id || 0),
  remark: row.remark_id ? {
    createdAt: row.remark_created_at ? new Date(row.remark_created_at).toISOString() : null,
    recipientName: row.remark_recipient_name || null,
    message: row.remark_message || '',
    senderName: row.remark_sender_name || null
  } : null
});

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
  diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
  createdAt: normalizeDate(row.created_at),
  updatedAt: normalizeDate(row.updated_at)
});

const ACTIVE_STATUS_ORDER_SQL = `CASE status
  WHEN 'in_progress' THEN 0
  WHEN 'new' THEN 1
  WHEN 'reserved' THEN 2
  ELSE 9
END`;

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
        disk_object_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at TIMESTAMPTZ NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(report_id, photo_code)
      )
    `);
    // Idempotent migration for existing tables (Postgres supports IF NOT EXISTS).
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS disk_object_id BIGINT NULL
    `);
  },

  async list({ dateFrom, dateTo, status, azsId, azsIds = [], limit = 200 } = {}) {
    const where = [];
    const params = [];
    let idx = 1;

    // BUG-014 fix: filter by updated_at (last status-change time) instead of
    // created_at (dispatch creation time).  R4Card asks "what happened in the
    // last 29 days"; a report is logically "in period" when it was completed /
    // expired within that window, not when the push was originally sent.
    if (dateFrom) {
      where.push(`updated_at >= $${idx}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
      idx += 1;
    }
    if (dateTo) {
      where.push(`updated_at <= $${idx}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
      idx += 1;
    }
    if (status) {
      where.push(`status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push(`azs_id = $${idx}`);
      params.push(selectedAzsIds[0]);
      idx += 1;
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id = ANY($${idx})`);
      params.push(selectedAzsIds);
      idx += 1;
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT d.*,
             (SELECT MAX(rp.disk_folder_id) FROM report_photo rp WHERE rp.report_id = d.id) AS disk_folder_id
      FROM dispatch_log d
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
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

  async listActiveByAdminUserId({ adminUserId, limit = 20 } = {}) {
    const userId = Number(adminUserId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return [];
    }

    const maxLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
    const sql = `
      SELECT *
      FROM dispatch_log
      WHERE admin_user_id = $1
        AND status IN ('new', 'in_progress', 'reserved')
      ORDER BY
        ${ACTIVE_STATUS_ORDER_SQL},
        deadline_at ASC NULLS LAST,
        id DESC
      LIMIT $2
    `;
    const result = await pool.query(sql, [userId, maxLimit]);
    return result.rows.map(toViewModel);
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    diskObjectId,
    uploadedBy,
    exifAt
  }) {
    await pool.query(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(report_id, photo_code) DO UPDATE
       SET file_id = EXCLUDED.file_id,
           file_name = EXCLUDED.file_name,
           disk_folder_id = EXCLUDED.disk_folder_id,
           disk_object_id = EXCLUDED.disk_object_id,
           uploaded_by = EXCLUDED.uploaded_by,
           exif_at = EXCLUDED.exif_at,
           uploaded_at = NOW(),
           updated_at = NOW()`,
      [reportId, photoCode, fileId, fileName, diskFolderId, diskObjectId ?? null, uploadedBy, exifAt ?? null]
    );
  },

  async listPhotos(reportId) {
    const result = await pool.query(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = $1 ORDER BY photo_code ASC',
      [reportId]
    );
    return result.rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
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

  async getSummary({ dateFrom, dateTo, azsId, azsIds = [], now = new Date() } = {}) {
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
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push(`azs_id = $${idx}`);
      params.push(selectedAzsIds[0]);
      idx += 1;
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id = ANY($${idx})`);
      params.push(selectedAzsIds);
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
  },

  // ---------------------------------------------------------------------------
  // listPhotosFeed — photo-feed with optional remark join
  // ---------------------------------------------------------------------------
  async listPhotosFeed({
    dateFrom, dateTo, azsIds = [], photoCodes = [],
    remarks = 'all', // 'all' | 'with' | 'without'
    limit = 50,
    cursor = null
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const where = [];
    const params = [];
    let idx = 1;

    if (dateFrom) {
      where.push(`rp.uploaded_at >= $${idx++}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
    }
    if (dateTo) {
      where.push(`rp.uploaded_at <= $${idx++}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
    }
    const normAzs = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normAzs.length === 1) {
      where.push(`d.azs_id = $${idx++}`);
      params.push(normAzs[0]);
    } else if (normAzs.length > 1) {
      where.push(`d.azs_id = ANY($${idx++})`);
      params.push(normAzs);
    }
    const normCodes = Array.isArray(photoCodes)
      ? photoCodes.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normCodes.length === 1) {
      where.push(`rp.photo_code = $${idx++}`);
      params.push(normCodes[0]);
    } else if (normCodes.length > 1) {
      where.push(`rp.photo_code = ANY($${idx++})`);
      params.push(normCodes);
    }

    // remark filter
    if (remarks === 'with') {
      where.push(`EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    } else if (remarks === 'without') {
      where.push(`NOT EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    }

    // keyset cursor
    if (cursor) {
      const decoded = decodeFeedCursor(cursor);
      if (decoded) {
        where.push(`(rp.uploaded_at, rp.id) < ($${idx}, $${idx + 1})`);
        idx += 2;
        params.push(new Date(decoded.uploadedAt), decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);

    const sql = `
      SELECT
        rp.id         AS photo_row_id,
        rp.report_id,
        rp.photo_code,
        rp.exif_at,
        rp.uploaded_at,
        d.azs_id,
        NULL          AS azs_title,
        lr.id         AS remark_id,
        lr.created_at AS remark_created_at,
        lr.recipient_name AS remark_recipient_name,
        lr.message    AS remark_message,
        lr.sender_name AS remark_sender_name
      FROM report_photo rp
      JOIN dispatch_log d ON d.id = rp.report_id
      LEFT JOIN LATERAL (
        SELECT pr.*
        FROM photo_remark pr
        JOIN photo_remark_photo prp ON prp.remark_id = pr.id
        WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code
        ORDER BY pr.created_at DESC
        LIMIT 1
      ) lr ON true
      ${whereSql}
      ORDER BY rp.uploaded_at DESC, rp.id DESC
      LIMIT $${idx}
    `;

    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);
    const items = rows.map(toFeedItemViewModel);
    const lastRow = rows[rows.length - 1];
    const nextCursor = hasMore
      ? encodeFeedCursor(lastRow.uploaded_at, lastRow.photo_row_id)
      : null;
    return { items, nextCursor };
  },

  async getPhoto(reportId, photoCode) {
    const result = await pool.query(
      `SELECT rp.file_name, rp.disk_object_id, rp.file_id, d.azs_id
       FROM report_photo rp
       JOIN dispatch_log d ON d.id = rp.report_id
       WHERE rp.report_id = $1 AND rp.photo_code = $2 LIMIT 1`,
      [reportId, photoCode]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null,
      azsId: row.azs_id ? String(row.azs_id) : null
    };
  },

  // ---------------------------------------------------------------------------
  // S8-A3 БЛОКЕР 2+3: getActiveReportForAzsOnDate
  // Ищет последний/актуальный отчёт (dispatch_log) данной АЗС за указанную дату
  // по полям azs_id + slot_key LIKE 'planDate:%'.
  // Возвращает viewModel со статусом или null если отчёт не найден.
  // Используется исполнителем напоминаний в dispatchScheduler для проверки OR-6.
  // ---------------------------------------------------------------------------
  async getActiveReportForAzsOnDate({ azsId, planDate }) {
    if (!azsId || !planDate) return null;
    // slot_key формат: YYYY-MM-DD:HHmm (или manual:YYYY-MM-DD:HHmm)
    // Ищем по дате начала slot_key: и primary-часть planDate: и manual:planDate:
    const result = await pool.query(
      `SELECT *
       FROM dispatch_log
       WHERE azs_id = $1
         AND (slot_key LIKE $2 OR slot_key LIKE $3)
       ORDER BY
         CASE status
           WHEN 'done' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'new' THEN 2
           WHEN 'reserved' THEN 3
           ELSE 9
         END,
         id DESC
       LIMIT 1`,
      [String(azsId), `${planDate}:%`, `manual:${planDate}:%`]
    );
    if (!result.rows.length) return null;
    return toViewModel(result.rows[0]);
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
        disk_object_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at DATETIME NULL,
        uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_report_photo_report_code (report_id, photo_code)
      )
    `);
    // MySQL lacks ADD COLUMN IF NOT EXISTS — guard with information_schema check.
    const [colRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'disk_object_id'`
    );
    if (Number(colRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN disk_object_id BIGINT NULL`
      );
    }
  },

  async list({ dateFrom, dateTo, status, azsId, azsIds = [], limit = 200 } = {}) {
    const where = [];
    const params = [];

    // BUG-014 fix: filter by updated_at (last status-change time) instead of
    // created_at (dispatch creation time).  R4Card asks "what happened in the
    // last 29 days"; a report is logically "in period" when it was completed /
    // expired within that window, not when the push was originally sent.
    if (dateFrom) {
      where.push('updated_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('updated_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push('azs_id = ?');
      params.push(selectedAzsIds[0]);
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id IN (${selectedAzsIds.map(() => '?').join(',')})`);
      params.push(...selectedAzsIds);
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT d.*,
             (SELECT MAX(rp.disk_folder_id) FROM report_photo rp WHERE rp.report_id = d.id) AS disk_folder_id
      FROM dispatch_log d
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
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

  async listActiveByAdminUserId({ adminUserId, limit = 20 } = {}) {
    const userId = Number(adminUserId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return [];
    }

    const maxLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE admin_user_id = ?
         AND status IN ('new', 'in_progress', 'reserved')
       ORDER BY
         ${ACTIVE_STATUS_ORDER_SQL},
         (deadline_at IS NULL) ASC,
         deadline_at ASC,
         id DESC
       LIMIT ?`,
      [userId, maxLimit]
    );
    return rows.map(toViewModel);
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    diskObjectId,
    uploadedBy,
    exifAt
  }) {
    await pool.execute(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_id = VALUES(file_id),
         file_name = VALUES(file_name),
         disk_folder_id = VALUES(disk_folder_id),
         disk_object_id = VALUES(disk_object_id),
         uploaded_by = VALUES(uploaded_by),
         exif_at = VALUES(exif_at),
         uploaded_at = CURRENT_TIMESTAMP`,
      [
        reportId,
        photoCode,
        fileId ?? null,
        fileName ?? null,
        diskFolderId ?? null,
        diskObjectId ?? null,
        uploadedBy,
        exifAt ? exifAt.toISOString().slice(0, 19).replace('T', ' ') : null
      ]
    );
  },

  async listPhotos(reportId) {
    const [rows] = await pool.execute(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = ? ORDER BY photo_code ASC',
      [reportId]
    );
    return rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
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

  async getSummary({ dateFrom, dateTo, azsId, azsIds = [], now = new Date() } = {}) {
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
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push('azs_id = ?');
      params.push(selectedAzsIds[0]);
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id IN (${selectedAzsIds.map(() => '?').join(',')})`);
      params.push(...selectedAzsIds);
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
  },

  // ---------------------------------------------------------------------------
  // listPhotosFeed — photo-feed with optional remark join (MySQL)
  // ---------------------------------------------------------------------------
  async listPhotosFeed({
    dateFrom, dateTo, azsIds = [], photoCodes = [],
    remarks = 'all',
    limit = 50,
    cursor = null
  } = {}) {
    const toMySqlDate = (d) => d instanceof Date
      ? d.toISOString().slice(0, 19).replace('T', ' ')
      : String(d);

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const where = [];
    const params = [];

    if (dateFrom) {
      where.push('rp.uploaded_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('rp.uploaded_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    const normAzs = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normAzs.length === 1) {
      where.push('d.azs_id = ?');
      params.push(normAzs[0]);
    } else if (normAzs.length > 1) {
      where.push(`d.azs_id IN (${normAzs.map(() => '?').join(',')})`);
      params.push(...normAzs);
    }
    const normCodes = Array.isArray(photoCodes)
      ? photoCodes.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normCodes.length === 1) {
      where.push('rp.photo_code = ?');
      params.push(normCodes[0]);
    } else if (normCodes.length > 1) {
      where.push(`rp.photo_code IN (${normCodes.map(() => '?').join(',')})`);
      params.push(...normCodes);
    }

    // remark filter — MySQL doesn't support LATERAL, use correlated EXISTS
    if (remarks === 'with') {
      where.push(`EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    } else if (remarks === 'without') {
      where.push(`NOT EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    }

    if (cursor) {
      const decoded = decodeFeedCursor(cursor);
      if (decoded) {
        const ca = toMySqlDate(new Date(decoded.uploadedAt));
        where.push('(rp.uploaded_at < ? OR (rp.uploaded_at = ? AND rp.id < ?))');
        params.push(ca, ca, decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);

    // MySQL doesn't have LATERAL — use a correlated subquery for the latest remark
    const sql = `
      SELECT
        rp.id         AS photo_row_id,
        rp.report_id,
        rp.photo_code,
        rp.exif_at,
        rp.uploaded_at,
        d.azs_id,
        NULL          AS azs_title,
        lr.id         AS remark_id,
        lr.created_at AS remark_created_at,
        lr.recipient_name AS remark_recipient_name,
        lr.message    AS remark_message,
        lr.sender_name AS remark_sender_name
      FROM report_photo rp
      JOIN dispatch_log d ON d.id = rp.report_id
      LEFT JOIN photo_remark lr ON lr.id = (
        SELECT pr.id FROM photo_remark pr
        JOIN photo_remark_photo prp ON prp.remark_id = pr.id
        WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code
        ORDER BY pr.created_at DESC
        LIMIT 1
      )
      ${whereSql}
      ORDER BY rp.uploaded_at DESC, rp.id DESC
      LIMIT ?
    `;

    const [rows] = await pool.execute(sql, params);
    const hasMore = rows.length > safeLimit;
    const limited = rows.slice(0, safeLimit);
    const items = limited.map(toFeedItemViewModel);
    const lastRow = limited[limited.length - 1];
    const nextCursor = hasMore
      ? encodeFeedCursor(lastRow.uploaded_at, lastRow.photo_row_id)
      : null;
    return { items, nextCursor };
  },

  async getPhoto(reportId, photoCode) {
    const [rows] = await pool.execute(
      `SELECT rp.file_name, rp.disk_object_id, rp.file_id, d.azs_id
       FROM report_photo rp
       JOIN dispatch_log d ON d.id = rp.report_id
       WHERE rp.report_id = ? AND rp.photo_code = ? LIMIT 1`,
      [reportId, photoCode]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null,
      azsId: row.azs_id ? String(row.azs_id) : null
    };
  },

  // ---------------------------------------------------------------------------
  // S8-A3 БЛОКЕР 2+3: getActiveReportForAzsOnDate (MySQL)
  // Ищет последний/актуальный отчёт (dispatch_log) данной АЗС за указанную дату
  // по полям azs_id + slot_key LIKE 'planDate:%'.
  // Возвращает viewModel со статусом или null если отчёт не найден.
  // ---------------------------------------------------------------------------
  async getActiveReportForAzsOnDate({ azsId, planDate }) {
    if (!azsId || !planDate) return null;
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE azs_id = ?
         AND (slot_key LIKE ? OR slot_key LIKE ?)
       ORDER BY
         CASE status
           WHEN 'done' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'new' THEN 2
           WHEN 'reserved' THEN 3
           ELSE 9
         END,
         id DESC
       LIMIT 1`,
      [String(azsId), `${planDate}:%`, `manual:${planDate}:%`]
    );
    if (!rows.length) return null;
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
