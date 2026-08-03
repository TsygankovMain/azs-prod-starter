// Очередь публикации поверх report_photo (схема — reportsStore.ensurePhotoSchema).
//
// Состояние публикации живёт в самой строке report_photo (publish_state,
// next_attempt_at, publish_attempts, last_publish_error) — отдельной таблицы
// задач нет, см. обоснование в ensurePhotoSchema. Этот стор — только доступ
// к этому состоянию для приёма фото и для воркеров публикации.
//
// Аренда задачи вместо статуса 'running': claimBatch сдвигает next_attempt_at
// на 5 минут вперёд и оставляет publish_state = 'accepted'. Если воркер
// умрёт с задачей в руках, отдельного восстановления при старте не нужно —
// строка сама станет видна claimBatch, как только текущее время перейдёт её
// next_attempt_at. Не путать с crmSyncJobStore, где статус 'running' требует
// reclaimStale() на старте процесса, чтобы снять осиротевшие задачи.

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
  async accept({ reportId, photoCode, uploadedBy, exifAt, content, mimeType, originalName }) {
    // Две отдельные вставки, не одна транзакция — это намеренно, а не
    // недосмотр. Если процесс упадёт между ними, останется строка
    // report_photo в 'accepted' без пары в report_photo_blob — тот самый
    // "приём прервался между вставками" случай, под который в claimBatch
    // стоит INNER JOIN (такая строка молча не попадёт в очередь на публикацию
    // и не будет раз за разом безуспешно браться), а в listStuck — LEFT JOIN
    // (сторож обязан её увидеть и сообщить). Оборачивать в транзакцию незачем:
    // это не убирает дефектные строки, а только меняет, кто их произвёл.
    const photoResult = await pool.query(
      `INSERT INTO report_photo (report_id, photo_code, uploaded_by, exif_at, publish_state)
       VALUES ($1, $2, $3, $4, 'accepted')
       ON CONFLICT (report_id, photo_code) DO UPDATE
          SET uploaded_by = EXCLUDED.uploaded_by,
              exif_at = EXCLUDED.exif_at,
              publish_state = 'accepted',
              publish_attempts = 0,
              next_attempt_at = NULL,
              last_publish_error = NULL,
              published_at = NULL,
              uploaded_at = NOW(),
              updated_at = NOW()
       RETURNING id`,
      [reportId, photoCode, uploadedBy, exifAt ?? null]
    );
    const id = photoResult.rows[0].id;
    // content — Buffer с сырыми байтами (тип согласован со схемой BYTEA);
    // кодирование/декодирование на границе HTTP — забота вызывающего роута.
    const byteSize = Buffer.byteLength(content);
    await pool.query(
      `INSERT INTO report_photo_blob (report_photo_id, content, mime_type, byte_size, original_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (report_photo_id) DO UPDATE
          SET content = EXCLUDED.content,
              mime_type = EXCLUDED.mime_type,
              byte_size = EXCLUDED.byte_size,
              original_name = EXCLUDED.original_name,
              created_at = NOW()`,
      [id, content, mimeType, byteSize, originalName ?? null]
    );
    return { id };
  },

  // FOR UPDATE SKIP LOCKED, а не SELECT-затем-UPDATE как в crmSyncJobStore:
  // у нас три воркера в процессе и потенциально несколько экземпляров
  // приложения на Timeweb. Гонка «оба увидели строку и оба взяли» дала бы
  // двойную публикацию одного файла и двойной расход бюджета портала.
  //
  // Байты приезжают тем же запросом (JOIN report_photo_blob): отдельный поход
  // за содержимым удвоил бы число обращений к БД на каждую задачу.
  async claimBatch({ limit = 3, now = new Date() } = {}) {
    const result = await pool.query(
      `WITH due AS (
         SELECT rp.id
           FROM report_photo rp
          WHERE rp.publish_state = 'accepted'
            AND (rp.next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY rp.uploaded_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE report_photo rp
          SET next_attempt_at = $1 + INTERVAL '5 minutes',
              updated_at = NOW()
         FROM due
         JOIN report_photo_blob b ON b.report_photo_id = due.id
        WHERE rp.id = due.id
       RETURNING rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.exif_at,
                 rp.slot_verified, b.content, b.mime_type, b.original_name`,
      [now, limit]
    );
    // Сдвиг next_attempt_at на 5 минут в момент взятия — аренда задачи:
    // если процесс умрёт с задачей в руках, она сама вернётся в оборот через
    // пять минут, без отдельного статуса 'running' и без reclaimStale на
    // старте (который в crmSyncWorker существует ровно потому, что там
    // статус 'running' некому снять после падения).
    //
    // JOIN, а не LEFT JOIN, намеренно: фото без байтов опубликовать нечем.
    // Такая строка — уже дефект (байты удалены раньше срока или приём
    // прервался между вставками), и её место у сторожа, а не в очереди, где
    // она вечно бралась бы и вечно падала.
    return result.rows;
  },

  async markPublished({ id, fileId, fileName, diskFolderId, diskObjectId }) {
    // Публикация НЕ удаляет байты — их чистит purgePublishedBlobs через
    // N дней. Пока файл свежий, возможность переслать его повторно без
    // участия оператора стоит дороже места на диске.
    await pool.query(
      `UPDATE report_photo
          SET publish_state = 'published',
              published_at = NOW(),
              file_id = $1,
              file_name = $2,
              disk_folder_id = $3,
              disk_object_id = $4,
              next_attempt_at = NULL,
              last_publish_error = NULL,
              updated_at = NOW()
        WHERE id = $5`,
      [fileId, fileName, diskFolderId, diskObjectId, id]
    );
  },

  async reschedule({ id, nextAttemptAt, error = null }) {
    await pool.query(
      `UPDATE report_photo
          SET publish_state = 'accepted',
              next_attempt_at = $1,
              last_publish_error = $2,
              publish_attempts = publish_attempts + 1,
              updated_at = NOW()
        WHERE id = $3`,
      [nextAttemptAt, error, id]
    );
  },

  async markFailed({ id, error }) {
    await pool.query(
      `UPDATE report_photo
          SET publish_state = 'failed',
              last_publish_error = $1,
              next_attempt_at = NULL,
              updated_at = NOW()
        WHERE id = $2`,
      [error, id]
    );
  },

  // Ручной «рычаг»: сбрасывает next_attempt_at на «сейчас» для фото,
  // которые давно не трогали. Не путать с восстановлением после падения —
  // для него отдельный механизм не нужен (см. комментарий в claimBatch).
  // Нужен для случая, когда reschedule() увёл фото в далёкий backoff
  // (например, портал был недоступен несколько часов) и после починки
  // хочется вернуть всё в оборот сразу, не дожидаясь истечения таймеров.
  async reclaimStale({ staleMs }) {
    const cutoff = new Date(Date.now() - Number(staleMs));
    const result = await pool.query(
      `UPDATE report_photo
          SET next_attempt_at = NOW(),
              updated_at = NOW()
        WHERE publish_state = 'accepted'
          AND updated_at <= $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  },

  async countByState() {
    const result = await pool.query(
      `SELECT publish_state, COUNT(*) AS count FROM report_photo GROUP BY publish_state`
    );
    const counts = {};
    for (const row of result.rows) counts[row.publish_state] = Number(row.count);
    return counts;
  },

  // LEFT JOIN, в отличие от claimBatch, намеренно: сторож обязан увидеть
  // фото, у которого пропали байты (b.report_photo_id IS NULL), а не только
  // те, что просто долго лежат неопубликованными.
  async listStuck({ olderThanMs, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - Number(olderThanMs));
    const result = await pool.query(
      `SELECT rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.last_publish_error, rp.uploaded_at
         FROM report_photo rp
         LEFT JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.publish_state <> 'published'
          AND (b.report_photo_id IS NULL OR rp.uploaded_at <= $1)
        ORDER BY rp.uploaded_at ASC
        LIMIT $2`,
      [cutoff, limit]
    );
    return result.rows;
  },

  // Байты чистит отдельная задача через N дней после публикации — markPublished
  // их не трогает (см. комментарий там). Условие на publish_state обязательно:
  // без него можно стереть байты ещё не опубликованного фото.
  async purgePublishedBlobs({ olderThanMs }) {
    const cutoff = new Date(Date.now() - Number(olderThanMs));
    const result = await pool.query(
      `DELETE FROM report_photo_blob b
        USING report_photo rp
        WHERE b.report_photo_id = rp.id
          AND rp.publish_state = 'published'
          AND rp.published_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
});

// ---------------------------------------------------------------------------
// MySQL store
// ---------------------------------------------------------------------------

const createMysqlStore = (pool) => ({
  async accept({ reportId, photoCode, uploadedBy, exifAt, content, mimeType, originalName }) {
    const exifAtSql = exifAt ? toDateSql(exifAt) : null;
    // ON DUPLICATE KEY UPDATE ... id = LAST_INSERT_ID(id) — без этого трюка
    // insertId равен 0 на ветке обновления (существующий report_id+photo_code),
    // а не на ветке вставки, и id из результата было бы неоткуда взять.
    const [result] = await pool.execute(
      `INSERT INTO report_photo (report_id, photo_code, uploaded_by, exif_at, publish_state)
       VALUES (?, ?, ?, ?, 'accepted')
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         uploaded_by = VALUES(uploaded_by),
         exif_at = VALUES(exif_at),
         publish_state = 'accepted',
         publish_attempts = 0,
         next_attempt_at = NULL,
         last_publish_error = NULL,
         published_at = NULL,
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [reportId, photoCode, uploadedBy, exifAtSql]
    );
    const id = result.insertId;
    const byteSize = Buffer.byteLength(content);
    await pool.execute(
      `INSERT INTO report_photo_blob (report_photo_id, content, mime_type, byte_size, original_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         content = VALUES(content),
         mime_type = VALUES(mime_type),
         byte_size = VALUES(byte_size),
         original_name = VALUES(original_name),
         created_at = CURRENT_TIMESTAMP`,
      [id, content, mimeType, byteSize, originalName ?? null]
    );
    return { id };
  },

  // MySQL < 8.0 не поддерживает FOR UPDATE SKIP LOCKED вовсе, а этот стор не
  // знает версию сервера (dbType её не сообщает, а держать открытую
  // транзакцию через pool.getConnection() ради одного запроса — новый паттерн,
  // которого нет больше нигде в кодовой базе, и лишний риск без реальной БД
  // под рукой для проверки). Вместо этого — тот же приём, что и в
  // crmSyncJobStore.claimNextDue, но на пакет из нескольких строк: кандидатов
  // выбираем обычным SELECT, а затем на каждую по отдельности делаем
  // атомарный UPDATE с повторной проверкой due-условия. InnoDB при UPDATE
  // читает актуальные (уже закоммиченные) данные для оценки WHERE — semi-
  // consistent read — поэтому строка, которую в промежутке забрал другой
  // воркер (его UPDATE уже сдвинул next_attempt_at), перестаёт удовлетворять
  // условию и просто не обновляется повторно. Двойного взятия нет, но под
  // высокой конкуренцией это чуть менее эффективно, чем SKIP LOCKED
  // (проигравший ждёт короткую блокировку строки вместо мгновенного пропуска).
  async claimBatch({ limit = 3, now = new Date() } = {}) {
    const nowSql = toDateSql(now);
    const [candidates] = await pool.execute(
      `SELECT rp.id
         FROM report_photo rp
         JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.publish_state = 'accepted'
          AND (rp.next_attempt_at IS NULL OR rp.next_attempt_at <= ?)
        ORDER BY rp.uploaded_at ASC
        LIMIT ?`,
      [nowSql, limit]
    );
    if (!candidates.length) return [];

    const claimedIds = [];
    for (const { id } of candidates) {
      const [result] = await pool.execute(
        `UPDATE report_photo
            SET next_attempt_at = DATE_ADD(?, INTERVAL 5 MINUTE),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND publish_state = 'accepted'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        [nowSql, id, nowSql]
      );
      if (result.affectedRows > 0) claimedIds.push(id);
    }
    if (!claimedIds.length) return [];

    const placeholders = claimedIds.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.exif_at,
              rp.slot_verified, b.content, b.mime_type, b.original_name
         FROM report_photo rp
         JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.id IN (${placeholders})`,
      claimedIds
    );
    return rows;
  },

  async markPublished({ id, fileId, fileName, diskFolderId, diskObjectId }) {
    await pool.execute(
      `UPDATE report_photo
          SET publish_state = 'published',
              published_at = CURRENT_TIMESTAMP,
              file_id = ?,
              file_name = ?,
              disk_folder_id = ?,
              disk_object_id = ?,
              next_attempt_at = NULL,
              last_publish_error = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [fileId, fileName, diskFolderId, diskObjectId, id]
    );
  },

  async reschedule({ id, nextAttemptAt, error = null }) {
    const nextAttemptSql = toDateSql(nextAttemptAt);
    await pool.execute(
      `UPDATE report_photo
          SET publish_state = 'accepted',
              next_attempt_at = ?,
              last_publish_error = ?,
              publish_attempts = publish_attempts + 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [nextAttemptSql, error, id]
    );
  },

  async markFailed({ id, error }) {
    await pool.execute(
      `UPDATE report_photo
          SET publish_state = 'failed',
              last_publish_error = ?,
              next_attempt_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [error, id]
    );
  },

  async reclaimStale({ staleMs }) {
    const cutoffSql = toDateSql(new Date(Date.now() - Number(staleMs)));
    const [result] = await pool.execute(
      `UPDATE report_photo
          SET next_attempt_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE publish_state = 'accepted'
          AND updated_at <= ?`,
      [cutoffSql]
    );
    return result?.affectedRows ?? 0;
  },

  async countByState() {
    const [rows] = await pool.execute(
      `SELECT publish_state, COUNT(*) AS count FROM report_photo GROUP BY publish_state`
    );
    const counts = {};
    for (const row of rows) counts[row.publish_state] = Number(row.count);
    return counts;
  },

  async listStuck({ olderThanMs, limit = 50 } = {}) {
    const cutoffSql = toDateSql(new Date(Date.now() - Number(olderThanMs)));
    const [rows] = await pool.execute(
      `SELECT rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.last_publish_error, rp.uploaded_at
         FROM report_photo rp
         LEFT JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.publish_state <> 'published'
          AND (b.report_photo_id IS NULL OR rp.uploaded_at <= ?)
        ORDER BY rp.uploaded_at ASC
        LIMIT ?`,
      [cutoffSql, limit]
    );
    return rows;
  },

  async purgePublishedBlobs({ olderThanMs }) {
    const cutoffSql = toDateSql(new Date(Date.now() - Number(olderThanMs)));
    const [result] = await pool.execute(
      `DELETE b FROM report_photo_blob b
         JOIN report_photo rp ON rp.id = b.report_photo_id
        WHERE rp.publish_state = 'published'
          AND rp.published_at < ?`,
      [cutoffSql]
    );
    return result?.affectedRows ?? 0;
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPhotoQueueStore = ({ pool, dbType } = {}) => {
  if (!pool) {
    throw new Error('pool is required');
  }
  if (isMysql(dbType)) {
    return createMysqlStore(pool);
  }
  return createPostgresStore(pool);
};

export default createPhotoQueueStore;
