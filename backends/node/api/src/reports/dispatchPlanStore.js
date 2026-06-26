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
        entry_type TEXT NOT NULL DEFAULT 'primary',
        window_index INT NOT NULL DEFAULT 0,
        deadline_at TIMESTAMPTZ NULL,
        UNIQUE(plan_date, azs_id, base_time, entry_type, window_index)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_dispatch_plan_due ON dispatch_plan (status, execute_at)
    `);
    // S8-A3: миграция — добавляем новые колонки идемпотентно (ALTER IF NOT EXISTS)
    // entry_type: 'primary' | 'reminder', дефолт 'primary' (обратная совместимость)
    await pool.query(`
      ALTER TABLE dispatch_plan
        ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'primary'
    `);
    // window_index: int, дефолт 0 (обратная совместимость)
    await pool.query(`
      ALTER TABLE dispatch_plan
        ADD COLUMN IF NOT EXISTS window_index INT NOT NULL DEFAULT 0
    `);
    // deadline_at: для режима B дедлайн = конец последнего окна
    await pool.query(`
      ALTER TABLE dispatch_plan
        ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ NULL
    `);
    // S8-A3 БЛОКЕР 1: миграция UNIQUE ключа.
    // Удаляем старый UNIQUE(plan_date, azs_id, base_time) и добавляем
    // новый UNIQUE(plan_date, azs_id, base_time, entry_type, window_index).
    // Идемпотентно: DROP IF EXISTS + CREATE IF NOT EXISTS.
    // Старые имена ограничений зависят от имени таблицы/PostgreSQL-конвенций.
    // Пробуем несколько вариантов имён (dispatch_plan_plan_date_azs_id_base_time_key, etc.)
    await pool.query(`
      DO $$
      BEGIN
        -- Снимаем старое ограничение с тремя полями (различные возможные имена)
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'dispatch_plan'::regclass
            AND contype = 'u'
            AND conname = 'dispatch_plan_plan_date_azs_id_base_time_key'
        ) THEN
          ALTER TABLE dispatch_plan DROP CONSTRAINT dispatch_plan_plan_date_azs_id_base_time_key;
        END IF;
        -- Добавляем новое ограничение с пятью полями (если ещё не существует)
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'dispatch_plan'::regclass
            AND contype = 'u'
            AND conname = 'dispatch_plan_plan_date_azs_id_base_time_entry_type_window_index_key'
        ) THEN
          ALTER TABLE dispatch_plan
            ADD CONSTRAINT dispatch_plan_plan_date_azs_id_base_time_entry_type_window_index_key
            UNIQUE (plan_date, azs_id, base_time, entry_type, window_index);
        END IF;
      END $$;
    `);
  },

  async upsertPlanned({
    planDate, azsId, adminUserId, baseTime, executeAt,
    jitterMinutes = 0,
    entryType = 'primary',
    windowIndex = 0,
    deadlineAt = null
  } = {}) {
    const result = await pool.query(
      `INSERT INTO dispatch_plan (plan_date, azs_id, admin_user_id, base_time, execute_at, jitter_minutes, entry_type, window_index, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (plan_date, azs_id, base_time, entry_type, window_index) DO NOTHING RETURNING *`,
      [planDate, azsId, adminUserId, baseTime, executeAt, jitterMinutes, entryType, windowIndex, deadlineAt]
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

  async cancelPlanned({ id }) {
    const res = await pool.query(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='planned'`,
      [Number(id)]
    );
    return { cancelled: res.rowCount ?? 0 };
  },

  async cancelPlannedForDate({ planDate }) {
    const res = await pool.query(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=NOW() WHERE plan_date=$1 AND status='planned'`,
      [String(planDate)]
    );
    return { cancelled: res.rowCount ?? 0 };
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
        base_time VARCHAR(16) NOT NULL,
        execute_at DATETIME NOT NULL,
        jitter_minutes INT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'planned',
        report_item_id BIGINT NULL,
        error_text LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        entry_type VARCHAR(16) NOT NULL DEFAULT 'primary',
        window_index INT NOT NULL DEFAULT 0,
        deadline_at DATETIME NULL,
        UNIQUE KEY ux_dispatch_plan (plan_date, azs_id, base_time, entry_type, window_index),
        INDEX ix_dispatch_plan_due (status, execute_at)
      )
    `);
    // S8-A3: миграция — добавляем новые колонки идемпотентно
    // MySQL не поддерживает ADD COLUMN IF NOT EXISTS до 8.0.29, используем отдельные ALTER
    // Ошибка 1060 (Duplicate column) игнорируется — идемпотентность
    try {
      await pool.execute(
        `ALTER TABLE dispatch_plan ADD COLUMN entry_type VARCHAR(16) NOT NULL DEFAULT 'primary'`
      );
    } catch (e) {
      if (!String(e.message || '').includes('Duplicate column') && e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
      await pool.execute(
        `ALTER TABLE dispatch_plan ADD COLUMN window_index INT NOT NULL DEFAULT 0`
      );
    } catch (e) {
      if (!String(e.message || '').includes('Duplicate column') && e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
      await pool.execute(
        `ALTER TABLE dispatch_plan ADD COLUMN deadline_at DATETIME NULL`
      );
    } catch (e) {
      if (!String(e.message || '').includes('Duplicate column') && e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    // S8-A3 БЛОКЕР 1: миграция UNIQUE ключа MySQL.
    // Снимаем старый UNIQUE KEY ux_dispatch_plan (plan_date, azs_id, base_time)
    // и добавляем новый с пятью полями. Идемпотентно — try/catch на отсутствие/дубликат.
    try {
      // Проверяем, существует ли старый ключ с тремя полями через information_schema
      const [oldKeyRows] = await pool.execute(
        `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'dispatch_plan'
           AND INDEX_NAME = 'ux_dispatch_plan'
           AND SEQ_IN_INDEX = 4
           -- Если есть 4-й компонент, значит ключ уже расширенный
           `,
        []
      ).catch(() => [[{ c: 0 }]]);
      // Если поле SEQ_IN_INDEX=4 не найдено (0 строк), ключ старый — нужно пересоздать
      if (Number(oldKeyRows?.[0]?.c || 0) === 0) {
        // Снимаем старый ключ (ignore если не существует)
        await pool.execute(`ALTER TABLE dispatch_plan DROP INDEX ux_dispatch_plan`).catch(() => {});
        // Добавляем новый расширенный ключ
        await pool.execute(
          `ALTER TABLE dispatch_plan ADD UNIQUE KEY ux_dispatch_plan (plan_date, azs_id, base_time, entry_type, window_index)`
        ).catch((e) => {
          // Duplicate key name — ключ с таким именем уже есть (с 5 полями) — игнорируем
          if (e.code !== 'ER_DUP_KEYNAME' && !String(e.message || '').includes('Duplicate key name')) throw e;
        });
      }
    } catch {
      // Лучшие усилия — если что-то пошло не так при проверке, продолжаем
    }
  },

  async upsertPlanned({
    planDate, azsId, adminUserId, baseTime, executeAt,
    jitterMinutes = 0,
    entryType = 'primary',
    windowIndex = 0,
    deadlineAt = null
  } = {}) {
    const executeAtSql = toDateSql(executeAt);
    const deadlineAtSql = deadlineAt ? toDateSql(deadlineAt) : null;
    const [result] = await pool.execute(
      `INSERT IGNORE INTO dispatch_plan (plan_date, azs_id, admin_user_id, base_time, execute_at, jitter_minutes, entry_type, window_index, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [planDate, azsId, adminUserId, baseTime, executeAtSql, jitterMinutes, entryType, windowIndex, deadlineAtSql]
    );
    // Re-SELECT by unique key (5 полей) — возвращает ИМЕННО эту строку
    const [rows] = await pool.execute(
      `SELECT * FROM dispatch_plan WHERE plan_date=? AND azs_id=? AND base_time=? AND entry_type=? AND window_index=? LIMIT 1`,
      [planDate, azsId, baseTime, entryType, windowIndex]
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

  async cancelPlanned({ id }) {
    const [res] = await pool.execute(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='planned'`,
      [Number(id)]
    );
    return { cancelled: res?.affectedRows ?? 0 };
  },

  async cancelPlannedForDate({ planDate }) {
    const [res] = await pool.execute(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE plan_date=? AND status='planned'`,
      [String(planDate)]
    );
    return { cancelled: res?.affectedRows ?? 0 };
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

// Note on upsertPlanned return value: idempotent on UNIQUE(plan_date,azs_id,
// base_time,entry_type,window_index). PG returns null when the row already
// existed (ON CONFLICT DO NOTHING); MySQL always returns the row (INSERT IGNORE
// + re-select by all 5 key fields). The generator ignores the return — it only
// relies on no duplicate being created. Primary and reminder rows for the same
// AZS/date/base_time coexist because they differ in entry_type/window_index.
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
