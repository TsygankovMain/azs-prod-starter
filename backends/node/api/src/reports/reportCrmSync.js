export const buildReportCrmUpdateFields = ({
  settings,
  status,
  photos = [],
  diskFolderId = null
}) => {
  const reportSettings = settings?.report || {};
  const fieldsMap = reportSettings.fields || {};
  const stages = reportSettings.stages || {};
  const fields = {};

  const stageId = {
    new: stages.new,
    in_progress: stages.inProgress,
    done: stages.done,
    expired: stages.expired
  }[status];

  if (stageId) {
    fields.stageId = stageId;
  }

  if (fieldsMap.folderId && diskFolderId) {
    fields[fieldsMap.folderId] = String(diskFolderId);
  }

  if (fieldsMap.photos) {
    const fileIds = [...new Set(
      photos
        .map((photo) => Number(photo.fileId))
        .filter((fileId) => Number.isFinite(fileId) && fileId > 0)
    )];

    if (fileIds.length) {
      fields[fieldsMap.photos] = fileIds;
    }
  }

  return fields;
};

export const updateReportCrmItem = async ({
  bitrixClient,
  settings,
  report,
  status,
  photos = [],
  diskFolderId = null,
  requireReportItem = false
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

  if (!Object.keys(fields).length) {
    return null;
  }

  return bitrixClient.updateReportItem({
    entityTypeId,
    id: reportItemId,
    fields
  });
};
