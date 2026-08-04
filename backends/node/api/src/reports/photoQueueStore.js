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

// Длительность аренды claimBatch — единственный источник правды. Раньше "5
// минут" было захардкожено отдельно в PostgreSQL- и MySQL-SQL и могло
// разъехаться; оба claimBatch ниже вычисляют интервал из этой константы.
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

// Минимальный безопасный порог для reclaimStale({ staleMs }) — см. подробное
// обоснование в комментарии над PostgreSQL-реализацией reclaimStale ниже.
// Экспортирован, чтобы вызывающий код (и его тесты) мог сверяться с тем же
// числом, а не заводить собственную копию "утроенной аренды".
export const MIN_RECLAIM_STALE_MS = CLAIM_LEASE_MS * 3;

// reclaimStale — НЕ аналог crmSyncWorker.recover(), и вешать её на старт
// процесса с "разумным" порогом вроде STALE_RUNNING_TIMEOUT_MS (те же 5
// минут) — самая естественная ошибка, которую сделает автор будущего
// воркера/сторожа по образцу существующего кода. В crmSyncJobStore статус
// 'running' — самодостаточный маркер "кто-то держит задачу", поэтому там
// reclaimStale с порогом в размер самой аренды безопасен: если 'running'
// висит дольше одной аренды, предыдущий процесс определённо мёртв. Здесь
// такого маркера нет по конструкции (см. комментарий в claimBatch) —
// 'accepted' означает одновременно и "ещё не забрано", и "забрано и
// публикуется прямо сейчас", и единственное отличие — updated_at. Если
// staleMs выставить в размер одной аренды, только что перезапустившийся
// экземпляр (на Timeweb их может быть несколько) отберёт аренду ровно у
// фото, которое в этот момент реально публикует другой, всё ещё живой
// экземпляр — та самая двойная публикация, против которой построен весь
// стор. Порог обязан быть заведомо больше времени одной аренды и выбираться
// осознанно (например, "фото не трогали много часов") — отсюда проверка
// ниже и трёхкратный запас.
const assertSafeReclaimStaleMs = (staleMs) => {
  const ms = Number(staleMs);
  if (!Number.isFinite(ms) || ms < MIN_RECLAIM_STALE_MS) {
    throw new RangeError(
      `reclaimStale: staleMs=${staleMs} слишком мал (минимум ${MIN_RECLAIM_STALE_MS} мс — ` +
      `3× аренды claimBatch, которая равна ${CLAIM_LEASE_MS} мс). Меньший порог может отобрать ` +
      'аренду у фото, которое прямо сейчас публикует другой живой воркер или экземпляр приложения.'
    );
  }
  return ms;
};

// C4 (финальное ревью ветки) — рычаг возврата из publish_state='failed'.
// Без него у сценария, ради которого построена вся эта очередь (портал лёг
// надолго — те самые QUERY_LIMIT_EXCEEDED обоих инцидентов), нет штатного
// выхода: markFailed — окончательный отказ ПО КОНСТРУКЦИИ (см. её
// комментарий выше), claimBatch эти строки не видит вовсе, а reclaimStale
// намеренно фильтрует только 'accepted' (см. её же комментарий) — 'failed'
// трогать не должна, это другой, куда более редкий и куда более осознанный
// жест. Единственный путь назад без этого метода — ручной UPDATE в проде.
//
// Избирательность — ОБЯЗАТЕЛЬНАЯ, а не удобство: ровно один из двух
// признаков (reportId — весь отчёт, ids — конкретный список строк, в том
// числе из нескольких отчётов сразу). Оба сразу или ни одного — бросает.
// "Восстановить вообще все failed-строки одним вызовом без выбора" здесь
// намеренно недостижимо — тот же принцип, что у минимального порога
// reclaimStale: чем шире жест восстановления, тем дороже цена его ошибки.
const normalizeRecoverFailedSelector = ({ reportId, ids }) => {
  const hasReportId = reportId !== undefined && reportId !== null;
  const hasIds = Array.isArray(ids) && ids.length > 0;
  if (hasReportId === hasIds) {
    throw new RangeError(
      'recoverFailed: обязан быть задан РОВНО ОДИН избирательный признак — либо reportId ' +
      '(весь отчёт), либо непустой ids (конкретный список строк), не оба сразу и не ни одного ' +
      '(глобальный возврат без выбора запрещён намеренно — см. заголовочный комментарий).'
    );
  }
  if (hasReportId) {
    const id = Number(reportId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new RangeError(`recoverFailed: reportId=${reportId} должен быть положительным числом`);
    }
    return { mode: 'report', reportId: id };
  }
  const normalizedIds = ids.map((value) => Number(value));
  if (normalizedIds.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('recoverFailed: все элементы ids должны быть положительными числами');
  }
  return { mode: 'ids', ids: normalizedIds };
};

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

const createPostgresStore = (pool) => ({
  // slotVerified (по умолчанию true) — стык с Task 5 (приём фото без
  // Битрикса): когда список требуемых фото не удаётся узнать локально ни из
  // report_local_state, ни из кэша, фото всё равно принимается, но с
  // slot_verified=false — саму проверку откладываем до публикации (её делает
  // воркер). Явный параметр запроса, а не расчёт на DEFAULT TRUE колонки:
  // ретейк идёт через ON CONFLICT DO UPDATE, а не через INSERT, и DEFAULT
  // колонки на UPDATE-ветке не действует вовсе.
  async accept({ reportId, photoCode, uploadedBy, exifAt, content, mimeType, originalName, slotVerified = true }) {
    // Две отдельные вставки, не одна транзакция — это намеренно, а не
    // недосмотр. Если процесс упадёт между ними, останется строка
    // report_photo в 'accepted' без пары в report_photo_blob — тот самый
    // "приём прервался между вставками" случай, под который в claimBatch
    // стоит INNER JOIN (такая строка молча не попадёт в очередь на публикацию
    // и не будет раз за разом безуспешно браться), а в listStuck — LEFT JOIN
    // (сторож обязан её увидеть и сообщить). Оборачивать в транзакцию незачем:
    // это не убирает дефектные строки, а только меняет, кто их произвёл.
    const photoResult = await pool.query(
      `INSERT INTO report_photo (report_id, photo_code, uploaded_by, exif_at, publish_state, slot_verified)
       VALUES ($1, $2, $3, $4, 'accepted', $5)
       ON CONFLICT (report_id, photo_code) DO UPDATE
          SET uploaded_by = EXCLUDED.uploaded_by,
              exif_at = EXCLUDED.exif_at,
              publish_state = 'accepted',
              publish_attempts = 0,
              next_attempt_at = NULL,
              last_publish_error = NULL,
              published_at = NULL,
              slot_verified = EXCLUDED.slot_verified,
              uploaded_at = NOW(),
              updated_at = NOW()
       RETURNING id`,
      [reportId, photoCode, uploadedBy, exifAt ?? null, Boolean(slotVerified)]
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
  // C1 (финальное ревью ветки, FIX_BASE 8cc9d94) — JOIN на report_photo_blob
  // ОБЯЗАН стоять ВНУТРИ CTE due, до WHERE/ORDER BY/LIMIT, а не только в
  // финальном UPDATE, как было раньше. Раньше due отбирала кандидатов ТОЛЬКО
  // по publish_state/next_attempt_at, ничего не зная про наличие байтов —
  // строка без пары в report_photo_blob (см. комментарий над accept() выше:
  // две отдельные вставки, любой сбой второй оставляет ровно её) занимала
  // слот в ОКНЕ выборки (LIMIT) наравне со здоровыми строками, и лишь ПОТОМ,
  // уже внутри UPDATE...FROM due JOIN report_photo_blob, вымывалась из
  // РЕЗУЛЬТАТА. Обновить её было некому — тот же JOIN отсекал её и от
  // UPDATE, значит её next_attempt_at не менялся НИКОГДА, и она навсегда
  // оставалась первой в ORDER BY uploaded_at ASC — то есть навсегда съедала
  // слот LIMIT на КАЖДОМ следующем тике, у любого числа воркеров.
  // Прежний комментарий здесь ошибочно утверждал, что JOIN «отправляет такую
  // строку к сторожу, а не в очередь» — неверно: JOIN убирает строку из
  // РЕЗУЛЬТАТА, но не из ОКНА выборки (CTE due, до LIMIT), а именно окно и
  // определяет, какие строки вообще имеют шанс быть обновлены.
  // Замерено на живом Postgres 16 (LIMIT 3, один тик): было 0 строк без
  // байтов -> 3 из 3 забрано; 1 -> 2 из 3; 2 -> 1 из 3; 3 -> 0 ИЗ 3, и это
  // не «в этот раз не повезло» — повторные тики тоже дают 0 (next_attempt_at
  // дефектных строк не меняется, значит они и дальше первые в сортировке).
  // Воркер при этом рапортует leader=true, claimed=0 — неотличимо от «очередь
  // пуста».
  // Починка — JOIN внутри due (кандидатом теперь может стать только строка,
  // У КОТОРОЙ байты реально есть), плюс FOR UPDATE OF rp SKIP LOCKED (лочим
  // только report_photo, не report_photo_blob) — ровно то же самое, что уже
  // сделано в MySQL-варианте ниже (там JOIN стоит в выборке кандидатов, до
  // LIMIT). Замерено: было 0 из 3, стало 3 из 3 при любом числе дефектных
  // строк впереди очереди; конкурентная защита (SKIP LOCKED — двум
  // одновременным вызовам не достаётся одна и та же строка) и аренда
  // (next_attempt_at сдвигается только у РЕАЛЬНО забранных строк, иммедиатный
  // повторный вызов их не перезабирает) проверены на живом Postgres 16
  // отдельно и не пострадали.
  async claimBatch({ limit = 3, now = new Date() } = {}) {
    const leaseMinutes = CLAIM_LEASE_MS / 60_000;
    const result = await pool.query(
      `WITH due AS (
         SELECT rp.id
           FROM report_photo rp
           JOIN report_photo_blob b ON b.report_photo_id = rp.id
          WHERE rp.publish_state = 'accepted'
            AND (rp.next_attempt_at IS NULL OR rp.next_attempt_at <= $1)
          ORDER BY rp.uploaded_at ASC
          LIMIT $2
          FOR UPDATE OF rp SKIP LOCKED
       )
       UPDATE report_photo rp
          SET next_attempt_at = $1 + INTERVAL '${leaseMinutes} minutes',
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
    // JOIN, а не LEFT JOIN, намеренно, и теперь СТОИТ В due (см. блок
    // комментариев выше, C1): фото без байтов опубликовать нечем. Такая
    // строка — уже дефект (байты удалены раньше срока или приём прервался
    // между вставками), и её место у сторожа (listStuck, LEFT JOIN), а не в
    // очереди, где она (до фикса C1) вечно бралась бы в окно выборки и вечно
    // не обновлялась.
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

  // ИНВАРИАНТ, ЗАЩИЩАЮЩИЙ ПОВЕДЕНИЕ POST /:id/submit (раунд правок 1,
  // Important 4 — ревью Task 8; НЕ трогать без синхронной правки submit):
  //
  // reportsStore.listPhotos (reportsRoutes.js) сознательно не выбирает и не
  // фильтрует по publish_state — missingCodes в POST /:id/submit считает код
  // "принятым" по самому ФАКТУ строки report_photo, независимо от её
  // publish_state. Это работает и не превращает /submit в тихую дыру ТОЛЬКО
  // потому, что сегодня markFailed ставится исключительно на отказы, за
  // которые отвечает инфраструктура/Битрикс (квота Диска, удалённая папка,
  // нет прав) — то есть ни разу не на то, что код в принципе не должен был
  // считаться загруженным.
  //
  // Если сюда добавится НОВАЯ причина markFailed — например, будущий воркер
  // публикации будет домечать failed фото с непройденной отложенной
  // проверкой слота (slot_verified=false на приёме, код оказался НЕ
  // обязательным для этой АЗС) — эта строка перестаёт быть "код, который
  // оператор законно загрузил" и становится "код, который вообще не должен
  // был здесь оказаться". Такую причину /submit обязан явно ИСКЛЮЧИТЬ из
  // missingCodes (иначе несуществующий/ошибочный код тихо замаскирует
  // реально недостающий требуемый). Любое расширение множества причин
  // markFailed ОБЯЗАНО сопровождаться синхронным пересмотром missingCodes в
  // reportsRoutes.js (POST /:id/submit) — см. комментарий там же.
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

  // Ручной «рычаг» для осознанного вызова оператором/скриптом, а НЕ аналог
  // crmSyncWorker.recover() и НЕ то, что можно повесить на старт процесса
  // без раздумий — полное обоснование см. в комментарии над
  // assertSafeReclaimStaleMs выше. Коротко: единственный маркер отличия
  // "давно забытую" строку от "прямо сейчас в аренде" — updated_at
  // (отдельного статуса running нет по конструкции, см. claimBatch), поэтому
  // staleMs меньше нескольких аренд подряд рискует отобрать работу у живого
  // воркера. Нужен для случая, когда reschedule() увёл фото в далёкий
  // backoff (например, портал был недоступен несколько часов) и после
  // починки хочется вернуть всё в оборот сразу, не дожидаясь истечения
  // таймеров, — а не для восстановления после падения процесса, для
  // которого отдельный механизм и так не нужен.
  async reclaimStale({ staleMs }) {
    const ms = assertSafeReclaimStaleMs(staleMs);
    const cutoff = new Date(Date.now() - ms);
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

  // C4 — см. заголовочный комментарий normalizeRecoverFailedSelector выше
  // по файлу. publish_attempts сбрасывается в 0: строка ушла в failed,
  // ИСЧЕРПАВ maxAttempts воркера (см. handleError в photoPublishWorker.js;
  // markFailed вызывается и на permanent-ошибку, и на исчерпание попыток) —
  // без сброса первая же попытка после возврата (даже разок споткнувшийся,
  // но в целом здоровый портал) немедленно уткнётся в attempts+1>=maxAttempts
  // и уйдёт обратно в failed, а не получит полный новый круг ретраев.
  // uploaded_at НЕ трогаем: если строка снова забуксует, она обязана сразу
  // попасть под критерий возраста сторожа (listStuck), а не выглядеть свежей.
  // last_publish_error НЕ трогаем: текст прежнего отказа — полезный
  // диагностический след до первого реального нового исхода (markPublished
  // очистит его, reschedule перезапишет).
  //
  // "Кто и когда дёрнул" — не колонка этой таблицы: в проекте нет отдельной
  // таблицы аудита ни для одного административного действия, весь аудит
  // живёт в структурированных логах (см. любой из console.log(JSON.stringify(
  // {event: ...})) по всему server.js/*Routes.js) — актёра и время пишет
  // вызывающий код (reportsRoutes.js, POST /photos/recover-failed), а не сам
  // стор: стору незачем знать про HTTP-запрос или личность оператора.
  async recoverFailed({ reportId, ids } = {}) {
    const selector = normalizeRecoverFailedSelector({ reportId, ids });
    const result = selector.mode === 'report'
      ? await pool.query(
          `UPDATE report_photo
              SET publish_state = 'accepted',
                  publish_attempts = 0,
                  next_attempt_at = NULL,
                  updated_at = NOW()
            WHERE publish_state = 'failed'
              AND report_id = $1
           RETURNING id, report_id, photo_code`,
          [selector.reportId]
        )
      : await pool.query(
          `UPDATE report_photo
              SET publish_state = 'accepted',
                  publish_attempts = 0,
                  next_attempt_at = NULL,
                  updated_at = NOW()
            WHERE publish_state = 'failed'
              AND id = ANY($1::bigint[])
           RETURNING id, report_id, photo_code`,
          [selector.ids]
        );
    return result.rows;
  },

  // reportId — опционален. Без него поведение прежнее: глобальная сводка по
  // всей таблице (используется диагностикой/сторожем). С ним — сводка по
  // ОДНОМУ отчёту: нужна Task 8/photoPublishCompletion.js, чтобы после
  // публикации каждого фото проверить, весь ли обязательный комплект ЭТОГО
  // отчёта уже 'published' — без фильтра по report_id "40 из 40 published"
  // где угодно в таблице ложно засчитало бы завершённость чужому отчёту.
  async countByState({ reportId } = {}) {
    const hasReportId = reportId !== undefined && reportId !== null;
    const result = await pool.query(
      hasReportId
        ? `SELECT publish_state, COUNT(*) AS count FROM report_photo WHERE report_id = $1 GROUP BY publish_state`
        : `SELECT publish_state, COUNT(*) AS count FROM report_photo GROUP BY publish_state`,
      hasReportId ? [reportId] : []
    );
    const counts = {};
    for (const row of result.rows) counts[row.publish_state] = Number(row.count);
    return counts;
  },

  // Важно 3 (раунд правок 1, ревью Task 8): агрегат countByState недостаточен
  // для проверки комплекта ОДНОГО отчёта — количество совпавших строк не
  // гарантирует, что совпали именно ТЕ коды, что сейчас обязательны. Два
  // реальных пробоя, которые ловит именно построчная сверка, а агрегат — нет:
  // (1) фото на непроверенном слоте (slot_verified=false) опубликовалось, не
  //     будучи ни для кого требуемым — раздувает счётчик мимо дела;
  //     (2) состав обязательных кодов у АЗС поменялся посреди смены при том
  //     же их числе — старое опубликованное фото по коду, переставшему быть
  //     нужным, маскирует реально недостающий новый код.
  // photoPublishCompletion.js обязан сверять requiredCodes с КОНКРЕТНЫМИ
  // кодами построчно, для чего и нужен этот метод (countByState остаётся —
  // полезен как есть для глобальной диагностики/сторожа).
  async listPhotoStates({ reportId }) {
    const result = await pool.query(
      `SELECT photo_code, publish_state FROM report_photo WHERE report_id = $1`,
      [reportId]
    );
    return result.rows.map((row) => ({ photoCode: row.photo_code, publishState: row.publish_state }));
  },

  // LEFT JOIN, в отличие от claimBatch, намеренно: сторож обязан увидеть
  // фото, у которого пропали байты (b.report_photo_id IS NULL), а не только
  // те, что просто долго лежат неопубликованными. По той же причине
  // publish_state = 'failed' — тоже исключение из порога возраста:
  // markFailed выставляется только на окончательные ошибки (квота Диска
  // исчерпана, папка удалена, нет прав) — это "без человека дальше не
  // поедет" уже в момент отказа, а не "ещё ретраится", и ждать olderThanMs
  // (типично часы), чтобы сторож наконец заметил заведомо мёртвую строку,
  // незачем — тем более что 'accepted' в этом же запросе всё ещё может быть
  // здоровым ретраем и порог возраста ему нужен по-настоящему.
  async listStuck({ olderThanMs, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - Number(olderThanMs));
    const result = await pool.query(
      `SELECT rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.last_publish_error, rp.uploaded_at
         FROM report_photo rp
         LEFT JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.publish_state <> 'published'
          AND (b.report_photo_id IS NULL OR rp.publish_state = 'failed' OR rp.uploaded_at <= $1)
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
  // См. комментарий у PostgreSQL-версии accept: slotVerified — стык с Task 5,
  // явный параметр запроса (не DEFAULT колонки), потому что ретейк идёт через
  // ON DUPLICATE KEY UPDATE, а не через чистый INSERT.
  async accept({ reportId, photoCode, uploadedBy, exifAt, content, mimeType, originalName, slotVerified = true }) {
    const exifAtSql = exifAt ? toDateSql(exifAt) : null;
    // ON DUPLICATE KEY UPDATE ... id = LAST_INSERT_ID(id) — без этого трюка
    // insertId равен 0 на ветке обновления (существующий report_id+photo_code),
    // а не на ветке вставки, и id из результата было бы неоткуда взять.
    const [result] = await pool.execute(
      `INSERT INTO report_photo (report_id, photo_code, uploaded_by, exif_at, publish_state, slot_verified)
       VALUES (?, ?, ?, ?, 'accepted', ?)
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         uploaded_by = VALUES(uploaded_by),
         exif_at = VALUES(exif_at),
         publish_state = 'accepted',
         publish_attempts = 0,
         next_attempt_at = NULL,
         last_publish_error = NULL,
         published_at = NULL,
         slot_verified = VALUES(slot_verified),
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      // MySQL BOOLEAN — алиас TINYINT(1): бинд как 1/0, а не как JS true/false,
      // тот же приём, что и is_admin в databaseAuthContextStore.js.
      [reportId, photoCode, uploadedBy, exifAtSql, slotVerified ? 1 : 0]
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
    const leaseMinutes = CLAIM_LEASE_MS / 60_000;
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
            SET next_attempt_at = DATE_ADD(?, INTERVAL ${leaseMinutes} MINUTE),
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

  // ИНВАРИАНТ — см. полный комментарий над PostgreSQL-версией markFailed
  // выше (раунд правок 1, Important 4): любое расширение множества причин
  // markFailed обязано сопровождаться синхронным пересмотром missingCodes в
  // reportsRoutes.js (POST /:id/submit).
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

  // См. комментарий над PostgreSQL-версией reclaimStale и над
  // assertSafeReclaimStaleMs выше в файле: НЕ аналог crmSyncWorker.recover(),
  // не вешать на старт процесса без осознанного выбора порога.
  async reclaimStale({ staleMs }) {
    const ms = assertSafeReclaimStaleMs(staleMs);
    const cutoffSql = toDateSql(new Date(Date.now() - ms));
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

  // C4 — см. заголовочный комментарий normalizeRecoverFailedSelector и
  // PostgreSQL-версию recoverFailed выше по файлу: тот же контракт
  // (избирательность обязательна, publish_attempts сбрасывается, uploaded_at
  // и last_publish_error не трогаются, "кто и когда" пишет вызывающий код).
  // MySQL не умеет RETURNING на UPDATE — тот же трёхшаговый приём
  // (кандидаты -> UPDATE по id -> финальный SELECT), что уже есть у
  // MySQL-версии claimBatch выше.
  async recoverFailed({ reportId, ids } = {}) {
    const selector = normalizeRecoverFailedSelector({ reportId, ids });

    const [candidates] = selector.mode === 'report'
      ? await pool.execute(
          `SELECT id FROM report_photo WHERE publish_state = 'failed' AND report_id = ?`,
          [selector.reportId]
        )
      : await pool.execute(
          `SELECT id FROM report_photo WHERE publish_state = 'failed' AND id IN (${selector.ids.map(() => '?').join(', ')})`,
          selector.ids
        );
    if (!candidates.length) return [];

    const candidateIds = candidates.map((row) => row.id);
    const placeholders = candidateIds.map(() => '?').join(', ');
    await pool.execute(
      `UPDATE report_photo
          SET publish_state = 'accepted',
              publish_attempts = 0,
              next_attempt_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
          AND publish_state = 'failed'`,
      candidateIds
    );

    const [rows] = await pool.execute(
      `SELECT id, report_id, photo_code FROM report_photo WHERE id IN (${placeholders})`,
      candidateIds
    );
    return rows;
  },

  // См. комментарий у PostgreSQL-версии countByState выше — тот же контракт:
  // reportId опционален, без него — прежняя глобальная сводка.
  async countByState({ reportId } = {}) {
    const hasReportId = reportId !== undefined && reportId !== null;
    const [rows] = await pool.execute(
      hasReportId
        ? `SELECT publish_state, COUNT(*) AS count FROM report_photo WHERE report_id = ? GROUP BY publish_state`
        : `SELECT publish_state, COUNT(*) AS count FROM report_photo GROUP BY publish_state`,
      hasReportId ? [reportId] : []
    );
    const counts = {};
    for (const row of rows) counts[row.publish_state] = Number(row.count);
    return counts;
  },

  // См. комментарий у PostgreSQL-версии listPhotoStates выше — тот же контракт.
  async listPhotoStates({ reportId }) {
    const [rows] = await pool.execute(
      `SELECT photo_code, publish_state FROM report_photo WHERE report_id = ?`,
      [reportId]
    );
    return rows.map((row) => ({ photoCode: row.photo_code, publishState: row.publish_state }));
  },

  // См. комментарий у PostgreSQL-версии listStuck: 'failed' — тоже
  // исключение из порога возраста, наравне с отсутствующими байтами.
  async listStuck({ olderThanMs, limit = 50 } = {}) {
    const cutoffSql = toDateSql(new Date(Date.now() - Number(olderThanMs)));
    const [rows] = await pool.execute(
      `SELECT rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.last_publish_error, rp.uploaded_at
         FROM report_photo rp
         LEFT JOIN report_photo_blob b ON b.report_photo_id = rp.id
        WHERE rp.publish_state <> 'published'
          AND (b.report_photo_id IS NULL OR rp.publish_state = 'failed' OR rp.uploaded_at <= ?)
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
