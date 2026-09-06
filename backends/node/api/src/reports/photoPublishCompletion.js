// Проверка комплекта отчёта после публикации фото + постановка перевода в
// CRM. Задумана как то, что будущий воркер публикации вызывает СРАЗУ ПОСЛЕ
// photoQueueStore.markPublished() для каждого успешно опубликованного фото
// (сам воркер, который вызывает markPublished в цикле — отдельная будущая
// задача, "до воркеров" в терминах брифа Task 8; здесь — только сама
// проверка, готовая к тому, чтобы воркер её позвал).
//
// НЕ ПУТАТЬ с POST /:id/submit (reportsRoutes.js): submit проставляет
// operator_completed_at и переводит отчёт в 'done' по ЛОКАЛЬНОМУ признаку —
// все обязательные слоты приняты (publish_state IN ('accepted','published')),
// НЕЗАВИСИМО от того, доехали ли байты до Битрикса. Эта функция — про ДРУГОЙ
// факт и ДРУГОЙ момент: отчёт уходит в CRM только тогда, когда ВСЕ
// обязательные фото реально ОПУБЛИКОВАНЫ (publish_state = 'published'), что
// почти всегда происходит позже сдачи смены, а не одновременно с ней. Путать
// эти два момента — ровно то, что сломало Task 5 (см. комментарий над
// POST /:id/submit в reportsRoutes.js).
//
// Постановка задачи — ТОЛЬКО через crmSyncJobStore.enqueue, не напрямую
// вызовом Битрикса: у очереди уже есть повторы (crmSyncWorker) и она
// переживает рестарт процесса.
//
// Идемпотентность через crmSyncJobStore.listByReport: enqueue() сам по себе
// не дедуплицирует (обычный INSERT без ON CONFLICT, см. crmSyncJobStore.js) —
// если для отчёта уже есть хотя бы одна поставленная задача, повторный вызов
// этой проверки (например, если её дёрнут дважды подряд для одного и того же
// уже полного комплекта) не создаёт вторую.
//
// BUG-8709 (сентябрь 2026). Раньше эта проверка была ЕДИНСТВЕННЫМ триггером
// перевода карточки в CRM, и её идемпотентность звучала как «для отчёта уже
// есть задача с непустой папкой — значит уже синкнуто». Оба утверждения по
// отдельности верны, вместе — теряют сдачу смены:
//
//   T+0  воркер публикует последнее обязательное фото -> эта проверка ->
//        задача поставлена. report.status ещё 'in_progress' (оператор жмёт
//        «сдать» на секунду-две позже), buildCrmSyncRunner читает статус в
//        момент выполнения и пишет стадию «в работе» — корректно на тот миг;
//   T+2  POST /:id/submit ставит dispatch_log.status='done' и НИЧЕГО не
//        ставит в очередь (так задумано Task 8);
//   ...  публиковать больше нечего -> этой проверки больше никто не позовёт,
//        а если бы и позвал — «задача с папкой уже есть» вернуло бы
//        already_queued.
//
// Итог: карточка навсегда остаётся в DT1116_44:PREPARATION при сданном
// отчёте. На проде так залипло 212 из 276 сентябрьских сдач и 960 из 1301
// августовских (1326 из 1464 задач поставлены РАНЬШЕ момента сдачи).
//
// Чинится двумя половинами, обе обязательны:
//   1) /:id/submit теперь тоже зовёт эту проверку (второй триггер — «статус
//      отчёта изменился», в дополнение к «фото доехали»);
//   2) идемпотентность здесь считается ПО СТАТУСУ, ради которого задача
//      ставилась (payload.triggerStatus): задача, поставленная под
//      'in_progress', больше не считается закрывающей потребность в задаче
//      под 'done'.
//
// payload.status здесь по-прежнему НЕ проставляется намеренно:
// buildCrmSyncRunner читает dispatch_log.status заново в момент выполнения,
// и это точнее, чем заморозка. triggerStatus — служебное поле ТОЛЬКО для
// дедупликации, стадию по нему никто не пишет.
export const syncReportToCrmIfComplete = async ({
  reportId,
  reportsStore,
  photoQueueStore,
  crmSyncJobStore,
  context = {},
  logger = console
}) => {
  if (!reportId) {
    throw new Error('reportId is required');
  }
  if (!reportsStore || typeof reportsStore.getRequiredPhotoCodes !== 'function' || typeof reportsStore.listPhotos !== 'function') {
    throw new Error('reportsStore with getRequiredPhotoCodes()/listPhotos() is required');
  }
  if (!photoQueueStore || typeof photoQueueStore.listPhotoStates !== 'function') {
    throw new Error('photoQueueStore with listPhotoStates() is required');
  }
  if (!crmSyncJobStore || typeof crmSyncJobStore.enqueue !== 'function' || typeof crmSyncJobStore.listByReport !== 'function') {
    throw new Error('crmSyncJobStore with enqueue()/listByReport() is required');
  }

  // Список обязательных кодов — ЛОКАЛЬНО (report_local_state), тот же
  // источник, которым уже пользуется приём фото (см. reportsRoutes.js,
  // resolveRequiredPhotoSlotLocally). Без списка не с чем сравнивать: считать
  // комплект «полным» при неизвестном списке значило бы 0 >= 0 — то есть
  // ложный успех при каждом непрогретом (или ещё не открытом карточкой)
  // отчёте.
  const requiredCodes = await reportsStore.getRequiredPhotoCodes(reportId);
  if (!Array.isArray(requiredCodes) || requiredCodes.length === 0) {
    // I4 (финальное ревью ветки) — "неизвестен список" САМ ПО СЕБЕ норма:
    // отчёт может быть ещё не весь принят (карточку не открывали, кэш пуст).
    // Опасен ДРУГОЙ, более узкий случай: ВСЕ уже принятые фото этого отчёта
    // уже 'published' — очередь публикации считает свою работу полностью
    // сделанной, а без списка мы никогда не узнаем, был ли принятый комплект
    // действительно полным. Эта функция вызывается ТОЛЬКО из завершения
    // публикации (finishPublished, photoPublishWorker.js) — если публиковать
    // больше нечего, для этого отчёта БОЛЬШЕ НЕ БУДЕТ события, которое
    // повторило бы проверку (достижимо, когда падает backfill в
    // reportsRoutes.js: resolveRequiredPhotoSlotLocally оборачивает запись
    // required_photo_codes в .catch(() => {}) — намеренно, чтобы не блокировать
    // приём, но следом ничто не замечает и не повторяет саму запись).
    // Тихий return ниже в ЭТОМ случае и есть тот отказ, который весь план
    // запрещает: фото уже в Битриксе, карточка CRM не обновлена, и никто не
    // узнает — поэтому громкий, отдельный лог именно здесь, а не молчание.
    const states = await photoQueueStore.listPhotoStates({ reportId });
    const allPublished = states.length > 0 && states.every((row) => row.publishState === 'published');
    if (allPublished) {
      console.error(JSON.stringify({
        event: 'photo_report_crm_sync_orphaned',
        reportId,
        publishedCount: states.length,
        reason: 'all accepted photos are published, but required_photo_codes is unknown — ' +
          'this report will NOT retry sync on its own (no more photos will publish to re-trigger this check)'
      }));
    }
    return { synced: false, reason: 'required_codes_unknown' };
  }

  // Important 3 (раунд правок 1, ревью): сверка КОНКРЕТНЫХ кодов, а не
  // агрегата. count(published) >= requiredCodes.length — недостаточное
  // условие, ловит совпадение по числу, но не по составу. Два реальных
  // пробоя, которые агрегат пропускал бы молча: (1) фото на непроверенном
  // слоте опубликовалось, не будучи ни для кого требуемым, и раздувало счёт;
  // (2) состав requiredCodes поменялся посреди смены при том же их числе —
  // старое опубликованное фото по коду, переставшему быть нужным,
  // маскировало реально недостающий новый код. Построчный список
  // (listPhotoStates) и сверка по Set — то же самое усиление, что submit уже
  // делает через сравнение множеств кодов (missingCodes), только на стороне
  // публикации.
  const states = await photoQueueStore.listPhotoStates({ reportId });
  const publishedCodes = new Set(
    states.filter((row) => row.publishState === 'published').map((row) => row.photoCode)
  );
  const missingRequiredCodes = requiredCodes.filter((code) => !publishedCodes.has(code));
  if (missingRequiredCodes.length > 0) {
    return {
      synced: false,
      reason: 'incomplete',
      missingCodes: missingRequiredCodes,
      requiredCount: requiredCodes.length
    };
  }

  // Important 2 (раунд правок 1, ревью): «есть хоть какая-то задача — значит
  // уже синкнуто» недостаточно. /:id/resync (reportsRoutes.js) ставит задачу
  // БЕЗУСЛОВНО, в том числе ДО завершения публикации — с пустым
  // diskFolderId в payload. Если считать такую задачу блокирующей, карточка
  // в CRM навсегда останется без ссылки на папку Диска: та единственная
  // задача никогда её не запишет (см. buildCrmSyncRunner — если и по
  // выполнении фото ещё не были готовы), а эта проверка больше никогда не
  // попытается снова. Блокирующей считаем только задачу, которая реально
  // несёт непустой diskFolderId — она либо уже записала ссылку, либо вот-вот
  // запишет свежую (buildCrmSyncRunner теперь тоже пересчитывает его из
  // свежих photos на момент выполнения, а не берёт замороженный payload).
  // BUG-8709: дедупликация — по СТАТУСУ, ради которого задача ставилась, а не
  // по факту «задача с папкой есть». Статус берётся свежим прямо здесь: эту
  // функцию зовут из двух мест (завершение публикации и /:id/submit), и в
  // каждом он свой.
  const report = typeof reportsStore.getById === 'function'
    ? await reportsStore.getById(reportId)
    : null;
  const triggerStatus = String(report?.status ?? '').trim() || null;

  const existingJobs = await crmSyncJobStore.listByReport(reportId);
  const hasJobForStatus = existingJobs.some((job) => {
    try {
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});
      // Задача без настоящей папки не закрывает потребность ни при каком
      // статусе (Important 2, ревью Task 8 — ручной /resync до публикации).
      if (!payload?.diskFolderId) return false;
      // Статус отчёта неизвестен (стор без getById — только в тестах/заглушках):
      // ведём себя как раньше, любая задача с папкой блокирует. Хуже, чем
      // сверка по статусу, но не хуже прежнего поведения.
      if (!triggerStatus) return true;
      const jobStatus = String(payload.triggerStatus ?? payload.status ?? '').trim();
      // Задачи, поставленные до этой правки, triggerStatus не несут. Считать их
      // закрывающими нельзя — именно они и залипли в «в работе»: пусть новый
      // статус породит новую задачу.
      if (!jobStatus) return false;
      return jobStatus === triggerStatus;
    } catch {
      return false;
    }
  });
  if (hasJobForStatus) {
    return { synced: false, reason: 'already_queued' };
  }

  // disk_folder_id — та же деривация из report_photo, что и в POST
  // /:id/resync (BUG-P3: локальной таблицы отчётов с этим полем не
  // существует). status в payload намеренно не проставлен: buildCrmSyncRunner
  // (reportsRoutes.js) фоллбечит на payload.status || report.status и читает
  // report.status заново в момент реального выполнения задачи — это точнее,
  // чем замораживать статус на момент постановки в очередь.
  const photos = await reportsStore.listPhotos(reportId);
  const diskFolderId = photos.map((photo) => photo.diskFolderId).find(Boolean) ?? null;

  await crmSyncJobStore.enqueue({
    reportId,
    payload: {
      triggerStatus,
      diskFolderId,
      contextKey: context?.key || '',
      domain: context?.domain || '',
      memberId: context?.memberId || ''
    }
  });

  // Постановка задачи на перевод стадии — событие, которое обязано быть видно
  // в логах: именно её отсутствие полгода никто не замечал (BUG-8709).
  if (typeof logger?.log === 'function') {
    logger.log(JSON.stringify({
      event: 'report_crm_stage_sync_queued',
      reportId,
      triggerStatus,
      diskFolderId,
      requiredCount: requiredCodes.length
    }));
  }

  return { synced: true, triggerStatus };
};

export default syncReportToCrmIfComplete;
