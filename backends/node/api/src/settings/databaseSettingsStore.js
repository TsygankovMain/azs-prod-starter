import { normalizeSettings } from './defaultSettings.js';
import { DEFAULT_SETTINGS_SCOPE, resolveSettingsScope } from './settingsScope.js';

const isMysql = (dbType) => String(dbType || '').trim().toLowerCase() === 'mysql';

const normalizeJson = (raw, scopeKey) => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return normalizeSettings({}, { requireBitrixSyncFields: false });
  }
  try {
    return normalizeSettings(JSON.parse(raw), { requireBitrixSyncFields: false });
  } catch (error) {
    throw new Error(`Invalid JSON in app_settings for scope "${scopeKey}": ${error.message}`);
  }
};

const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        scope_key TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async read(scopeKey = DEFAULT_SETTINGS_SCOPE) {
    const primary = await pool.query(
      'SELECT settings_json FROM app_settings WHERE scope_key = $1 LIMIT 1',
      [scopeKey]
    );
    if (primary.rows.length > 0) {
      return normalizeJson(primary.rows[0].settings_json, scopeKey);
    }
    if (scopeKey !== DEFAULT_SETTINGS_SCOPE) {
      const fallback = await pool.query(
        'SELECT settings_json FROM app_settings WHERE scope_key = $1 LIMIT 1',
        [DEFAULT_SETTINGS_SCOPE]
      );
      if (fallback.rows.length > 0) {
        return normalizeJson(fallback.rows[0].settings_json, DEFAULT_SETTINGS_SCOPE);
      }
    }
    return normalizeSettings({}, { requireBitrixSyncFields: false });
  },

  async write(settings, scopeKey = DEFAULT_SETTINGS_SCOPE) {
    const normalized = normalizeSettings(settings);
    const payload = JSON.stringify(normalized);
    await pool.query(
      `INSERT INTO app_settings(scope_key, settings_json, updated_at)
       VALUES($1, $2, NOW())
       ON CONFLICT(scope_key) DO UPDATE
       SET settings_json = EXCLUDED.settings_json,
           updated_at = NOW()`,
      [scopeKey, payload]
    );
    return normalized;
  }
});

const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS app_settings (
        scope_key VARCHAR(191) NOT NULL PRIMARY KEY,
        settings_json LONGTEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  },

  async read(scopeKey = DEFAULT_SETTINGS_SCOPE) {
    const [rows] = await pool.execute(
      'SELECT settings_json FROM app_settings WHERE scope_key = ? LIMIT 1',
      [scopeKey]
    );
    if (rows.length > 0) {
      return normalizeJson(rows[0].settings_json, scopeKey);
    }
    if (scopeKey !== DEFAULT_SETTINGS_SCOPE) {
      const [fallbackRows] = await pool.execute(
        'SELECT settings_json FROM app_settings WHERE scope_key = ? LIMIT 1',
        [DEFAULT_SETTINGS_SCOPE]
      );
      if (fallbackRows.length > 0) {
        return normalizeJson(fallbackRows[0].settings_json, DEFAULT_SETTINGS_SCOPE);
      }
    }
    return normalizeSettings({}, { requireBitrixSyncFields: false });
  },

  async write(settings, scopeKey = DEFAULT_SETTINGS_SCOPE) {
    const normalized = normalizeSettings(settings);
    const payload = JSON.stringify(normalized);
    await pool.execute(
      `INSERT INTO app_settings(scope_key, settings_json)
       VALUES(?, ?)
       ON DUPLICATE KEY UPDATE
         settings_json = VALUES(settings_json),
         updated_at = CURRENT_TIMESTAMP`,
      [scopeKey, payload]
    );
    return normalized;
  }
});

export const createDatabaseSettingsStore = ({ pool, dbType } = {}) => {
  if (!pool) {
    throw new Error('pool is required');
  }

  const store = isMysql(dbType)
    ? createMysqlStore(pool)
    : createPostgresStore(pool);

  return {
    async ensureSchema() {
      await store.ensureSchema();
    },

    async read({ context = {} } = {}) {
      const scopeKey = resolveSettingsScope(context);
      return store.read(scopeKey);
    },

    async write(settings, { context = {} } = {}) {
      const scopeKey = resolveSettingsScope(context);
      return store.write(settings, scopeKey);
    }
  };
};

export default createDatabaseSettingsStore;
