/**
 * photoRemarkStore — журнал замечаний по фото АЗС.
 *
 * Таблицы:
 *  - photo_remark : заголовок замечания (снапшоты получателя/отправителя/АЗС)
 *  - photo_remark_photo : нормализованная связка remark ↔ конкретное фото
 *    (UX-2) + колонки comment, delivery_status, delivery_error — пофотный статус
 *
 * Контракт:
 *   ensureSchema()
 *   insertRemark({ azsId, azsTitle, recipientRole, recipientUserId, recipientName,
 *                  senderUserId, senderName,
 *                  photos:[{reportId, photoCode, comment}] }) → row
 *   markDelivery(id, status, error)          — общий статус пачки на photo_remark
 *   markPhotoDelivery(remarkId, reportId, photoCode, status, error)  — пофотный
 *   getById(id) → row with photos[] | null
 *   getPhotoRow(remarkId, reportId, photoCode) → photoViewModel | null
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
  senderUserId: row.sender_user_id ? Number(row.sender_user_id) : null,
  senderName: row.sender_name || null,
  deliveryStatus: row.delivery_status || 'sent',
  deliveryError: row.delivery_error || null
});

// UX-2: each photo row now carries comment + per-photo delivery_status
const toPhotoViewModel = (row) => ({
  remarkId: Number(row.remark_id),
  reportId: Number(row.report_id),
  photoCode: row.photo_code,
  comment: row.comment || '',
  deliveryStatus: row.delivery_status || 'pending',
  deliveryError: row.delivery_error || null
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
        remark_id       BIGINT NOT NULL,
        report_id       BIGINT NOT NULL,
        photo_code      TEXT NOT NULL,
        comment         TEXT NOT NULL DEFAULT '',
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        delivery_error  TEXT NULL,
        PRIMARY KEY (remark_id, report_id, photo_code)
      )
    `);
    // Idempotent migrations for existing prod data (ADD COLUMN IF NOT EXISTS — PG 9.6+)
    await pool.query(`ALTER TABLE photo_remark_photo ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE photo_remark_photo ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE photo_remark_photo ADD COLUMN IF NOT EXISTS delivery_error TEXT NULL`);
    // FEED-2 / BE-3: add recipient_user_id + recipient_name to photo_remark (nullable, additive)
    // Safe for pre-existing prod tables; no-op if already present (PG 9.6+).
    await pool.query(`ALTER TABLE photo_remark ADD COLUMN IF NOT EXISTS recipient_user_id BIGINT NULL`);
    await pool.query(`ALTER TABLE photo_remark ADD COLUMN IF NOT EXISTS recipient_name TEXT NULL`);
    // Remove legacy top-level message column from photo_remark if present (safe — ignored if missing)
    // We do NOT drop it to avoid data loss; new code simply no longer writes it.
  },

  async insertRemark({
    azsId, azsTitle = null,
    recipientRole, recipientUserId = null, recipientName = null,
    senderUserId = null, senderName = null,
    photos = []
  }) {
    const result = await pool.query(
      `INSERT INTO photo_remark
         (azs_id, azs_title, recipient_role, recipient_user_id, recipient_name,
          sender_user_id, sender_name, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent')
       RETURNING *`,
      [azsId, azsTitle ?? null, recipientRole, recipientUserId ?? null, recipientName ?? null,
       senderUserId ?? null, senderName ?? null]
    );
    const row = result.rows[0];
    if (photos.length > 0) {
      for (const ph of photos) {
        await pool.query(
          `INSERT INTO photo_remark_photo (remark_id, report_id, photo_code, comment, delivery_status)
           VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT DO NOTHING`,
          [row.id, ph.reportId, ph.photoCode, ph.comment ?? '']
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

  async markPhotoDelivery(remarkId, reportId, photoCode, status, error = null) {
    await pool.query(
      `UPDATE photo_remark_photo
       SET delivery_status = $1, delivery_error = $2
       WHERE remark_id = $3 AND report_id = $4 AND photo_code = $5`,
      [status, error ?? null, remarkId, reportId, photoCode]
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

  async getPhotoRow(remarkId, reportId, photoCode) {
    const result = await pool.query(
      `SELECT * FROM photo_remark_photo
       WHERE remark_id = $1 AND report_id = $2 AND photo_code = $3 LIMIT 1`,
      [remarkId, reportId, photoCode]
    );
    if (!result.rows.length) return null;
    return toPhotoViewModel(result.rows[0]);
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
        remark_id       BIGINT NOT NULL,
        report_id       BIGINT NOT NULL,
        photo_code      VARCHAR(191) NOT NULL,
        comment         LONGTEXT NOT NULL,
        delivery_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        delivery_error  LONGTEXT NULL,
        PRIMARY KEY (remark_id, report_id, photo_code)
      )
    `);
    // Idempotent migration for existing prod tables (MySQL lacks ADD COLUMN IF NOT EXISTS)
    // Guard via information_schema before each ALTER.
    const migrateCol = async (table, column, definition) => {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
         WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt === 0) {
        await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    await migrateCol('photo_remark_photo', 'comment', 'LONGTEXT NOT NULL DEFAULT (\'\')');
    await migrateCol('photo_remark_photo', 'delivery_status', "VARCHAR(16) NOT NULL DEFAULT 'pending'");
    await migrateCol('photo_remark_photo', 'delivery_error', 'LONGTEXT NULL');
    // FEED-2 / BE-3: add recipient_user_id + recipient_name to photo_remark (nullable, additive)
    await migrateCol('photo_remark', 'recipient_user_id', 'BIGINT NULL');
    await migrateCol('photo_remark', 'recipient_name', 'VARCHAR(500) NULL');
  },

  async insertRemark({
    azsId, azsTitle = null,
    recipientRole, recipientUserId = null, recipientName = null,
    senderUserId = null, senderName = null,
    photos = []
  }) {
    const [result] = await pool.execute(
      `INSERT INTO photo_remark
         (azs_id, azs_title, recipient_role, recipient_user_id, recipient_name,
          sender_user_id, sender_name, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [azsId, azsTitle ?? null, recipientRole, recipientUserId ?? null, recipientName ?? null,
       senderUserId ?? null, senderName ?? null]
    );
    const insertId = result.insertId;
    if (photos.length > 0) {
      for (const ph of photos) {
        await pool.execute(
          `INSERT IGNORE INTO photo_remark_photo (remark_id, report_id, photo_code, comment, delivery_status)
           VALUES (?, ?, ?, ?, 'pending')`,
          [insertId, ph.reportId, ph.photoCode, ph.comment ?? '']
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

  async markPhotoDelivery(remarkId, reportId, photoCode, status, error = null) {
    await pool.execute(
      `UPDATE photo_remark_photo
       SET delivery_status = ?, delivery_error = ?
       WHERE remark_id = ? AND report_id = ? AND photo_code = ?`,
      [status, error ?? null, remarkId, reportId, photoCode]
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

  async getPhotoRow(remarkId, reportId, photoCode) {
    const [rows] = await pool.execute(
      `SELECT * FROM photo_remark_photo
       WHERE remark_id = ? AND report_id = ? AND photo_code = ? LIMIT 1`,
      [remarkId, reportId, photoCode]
    );
    if (!rows.length) return null;
    return toPhotoViewModel(rows[0]);
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
