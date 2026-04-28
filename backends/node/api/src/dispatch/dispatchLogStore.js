const MAX_ERROR_TEXT_LEN = 1000;

const trimErrorText = (value) => String(value || '').slice(0, MAX_ERROR_TEXT_LEN);

const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

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

    async reserve({ slotKey, azsId, adminUserId, status }) {
      const result = await query(
        `INSERT INTO dispatch_log(slot_key, azs_id, admin_user_id, status)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(slot_key, azs_id) DO NOTHING
         RETURNING id`,
        [slotKey, azsId, adminUserId, status]
      );
      if (!result.rows.length) {
        return { reserved: false, id: null };
      }
      return { reserved: true, id: Number(result.rows[0].id) };
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
        ['done', reportItemId ?? null, jitterMinutes ?? null, scheduledAt ?? null, deadlineAt ?? null, id]
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

    async reserve({ slotKey, azsId, adminUserId, status }) {
      const [result] = await query(
        `INSERT IGNORE INTO dispatch_log(slot_key, azs_id, admin_user_id, status)
         VALUES(?, ?, ?, ?)`,
        [slotKey, azsId, adminUserId, status]
      );

      if (!result.affectedRows) {
        return { reserved: false, id: null };
      }

      return { reserved: true, id: Number(result.insertId) || null };
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
        ['done', reportItemId ?? null, jitterMinutes ?? null, serializeDate(scheduledAt), serializeDate(deadlineAt), id]
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

