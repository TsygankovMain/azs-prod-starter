// backends/node/api/src/reports/analyticsStore.js

const isMysql = (t) => String(t || '').toLowerCase() === 'mysql';

const createPostgresStore = (pool) => ({
  async getRating({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx++}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); }
    if (dateTo)   { where.push(`created_at <= $${idx++}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push(`azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id = ANY($${idx++})`); params.push(ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        azs_id,
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (
          WHERE status = 'done'
            AND (deadline_at IS NULL OR updated_at <= deadline_at)
        )::int                                                 AS on_time,
        COUNT(*) FILTER (
          WHERE status = 'expired'
            OR (status = 'done' AND deadline_at IS NOT NULL AND updated_at > deadline_at)
        )::int                                                 AS late,
        ROUND(
          AVG(EXTRACT(EPOCH FROM (updated_at - scheduled_at)) / 60.0)
          FILTER (WHERE status = 'done')
        )::int                                                 AS avg_minutes
      FROM dispatch_log
      ${wSql}
      GROUP BY azs_id
      ORDER BY on_time DESC, total DESC
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(r => ({
      azsId:      String(r.azs_id),
      total:      Number(r.total),
      onTime:     Number(r.on_time),
      late:       Number(r.late),
      avgMinutes: r.avg_minutes !== null && r.avg_minutes !== undefined ? Number(r.avg_minutes) : null,
    }));
  },

  async getTrend({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx++}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); }
    if (dateTo)   { where.push(`created_at <= $${idx++}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push(`azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id = ANY($${idx++})`); params.push(ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        (created_at AT TIME ZONE 'UTC')::date::text      AS day,
        COUNT(*)::int                                     AS total,
        COUNT(*) FILTER (WHERE status = 'done')::int     AS done,
        COUNT(*) FILTER (WHERE status = 'expired')::int  AS expired,
        COUNT(*) FILTER (WHERE status IN ('new','in_progress','reserved'))::int AS open
      FROM dispatch_log
      ${wSql}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(r => ({
      date:    String(r.day),
      total:   Number(r.total),
      done:    Number(r.done),
      expired: Number(r.expired),
      open:    Number(r.open),
    }));
  },

  async getDayPhotos({ date, azsIds = [] } = {}) {
    if (!date) return [];
    const where = [
      `d.status = 'done'`,
      `d.created_at >= $1`,
      `d.created_at <= $2`,
    ];
    const params = [
      new Date(`${date}T00:00:00.000Z`),
      new Date(`${date}T23:59:59.999Z`),
    ];
    let idx = 3;
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push(`d.azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`d.azs_id = ANY($${idx++})`); params.push(ids); }
    const sql = `
      SELECT
        d.id AS report_id, d.azs_id, d.updated_at AS done_at,
        rp.photo_code, rp.disk_object_id, rp.disk_folder_id, rp.exif_at, rp.uploaded_at
      FROM dispatch_log d
      JOIN report_photo rp ON rp.report_id = d.id
      WHERE ${where.join(' AND ')}
      ORDER BY d.updated_at DESC, rp.photo_code ASC
    `;
    const result = await pool.query(sql, params);
    // Group by report
    const map = new Map();
    for (const row of result.rows) {
      const key = Number(row.report_id);
      if (!map.has(key)) {
        map.set(key, {
          reportId: key,
          azsId:    String(row.azs_id),
          doneAt:   row.done_at ? new Date(row.done_at).toISOString() : null,
          photos:   [],
        });
      }
      map.get(key).photos.push({
        photoCode:    row.photo_code,
        diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
        diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
        exifAt:       row.exif_at ? new Date(row.exif_at).toISOString() : null,
        uploadedAt:   row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
      });
    }
    return [...map.values()];
  },
});

const createMysqlStore = (pool) => ({
  async getRating({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push('azs_id = ?');                                    params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id IN (${ids.map(() => '?').join(',')})`);  params.push(...ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        azs_id,
        COUNT(*)                                          AS total,
        SUM(CASE WHEN status = 'done'
                  AND (deadline_at IS NULL OR updated_at <= deadline_at)
             THEN 1 ELSE 0 END)                          AS on_time,
        SUM(CASE WHEN status = 'expired'
                  OR (status = 'done' AND deadline_at IS NOT NULL AND updated_at > deadline_at)
             THEN 1 ELSE 0 END)                          AS late,
        ROUND(AVG(CASE WHEN status = 'done'
                       THEN TIMESTAMPDIFF(MINUTE, scheduled_at, updated_at)
                       ELSE NULL END))                   AS avg_minutes
      FROM dispatch_log
      ${wSql}
      GROUP BY azs_id
      ORDER BY on_time DESC, total DESC
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(r => ({
      azsId:      String(r.azs_id),
      total:      Number(r.total),
      onTime:     Number(r.on_time),
      late:       Number(r.late),
      avgMinutes: r.avg_minutes !== null && r.avg_minutes !== undefined ? Number(r.avg_minutes) : null,
    }));
  },

  async getTrend({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push('azs_id = ?');                                    params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id IN (${ids.map(() => '?').join(',')})`);  params.push(...ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        DATE_FORMAT(created_at, '%Y-%m-%d')              AS day,
        COUNT(*)                                         AS total,
        SUM(status = 'done')                             AS done,
        SUM(status = 'expired')                          AS expired,
        SUM(status IN ('new','in_progress','reserved'))  AS open
      FROM dispatch_log
      ${wSql}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(r => ({
      date:    String(r.day),
      total:   Number(r.total),
      done:    Number(r.done),
      expired: Number(r.expired),
      open:    Number(r.open),
    }));
  },

  async getDayPhotos({ date, azsIds = [] } = {}) {
    if (!date) return [];
    const where = [
      `d.status = 'done'`,
      `d.created_at >= ?`,
      `d.created_at <= ?`,
    ];
    const params = [
      `${date} 00:00:00`,
      `${date} 23:59:59`,
    ];
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)    { where.push('d.azs_id = ?');                                    params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`d.azs_id IN (${ids.map(() => '?').join(',')})`);  params.push(...ids); }
    const sql = `
      SELECT
        d.id AS report_id, d.azs_id, d.updated_at AS done_at,
        rp.photo_code, rp.disk_object_id, rp.disk_folder_id, rp.exif_at, rp.uploaded_at
      FROM dispatch_log d
      JOIN report_photo rp ON rp.report_id = d.id
      WHERE ${where.join(' AND ')}
      ORDER BY d.updated_at DESC, rp.photo_code ASC
    `;
    const [rows] = await pool.execute(sql, params);
    // Group by report
    const map = new Map();
    for (const row of rows) {
      const key = Number(row.report_id);
      if (!map.has(key)) {
        map.set(key, {
          reportId: key,
          azsId:    String(row.azs_id),
          doneAt:   row.done_at ? new Date(row.done_at).toISOString() : null,
          photos:   [],
        });
      }
      map.get(key).photos.push({
        photoCode:    row.photo_code,
        diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
        diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
        exifAt:       row.exif_at ? new Date(row.exif_at).toISOString() : null,
        uploadedAt:   row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
      });
    }
    return [...map.values()];
  },
});

export const createAnalyticsStore = ({ pool, dbType }) => {
  if (!pool) throw new Error('pool is required');
  return isMysql(dbType) ? createMysqlStore(pool) : createPostgresStore(pool);
};

export default createAnalyticsStore;
