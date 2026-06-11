/**
 * photoRemarkStore — журнал замечаний по фото АЗС.
 *
 * Таблицы:
 *  - photo_remark : заголовок замечания (снапшоты получателя/отправителя/АЗС)
 *  - photo_remark_photo : нормализованная связка remark ↔ конкретное фото
 *
 * Обе ветки (PG / MySQL) реализуют один и тот же контракт:
 *   ensureSchema()
 *   insertRemark({ azsId, azsTitle, recipientRole, recipientUserId, recipientName,
 *                  message, senderUserId, senderName, photos:[{reportId,photoCode}] }) → row
 *   markDelivery(id, status, error)
 *   getById(id) → row with photos[] | null
 *   list({ dateFrom, dateTo, azsIds, limit, cursor }) → { items, nextCursor }
 */

const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const normalizeDate = (value, fallback = null) => {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
};

const toDateSql = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`toDateSql: invalid date: ${date}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const toRemarkViewModel = (row) => ({
  id: Number(row.id),
  createdAt: normalizeDate(row.created_at),
  azsId: String(row.azs_id || ''),
  azsTitle: row.azs_title || null,
  recipientRole: row.recipient_role,
  recipientUserId: row.recipient_user_id ? Number(row.recipient_user_id) : null,
  recipientName: row.recipient_name || null,
  message: row.message || '',
  senderUserId: row.sender_user_id ? Number(row.sender_user_id) : null,
  senderName: row.sender_name || null,
  deliveryStatus: row.delivery_status || 'sent',
  deliveryError: row.delivery_error || null
});

const toPhotoViewModel = (row) => ({
  remarkId: Number(row.remark_id),
  reportId: Number(row.report_id),
  photoCode: row.photo_code
});

// ---------------------------------------------------------------------------
// cursor helpers  (keyset по created_at DESC, id DESC)
// ---------------------------------------------------------------------------

const encodeCursor = (createdAt, id) =>
  Buffer.from(JSON.stringify({ ca: createdAt, id: Number(id) })).toString('base64');

const decodeCursor = (cursor) => {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    const ca = String(raw.ca || '').trim();
    const id = Number(raw.id);
    if (!ca || !Number.isFinite(id)) return null;
    return { createdAt: ca, id };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS photo_remark (
        id              BIGSERIAL PRIMARY KEY,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        azs_id          TEXT NOT NULL,
        azs_title       TEXT NULL,
        recipient_role  TEXT NOT NULL,
        recipient_user_id BIGINT NULL,
        recipient_name  TEXT NULL,
        message         TEXT NOT NULL DEFAULT '',
        sender_user_id  BIGINT NULL,
        sender_name     TEXT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'sent',
        delivery_error  TEXT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_photo_remark_created_at ON photo_remark (created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_photo_remark_azs_id ON photo_remark (azs_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS photo_remark_photo (
        remark_id   BIGINT NOT NULL,
        report_id   BIGINT NOT NULL,
        photo_code  TEXT NOT NULL,
        PRIMARY KEY (remark_id, report_id, photo_code)
      )
    `);
  },

  async insertRemark({
    azsId, azsTitle = null,
    recipientRole, recipientUserId = null, recipientName = null,
    message = '', senderUserId = null, senderName = null,
    photos = []
  }) {
    const result = await pool.query(
      `INSERT INTO photo_remark
         (azs_id, azs_title, recipient_role, recipient_user_id, recipient_name,
          message, sender_user_id, sender_name, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent')
       RETURNING *`,
      [azsId, azsTitle ?? null, recipientRole, recipientUserId ?? null, recipientName ?? null,
       message, senderUserId ?? null, senderName ?? null]
    );
    const row = result.rows[0];
    if (photos.length > 0) {
      for (const ph of photos) {
        await pool.query(
          `INSERT INTO photo_remark_photo (remark_id, report_id, photo_code)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [row.id, ph.reportId, ph.photoCode]
        );
      }
    }
    return toRemarkViewModel(row);
  },

  async markDelivery(id, status, error = null) {
    await pool.query(
      `UPDATE photo_remark SET delivery_status = $1, delivery_error = $2 WHERE id = $3`,
      [status, error ?? null, id]
    );
  },

  async getById(id) {
    const result = await pool.query(
      `SELECT * FROM photo_remark WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!result.rows.length) return null;
    const row = toRemarkViewModel(result.rows[0]);
    const phResult = await pool.query(
      `SELECT * FROM photo_remark_photo WHERE remark_id = $1`,
      [id]
    );
    row.photos = phResult.rows.map(toPhotoViewModel);
    return row;
  },

  async list({ dateFrom, dateTo, azsIds = [], limit = 50, cursor = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = [];
    const params = [];
    let idx = 1;

    if (dateFrom) {
      where.push(`created_at >= $${idx++}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
    }
    if (dateTo) {
      where.push(`created_at <= $${idx++}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
    }
    const normIds = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normIds.length === 1) {
      where.push(`azs_id = $${idx++}`);
      params.push(normIds[0]);
    } else if (normIds.length > 1) {
      where.push(`azs_id = ANY($${idx++})`);
      params.push(normIds);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        where.push(`(created_at, id) < ($${idx}, $${idx + 1})`);
        idx += 2;
        params.push(new Date(decoded.createdAt), decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);
    const sql = `
      SELECT * FROM photo_remark
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${idx}
    `;
    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);

    // load photos for all remarks
    if (rows.length > 0) {
      const remarkIds = rows.map((r) => r.id);
      const phResult = await pool.query(
        `SELECT * FROM photo_remark_photo WHERE remark_id = ANY($1)`,
        [remarkIds]
      );
      const photosByRemark = new Map();
      for (const ph of phResult.rows) {
        const key = Number(ph.remark_id);
        if (!photosByRemark.has(key)) photosByRemark.set(key, []);
        photosByRemark.get(key).push(toPhotoViewModel(ph));
      }
      const items = rows.map((r) => {
        const vm = toRemarkViewModel(r);
        vm.photos = photosByRemark.get(vm.id) || [];
        return vm;
      });
      const lastRow = rows[rows.length - 1];
      const nextCursor = hasMore
        ? encodeCursor(lastRow.created_at, lastRow.id)
        : null;
      return { items, nextCursor };
    }
    return { items: [], nextCursor: null };
  }
});

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS photo_remark (
        id                BIGINT AUTO_INCREMENT PRIMARY KEY,
        created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        azs_id            VARCHAR(191) NOT NULL,
        azs_title         VARCHAR(500) NULL,
        recipient_role    VARCHAR(32) NOT NULL,
        recipient_user_id BIGINT NULL,
        recipient_name    VARCHAR(500) NULL,
        message           LONGTEXT NOT NULL DEFAULT '',
        sender_user_id    BIGINT NULL,
        sender_name       VARCHAR(500) NULL,
        delivery_status   VARCHAR(16) NOT NULL DEFAULT 'sent',
        delivery_error    LONGTEXT NULL,
        INDEX ix_photo_remark_created_at (created_at),
        INDEX ix_photo_remark_azs_id (azs_id)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS photo_remark_photo (
        remark_id   BIGINT NOT NULL,
        report_id   BIGINT NOT NULL,
        photo_code  VARCHAR(191) NOT NULL,
        PRIMARY KEY (remark_id, report_id, photo_code)
      )
    `);
  },

  async insertRemark({
    azsId, azsTitle = null,
    recipientRole, recipientUserId = null, recipientName = null,
    message = '', senderUserId = null, senderName = null,
    photos = []
  }) {
    const [result] = await pool.execute(
      `INSERT INTO photo_remark
         (azs_id, azs_title, recipient_role, recipient_user_id, recipient_name,
          message, sender_user_id, sender_name, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [azsId, azsTitle ?? null, recipientRole, recipientUserId ?? null, recipientName ?? null,
       message, senderUserId ?? null, senderName ?? null]
    );
    const insertId = result.insertId;
    if (photos.length > 0) {
      for (const ph of photos) {
        await pool.execute(
          `INSERT IGNORE INTO photo_remark_photo (remark_id, report_id, photo_code)
           VALUES (?, ?, ?)`,
          [insertId, ph.reportId, ph.photoCode]
        );
      }
    }
    const [rows] = await pool.execute(
      `SELECT * FROM photo_remark WHERE id = ? LIMIT 1`,
      [insertId]
    );
    return toRemarkViewModel(rows[0]);
  },

  async markDelivery(id, status, error = null) {
    await pool.execute(
      `UPDATE photo_remark SET delivery_status = ?, delivery_error = ? WHERE id = ?`,
      [status, error ?? null, id]
    );
  },

  async getById(id) {
    const [rows] = await pool.execute(
      `SELECT * FROM photo_remark WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) return null;
    const row = toRemarkViewModel(rows[0]);
    const [phRows] = await pool.execute(
      `SELECT * FROM photo_remark_photo WHERE remark_id = ?`,
      [id]
    );
    row.photos = phRows.map(toPhotoViewModel);
    return row;
  },

  async list({ dateFrom, dateTo, azsIds = [], limit = 50, cursor = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
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
    const normIds = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normIds.length === 1) {
      where.push('azs_id = ?');
      params.push(normIds[0]);
    } else if (normIds.length > 1) {
      where.push(`azs_id IN (${normIds.map(() => '?').join(',')})`);
      params.push(...normIds);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        const ca = toDateSql(new Date(decoded.createdAt));
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(ca, ca, decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);
    const sql = `
      SELECT * FROM photo_remark
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    const [rows] = await pool.execute(sql, params);
    const hasMore = rows.length > safeLimit;
    const limited = rows.slice(0, safeLimit);

    if (limited.length > 0) {
      const remarkIds = limited.map((r) => r.id);
      const [phRows] = await pool.execute(
        `SELECT * FROM photo_remark_photo WHERE remark_id IN (${remarkIds.map(() => '?').join(',')})`,
        remarkIds
      );
      const photosByRemark = new Map();
      for (const ph of phRows) {
        const key = Number(ph.remark_id);
        if (!photosByRemark.has(key)) photosByRemark.set(key, []);
        photosByRemark.get(key).push(toPhotoViewModel(ph));
      }
      const items = limited.map((r) => {
        const vm = toRemarkViewModel(r);
        vm.photos = photosByRemark.get(vm.id) || [];
        return vm;
      });
      const lastRow = limited[limited.length - 1];
      const nextCursor = hasMore
        ? encodeCursor(lastRow.created_at, lastRow.id)
        : null;
      return { items, nextCursor };
    }
    return { items: [], nextCursor: null };
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPhotoRemarkStore = ({ pool, dbType } = {}) => {
  if (!pool) throw new Error('pool is required');
  if (isMysql(dbType)) return createMysqlStore(pool);
  return createPostgresStore(pool);
};

export default createPhotoRemarkStore;
