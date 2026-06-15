/**
 * databaseBrandStore — CRUD-стор для таблиц `brand` и `brand_azs`.
 *
 * Паттерн: аналогичен databaseAuthContextStore / reasonStore:
 *   - отдельные pg- и mysql-реализации
 *   - публичная фабрика createDatabaseBrandStore({ pool, dbType })
 *   - параметризованный SQL без конкатенации строк пользователя
 *   - ensureSchema() идемпотентен (CREATE TABLE IF NOT EXISTS)
 *
 * Инвариант «одна АЗС = один бренд»:
 *   - БД: UNIQUE(azs_id) в brand_azs
 *   - addAzs / setBrandAzs: INSERT … ON CONFLICT (azs_id) DO UPDATE SET brand_id
 *     (pg) / ON DUPLICATE KEY UPDATE brand_id (mysql) — «перенос», не 409
 */

const isMysql = (dbType) => String(dbType || '').trim().toLowerCase() === 'mysql';

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------
const createPgStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brand (
        id                     BIGSERIAL PRIMARY KEY,
        name                   TEXT NOT NULL,
        disk_folder_id         BIGINT NULL,
        disk_folder_path       TEXT NULL,
        external_link          TEXT NULL,
        external_link_updated_at TIMESTAMPTZ NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brand_azs (
        id         BIGSERIAL PRIMARY KEY,
        brand_id   BIGINT NOT NULL,
        azs_id     TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(azs_id)
      )
    `);
  },

  // --- brand CRUD ---

  async createBrand({ name }) {
    const result = await pool.query(
      `INSERT INTO brand (name) VALUES ($1) RETURNING *`,
      [name]
    );
    return result.rows[0] ?? null;
  },

  async getBrand(id) {
    const result = await pool.query(
      `SELECT * FROM brand WHERE id = $1 LIMIT 1`,
      [Number(id)]
    );
    return result.rows[0] ?? null;
  },

  async listBrands() {
    const result = await pool.query(
      `SELECT * FROM brand ORDER BY id ASC`
    );
    return result.rows;
  },

  async updateBrand(id, { name }) {
    const result = await pool.query(
      `UPDATE brand SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name, Number(id)]
    );
    return result.rows[0] ?? null;
  },

  async deleteBrand(id) {
    // Удаляем привязки АЗС (каскад не настроен через FK, чистим вручную)
    await pool.query(
      `DELETE FROM brand_azs WHERE brand_id = $1`,
      [Number(id)]
    );
    await pool.query(
      `DELETE FROM brand WHERE id = $1`,
      [Number(id)]
    );
  },

  // --- brand ↔ azs ---

  /**
   * Добавить АЗС в бренд. Если АЗС уже числится в другом бренде — перенести.
   * Реализуется через ON CONFLICT (azs_id) DO UPDATE SET brand_id.
   */
  async addAzs(brandId, azsId) {
    await pool.query(
      `INSERT INTO brand_azs (brand_id, azs_id)
       VALUES ($1, $2)
       ON CONFLICT (azs_id) DO UPDATE SET brand_id = EXCLUDED.brand_id`,
      [Number(brandId), String(azsId)]
    );
  },

  async removeAzs(brandId, azsId) {
    await pool.query(
      `DELETE FROM brand_azs WHERE brand_id = $1 AND azs_id = $2`,
      [Number(brandId), String(azsId)]
    );
  },

  /**
   * Переустановить полный список АЗС бренда:
   *   1. Удаляем все текущие записи этого бренда.
   *   2. Вставляем новые с ON CONFLICT DO UPDATE (перенос от другого бренда).
   */
  async setBrandAzs(brandId, azsIds) {
    const bId = Number(brandId);
    const ids = (Array.isArray(azsIds) ? azsIds : []).map(String).filter(Boolean);
    // Удаляем предыдущие привязки этого бренда
    await pool.query(`DELETE FROM brand_azs WHERE brand_id = $1`, [bId]);
    // Вставляем новые, каждую АЗС отдельным запросом (перенос если нужно)
    for (const azsId of ids) {
      await pool.query(
        `INSERT INTO brand_azs (brand_id, azs_id)
         VALUES ($1, $2)
         ON CONFLICT (azs_id) DO UPDATE SET brand_id = EXCLUDED.brand_id`,
        [bId, azsId]
      );
    }
  },

  async listAzsForBrand(brandId) {
    const result = await pool.query(
      `SELECT azs_id FROM brand_azs WHERE brand_id = $1 ORDER BY azs_id ASC`,
      [Number(brandId)]
    );
    return result.rows.map((r) => r.azs_id);
  },

  async getBrandByAzsId(azsId) {
    const result = await pool.query(
      `SELECT b.* FROM brand_azs ba
       JOIN brand b ON b.id = ba.brand_id
       WHERE ba.azs_id = $1 LIMIT 1`,
      [String(azsId)]
    );
    return result.rows[0] ?? null;
  },

  // --- сеттеры для B2 ---

  async setBrandDiskFolder(brandId, folderId, folderPath = null) {
    await pool.query(
      `UPDATE brand SET disk_folder_id = $1, disk_folder_path = $2, updated_at = NOW()
       WHERE id = $3`,
      [folderId != null ? Number(folderId) : null, folderPath || null, Number(brandId)]
    );
  },

  async setBrandExternalLink(brandId, link) {
    await pool.query(
      `UPDATE brand SET external_link = $1, external_link_updated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [link || null, Number(brandId)]
    );
  }
});

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------
const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS brand (
        id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
        name                     TEXT NOT NULL,
        disk_folder_id           BIGINT NULL,
        disk_folder_path         TEXT NULL,
        external_link            TEXT NULL,
        external_link_updated_at DATETIME NULL,
        created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS brand_azs (
        id         BIGINT AUTO_INCREMENT PRIMARY KEY,
        brand_id   BIGINT NOT NULL,
        azs_id     VARCHAR(128) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ux_brand_azs_azs_id (azs_id)
      )
    `);
  },

  // --- brand CRUD ---

  async createBrand({ name }) {
    const [result] = await pool.execute(
      `INSERT INTO brand (name) VALUES (?)`,
      [name]
    );
    const [rows] = await pool.execute(
      `SELECT * FROM brand WHERE id = ? LIMIT 1`,
      [result.insertId]
    );
    return rows[0] ?? null;
  },

  async getBrand(id) {
    const [rows] = await pool.execute(
      `SELECT * FROM brand WHERE id = ? LIMIT 1`,
      [Number(id)]
    );
    return rows[0] ?? null;
  },

  async listBrands() {
    const [rows] = await pool.execute(
      `SELECT * FROM brand ORDER BY id ASC`
    );
    return rows;
  },

  async updateBrand(id, { name }) {
    await pool.execute(
      `UPDATE brand SET name = ?, updated_at = NOW() WHERE id = ?`,
      [name, Number(id)]
    );
    return this.getBrand(id);
  },

  async deleteBrand(id) {
    await pool.execute(
      `DELETE FROM brand_azs WHERE brand_id = ?`,
      [Number(id)]
    );
    await pool.execute(
      `DELETE FROM brand WHERE id = ?`,
      [Number(id)]
    );
  },

  // --- brand ↔ azs ---

  /**
   * ON DUPLICATE KEY UPDATE brand_id = VALUES(brand_id) реализует перенос
   * АЗС из одного бренда в другой без ошибки дубликата.
   */
  async addAzs(brandId, azsId) {
    await pool.execute(
      `INSERT INTO brand_azs (brand_id, azs_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE brand_id = VALUES(brand_id)`,
      [Number(brandId), String(azsId)]
    );
  },

  async removeAzs(brandId, azsId) {
    await pool.execute(
      `DELETE FROM brand_azs WHERE brand_id = ? AND azs_id = ?`,
      [Number(brandId), String(azsId)]
    );
  },

  async setBrandAzs(brandId, azsIds) {
    const bId = Number(brandId);
    const ids = (Array.isArray(azsIds) ? azsIds : []).map(String).filter(Boolean);
    await pool.execute(`DELETE FROM brand_azs WHERE brand_id = ?`, [bId]);
    for (const azsId of ids) {
      await pool.execute(
        `INSERT INTO brand_azs (brand_id, azs_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE brand_id = VALUES(brand_id)`,
        [bId, azsId]
      );
    }
  },

  async listAzsForBrand(brandId) {
    const [rows] = await pool.execute(
      `SELECT azs_id FROM brand_azs WHERE brand_id = ? ORDER BY azs_id ASC`,
      [Number(brandId)]
    );
    return rows.map((r) => r.azs_id);
  },

  async getBrandByAzsId(azsId) {
    const [rows] = await pool.execute(
      `SELECT b.* FROM brand_azs ba
       JOIN brand b ON b.id = ba.brand_id
       WHERE ba.azs_id = ? LIMIT 1`,
      [String(azsId)]
    );
    return rows[0] ?? null;
  },

  // --- сеттеры для B2 ---

  async setBrandDiskFolder(brandId, folderId, folderPath = null) {
    await pool.execute(
      `UPDATE brand SET disk_folder_id = ?, disk_folder_path = ?, updated_at = NOW()
       WHERE id = ?`,
      [folderId != null ? Number(folderId) : null, folderPath || null, Number(brandId)]
    );
  },

  async setBrandExternalLink(brandId, link) {
    await pool.execute(
      `UPDATE brand SET external_link = ?, external_link_updated_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [link || null, Number(brandId)]
    );
  }
});

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export const createDatabaseBrandStore = ({ pool, dbType } = {}) => {
  if (!pool) throw new Error('pool is required');
  return isMysql(dbType) ? createMysqlStore(pool) : createPgStore(pool);
};

export default createDatabaseBrandStore;
