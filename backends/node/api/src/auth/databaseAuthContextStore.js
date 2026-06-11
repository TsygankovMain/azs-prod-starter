import {
  buildAuthContextKey,
  mergeContextRecords
} from './authContextStore.js';

const isMysql = (dbType) => String(dbType || '').trim().toLowerCase() === 'mysql';

const parsePayload = (raw) => {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
};

const rowToEntry = (row) => {
  if (!row) return null;
  const ctx = parsePayload(row.payload);
  if (!ctx) return null;
  return { key: row.key, context: ctx };
};

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------
const createPgStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_context (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        last_admin_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async getByKey(key) {
    const result = await pool.query(
      'SELECT key, payload, is_admin, last_admin_at, updated_at FROM auth_context WHERE key = $1 LIMIT 1',
      [key]
    );
    return result.rows[0] || null;
  },

  async upsert(key, payload, isAdmin) {
    await pool.query(
      `INSERT INTO auth_context (key, payload, is_admin, last_admin_at, updated_at)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (key) DO UPDATE
         SET payload = EXCLUDED.payload,
             is_admin = EXCLUDED.is_admin,
             last_admin_at = CASE WHEN EXCLUDED.is_admin THEN NOW() ELSE auth_context.last_admin_at END,
             updated_at = NOW()`,
      [key, JSON.stringify(payload), isAdmin]
    );
  },

  async getLastAdmin() {
    const result = await pool.query(
      `SELECT key, payload, is_admin, last_admin_at, updated_at
       FROM auth_context
       WHERE is_admin = TRUE
       ORDER BY last_admin_at DESC NULLS LAST
       LIMIT 1`
    );
    return result.rows[0] || null;
  },

  async listAll() {
    const result = await pool.query(
      'SELECT key, payload, is_admin, last_admin_at, updated_at FROM auth_context'
    );
    return result.rows;
  }
});

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------
const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS auth_context (
        \`key\` VARCHAR(500) NOT NULL PRIMARY KEY,
        payload LONGTEXT NOT NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        last_admin_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  },

  async getByKey(key) {
    const [rows] = await pool.execute(
      'SELECT `key`, payload, is_admin, last_admin_at, updated_at FROM auth_context WHERE `key` = ? LIMIT 1',
      [key]
    );
    return rows[0] || null;
  },

  async upsert(key, payload, isAdmin) {
    await pool.execute(
      `INSERT INTO auth_context (\`key\`, payload, is_admin, last_admin_at)
       VALUES (?, ?, ?, IF(?, NOW(), NULL))
       ON DUPLICATE KEY UPDATE
         payload = VALUES(payload),
         is_admin = VALUES(is_admin),
         last_admin_at = IF(VALUES(is_admin), NOW(), last_admin_at),
         updated_at = NOW()`,
      [key, JSON.stringify(payload), isAdmin ? 1 : 0, isAdmin ? 1 : 0]
    );
  },

  async getLastAdmin() {
    const [rows] = await pool.execute(
      `SELECT \`key\`, payload, is_admin, last_admin_at, updated_at
       FROM auth_context
       WHERE is_admin = 1
       ORDER BY last_admin_at DESC
       LIMIT 1`
    );
    return rows[0] || null;
  },

  async listAll() {
    const [rows] = await pool.execute(
      'SELECT `key`, payload, is_admin, last_admin_at, updated_at FROM auth_context'
    );
    return rows;
  }
});

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export const createDatabaseAuthContextStore = ({ pool, dbType } = {}) => {
  if (!pool) {
    throw new Error('pool is required');
  }

  const db = isMysql(dbType) ? createMysqlStore(pool) : createPgStore(pool);

  return {
    async ensureSchema() {
      await db.ensureSchema();
    },

    async upsertContext(contextInput = {}) {
      const source = (
        contextInput !== null
        && typeof contextInput === 'object'
        && !Array.isArray(contextInput)
      ) ? contextInput : {};
      const key = buildAuthContextKey(source);
      if (!key) {
        throw new Error('memberId, domain and userId are required for auth context upsert');
      }

      // Load existing record for merge so partial upsert never wipes existing fields
      const existing = await db.getByKey(key);
      const previous = existing ? (parsePayload(existing.payload) || {}) : {};
      const merged = mergeContextRecords(previous, source);

      await db.upsert(key, merged, Boolean(merged.isAdmin));

      return { key, context: merged };
    },

    async getContextByKey(keyValue) {
      const key = String(keyValue || '').trim();
      if (!key) return null;
      const row = await db.getByKey(key);
      if (!row) return null;
      const entry = rowToEntry(row);
      return entry ? entry.context : null;
    },

    async getContext({ memberId, domain, userId } = {}) {
      const key = buildAuthContextKey({ memberId, domain, userId });
      if (!key) return null;
      return this.getContextByKey(key);
    },

    async getLastAdminContext() {
      const row = await db.getLastAdmin();
      if (!row) return null;
      const entry = rowToEntry(row);
      if (!entry || !entry.context?.isAdmin) return null;
      return entry;
    },

    async listContexts() {
      const rows = await db.listAll();
      return rows
        .map(rowToEntry)
        .filter(Boolean);
    },

    // DB writes are synchronous per-call — no write chain to drain.
    async flush() {
      return Promise.resolve();
    }
  };
};

export default createDatabaseAuthContextStore;
