const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

// ---------------------------------------------------------------------------
// Photo-feed cursor helpers  (keyset по uploaded_at DESC, rp.id DESC)
// ---------------------------------------------------------------------------

const encodeFeedCursor = (uploadedAt, id) =>
  Buffer.from(JSON.stringify({ ua: uploadedAt, id: Number(id) })).toString('base64');

const decodeFeedCursor = (cursor) => {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    const ua = String(raw.ua || '').trim();
    const id = Number(raw.id);
    if (!ua || !Number.isFinite(id)) return null;
    return { uploadedAt: ua, id };
  } catch {
    return null;
  }
};

const toFeedItemViewModel = (row) => ({
  reportId: Number(row.report_id),
  azsId: String(row.azs_id || ''),
  azsTitle: row.azs_title || null,
  photoCode: row.photo_code,
  exifAt: row.exif_at ? new Date(row.exif_at).toISOString() : null,
  uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
  photoRowId: Number(row.photo_row_id || row.id || 0),
  // Task 9: без этого поля проверяющий не отличит «ещё не в Битриксе» от
  // «пропало». Дефолт 'published' сознательно совпадает с ALTER TABLE ...
  // DEFAULT 'published' в ensurePhotoSchema — строка без явного publish_state
  // (старая миграция, фейковая строка в тесте) трактуется как уже
  // опубликованная, а не зависает вечно под плашкой «публикуется».
  publishState: row.publish_state || 'published',
  remark: row.remark_id ? {
    createdAt: row.remark_created_at ? new Date(row.remark_created_at).toISOString() : null,
    recipientName: row.remark_recipient_name || null,
    message: row.remark_message || '',
    senderName: row.remark_sender_name || null
  } : null
});

const normalizeDate = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toISOString();
};

const toViewModel = (row) => ({
  id: Number(row.id),
  slotKey: row.slot_key,
  azsId: row.azs_id,
  adminUserId: Number(row.admin_user_id),
  status: row.status,
  reportItemId: row.report_item_id ? Number(row.report_item_id) : null,
  jitterMinutes: row.jitter_minutes === null || row.jitter_minutes === undefined
    ? null
    : Number(row.jitter_minutes),
  scheduledAt: normalizeDate(row.scheduled_at),
  deadlineAt: normalizeDate(row.deadline_at),
  errorText: row.error_text || null,
  diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
  createdAt: normalizeDate(row.created_at),
  updatedAt: normalizeDate(row.updated_at)
});

const ACTIVE_STATUS_ORDER_SQL = `CASE status
  WHEN 'in_progress' THEN 0
  WHEN 'new' THEN 1
  WHEN 'reserved' THEN 2
  WHEN 'expired' THEN 3
  ELSE 9
END`;

// Экран оператора: активные отчёты плюс свежий просроченный (чтобы человек
// видел, что именно он пропустил, а не пустой список). Строки напоминаний
// (slot_key вида '%:reminder:%') сюда не попадают: у них нет карточки
// смарт-процесса и они навсегда остаются в статусе 'reserved'.
const ACTIVE_STATUSES_SQL = `'new', 'in_progress', 'reserved', 'expired'`;
const EXPIRED_WINDOW_HOURS = 24;

const createPostgresStore = (pool) => ({
  async ensurePhotoSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_photo (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        photo_code TEXT NOT NULL,
        file_id BIGINT NULL,
        file_name TEXT NULL,
        disk_folder_id BIGINT NULL,
        disk_object_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at TIMESTAMPTZ NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(report_id, photo_code)
      )
    `);
    // Idempotent migration for existing tables (Postgres supports IF NOT EXISTS).
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS disk_object_id BIGINT NULL
    `);
    // Очередь публикации живёт прямо в report_photo, отдельной таблицы задач
    // нет: состояние фото и состояние его публикации — один и тот же факт, и
    // разносить их значит заводить второй источник правды и рассинхрон.
    //
    // DEFAULT 'published' намеренно: строки, уже лежащие в таблице, попали
    // сюда ПОСЛЕ успешной загрузки в Битрикс. Дефолт 'accepted' поставил бы
    // весь исторический архив в очередь на повторную публикацию — то есть
    // устроил бы ровно тот шторм запросов, который эта задача и лечит.
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS publish_state TEXT NOT NULL DEFAULT 'published'
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS publish_attempts INT NOT NULL DEFAULT 0
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS last_publish_error TEXT NULL
    `);
    // Частичный индекс: в очереди всегда меньшинство строк, а сканировать
    // весь архив опубликованных на каждый тик воркера незачем.
    //
    // Мелочь (финальное ревью ветки, ЗАДОКУМЕНТИРОВАТЬ, НЕ чинить в рамках
    // этой задачи): CREATE INDEX здесь и у ix_report_photo_stuck ниже — БЕЗ
    // CONCURRENTLY. На пустой таблице (первый деплой, report_photo только
    // что создана) это мгновенно и безвредно. На РЕДЕПЛОЕ уже наполненной
    // таблицы (ensurePhotoSchema — идемпотентная функция, выполняется на
    // КАЖДОМ старте процесса, IF NOT EXISTS обычно делает эти два запроса
    // no-op) построение индекса держит SHARE LOCK на report_photo на всё
    // время построения — конкурентные INSERT/UPDATE (в том числе
    // photoQueueStore.accept(), то есть приём фото оператором) блокируются
    // до его завершения. С CONCURRENTLY тот же индекс строится без этой
    // блокировки ценой более сложной, некраткой транзакции DDL (CONCURRENTLY
    // не может идти внутри обычной пары запросов подряд без учёта частичных
    // сбоев — INVALID индекс требует отдельной обработки, которой здесь
    // сейчас нет). Риск разовый и краткий (секунды на реалистичном объёме
    // таблицы), но реален именно на живом проде с уже идущим приёмом.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_report_photo_publish_due
        ON report_photo (next_attempt_at)
        WHERE publish_state = 'accepted'
    `);
    // Task 11 (пункт 8, найдено ревью): у сторожа (photoPublishWatchdog.js ->
    // listStuck) условие ДРУГОЕ — `publish_state <> 'published' AND (...)`, а
    // не `= 'accepted'` индекса выше. `<> 'published'` не влечёт предикат
    // `= 'accepted'` буквально (строка может быть и 'failed') — планировщик
    // Postgres не может воспользоваться партиционным индексом, чей предикат
    // не подпадает под условие запроса. report_photo не чистится целиком
    // (только report_photo_blob, через N дней после публикации, см.
    // purgePublishedBlobs) — опубликованные строки остаются в таблице
    // навсегда, и по мере роста архива каждый тик сторожа читал бы её
    // целиком. Отдельный партиционный индекс с СОБСТВЕННЫМ, совпадающим
    // предикатом решает это тем же приёмом, что и индекс очереди выше.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_report_photo_stuck
        ON report_photo (uploaded_at)
        WHERE publish_state <> 'published'
    `);
    // Байты отдельной таблицей: обычные выборки по фото не должны тянуть
    // мегабайты, а удаление байтов после публикации не должно трогать
    // метаданные, на которые ссылается фотолента.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_photo_blob (
        report_photo_id BIGINT PRIMARY KEY REFERENCES report_photo(id) ON DELETE CASCADE,
        content         BYTEA NOT NULL,
        mime_type       TEXT  NOT NULL,
        byte_size       INT   NOT NULL,
        original_name   TEXT  NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Локальное состояние отчёта.
    //
    // ОТДЕЛЬНОЙ ТАБЛИЦЕЙ, а не колонками в таблице отчётов, потому что
    // локальной таблицы отчётов НЕ СУЩЕСТВУЕТ: сами отчёты живут элементами
    // смарт-процесса в Битриксе, а у нас локальны только report_photo,
    // dispatch_plan, auth_context, app_settings и report_reason. Ключ —
    // report_id, то есть id элемента CRM.
    //
    // Не в dispatch_plan, хотя там есть report_item_id: отчёт можно создать
    // вручную через POST /manual, и тогда строки плана у него нет вовсе.
    //
    // required_photo_codes — JSON-массив кодов. Нужен затем, что приём фото
    // не имеет права зависеть от Битрикса ВООБЩЕ. Кэш в памяти этого не даёт:
    // после рестарта процесса он пуст, и первый же снимок пошёл бы в портал
    // за списком — то есть приём падал бы ровно тогда, когда портал лежит.
    // Заполняется при открытии карточки отчёта, когда список уже получен и
    // оплачен, и дальше читается из нашей БД.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_local_state (
        report_id             BIGINT PRIMARY KEY,
        operator_completed_at TIMESTAMPTZ NULL,
        required_photo_codes  TEXT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Слот не проверен против Битрикса: список не был известен в момент
    // приёма. Фото всё равно принято — проверка отложена до публикации.
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS slot_verified BOOLEAN NOT NULL DEFAULT TRUE
    `);
  },

  // report_local_state — таблица создана в ensurePhotoSchema выше, но методов
  // доступа к ней не было (Task 2 завела только схему). Эти два метода нужны
  // приёму фото (POST /:id/photo): required_photo_codes читается ЛОКАЛЬНО, из
  // нашей БД — это первый и самый частый из трёх уровней резолвинга списка
  // требуемых фото, и единственный, что переживает рестарт процесса (кэш в
  // памяти после рестарта пуст). Заполняется при открытии карточки отчёта
  // (GET /:id), когда список уже получен и оплачен живым Битриксом.
  //
  // ЛОВУШКА СХЕМЫ (см. ensurePhotoSchema/report_local_state выше и MySQL-
  // вариант ниже): updated_at обновляется автоматически ТОЛЬКО в MySQL
  // (ON UPDATE CURRENT_TIMESTAMP) — в PostgreSQL триггера нет. updated_at
  // здесь проставлен ЯВНО, тем же приёмом, что и dispatch_log выше
  // (uploaded_at = NOW(), updated_at = NOW() в upsertPhoto/setReportStatus).
  async setRequiredPhotoCodes({ reportId, codes }) {
    const json = JSON.stringify(Array.isArray(codes) ? codes.map((code) => String(code)) : []);
    await pool.query(
      `INSERT INTO report_local_state (report_id, required_photo_codes)
       VALUES ($1, $2)
       ON CONFLICT (report_id) DO UPDATE
          SET required_photo_codes = EXCLUDED.required_photo_codes,
              updated_at = NOW()`,
      [reportId, json]
    );
  },

  async getRequiredPhotoCodes(reportId) {
    const result = await pool.query(
      'SELECT required_photo_codes FROM report_local_state WHERE report_id = $1 LIMIT 1',
      [reportId]
    );
    const raw = result.rows[0]?.required_photo_codes;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((code) => String(code)) : null;
    } catch {
      return null;
    }
  },

  // Task 8 (чинит CRITICAL Task 5): момент, когда ОПЕРАТОР закончил — а не
  // когда фото доехали до Битрикса (report_photo.published_at). POST
  // /:id/submit проставляет это поле, как только все обязательные слоты
  // приняты ЛОКАЛЬНО, независимо от факта публикации; дедлайн сверяется по
  // этому полю, а не по published_at (см. обоснование в reportsRoutes.js,
  // POST /:id/submit).
  //
  // Тот же upsert-приём и та же ЛОВУШКА СХЕМЫ, что и у setRequiredPhotoCodes
  // выше: updated_at обновляется автоматически ТОЛЬКО в MySQL — в PostgreSQL
  // явный NOW() обязателен.
  async setOperatorCompletedAt({ reportId, at }) {
    const completedAt = at instanceof Date ? at : new Date(at);
    await pool.query(
      `INSERT INTO report_local_state (report_id, operator_completed_at)
       VALUES ($1, $2)
       ON CONFLICT (report_id) DO UPDATE
          SET operator_completed_at = EXCLUDED.operator_completed_at,
              updated_at = NOW()`,
      [reportId, completedAt]
    );
  },

  async list({ dateFrom, dateTo, status, azsId, azsIds = [], limit = 200 } = {}) {
    const where = [];
    const params = [];
    let idx = 1;

    // BUG-014 fix: filter by updated_at (last status-change time) instead of
    // created_at (dispatch creation time).  R4Card asks "what happened in the
    // last 29 days"; a report is logically "in period" when it was completed /
    // expired within that window, not when the push was originally sent.
    if (dateFrom) {
      where.push(`updated_at >= $${idx}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
      idx += 1;
    }
    if (dateTo) {
      where.push(`updated_at <= $${idx}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
      idx += 1;
    }
    if (status) {
      where.push(`status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push(`azs_id = $${idx}`);
      params.push(selectedAzsIds[0]);
      idx += 1;
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id = ANY($${idx})`);
      params.push(selectedAzsIds);
      idx += 1;
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT d.*,
             (SELECT MAX(rp.disk_folder_id) FROM report_photo rp WHERE rp.report_id = d.id) AS disk_folder_id
      FROM dispatch_log d
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
      LIMIT $${idx}
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(toViewModel);
  },

  async getById(id) {
    const result = await pool.query('SELECT * FROM dispatch_log WHERE id = $1 LIMIT 1', [id]);
    if (!result.rows.length) {
      return null;
    }
    return toViewModel(result.rows[0]);
  },

  async listActiveByAdminUserId({ adminUserId, limit = 20 } = {}) {
    const userId = Number(adminUserId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return [];
    }

    const maxLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
    const sql = `
      SELECT *
      FROM dispatch_log
      WHERE admin_user_id = $1
        AND status IN (${ACTIVE_STATUSES_SQL})
        AND slot_key NOT LIKE '%:reminder:%'
        AND (
          status <> 'expired'
          OR deadline_at > NOW() - INTERVAL '${EXPIRED_WINDOW_HOURS} hours'
        )
      ORDER BY
        ${ACTIVE_STATUS_ORDER_SQL},
        deadline_at ASC NULLS LAST,
        id DESC
      LIMIT $2
    `;
    const result = await pool.query(sql, [userId, maxLimit]);
    return result.rows.map(toViewModel);
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    diskObjectId,
    uploadedBy,
    exifAt
  }) {
    await pool.query(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(report_id, photo_code) DO UPDATE
       SET file_id = EXCLUDED.file_id,
           file_name = EXCLUDED.file_name,
           disk_folder_id = EXCLUDED.disk_folder_id,
           disk_object_id = EXCLUDED.disk_object_id,
           uploaded_by = EXCLUDED.uploaded_by,
           exif_at = EXCLUDED.exif_at,
           uploaded_at = NOW(),
           updated_at = NOW()`,
      [reportId, photoCode, fileId, fileName, diskFolderId, diskObjectId ?? null, uploadedBy, exifAt ?? null]
    );
  },

  async listPhotos(reportId) {
    const result = await pool.query(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = $1 ORDER BY photo_code ASC',
      [reportId]
    );
    return result.rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      uploadedBy: Number(row.uploaded_by),
      exifAt: normalizeDate(row.exif_at),
      uploadedAt: normalizeDate(row.uploaded_at)
    }));
  },

  async setReportStatus({ reportId, status }) {
    // B5/C3 defense-in-depth: only move out of a non-terminal status. Prevents a
    // late/racing writer (e.g. timeoutWatcher) from clobbering a report the
    // operator already completed (done) or that was already expired.
    await pool.query(
      `UPDATE dispatch_log
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND status NOT IN ('done', 'expired')`,
      [status, reportId]
    );
  },

  async listNotSubmittedForDate({ planDate }) {
    if (!planDate) return [];
    const result = await pool.query(
      `SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status NOT IN ('done', 'cancelled')
       ORDER BY id`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rows.map((r) => ({
      id: Number(r.id),
      azsId: String(r.azs_id),
      adminUserId: Number(r.admin_user_id),
      reportItemId: r.report_item_id == null ? null : Number(r.report_item_id),
      status: r.status,
    }));
  },

  async cancelNotSubmittedForDate({ planDate }) {
    if (!planDate) return 0;
    const result = await pool.query(
      `UPDATE dispatch_log SET status='cancelled', updated_at = NOW()
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status NOT IN ('done', 'cancelled')`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rowCount ?? 0;
  },

  async listSubmittedAzsForDate({ planDate }) {
    if (!planDate) return [];
    const result = await pool.query(
      `SELECT DISTINCT azs_id FROM dispatch_log
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status = 'done'`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rows.map((r) => String(r.azs_id));
  },

  async listOverdueReports({ now = new Date(), limit = 200 } = {}) {
    const result = await pool.query(
      `SELECT *
       FROM dispatch_log
       WHERE deadline_at IS NOT NULL
         AND deadline_at < $1
         AND status NOT IN ('done', 'expired', 'cancelled')
       ORDER BY deadline_at ASC
       LIMIT $2`,
      [new Date(now), Math.min(Number(limit) || 200, 500)]
    );
    return result.rows.map(toViewModel);
  },

  async getSummary({ dateFrom, dateTo, azsId, azsIds = [], now = new Date() } = {}) {
    const where = [];
    const params = [];
    let idx = 1;

    if (dateFrom) {
      where.push(`created_at >= $${idx}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
      idx += 1;
    }
    if (dateTo) {
      where.push(`created_at <= $${idx}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
      idx += 1;
    }
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push(`azs_id = $${idx}`);
      params.push(selectedAzsIds[0]);
      idx += 1;
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id = ANY($${idx})`);
      params.push(selectedAzsIds);
      idx += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const statusResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM dispatch_log ${whereSql} GROUP BY status`,
      params
    );

    const byStatus = {};
    let total = 0;
    for (const row of statusResult.rows) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    const overdueWhere = [...where, `deadline_at IS NOT NULL`, `deadline_at < $${idx}`, `status NOT IN ('done', 'expired', 'cancelled')`];
    const overdueParams = [...params, new Date(now)];
    const overdueResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM dispatch_log WHERE ${overdueWhere.join(' AND ')}`,
      overdueParams
    );
    const overdue = Number(overdueResult.rows[0]?.count || 0);

    const open = Number(byStatus.new || 0) + Number(byStatus.in_progress || 0) + Number(byStatus.reserved || 0);
    const done = Number(byStatus.done || 0);
    const expired = Number(byStatus.expired || 0);
    const failed = Number(byStatus.failed || 0);

    return {
      total,
      overdue,
      open,
      done,
      expired,
      failed,
      byStatus
    };
  },

  // ---------------------------------------------------------------------------
  // listPhotosFeed — photo-feed with optional remark join
  // ---------------------------------------------------------------------------
  async listPhotosFeed({
    dateFrom, dateTo, azsIds = [], photoCodes = [],
    remarks = 'all', // 'all' | 'with' | 'without'
    limit = 50,
    cursor = null
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const where = [];
    const params = [];
    let idx = 1;

    if (dateFrom) {
      where.push(`rp.uploaded_at >= $${idx++}`);
      params.push(new Date(`${dateFrom}T00:00:00.000Z`));
    }
    if (dateTo) {
      where.push(`rp.uploaded_at <= $${idx++}`);
      params.push(new Date(`${dateTo}T23:59:59.999Z`));
    }
    const normAzs = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normAzs.length === 1) {
      where.push(`d.azs_id = $${idx++}`);
      params.push(normAzs[0]);
    } else if (normAzs.length > 1) {
      where.push(`d.azs_id = ANY($${idx++})`);
      params.push(normAzs);
    }
    const normCodes = Array.isArray(photoCodes)
      ? photoCodes.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normCodes.length === 1) {
      where.push(`rp.photo_code = $${idx++}`);
      params.push(normCodes[0]);
    } else if (normCodes.length > 1) {
      where.push(`rp.photo_code = ANY($${idx++})`);
      params.push(normCodes);
    }

    // remark filter
    if (remarks === 'with') {
      where.push(`EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    } else if (remarks === 'without') {
      where.push(`NOT EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    }

    // keyset cursor
    if (cursor) {
      const decoded = decodeFeedCursor(cursor);
      if (decoded) {
        where.push(`(rp.uploaded_at, rp.id) < ($${idx}, $${idx + 1})`);
        idx += 2;
        params.push(new Date(decoded.uploadedAt), decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);

    const sql = `
      SELECT
        rp.id         AS photo_row_id,
        rp.report_id,
        rp.photo_code,
        rp.exif_at,
        rp.uploaded_at,
        rp.publish_state,
        d.azs_id,
        NULL          AS azs_title,
        lr.id         AS remark_id,
        lr.created_at AS remark_created_at,
        lr.recipient_name AS remark_recipient_name,
        lr.message    AS remark_message,
        lr.sender_name AS remark_sender_name
      FROM report_photo rp
      JOIN dispatch_log d ON d.id = rp.report_id
      LEFT JOIN LATERAL (
        SELECT pr.*
        FROM photo_remark pr
        JOIN photo_remark_photo prp ON prp.remark_id = pr.id
        WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code
        ORDER BY pr.created_at DESC
        LIMIT 1
      ) lr ON true
      ${whereSql}
      ORDER BY rp.uploaded_at DESC, rp.id DESC
      LIMIT $${idx}
    `;

    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);
    const items = rows.map(toFeedItemViewModel);
    const lastRow = rows[rows.length - 1];
    const nextCursor = hasMore
      ? encodeFeedCursor(lastRow.uploaded_at, lastRow.photo_row_id)
      : null;
    return { items, nextCursor };
  },

  async getPhoto(reportId, photoCode) {
    const result = await pool.query(
      `SELECT rp.file_name, rp.disk_object_id, rp.file_id, d.azs_id
       FROM report_photo rp
       JOIN dispatch_log d ON d.id = rp.report_id
       WHERE rp.report_id = $1 AND rp.photo_code = $2 LIMIT 1`,
      [reportId, photoCode]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null,
      azsId: row.azs_id ? String(row.azs_id) : null
    };
  },

  // ---------------------------------------------------------------------------
  // S8-A3 БЛОКЕР 2+3: getActiveReportForAzsOnDate
  // Ищет последний/актуальный отчёт (dispatch_log) данной АЗС за указанную дату
  // по полям azs_id + slot_key LIKE 'planDate:%'.
  // Возвращает viewModel со статусом или null если отчёт не найден.
  // Используется исполнителем напоминаний в dispatchScheduler для проверки OR-6.
  // ---------------------------------------------------------------------------
  async getActiveReportForAzsOnDate({ azsId, planDate }) {
    if (!azsId || !planDate) return null;
    // slot_key формат: YYYY-MM-DD:HHmm (или manual:YYYY-MM-DD:HHmm)
    // Ищем по дате начала slot_key: и primary-часть planDate: и manual:planDate:
    // S8-БЛОКЕР #3б: исключаем reminder-строки (slot_key вида '%:reminder:%')
    // чтобы они не попадали в выборку отчёта первичной точки.
    const result = await pool.query(
      `SELECT *
       FROM dispatch_log
       WHERE azs_id = $1
         AND (slot_key LIKE $2 OR slot_key LIKE $3)
         AND slot_key NOT LIKE $4
         AND status <> 'cancelled'
       ORDER BY
         CASE status
           WHEN 'done' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'new' THEN 2
           WHEN 'reserved' THEN 3
           ELSE 9
         END,
         id DESC
       LIMIT 1`,
      [String(azsId), `${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    if (!result.rows.length) return null;
    return toViewModel(result.rows[0]);
  }
});

const createMysqlStore = (pool) => ({
  async ensurePhotoSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_photo (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        photo_code VARCHAR(191) NOT NULL,
        file_id BIGINT NULL,
        file_name VARCHAR(255) NULL,
        disk_folder_id BIGINT NULL,
        disk_object_id BIGINT NULL,
        uploaded_by BIGINT NOT NULL,
        exif_at DATETIME NULL,
        uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_report_photo_report_code (report_id, photo_code)
      )
    `);
    // MySQL lacks ADD COLUMN IF NOT EXISTS — guard with information_schema check.
    const [colRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'disk_object_id'`
    );
    if (Number(colRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN disk_object_id BIGINT NULL`
      );
    }
    // Очередь публикации живёт прямо в report_photo — см. комментарий в
    // PostgreSQL-варианте выше: состояние фото и состояние его публикации —
    // один и тот же факт, разносить их по разным таблицам значит заводить
    // второй источник правды и рассинхрон.
    //
    // DEFAULT 'published' намеренно: строки, уже лежащие в таблице, попали
    // сюда ПОСЛЕ успешной загрузки в Битрикс. Дефолт 'accepted' поставил бы
    // весь исторический архив в очередь на повторную публикацию — то есть
    // устроил бы ровно тот шторм запросов, который эта задача и лечит.
    // Новые строки проставляют 'accepted' явно.
    //
    // MySQL lacks ADD COLUMN IF NOT EXISTS — тот же приём information_schema,
    // что и для disk_object_id выше, по одному на колонку.
    const [publishStateRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'publish_state'`
    );
    if (Number(publishStateRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN publish_state VARCHAR(16) NOT NULL DEFAULT 'published'`
      );
    }
    const [publishedAtRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'published_at'`
    );
    if (Number(publishedAtRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN published_at DATETIME NULL`
      );
    }
    const [publishAttemptsRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'publish_attempts'`
    );
    if (Number(publishAttemptsRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN publish_attempts INT NOT NULL DEFAULT 0`
      );
    }
    const [nextAttemptAtRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'next_attempt_at'`
    );
    if (Number(nextAttemptAtRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN next_attempt_at DATETIME NULL`
      );
    }
    const [lastPublishErrorRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'last_publish_error'`
    );
    if (Number(lastPublishErrorRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN last_publish_error LONGTEXT NULL`
      );
    }
    // Частичный индекс (WHERE publish_state = 'accepted') недоступен в MySQL —
    // CREATE INDEX там не принимает предикат. Составной индекс — тот же приём,
    // что и ix_crm_sync_jobs_due (status, next_attempt_at) в crmSyncJobStore.js.
    // CREATE INDEX в MySQL не поддерживает IF NOT EXISTS, поэтому проверяем
    // information_schema.STATISTICS — тот же стиль guard'а, что и для колонок.
    const [dueIndexRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND INDEX_NAME = 'ix_report_photo_publish_due'`
    );
    if (Number(dueIndexRows[0]?.c || 0) === 0) {
      await pool.execute(
        `CREATE INDEX ix_report_photo_publish_due ON report_photo (publish_state, next_attempt_at)`
      );
    }
    // Task 11 (пункт 8) — см. полное обоснование в PostgreSQL-варианте выше:
    // у сторожа условие (`publish_state <> 'published'`) другое, чем у
    // очереди (`= 'accepted'`), индекс выше ему не подходит. MySQL не
    // поддерживает предикатные индексы — тот же приём, что и у
    // ix_report_photo_publish_due: составной индекс, ведущая колонка
    // publish_state, вместо предиката; тот же guard через
    // information_schema.STATISTICS, потому что CREATE INDEX в MySQL не
    // поддерживает IF NOT EXISTS.
    const [stuckIndexRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND INDEX_NAME = 'ix_report_photo_stuck'`
    );
    if (Number(stuckIndexRows[0]?.c || 0) === 0) {
      await pool.execute(
        `CREATE INDEX ix_report_photo_stuck ON report_photo (publish_state, uploaded_at)`
      );
    }
    // Байты отдельной таблицей — см. комментарий в PostgreSQL-варианте выше.
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_photo_blob (
        report_photo_id BIGINT PRIMARY KEY,
        content         LONGBLOB NOT NULL,
        mime_type       VARCHAR(128) NOT NULL,
        byte_size       INT NOT NULL,
        original_name   VARCHAR(512) NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_report_photo_blob FOREIGN KEY (report_photo_id)
          REFERENCES report_photo(id) ON DELETE CASCADE
      )
    `);
    // Локальное состояние отчёта — своя таблица, а не колонки в несуществующей
    // таблице отчётов (полное обоснование — в комментарии PostgreSQL-варианта
    // выше: локальной таблицы отчётов не существует, отчёты живут элементами
    // смарт-процесса в Битриксе).
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_local_state (
        report_id             BIGINT PRIMARY KEY,
        operator_completed_at DATETIME NULL,
        required_photo_codes  LONGTEXT NULL,
        created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Слот не проверен против Битрикса — см. комментарий в PostgreSQL-варианте
    // выше. MySQL BOOLEAN — алиас TINYINT(1); DEFAULT TRUE хранится как 1
    // (тот же приём, что и is_admin в databaseAuthContextStore.js).
    const [slotVerifiedRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'report_photo'
         AND COLUMN_NAME = 'slot_verified'`
    );
    if (Number(slotVerifiedRows[0]?.c || 0) === 0) {
      await pool.execute(
        `ALTER TABLE report_photo ADD COLUMN slot_verified TINYINT(1) NOT NULL DEFAULT 1`
      );
    }
  },

  // См. комментарий у PostgreSQL-варианта выше — тот же контракт. explicit
  // updated_at здесь не избыточен: MySQL и так обновит его через ON UPDATE
  // CURRENT_TIMESTAMP, но код не должен молчаливо полагаться на асимметрию
  // между движками (единственный источник правды — сам SQL, не то, какая
  // база сейчас в проде).
  async setRequiredPhotoCodes({ reportId, codes }) {
    const json = JSON.stringify(Array.isArray(codes) ? codes.map((code) => String(code)) : []);
    await pool.execute(
      `INSERT INTO report_local_state (report_id, required_photo_codes)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         required_photo_codes = VALUES(required_photo_codes),
         updated_at = CURRENT_TIMESTAMP`,
      [reportId, json]
    );
  },

  async getRequiredPhotoCodes(reportId) {
    const [rows] = await pool.execute(
      'SELECT required_photo_codes FROM report_local_state WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    const raw = rows[0]?.required_photo_codes;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((code) => String(code)) : null;
    } catch {
      return null;
    }
  },

  // См. комментарий у PostgreSQL-варианта выше — тот же контракт. Дата
  // форматируется вручную (тот же приём, что и exifAt в upsertPhoto ниже),
  // отдельного toDateSql в этом файле нет.
  async setOperatorCompletedAt({ reportId, at }) {
    const completedAt = at instanceof Date ? at : new Date(at);
    const completedAtSql = completedAt.toISOString().slice(0, 19).replace('T', ' ');
    await pool.execute(
      `INSERT INTO report_local_state (report_id, operator_completed_at)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         operator_completed_at = VALUES(operator_completed_at),
         updated_at = CURRENT_TIMESTAMP`,
      [reportId, completedAtSql]
    );
  },

  async list({ dateFrom, dateTo, status, azsId, azsIds = [], limit = 200 } = {}) {
    const where = [];
    const params = [];

    // BUG-014 fix: filter by updated_at (last status-change time) instead of
    // created_at (dispatch creation time).  R4Card asks "what happened in the
    // last 29 days"; a report is logically "in period" when it was completed /
    // expired within that window, not when the push was originally sent.
    if (dateFrom) {
      where.push('updated_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('updated_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push('azs_id = ?');
      params.push(selectedAzsIds[0]);
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id IN (${selectedAzsIds.map(() => '?').join(',')})`);
      params.push(...selectedAzsIds);
    }

    params.push(Math.min(Number(limit) || 200, 500));
    const sql = `
      SELECT d.*,
             (SELECT MAX(rp.disk_folder_id) FROM report_photo rp WHERE rp.report_id = d.id) AS disk_folder_id
      FROM dispatch_log d
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
      LIMIT ?
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(toViewModel);
  },

  async getById(id) {
    const [rows] = await pool.execute('SELECT * FROM dispatch_log WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return null;
    }
    return toViewModel(rows[0]);
  },

  async listActiveByAdminUserId({ adminUserId, limit = 20 } = {}) {
    const userId = Number(adminUserId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return [];
    }

    const maxLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE admin_user_id = ?
         AND status IN (${ACTIVE_STATUSES_SQL})
         AND slot_key NOT LIKE '%:reminder:%'
         AND (
           status <> 'expired'
           OR deadline_at > NOW() - INTERVAL ${EXPIRED_WINDOW_HOURS} HOUR
         )
       ORDER BY
         ${ACTIVE_STATUS_ORDER_SQL},
         (deadline_at IS NULL) ASC,
         deadline_at ASC,
         id DESC
       LIMIT ?`,
      [userId, maxLimit]
    );
    return rows.map(toViewModel);
  },

  async upsertPhoto({
    reportId,
    photoCode,
    fileId,
    fileName,
    diskFolderId,
    diskObjectId,
    uploadedBy,
    exifAt
  }) {
    await pool.execute(
      `INSERT INTO report_photo(report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_id = VALUES(file_id),
         file_name = VALUES(file_name),
         disk_folder_id = VALUES(disk_folder_id),
         disk_object_id = VALUES(disk_object_id),
         uploaded_by = VALUES(uploaded_by),
         exif_at = VALUES(exif_at),
         uploaded_at = CURRENT_TIMESTAMP`,
      [
        reportId,
        photoCode,
        fileId ?? null,
        fileName ?? null,
        diskFolderId ?? null,
        diskObjectId ?? null,
        uploadedBy,
        exifAt ? exifAt.toISOString().slice(0, 19).replace('T', ' ') : null
      ]
    );
  },

  async listPhotos(reportId) {
    const [rows] = await pool.execute(
      'SELECT report_id, photo_code, file_id, file_name, disk_folder_id, disk_object_id, uploaded_by, exif_at, uploaded_at FROM report_photo WHERE report_id = ? ORDER BY photo_code ASC',
      [reportId]
    );
    return rows.map((row) => ({
      reportId: Number(row.report_id),
      photoCode: row.photo_code,
      fileId: row.file_id ? Number(row.file_id) : null,
      fileName: row.file_name || null,
      diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      uploadedBy: Number(row.uploaded_by),
      exifAt: normalizeDate(row.exif_at),
      uploadedAt: normalizeDate(row.uploaded_at)
    }));
  },

  async setReportStatus({ reportId, status }) {
    // B5/C3 defense-in-depth: only move out of a non-terminal status. Prevents a
    // late/racing writer (e.g. timeoutWatcher) from clobbering a report the
    // operator already completed (done) or that was already expired.
    await pool.execute(
      `UPDATE dispatch_log
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status NOT IN ('done', 'expired')`,
      [status, reportId]
    );
  },

  async listNotSubmittedForDate({ planDate }) {
    if (!planDate) return [];
    const [rows] = await pool.execute(
      `SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status NOT IN ('done', 'cancelled')
       ORDER BY id`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return rows.map((r) => ({
      id: Number(r.id),
      azsId: String(r.azs_id),
      adminUserId: Number(r.admin_user_id),
      reportItemId: r.report_item_id == null ? null : Number(r.report_item_id),
      status: r.status,
    }));
  },

  async cancelNotSubmittedForDate({ planDate }) {
    if (!planDate) return 0;
    const [result] = await pool.execute(
      `UPDATE dispatch_log SET status='cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status NOT IN ('done', 'cancelled')`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result?.affectedRows ?? 0;
  },

  async listSubmittedAzsForDate({ planDate }) {
    if (!planDate) return [];
    const [rows] = await pool.execute(
      `SELECT DISTINCT azs_id FROM dispatch_log
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status = 'done'`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return rows.map((r) => String(r.azs_id));
  },

  async listOverdueReports({ now = new Date(), limit = 200 } = {}) {
    const dt = new Date(now);
    const sqlDate = Number.isNaN(dt.getTime())
      ? new Date().toISOString().slice(0, 19).replace('T', ' ')
      : dt.toISOString().slice(0, 19).replace('T', ' ');
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE deadline_at IS NOT NULL
         AND deadline_at < ?
         AND status NOT IN ('done', 'expired', 'cancelled')
       ORDER BY deadline_at ASC
       LIMIT ?`,
      [sqlDate, Math.min(Number(limit) || 200, 500)]
    );
    return rows.map(toViewModel);
  },

  async getSummary({ dateFrom, dateTo, azsId, azsIds = [], now = new Date() } = {}) {
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
    const normalizedAzsIds = Array.isArray(azsIds)
      ? azsIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const singleAzsId = String(azsId || '').trim();
    const selectedAzsIds = normalizedAzsIds.length > 0
      ? normalizedAzsIds
      : (singleAzsId ? [singleAzsId] : []);
    if (selectedAzsIds.length === 1) {
      where.push('azs_id = ?');
      params.push(selectedAzsIds[0]);
    } else if (selectedAzsIds.length > 1) {
      where.push(`azs_id IN (${selectedAzsIds.map(() => '?').join(',')})`);
      params.push(...selectedAzsIds);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [statusRows] = await pool.execute(
      `SELECT status, COUNT(*) AS count FROM dispatch_log ${whereSql} GROUP BY status`,
      params
    );

    const byStatus = {};
    let total = 0;
    for (const row of statusRows) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    const dt = new Date(now);
    const nowSql = Number.isNaN(dt.getTime())
      ? new Date().toISOString().slice(0, 19).replace('T', ' ')
      : dt.toISOString().slice(0, 19).replace('T', ' ');
    const overdueWhere = [...where, 'deadline_at IS NOT NULL', 'deadline_at < ?', "status NOT IN ('done', 'expired', 'cancelled')"];
    const overdueParams = [...params, nowSql];
    const [overdueRows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM dispatch_log WHERE ${overdueWhere.join(' AND ')}`,
      overdueParams
    );
    const overdue = Number(overdueRows[0]?.count || 0);

    const open = Number(byStatus.new || 0) + Number(byStatus.in_progress || 0) + Number(byStatus.reserved || 0);
    const done = Number(byStatus.done || 0);
    const expired = Number(byStatus.expired || 0);
    const failed = Number(byStatus.failed || 0);

    return {
      total,
      overdue,
      open,
      done,
      expired,
      failed,
      byStatus
    };
  },

  // ---------------------------------------------------------------------------
  // listPhotosFeed — photo-feed with optional remark join (MySQL)
  // ---------------------------------------------------------------------------
  async listPhotosFeed({
    dateFrom, dateTo, azsIds = [], photoCodes = [],
    remarks = 'all',
    limit = 50,
    cursor = null
  } = {}) {
    const toMySqlDate = (d) => d instanceof Date
      ? d.toISOString().slice(0, 19).replace('T', ' ')
      : String(d);

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const where = [];
    const params = [];

    if (dateFrom) {
      where.push('rp.uploaded_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('rp.uploaded_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    const normAzs = Array.isArray(azsIds)
      ? azsIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normAzs.length === 1) {
      where.push('d.azs_id = ?');
      params.push(normAzs[0]);
    } else if (normAzs.length > 1) {
      where.push(`d.azs_id IN (${normAzs.map(() => '?').join(',')})`);
      params.push(...normAzs);
    }
    const normCodes = Array.isArray(photoCodes)
      ? photoCodes.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (normCodes.length === 1) {
      where.push('rp.photo_code = ?');
      params.push(normCodes[0]);
    } else if (normCodes.length > 1) {
      where.push(`rp.photo_code IN (${normCodes.map(() => '?').join(',')})`);
      params.push(...normCodes);
    }

    // remark filter — MySQL doesn't support LATERAL, use correlated EXISTS
    if (remarks === 'with') {
      where.push(`EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    } else if (remarks === 'without') {
      where.push(`NOT EXISTS (SELECT 1 FROM photo_remark_photo prp WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code)`);
    }

    if (cursor) {
      const decoded = decodeFeedCursor(cursor);
      if (decoded) {
        const ca = toMySqlDate(new Date(decoded.uploadedAt));
        where.push('(rp.uploaded_at < ? OR (rp.uploaded_at = ? AND rp.id < ?))');
        params.push(ca, ca, decoded.id);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(safeLimit + 1);

    // MySQL doesn't have LATERAL — use a correlated subquery for the latest remark
    const sql = `
      SELECT
        rp.id         AS photo_row_id,
        rp.report_id,
        rp.photo_code,
        rp.exif_at,
        rp.uploaded_at,
        rp.publish_state,
        d.azs_id,
        NULL          AS azs_title,
        lr.id         AS remark_id,
        lr.created_at AS remark_created_at,
        lr.recipient_name AS remark_recipient_name,
        lr.message    AS remark_message,
        lr.sender_name AS remark_sender_name
      FROM report_photo rp
      JOIN dispatch_log d ON d.id = rp.report_id
      LEFT JOIN photo_remark lr ON lr.id = (
        SELECT pr.id FROM photo_remark pr
        JOIN photo_remark_photo prp ON prp.remark_id = pr.id
        WHERE prp.report_id = rp.report_id AND prp.photo_code = rp.photo_code
        ORDER BY pr.created_at DESC
        LIMIT 1
      )
      ${whereSql}
      ORDER BY rp.uploaded_at DESC, rp.id DESC
      LIMIT ?
    `;

    const [rows] = await pool.execute(sql, params);
    const hasMore = rows.length > safeLimit;
    const limited = rows.slice(0, safeLimit);
    const items = limited.map(toFeedItemViewModel);
    const lastRow = limited[limited.length - 1];
    const nextCursor = hasMore
      ? encodeFeedCursor(lastRow.uploaded_at, lastRow.photo_row_id)
      : null;
    return { items, nextCursor };
  },

  async getPhoto(reportId, photoCode) {
    const [rows] = await pool.execute(
      `SELECT rp.file_name, rp.disk_object_id, rp.file_id, d.azs_id
       FROM report_photo rp
       JOIN dispatch_log d ON d.id = rp.report_id
       WHERE rp.report_id = ? AND rp.photo_code = ? LIMIT 1`,
      [reportId, photoCode]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null,
      azsId: row.azs_id ? String(row.azs_id) : null
    };
  },

  // ---------------------------------------------------------------------------
  // S8-A3 БЛОКЕР 2+3: getActiveReportForAzsOnDate (MySQL)
  // Ищет последний/актуальный отчёт (dispatch_log) данной АЗС за указанную дату
  // по полям azs_id + slot_key LIKE 'planDate:%'.
  // Возвращает viewModel со статусом или null если отчёт не найден.
  // ---------------------------------------------------------------------------
  async getActiveReportForAzsOnDate({ azsId, planDate }) {
    if (!azsId || !planDate) return null;
    // S8-БЛОКЕР #3б: исключаем reminder-строки (slot_key вида '%:reminder:%')
    // чтобы они не попадали в выборку отчёта первичной точки (MySQL).
    const [rows] = await pool.execute(
      `SELECT *
       FROM dispatch_log
       WHERE azs_id = ?
         AND (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status <> 'cancelled'
       ORDER BY
         CASE status
           WHEN 'done' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'new' THEN 2
           WHEN 'reserved' THEN 3
           ELSE 9
         END,
         id DESC
       LIMIT 1`,
      [String(azsId), `${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    if (!rows.length) return null;
    return toViewModel(rows[0]);
  }
});

export const createReportsStore = ({ pool, dbType }) => {
  if (!pool) {
    throw new Error('pool is required');
  }
  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }
  return createPostgresStore(pool);
};

export default createReportsStore;
