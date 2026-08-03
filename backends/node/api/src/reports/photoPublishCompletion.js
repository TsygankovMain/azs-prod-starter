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
export const syncReportToCrmIfComplete = async ({
  reportId,
  reportsStore,
  photoQueueStore,
  crmSyncJobStore,
  context = {}
}) => {
  if (!reportId) {
    throw new Error('reportId is required');
  }
  if (!reportsStore || typeof reportsStore.getRequiredPhotoCodes !== 'function' || typeof reportsStore.listPhotos !== 'function') {
    throw new Error('reportsStore with getRequiredPhotoCodes()/listPhotos() is required');
  }
  if (!photoQueueStore || typeof photoQueueStore.countByState !== 'function') {
    throw new Error('photoQueueStore with countByState() is required');
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
    return { synced: false, reason: 'required_codes_unknown' };
  }

  const counts = await photoQueueStore.countByState({ reportId });
  const publishedCount = Number(counts?.published || 0);
  if (publishedCount < requiredCodes.length) {
    return {
      synced: false,
      reason: 'incomplete',
      publishedCount,
      requiredCount: requiredCodes.length
    };
  }

  const existingJobs = await crmSyncJobStore.listByReport(reportId);
  if (existingJobs.length > 0) {
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
      diskFolderId,
      contextKey: context?.key || '',
      domain: context?.domain || '',
      memberId: context?.memberId || ''
    }
  });

  return { synced: true };
};

export default syncReportToCrmIfComplete;
