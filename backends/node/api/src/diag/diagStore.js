/**
 * diagStore — хранение диагностических бандлов.
 *
 * Только PostgreSQL: DB_TYPE=postgresql и в .env, и в .env.timeweb. Для mysql
 * конструктор бросает ошибку сразу, а не отдаёт стор, который сломается на
 * первом запросе.
 *
 * ensureSchema() идемпотентен (CREATE TABLE/INDEX IF NOT EXISTS) — по образцу
 * reasonStore и databaseBrandStore.
 */
export const createDiagStore = ({ pool, dbType = 'postgresql' }) => {
  if (String(dbType).toLowerCase() !== 'postgresql') {
    throw new Error(`diagStore: only PostgreSQL is supported, got "${dbType}"`);
  }

  return {
    async ensureSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS diag_report (
          id BIGSERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          diag_session_id TEXT NULL,
          user_id BIGINT NULL,
          azs_id TEXT NULL,
          report_id BIGINT NULL,
          trigger TEXT NOT NULL,
          size_bytes INT NOT NULL,
          bundle JSONB NOT NULL,
          -- Серверная половина картины: состояние OAuth-токена, живая проба
          -- Диска с таймингом, пинг БД. Отдельной колонкой, а не внутри bundle:
          -- она не приходит от клиента, не подлежит проверке доверия и не должна
          -- влиять на потолок размера бандла.
          server_slice JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_azs_created
          ON diag_report (azs_id, created_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_session
          ON diag_report (diag_session_id)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_created
          ON diag_report (created_at)
      `);
    },

    async insert({ code, diagSessionId, userId, azsId, reportId, trigger, sizeBytes, bundle, serverSlice = null }) {
      const result = await pool.query(
        `INSERT INTO diag_report
           (code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, bundle, server_slice)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, code, created_at`,
        [
          code,
          diagSessionId ?? null,
          Number.isFinite(Number(userId)) ? Number(userId) : null,
          azsId ?? null,
          Number.isFinite(Number(reportId)) ? Number(reportId) : null,
          trigger,
          Number(sizeBytes) || 0,
          JSON.stringify(bundle),
          serverSlice === null ? null : JSON.stringify(serverSlice)
        ]
      );
      return result.rows[0] ?? null;
    },

    async getByCode(code) {
      const result = await pool.query(
        'SELECT id, code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, bundle, server_slice, created_at FROM diag_report WHERE code = $1 LIMIT 1',
        [String(code || '')]
      );
      return result.rows[0] ?? null;
    },

    async list({ azsId = '', dateFrom = '', dateTo = '', limit = 50 } = {}) {
      const where = [];
      const params = [];
      let idx = 1;
      if (azsId) { where.push(`azs_id = $${idx}`); params.push(String(azsId)); idx += 1; }
      if (dateFrom) { where.push(`created_at >= $${idx}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); idx += 1; }
      if (dateTo) { where.push(`created_at <= $${idx}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); idx += 1; }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
      params.push(safeLimit);
      const result = await pool.query(
        `SELECT id, code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, created_at
         FROM diag_report ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        params
      );
      return result.rows;
    },

    async deleteOlderThan(days) {
      const safeDays = Math.max(Number(days) || 30, 1);
      const result = await pool.query(
        `DELETE FROM diag_report WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(safeDays)]
      );
      return Number(result.rowCount || 0);
    }
  };
};
