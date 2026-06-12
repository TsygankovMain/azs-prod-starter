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
  const stages = reportSettings.stages || {};
  const fields = {};

  const stageId = {
    new: stages.new,
    in_progress: stages.inProgress,
    done: stages.done,
    expired: stages.expired,
    rejected: stages.rejected
  }[status];

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
 */
export const buildReportPhotoFieldValue = async ({ photos = [], diskApi, context = {} }) => {
  if (!diskApi || typeof diskApi.downloadFileContent !== 'function') return [];
  const withDisk = photos.filter((p) => Number(p?.diskObjectId) > 0);
  const pairs = [];
  for (const photo of withDisk) {
    const { base64, name } = await diskApi.downloadFileContent(Number(photo.diskObjectId), context);
    const fileName = String(photo.fileName || name || `photo_${photo.diskObjectId}`);
    pairs.push([fileName, base64]);
  }
  return pairs;
};

export const updateReportCrmItem = async ({
  bitrixClient,
  settings,
  report,
  status,
  photos = [],
  diskFolderId = null,
  requireReportItem = false,
  context = {}
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
        context
      });
      if (pairs.length) {
        fields[photosFieldCode] = pairs;
      }
    }
  }

  if (!Object.keys(fields).length) {
    return null;
  }

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
