const MAX_ERROR_TEXT_LEN = 1000;

const trimErrorText = (value) => String(value || '').slice(0, MAX_ERROR_TEXT_LEN);

const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

/**
 * Parse a slot_key (format YYYY-MM-DD:HHmm or manual:YYYY-MM-DD:HHmm) into a UTC Date.
 * Returns null when the key cannot be parsed.
 */
export const parseSlotDateTimeUtc = (slotKey) => {
  const raw = String(slotKey || '').trim();
  const parts = raw.split(':');
  // strip 'manual' prefix if present
  const dateParts = String(parts[0] || '').toLowerCase() === 'manual' ? parts.slice(1) : parts;
  const dateStr = String(dateParts[0] || '').trim();
  const hhmmStr = String(dateParts[1] || '').replace(/[^0-9]/g, '').slice(0, 4);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || hhmmStr.length !== 4) {
    return null;
  }
  const hours = Number(hhmmStr.slice(0, 2));
  const minutes = Number(hhmmStr.slice(2, 4));
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  const dt = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const serializeDate = (value) => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const createPostgresStore = (pool) => {
  const query = (sql, params) => pool.query(sql, params);

  return {
    async ensureSchema() {
      await query(`
        CREATE TABLE IF NOT EXISTS dispatch_log (
          id BIGSERIAL PRIMARY KEY,
          slot_key TEXT NOT NULL,
          azs_id TEXT NOT NULL,
          admin_user_id BIGINT NOT NULL,
          status TEXT NOT NULL,
          report_item_id BIGINT NULL,
          jitter_minutes INTEGER NULL,
          scheduled_at TIMESTAMPTZ NULL,
          deadline_at TIMESTAMPTZ NULL,
          error_text TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(slot_key, azs_id)
        )
      `);
    },

    /**
     * @param {{ slotKey, azsId, adminUserId, status, scheduledAt?: Date|null }} args
     *   scheduledAt — zone-correct slot instant (portal timezone) supplied by the
     *   caller.  When absent, falls back to parseSlotDateTimeUtc(slotKey) which
     *   treats HHmm as UTC — accurate only for UTC portals.
     */
    async reserve({ slotKey, azsId, adminUserId, status, scheduledAt: callerScheduledAt }) {
      const scheduledAt = callerScheduledAt instanceof Date
        ? callerScheduledAt
        : parseSlotDateTimeUtc(slotKey);
      const result = await query(
        `INSERT INTO dispatch_log(slot_key, azs_id, admin_user_id, status, scheduled_at)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(slot_key, azs_id) DO NOTHING
         RETURNING id`,
        [slotKey, azsId, adminUserId, status, scheduledAt]
      );
      if (!result.rows.length) {
        return { reserved: false, id: null };
      }
      return { reserved: true, id: Number(result.rows[0].id) };
    },

    /**
     * List dispatch_log rows whose status is still 'reserved' (planned/not yet
     * executed) and whose created_at is older than `staleBefore`. Used by the
     * stale-slot finisher in dispatchScheduler to retry or fail hanging entries.
     *
     * @param {{ staleBefore: Date }} args
     * @returns {Promise<Array<{id, slot_key, azs_id, admin_user_id, status, created_at}>>}
     */
    async listStalePlanned({ staleBefore }) {
      // S8-БЛОКЕР #3а: исключаем reminder-строки (slot_key вида '%:reminder:%')
      // чтобы finishStalePlannedSlots не подобрал их и не создал вторую CRM-карточку (OR-1).
      const result = await query(
        `SELECT id, slot_key, azs_id, admin_user_id, status, created_at, scheduled_at
         FROM dispatch_log
         WHERE status = $1
           AND slot_key NOT LIKE $2
           AND (
             (scheduled_at IS NOT NULL AND scheduled_at < $3)
             OR (scheduled_at IS NULL AND created_at < $3)
           )
         ORDER BY created_at ASC`,
        ['reserved', '%:reminder:%', staleBefore]
      );
      return result.rows || [];
    },

    async markDone({ id, reportItemId, jitterMinutes, scheduledAt, deadlineAt }) {
      await query(
        `UPDATE dispatch_log
         SET status = $1,
             report_item_id = $2,
             jitter_minutes = $3,
             scheduled_at = $4,
             deadline_at = $5,
             updated_at = NOW()
         WHERE id = $6`,
        ['new', reportItemId ?? null, jitterMinutes ?? null, scheduledAt ?? null, deadlineAt ?? null, id]
      );
    },

    async markFailed({ id, errorText }) {
      await query(
        `UPDATE dispatch_log
         SET status = $1,
             error_text = $2,
             updated_at = NOW()
         WHERE id = $3`,
        ['failed', trimErrorText(errorText), id]
      );
    },

    async appendErrorText({ id, reportId, errorText }) {
      const rowId = id ?? reportId;
      if (!rowId || !String(errorText || '').trim()) return;
      const text = String(errorText).trim();
      await query(
        `UPDATE dispatch_log
         SET error_text = LEFT(
           CASE WHEN error_text IS NULL OR error_text = ''
             THEN $1
             ELSE error_text || ' | ' || $1
           END,
           ${MAX_ERROR_TEXT_LEN}
         ),
         updated_at = NOW()
         WHERE id = $2`,
        [text, rowId]
      );
    }
  };
};

const createMysqlStore = (pool) => {
  const query = (sql, params) => pool.execute(sql, params);

  return {
    async ensureSchema() {
      await query(`
        CREATE TABLE IF NOT EXISTS dispatch_log (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          slot_key VARCHAR(191) NOT NULL,
          azs_id VARCHAR(191) NOT NULL,
          admin_user_id BIGINT NOT NULL,
          status VARCHAR(32) NOT NULL,
          report_item_id BIGINT NULL,
          jitter_minutes INT NULL,
          scheduled_at DATETIME NULL,
          deadline_at DATETIME NULL,
          error_text TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY ux_dispatch_slot_azs (slot_key, azs_id)
        )
      `);
    },

    /**
     * @param {{ slotKey, azsId, adminUserId, status, scheduledAt?: Date|null }} args
     *   scheduledAt — zone-correct slot instant (portal timezone) supplied by the
     *   caller.  When absent, falls back to parseSlotDateTimeUtc(slotKey) which
     *   treats HHmm as UTC — accurate only for UTC portals.
     */
    async reserve({ slotKey, azsId, adminUserId, status, scheduledAt: callerScheduledAt }) {
      const scheduledAt = callerScheduledAt instanceof Date
        ? callerScheduledAt
        : parseSlotDateTimeUtc(slotKey);
      const [result] = await query(
        `INSERT IGNORE INTO dispatch_log(slot_key, azs_id, admin_user_id, status, scheduled_at)
         VALUES(?, ?, ?, ?, ?)`,
        [slotKey, azsId, adminUserId, status, serializeDate(scheduledAt)]
      );

      if (!result.affectedRows) {
        return { reserved: false, id: null };
      }

      return { reserved: true, id: Number(result.insertId) || null };
    },

    /**
     * List dispatch_log rows whose status is still 'reserved' (planned/not yet
     * executed) and whose created_at is older than `staleBefore`. Used by the
     * stale-slot finisher in dispatchScheduler to retry or fail hanging entries.
     *
     * @param {{ staleBefore: Date }} args
     * @returns {Promise<Array<{id, slot_key, azs_id, admin_user_id, status, created_at}>>}
     */
    async listStalePlanned({ staleBefore }) {
      // S8-БЛОКЕР #3а: исключаем reminder-строки (slot_key вида '%:reminder:%')
      // чтобы finishStalePlannedSlots не подобрал их и не создал вторую CRM-карточку (OR-1).
      const threshold = serializeDate(staleBefore);
      const [rows] = await query(
        `SELECT id, slot_key, azs_id, admin_user_id, status, created_at, scheduled_at
         FROM dispatch_log
         WHERE status = ?
           AND slot_key NOT LIKE ?
           AND (
             (scheduled_at IS NOT NULL AND scheduled_at < ?)
             OR (scheduled_at IS NULL AND created_at < ?)
           )
         ORDER BY created_at ASC`,
        ['reserved', '%:reminder:%', threshold, threshold]
      );
      return rows || [];
    },

    async markDone({ id, reportItemId, jitterMinutes, scheduledAt, deadlineAt }) {
      await query(
        `UPDATE dispatch_log
         SET status = ?,
             report_item_id = ?,
             jitter_minutes = ?,
             scheduled_at = ?,
             deadline_at = ?
         WHERE id = ?`,
        ['new', reportItemId ?? null, jitterMinutes ?? null, serializeDate(scheduledAt), serializeDate(deadlineAt), id]
      );
    },

    async markFailed({ id, errorText }) {
      await query(
        `UPDATE dispatch_log
         SET status = ?,
             error_text = ?
         WHERE id = ?`,
        ['failed', trimErrorText(errorText), id]
      );
    },

    async appendErrorText({ id, reportId, errorText }) {
      const rowId = id ?? reportId;
      if (!rowId || !String(errorText || '').trim()) return;
      const text = String(errorText).trim();
      await query(
        `UPDATE dispatch_log
         SET error_text = LEFT(
           CASE WHEN error_text IS NULL OR error_text = ''
             THEN ?
             ELSE CONCAT(error_text, ' | ', ?)
           END,
           ${MAX_ERROR_TEXT_LEN}
         )
         WHERE id = ?`,
        [text, text, rowId]
      );
    }
  };
};

export const createDispatchLogStore = ({ pool, dbType }) => {
  if (!pool) {
    throw new Error('pool is required');
  }

  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }

  return createPostgresStore(pool);
};

export default createDispatchLogStore;
