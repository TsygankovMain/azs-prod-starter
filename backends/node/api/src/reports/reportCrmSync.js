/**
 * Единственное место, где локальный статус отчёта (dispatch_log.status)
 * превращается в идентификатор стадии смарт-процесса. Вынесено из
 * buildReportCrmUpdateFields, потому что тем же соответствием обязана
 * пользоваться ПРОВЕРКА записи (verifyCrmStageSync в reportsRoutes.js):
 * иначе «какую стадию ждали» и «какую записали» считались бы по двум разным
 * копиям одной таблицы и разъехались бы при первой же правке.
 *
 * Возвращает null, если для статуса стадия не настроена ('cancelled',
 * 'failed' — у них стадии нет по замыслу) или маппинг вообще пуст.
 */
export const resolveReportStageId = ({ settings, status }) => {
  const stages = settings?.report?.stages || {};
  const stageId = {
    new: stages.new,
    in_progress: stages.inProgress,
    done: stages.done,
    expired: stages.expired,
    rejected: stages.rejected
  }[status];
  const normalized = String(stageId ?? '').trim();
  return normalized || null;
};

export const buildReportCrmUpdateFields = ({
  settings,
  status,
  // photos param kept in signature for caller compatibility but no longer used here.
  // Photos are populated async-only via buildReportPhotoFieldValue on done syncs.
  photos = [],
  diskFolderId = null,
  reasonValue = null // NEW: already-encoded reason string from reasonCatalog.encodeValue()
}) => {
  const reportSettings = settings?.report || {};
  const fieldsMap = reportSettings.fields || {};
  const fields = {};

  const stageId = resolveReportStageId({ settings, status });

  if (stageId) {
    fields.stageId = stageId;
  }

  if (fieldsMap.folderId && diskFolderId) {
    fields[fieldsMap.folderId] = String(diskFolderId);
  }

  // NEW: reason UF field — written only when reasonValue is provided and field is configured
  if (fieldsMap.reason && reasonValue !== undefined && reasonValue !== null) {
    fields[fieldsMap.reason] = String(reasonValue);
  }

  // NOTE: photos field intentionally NOT set here.
  // Bare b_file integer IDs are invalid for Bitrix file-type user fields.
  // Photos are written as [name, base64] pairs only on status=done via buildReportPhotoFieldValue.

  return fields;
};

/**
 * Downloads disk file content for each photo that has a diskObjectId and
 * returns an array of [fileName, base64] pairs suitable for a Bitrix
 * `file`-type user field written via crm.item.update.
 *
 * Photos without a diskObjectId are silently skipped.
 *
 * I1 (финальное ревью ветки) — limiter — тот же приём, что и publishOne в
 * photoPublisher.js: КАЖДЫЙ реальный поход к Битриксу берёт токен сам,
 * непосредственно перед вызовом, а не полагается на то, что его вызвал уже
 * "оплаченный" код снаружи. На отчёте из 40 фото это до 40 обращений
 * disk.file.get подряд (по одному на каждое downloadFileContent) — без
 * лимитера цикл идёт со скоростью сети, а не со скоростью, которую портал
 * согласился терпеть. Опционален и по умолчанию отсутствует (не ломает
 * существующих вызывающих без лимитера, например timeoutWatcher.js — см.
 * комментарий над updateReportCrmItem ниже, почему это осознанная граница,
 * а не дыра).
 */
export const buildReportPhotoFieldValue = async ({ photos = [], diskApi, context = {}, limiter = null }) => {
  if (!diskApi || typeof diskApi.downloadFileContent !== 'function') return [];
  const withDisk = photos.filter((p) => Number(p?.diskObjectId) > 0);
  const pairs = [];
  for (const photo of withDisk) {
    if (limiter) await limiter.acquire();
    const { base64, name } = await diskApi.downloadFileContent(Number(photo.diskObjectId), context);
    const fileName = String(photo.fileName || name || `photo_${photo.diskObjectId}`);
    pairs.push([fileName, base64]);
  }
  return pairs;
};

// I1 (финальное ревью ветки, "CRM-синк идёт мимо ограничителя, и это создала
// именно эта ветка") — limiter здесь и в buildReportPhotoFieldValue выше —
// НОВЫЙ, опциональный параметр. До этой правки ни один реальный вызов
// Битрикса на этом пути (downloadFileContent на каждое фото, финальный
// updateReportItem, verifyCrmFolderSync.getCrmItem в reportsRoutes.js) не
// проходил через photoRateLimiter вообще — crmSyncWorker.drain() (см. её
// заголовок, а также rateLimiter.js:5-7 — приём, который явно назван
// "нельзя копировать") крутит tick() без пауз, и единственной защитой
// оставался темп самой сети. На отчёте из 40 фото это ~83 обращения к
// порталу за один тик; слив бэклога всего парка после инцидента —
// ~5900 таких запросов ОДНОВРЕМЕННО с нашим аккуратным потоком 1.4/с —
// то есть повторение того же перегруза, ради лечения которого вся эта
// ветка написана, только с другой стороны.
//
// Опционален (default null, `if (limiter) await limiter.acquire()`), а НЕ
// обязателен — намеренно: src/dispatch/timeoutWatcher.js тоже зовёт эту
// функцию (отдельный, гораздо более редкий путь — плановая проверка
// просроченных отчётов, не бэклог парка, ветка status==='done' с фото у
// него никогда не исполняется — photos туда не передаются), и требовать
// limiter у ВСЕХ вызывающих значило бы либо ломать этот вызов, либо тащить
// photoRateLimiter в server.js в код, который сегодня о нём не знает и не
// должен. buildCrmSyncRunner (reportsRoutes.js) — ЕДИНСТВЕННЫЙ вызывающий,
// который реально передаёт limiter (проводка — server.js, тот же общий
// photoRateLimiter, что и у photoPublisher/photoPublishWorker). Это
// осознанная, узкая граница, а не тихо забытый путь — см. также I2/I3 в
// отчёте задачи.
export const updateReportCrmItem = async ({
  bitrixClient,
  settings,
  report,
  status,
  photos = [],
  diskFolderId = null,
  requireReportItem = false,
  context = {},
  logger = console,
  limiter = null
}) => {
  const entityTypeId = Number(settings?.report?.entityTypeId || 0);
  const reportItemId = Number(report?.reportItemId || 0);

  if (!entityTypeId || typeof bitrixClient?.updateReportItem !== 'function') {
    return null;
  }
  if (!reportItemId) {
    if (requireReportItem) {
      const error = new Error('reportItemId is missing or invalid; cannot sync report to Bitrix24 CRM');
      error.code = 'report_item_id_invalid';
      error.statusCode = 422;
      throw error;
    }
    return null;
  }

  const fields = buildReportCrmUpdateFields({
    settings,
    status,
    photos,
    diskFolderId
  });

  // On done syncs: attach photos as [name, base64] pairs (correct Bitrix file field format).
  // On in_progress syncs: do NOT touch the photos field — reviewers see photos via Disk folder.
  if (status === 'done') {
    const photosFieldCode = String(settings?.report?.fields?.photos || '');
    if (photosFieldCode && bitrixClient.diskApi && photos.length > 0) {
      const pairs = await buildReportPhotoFieldValue({
        photos,
        diskApi: bitrixClient.diskApi,
        context,
        limiter
      });
      if (pairs.length < photos.length) {
        logger.warn('crm_photos_dropped', {
          event: 'crm_photos_dropped',
          reportId: report?.id,
          reportItemId,
          expected: photos.length,
          attached: pairs.length
        });
        if (pairs.length === 0) {
          logger.error('crm_photos_all_dropped', {
            event: 'crm_photos_all_dropped',
            reportId: report?.id,
            reportItemId,
            expected: photos.length
          });
        }
      }
      if (pairs.length) {
        fields[photosFieldCode] = pairs;
      }
    }
  }

  if (!Object.keys(fields).length) {
    return null;
  }

  if (limiter) await limiter.acquire();
  return bitrixClient.updateReportItem({
    entityTypeId,
    id: reportItemId,
    fields,
    context
  });
};

/**
 * Записать причину в UF-поле карточки отчёта под контекстом оператора.
 * reasonValue — уже закодированная строка (из reasonCatalog.encodeValue()).
 * Код поля берётся из settings.report.fields.reason (никакого хардкода).
 */
export const updateReasonCrmField = async ({
  bitrixClient,
  settings,
  reportItemId,
  reasonValue,
  context = {}
}) => {
  const entityTypeId = Number(settings?.report?.entityTypeId || 0);
  const reasonFieldCode = String(settings?.report?.fields?.reason || '').trim();

  if (!reasonFieldCode) {
    console.warn('reason_uf_not_configured', {
      message: 'report.fields.reason не задан — причина не записывается в CRM (нет durability)'
    });
    return null;
  }

  if (!entityTypeId || !Number(reportItemId) || typeof bitrixClient?.updateReportItem !== 'function') {
    return null;
  }

  return bitrixClient.updateReportItem({
    entityTypeId,
    id: Number(reportItemId),
    fields: { [reasonFieldCode]: String(reasonValue) },
    context
  });
};
