import express from 'express';
import multer from 'multer';
import exifr from 'exifr';
import { ensureRootFolder, isSupportedPhotoUpload, uploadPhoto } from '../disk/diskService.js';
import { updateReportCrmItem } from './reportCrmSync.js';
import { generateDailyPlan } from '../dispatch/dispatchPlanGenerator.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXIF_MAX_AGE_MINUTES = Number(process.env.EXIF_MAX_AGE_MINUTES || 720);
const RETRYABLE_UPLOAD_ERROR_PATTERN = /(OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|HTTP 429|HTTP 504|too many requests|gateway timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network error|timeout)/i;

class ReportConfigError extends Error {
  constructor(message, code = 'report_config_error') {
    super(message);
    this.name = 'ReportConfigError';
    this.code = code;
    this.statusCode = 422;
  }
}

class ReportSyncError extends Error {
  constructor(message, code = 'report_sync_failed') {
    super(message);
    this.name = 'ReportSyncError';
    this.code = code;
    this.statusCode = 502;
  }
}

class ManualReportValidationError extends Error {
  constructor(details) {
    super('Заполните обязательные поля');
    this.name = 'ManualReportValidationError';
    this.code = 'manual_report_validation_failed';
    this.statusCode = 400;
    this.details = details;
  }
}

const normalizeDateFilter = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
};

const normalizeLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 200;
  }
  return Math.min(Math.floor(parsed), 500);
};

const normalizeAzsIds = (value) => {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n;]+/g);

  return [...new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  )];
};

const normalizePhotoCode = (value) => String(value || '').trim().toLowerCase();

const normalizeSlotHHmm = (value) => {
  const raw = String(value || '').replace(/[^0-9]/g, '').slice(0, 4);
  if (raw.length !== 4) {
    return '';
  }
  const hours = Number(raw.slice(0, 2));
  const minutes = Number(raw.slice(2, 4));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return '';
  }
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
};

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }

  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const createAzsTitleResolver = ({ bitrixClient, settings, context = {} }) => {
  const entityTypeId = Number(settings?.azs?.entityTypeId || 0);
  const cache = new Map();

  const resolveOne = async (azsId) => {
    const key = String(azsId ?? '').trim();
    const parsedId = parseCrmItemId(key);
    const fallback = `АЗС ${parsedId || key || '?'}`.trim();
    if (!parsedId || !entityTypeId) {
      return fallback;
    }

    if (cache.has(parsedId)) {
      return cache.get(parsedId);
    }

    const promise = (async () => {
      try {
        if (typeof bitrixClient?.getCrmItem === 'function') {
          const item = await bitrixClient.getCrmItem({
            entityTypeId,
            id: parsedId,
            context
          });
          const title = String(item?.title ?? item?.TITLE ?? '').trim();
          return title || fallback;
        }

        if (typeof bitrixClient?.listCrmItems === 'function') {
          const rows = await bitrixClient.listCrmItems({
            entityTypeId,
            select: ['id', 'ID', 'title', 'TITLE'],
            filter: { id: parsedId },
            limit: 1,
            useOriginalUfNames: 'N',
            context
          });
          const row = Array.isArray(rows) ? rows[0] : null;
          const title = String(row?.title ?? row?.TITLE ?? '').trim();
          return title || fallback;
        }
      } catch {
        // ignore and fallback
      }
      return fallback;
    })();

    cache.set(parsedId, promise);
    return promise;
  };

  return resolveOne;
};

const extractMultipleIds = (value) => {
  if (Array.isArray(value)) {
    return value.flatMap(extractMultipleIds);
  }

  if (value && typeof value === 'object') {
    const item = value;
    return extractMultipleIds(item.id ?? item.ID ?? item.value ?? item.VALUE);
  }

  const id = parseCrmItemId(value);
  return id ? [id] : [];
};

const getFieldValue = (item, fieldCode) => {
  if (!item || !fieldCode) {
    return undefined;
  }
  // Bitrix returns UF fields camelCased (ufCrm2_123) when useOriginalUfNames:N,
  // while settings store the original code (UF_CRM_2_123). Match across both
  // forms — otherwise admin/azs UF lookups silently miss and resolve to empty.
  // Mirrors dispatchScheduler.getFieldValue so manual and auto paths agree.
  const code = String(fieldCode).trim();
  const aliases = [code, code.toLowerCase(), code.toUpperCase()];
  const underscoreMatch = code.match(/^UF_CRM_(\d+)_(\d+)$/i);
  if (underscoreMatch) {
    aliases.push(`ufCrm${underscoreMatch[1]}_${underscoreMatch[2]}`);
  }
  const camelMatch = code.match(/^ufCrm(\d+)_(\d+)$/i);
  if (camelMatch) {
    aliases.push(`UF_CRM_${camelMatch[1]}_${camelMatch[2]}`);
  }
  for (const alias of aliases) {
    if (alias && alias in item && item[alias] !== undefined && item[alias] !== null) {
      return item[alias];
    }
  }
  return undefined;
};

const extractFirstUserId = (value) => {
  const ids = extractMultipleIds(value);
  return ids.length ? Number(ids[0]) : 0;
};

const normalizeAzsOption = ({ row, adminField }) => {
  const id = parseCrmItemId(row?.id ?? row?.ID);
  if (!id) {
    return null;
  }
  const title = String(row?.title ?? row?.TITLE ?? `АЗС ${id}`).trim();
  return {
    id: String(id),
    title,
    adminUserId: adminField ? extractFirstUserId(getFieldValue(row, adminField)) : 0
  };
};

const makeManualValidationError = (details) => new ManualReportValidationError([...new Set(
  details.map((item) => String(item || '').trim()).filter(Boolean)
)]);

export const resolveManualCandidates = async ({
  payload,
  settings,
  bitrixClient,
  context = {},
  fallbackUserId = 0
}) => {
  const normalizedFallbackUserId = Number(fallbackUserId) > 0 ? Math.floor(Number(fallbackUserId)) : 0;
  const details = [];
  const rawCandidates = Array.isArray(payload?.candidates)
    ? payload.candidates
    : (payload?.candidate ? [payload.candidate] : []);
  const azsIdsFromPayload = normalizeAzsIds(payload?.azsIds);
  const candidateSources = rawCandidates.length > 0
    ? rawCandidates
    : azsIdsFromPayload.map((azsId) => ({ azsId }));
  const firstCandidate = candidateSources[0] || {};
  const slotDate = String(payload?.slotDate || firstCandidate.slotDate || '').trim();
  const slotHHmm = normalizeSlotHHmm(payload?.slotHHmm || payload?.slotTime || firstCandidate.slotHHmm || firstCandidate.slotTime);

  if (!candidateSources.length) {
    details.push('Выберите хотя бы одну АЗС');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
    details.push('Укажите дату запуска');
  }
  if (!slotHHmm) {
    details.push('Укажите время запуска');
  }
  if (!Number(settings?.report?.entityTypeId || 0)) {
    details.push('В настройках не выбран смарт-процесс отчётов');
  }
  if (!Number(settings?.azs?.entityTypeId || 0)) {
    details.push('В настройках не выбран смарт-процесс АЗС');
  }

  if (details.length) {
    throw makeManualValidationError(details);
  }

  const adminField = String(settings?.azs?.fields?.admin || '').trim();
  const candidates = [];
  const failedItems = [];

  for (const source of candidateSources) {
    const azsId = String(source?.azsId ?? source?.id ?? '').trim();
    const azsItemId = parseCrmItemId(azsId);
    if (!azsItemId) {
      failedItems.push({
        ok: false,
        azsId,
        error: 'Некорректный ID АЗС'
      });
      continue;
    }

    let adminUserId = Number(source?.adminUserId || 0);
    if (!Number.isFinite(adminUserId) || adminUserId <= 0) {
      if (!adminField) {
        failedItems.push({
          ok: false,
          azsId: String(azsItemId),
          error: 'В настройках не сопоставлено поле "Администратор АЗС"'
        });
        continue;
      }

      const azsItem = await bitrixClient.getCrmItem({
        entityTypeId: Number(settings.azs.entityTypeId),
        id: azsItemId,
        context
      });
      adminUserId = extractFirstUserId(getFieldValue(azsItem, adminField));
    }

    if (!Number.isFinite(adminUserId) || adminUserId <= 0) {
      // No admin on the AZS card → fall back to the requesting reviewer so the
      // report still gets created and someone is accountable, instead of failing.
      if (normalizedFallbackUserId > 0) {
        adminUserId = normalizedFallbackUserId;
      } else {
        failedItems.push({
          ok: false,
          azsId: String(azsItemId),
          error: 'В карточке АЗС не указан администратор'
        });
        continue;
      }
    }

    candidates.push({
      azsId: String(azsItemId),
      adminUserId: Math.floor(adminUserId),
      slotDate,
      slotHHmm
    });
  }

  if (!candidates.length && failedItems.length) {
    throw makeManualValidationError(failedItems.map((item) => `${item.azsId || 'АЗС'}: ${item.error}`));
  }

  return {
    candidates,
    failedItems
  };
};

export const readRequiredPhotos = async ({ bitrixClient, settings, azsId, context = {} }) => {
  const azsEntityTypeId = Number(settings.azs?.entityTypeId || 0);
  const photoSetField = String(settings.azs?.fields?.photoSet || '').trim();
  const photoTypeEntityTypeId = Number(settings.photoType?.entityTypeId || 0);
  const azsItemId = parseCrmItemId(azsId);

  if (!azsEntityTypeId || !photoSetField || !photoTypeEntityTypeId) {
    throw new ReportConfigError(
      'Required photos mapping is not configured: set AZS entity/photoSet and PhotoType entity in settings',
      'required_photos_mapping_not_configured'
    );
  }
  if (!azsItemId) {
    throw new ReportConfigError(
      `Report AZS id "${String(azsId || '')}" is not a valid smart-process item id`,
      'invalid_report_azs_id'
    );
  }
  if (typeof bitrixClient.getCrmItem !== 'function') {
    throw new ReportConfigError(
      'Bitrix client does not support crm.item.get',
      'bitrix_client_not_supported'
    );
  }

  const azsItem = await bitrixClient.getCrmItem({
    entityTypeId: azsEntityTypeId,
    id: azsItemId,
    context
  });
  if (!azsItem) {
    throw new ReportConfigError(
      `AZS item ${azsItemId} was not found in entityTypeId=${azsEntityTypeId}`,
      'azs_item_not_found'
    );
  }

  const photoTypeIds = [...new Set(extractMultipleIds(getFieldValue(azsItem, photoSetField)))];
  if (!photoTypeIds.length) {
    throw new ReportConfigError(
      `AZS item ${azsItemId} has empty required photo set field "${photoSetField}"`,
      'azs_photo_set_empty'
    );
  }

  const items = await Promise.all(photoTypeIds.map((id) => bitrixClient.getCrmItem({
    entityTypeId: photoTypeEntityTypeId,
    id,
    context
  })));

  const requiredPhotos = items
    .filter(Boolean)
    .map((item) => {
      const id = Number(item.id ?? item.ID ?? 0);
      const code = id ? String(id) : '';
      const standardTitle = String(item.title ?? item.TITLE ?? '').trim();
      const title = standardTitle || `Фото #${id}`;
      return { code, title, sort: id };
    })
    .filter((item) => item.code)
    .sort((a, b) => a.sort - b.sort)
    .map(({ code, title, sort }) => ({ code, title, sort }));

  if (!requiredPhotos.length) {
    throw new ReportConfigError(
      'Failed to load photo type records',
      'photo_types_not_found'
    );
  }

  return requiredPhotos;
};

const extractUserId = (user) => {
  const id = Number(user?.user_id ?? user?.id ?? user?.uid ?? 0);
  return Number.isFinite(id) ? id : 0;
};

const validateExifDate = (exifDate) => {
  if (!exifDate) {
    return { ok: true, exifAt: null };
  }

  const capturedAt = new Date(exifDate);
  if (Number.isNaN(capturedAt.getTime())) {
    return { ok: true, exifAt: null };
  }

  const ageMinutes = (Date.now() - capturedAt.getTime()) / (60 * 1000);
  if (ageMinutes > EXIF_MAX_AGE_MINUTES) {
    return {
      ok: false,
      message: `Photo EXIF is too old: ${Math.floor(ageMinutes)} minutes`
    };
  }

  return {
    ok: true,
    exifAt: capturedAt
  };
};

const ensureFolderFieldMapping = (settings) => {
  const folderFieldCode = String(settings?.report?.fields?.folderId || '').trim();
  if (!folderFieldCode) {
    throw new ReportConfigError(
      'Field mapping report.fields.folderId is required to sync Disk folder id into report smart process item',
      'report_folder_mapping_not_configured'
    );
  }
  return folderFieldCode;
};

const ensureCurrentUserOwnsReport = ({ req, report }) => {
  const currentUserId = extractUserId(req.user);
  if (!currentUserId || currentUserId !== Number(report.adminUserId)) {
    const error = new Error('Current user is not report administrator');
    error.code = 'forbidden_user';
    error.statusCode = 403;
    error.currentUserId = currentUserId;
    error.expectedAdminUserId = Number(report.adminUserId);
    throw error;
  }
  return currentUserId;
};

const canUseReviewerTools = (req) => (
  Boolean(req.accessContext?.capabilities?.reviewer)
  || Boolean(req.accessContext?.capabilities?.settings)
);

const canUseAdminReportTools = (req) => (
  Boolean(req.accessContext?.capabilities?.reports)
  || Boolean(req.accessContext?.capabilities?.settings)
);

export const parseReportSlotKey = (slotKey) => {
  const parts = String(slotKey || '').split(':').map((part) => String(part || '').trim());
  const isManual = String(parts[0] || '').toLowerCase() === 'manual';
  const slotDate = isManual ? String(parts[1] || '').trim() : String(parts[0] || '').trim();
  const rawSlotHHmm = isManual ? String(parts[2] || '').trim() : String(parts[1] || '').trim();
  const slotHHmm = rawSlotHHmm.replace(/[^0-9]/g, '').slice(0, 4);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !normalizeSlotHHmm(slotHHmm)) {
    throw new ReportConfigError(
      `Report slotKey "${String(slotKey || '')}" is invalid; expected YYYY-MM-DD:HHmm or manual:YYYY-MM-DD:HHmm`,
      'report_slot_key_invalid'
    );
  }

  return {
    slotDate,
    slotHHmm
  };
};

export const resolveAdminCrmSyncContext = async ({ authContextStore, requestContext }) => {
  if (!authContextStore || typeof authContextStore.getLastAdminContext !== 'function') {
    return null;
  }
  const current = requestContext && typeof requestContext === 'object' ? requestContext : {};
  const adminEntry = await authContextStore.getLastAdminContext();
  const adminContext = adminEntry?.context || null;

  if (!adminContext?.authId) {
    return null;
  }

  // Safety: don't accidentally sync to a different portal if this backend
  // ever hosts multiple memberId/domain records.
  const currentDomain = String(current.domain || '').trim().toLowerCase();
  const currentMemberId = String(current.memberId || '').trim();
  const adminDomain = String(adminContext.domain || '').trim().toLowerCase();
  const adminMemberId = String(adminContext.memberId || '').trim();

  if (!currentDomain || !currentMemberId || !adminDomain || !adminMemberId) {
    return null;
  }
  if (currentDomain !== adminDomain) {
    return null;
  }
  if (currentMemberId !== adminMemberId) {
    return null;
  }

  return {
    key: String(adminEntry?.key || '').trim(),
    ...adminContext
  };
};


const isRetryableUploadError = (error) => RETRYABLE_UPLOAD_ERROR_PATTERN.test(String(error?.message || error || ''));


const verifyCrmFolderSync = async ({
  bitrixClient,
  settings,
  report,
  folderFieldCode,
  expectedFolderId,
  context = {}
}) => {
  const syncedCrmItem = await bitrixClient.getCrmItem({
    entityTypeId: Number(settings.report?.entityTypeId || 0),
    id: Number(report.reportItemId || 0),
    context
  });
  const syncedFolderId = String(getFieldValue(syncedCrmItem, folderFieldCode) ?? '').trim();
  if (syncedFolderId !== String(expectedFolderId)) {
    throw new ReportSyncError(
      `Report CRM folder field "${folderFieldCode}" was not synced. Expected "${String(expectedFolderId)}", got "${syncedFolderId || '<empty>'}"`,
      'report_folder_sync_failed'
    );
  }
};

const syncReportCrmStrict = async ({
  bitrixClient,
  settings,
  report,
  status,
  photos,
  diskFolderId,
  folderFieldCode,
  context = {}
}) => {
  await updateReportCrmItem({
    bitrixClient,
    settings,
    report,
    status,
    photos,
    diskFolderId,
    requireReportItem: true,
    context
  });

  await verifyCrmFolderSync({
    bitrixClient,
    settings,
    report,
    folderFieldCode,
    expectedFolderId: diskFolderId,
    context
  });
};

export const buildCrmSyncRunner = ({ reportsStore, settingsStore, bitrixClient, authContextStore }) => async (job) => {
  const reportId = Number(job.report_id ?? job.reportId);
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});
  const report = await reportsStore.getById(reportId);
  if (!report) {
    // Report no longer exists — nothing to sync; resolve normally so the worker marks the job done.
    return;
  }
  const settings = await settingsStore.read();
  const photos = await reportsStore.listPhotos(reportId);
  const folderFieldCode = String(settings.report?.fields?.folderId || '').trim();

  // CRM writes to the report SPA require admin scope (regular AZS-user tokens
  // hit insufficient_scope). Resolve the portal admin context for the sync.
  // payload.contextKey (the uploader) is kept only as an audit/fallback key.
  let context = {};
  const adminEntry = await authContextStore.getLastAdminContext();
  if (adminEntry?.context) {
    context = { key: adminEntry.key, ...adminEntry.context };
  } else if (payload.contextKey) {
    // Fallback: no admin context available — try the uploader's stored context.
    const stored = await authContextStore.getContextByKey(payload.contextKey);
    if (stored) {
      context = { ...stored, key: payload.contextKey };
    } else {
      console.warn('crm_sync_context_missing', { reportId, contextKey: payload.contextKey });
    }
  } else {
    console.warn('crm_sync_admin_context_missing', { reportId });
  }

  await syncReportCrmStrict({
    bitrixClient,
    settings,
    report,
    status: payload.status || report.status,
    photos,
    diskFolderId: payload.diskFolderId ?? report.diskFolderId ?? null,
    folderFieldCode,
    context
  });
};


const normalizePlanDate = (v) => {
  const raw = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

const todayInTz = (tz) => {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return formatter.format(new Date());
  } catch {
    // Fallback to UTC if the tz is invalid
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
};

/**
 * Load enabled AZS candidates using reportsRoutes' own camelCase-aware helpers.
 * Mirrors dispatchScheduler.loadCandidatesFromAzs but avoids importing that
 * closure — uses getFieldValue / extractFirstUserId / parseCrmItemId already in
 * this file's scope.
 */
const loadEnabledAzsCandidates = async ({ settings, bitrixClient, context }) => {
  const entityTypeId = Number(settings?.azs?.entityTypeId || 0);
  const adminField = String(settings?.azs?.fields?.admin || '').trim();
  const enabledField = String(settings?.azs?.fields?.enabled || '').trim();

  if (!entityTypeId || !adminField || typeof bitrixClient?.listCrmItems !== 'function') {
    return [];
  }

  const isDisabledValue = (value) => {
    if (Array.isArray(value)) return value.some(isDisabledValue);
    if (value && typeof value === 'object') {
      return isDisabledValue(value.value ?? value.VALUE ?? value.id ?? value.ID);
    }
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === 'n' || raw === '0' || raw === 'false' || raw === 'нет';
  };

  // Build deduped select list covering camelCase and original-case aliases
  const selectSet = new Set(['id', 'ID']);
  for (const alias of [adminField, adminField.toLowerCase(), adminField.toUpperCase()]) {
    if (alias) selectSet.add(alias);
  }
  if (enabledField) {
    for (const alias of [enabledField, enabledField.toLowerCase(), enabledField.toUpperCase()]) {
      if (alias) selectSet.add(alias);
    }
  }
  const select = [...selectSet];

  const rows = await bitrixClient.listCrmItems({
    entityTypeId,
    select,
    limit: 1000,
    useOriginalUfNames: 'N',
    context
  });

  return rows
    .filter((row) => {
      if (!enabledField) return true;
      const val = getFieldValue(row, enabledField);
      return val !== undefined && val !== null && val !== '' && val !== 0 && val !== false && !isDisabledValue(val);
    })
    .map((row) => ({
      azsId: String(parseCrmItemId(row?.id ?? row?.ID)),
      adminUserId: extractFirstUserId(getFieldValue(row, adminField))
    }))
    .filter((item) => item.azsId && Number(item.adminUserId) > 0);
};

export const createReportsRouter = ({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore,
  crmSyncJobStore,
  dispatchPlanStore = null
}) => {
  if (!reportsStore || !dispatchService || !settingsStore || !bitrixClient || !notificationService || !authContextStore || !crmSyncJobStore) {
    throw new Error('reportsStore, dispatchService, settingsStore, bitrixClient, notificationService, authContextStore and crmSyncJobStore are required');
  }

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_BYTES
    }
  });

  router.get('/', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      const settings = await settingsStore.read();
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });

      const items = await reportsStore.list({
        dateFrom: normalizeDateFilter(req.query.dateFrom),
        dateTo: normalizeDateFilter(req.query.dateTo),
        status: String(req.query.status || '').trim(),
        azsIds: normalizeAzsIds(req.query.azsId),
        limit: normalizeLimit(req.query.limit)
      });

      const decorated = await Promise.all(items.map(async (item) => ({
        ...item,
        azsTitle: await resolveAzsTitle(item.azsId)
      })));

      return res.json({
        items: decorated,
        total: decorated.length
      });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_list_failed',
        message: error.message
      });
    }
  });

  router.get('/summary', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      const summary = await reportsStore.getSummary({
        dateFrom: normalizeDateFilter(req.query.dateFrom),
        dateTo: normalizeDateFilter(req.query.dateTo),
        azsIds: normalizeAzsIds(req.query.azsId)
      });

      return res.json({ summary });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_summary_failed',
        message: error.message
      });
    }
  });

  router.get('/azs-options', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      const settings = await settingsStore.read();
      const entityTypeId = Number(settings?.azs?.entityTypeId || 0);
      if (!entityTypeId) {
        return res.status(400).json({
          error: 'azs_settings_not_configured',
          message: 'В настройках не выбран смарт-процесс АЗС'
        });
      }
      if (typeof bitrixClient.listCrmItems !== 'function') {
        return res.status(501).json({
          error: 'bitrix_client_not_supported',
          message: 'Bitrix client does not support crm.item.list'
        });
      }

      const adminField = String(settings?.azs?.fields?.admin || '').trim();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
      const select = ['id', 'ID', 'title', 'TITLE'];
      if (adminField) {
        select.push(adminField, adminField.toLowerCase(), adminField.toUpperCase());
      }

      const rows = await bitrixClient.listCrmItems({
        entityTypeId,
        select,
        order: { id: 'ASC' },
        limit: 500,
        useOriginalUfNames: 'N',
        context: req.bitrixContext || {}
      });

      const items = rows
        .map((row) => normalizeAzsOption({ row, adminField }))
        .filter(Boolean)
        .filter((item) => {
          if (!search) {
            return true;
          }
          return item.title.toLowerCase().includes(search) || item.id.includes(search);
        })
        .slice(0, limit);

      return res.json({ items });
    } catch (error) {
      return res.status(502).json({
        error: 'azs_options_failed',
        message: error.message
      });
    }
  });

  router.get('/plan', async (req, res) => {
    if (!canUseReviewerTools(req)) return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
    try {
      if (!dispatchPlanStore || typeof dispatchPlanStore.listByDate !== 'function') {
        return res.json({ items: [], planDate: null, enabled: false });
      }
      const settings = await settingsStore.read();
      const tz = String(settings?.timezone || 'Europe/Moscow').trim();
      const planDate = normalizePlanDate(req.query.date) || todayInTz(tz);
      const rows = await dispatchPlanStore.listByDate({ planDate });
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
      const items = [];
      for (const row of rows) {
        items.push({
          azsId: row.azs_id,
          azsTitle: await resolveAzsTitle(row.azs_id),
          adminUserId: row.admin_user_id,
          baseTime: row.base_time,
          executeAt: row.execute_at,
          status: row.status,
          reportItemId: row.report_item_id ?? null
        });
      }
      return res.json({ items, planDate, enabled: true });
    } catch (error) {
      return res.status(502).json({ error: 'plan_failed', message: error.message });
    }
  });

  router.post('/plan/generate', async (req, res) => {
    if (!canUseReviewerTools(req)) return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
    try {
      if (!dispatchPlanStore || typeof dispatchPlanStore.upsertPlanned !== 'function') {
        return res.status(503).json({ error: 'plan_mode_unavailable', message: 'Случайный план рассылки недоступен (хранилище не инициализировано)' });
      }
      // Ensure table exists even on a fresh prod that never ran plan-mode via scheduler
      await dispatchPlanStore.ensureSchema();
      const settings = await settingsStore.read();
      const tz = String(settings?.timezone || 'Europe/Moscow').trim();
      const planDate = normalizePlanDate(req.body?.date) || todayInTz(tz);
      const context = req.bitrixContext || {};
      const candidates = await loadEnabledAzsCandidates({ settings, bitrixClient, context });
      if (!candidates.length) {
        return res.status(422).json({ error: 'no_candidates', message: 'Нет включённых АЗС с назначенным администратором. Проверьте смарт-процесс АЗС и поле «Администратор».' });
      }
      // regenerate=true: deletes status='planned' rows for the date then rebuilds
      const summary = await generateDailyPlan({ planDate, candidates, settings, planStore: dispatchPlanStore, regenerate: true, logger: console });
      return res.json({ ok: true, planDate, azsCount: candidates.length, planned: summary?.planned ?? null, summary });
    } catch (error) {
      return res.status(502).json({ error: 'plan_generate_failed', message: error.message });
    }
  });

  router.get('/my-active', async (req, res) => {
    if (!canUseAdminReportTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'AZS administrator access is required'
      });
    }

    try {
      const currentUserId = extractUserId(req.user);
      if (!currentUserId) {
        return res.status(401).json({
          error: 'unauthorized_user',
          message: 'Unable to resolve current user id from JWT'
        });
      }

      if (typeof reportsStore.listActiveByAdminUserId !== 'function') {
        return res.status(501).json({
          error: 'reports_active_not_supported',
          message: 'reportsStore.listActiveByAdminUserId is not implemented'
        });
      }

      const settings = await settingsStore.read();
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
      const items = await reportsStore.listActiveByAdminUserId({
        adminUserId: currentUserId,
        limit: normalizeLimit(req.query.limit)
      });
      const decorated = await Promise.all(items.map(async (item) => ({
        ...item,
        azsTitle: await resolveAzsTitle(item.azsId)
      })));

      return res.json({
        item: decorated[0] || null,
        items: decorated,
        total: decorated.length
      });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_my_active_failed',
        message: error.message
      });
    }
  });

  router.get('/:id', async (req, res) => {
    if (!canUseAdminReportTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'AZS administrator access is required'
      });
    }

    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({
          error: 'invalid_report_id',
          message: 'report id must be a positive number'
        });
      }

      const item = await reportsStore.getById(id);
      if (!item) {
        return res.status(404).json({
          error: 'report_not_found'
        });
      }

      const settings = await settingsStore.read();
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
      const [photos, requiredPhotos, syncJobs] = await Promise.all([
        reportsStore.listPhotos(id),
        readRequiredPhotos({
          bitrixClient,
          settings,
          azsId: item.azsId,
          context: req.bitrixContext || {}
        }),
        crmSyncJobStore.listByReport(id)
      ]);
      const azsTitle = await resolveAzsTitle(item.azsId);
      const latestJob = syncJobs.length ? syncJobs[syncJobs.length - 1] : null;
      const syncStatus = latestJob
        ? { synced: latestJob.status === 'done', lastSyncError: latestJob.last_error || null, syncState: latestJob.status }
        // No sync job for this report (e.g. pre-CRM-sync legacy / nothing queued) → treat as synced.
        : { synced: true, lastSyncError: null, syncState: 'none' };
      return res.json({ item: { ...item, azsTitle }, photos, requiredPhotos, syncStatus });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({
        error: error?.code || 'report_get_failed',
        message: error.message
      });
    }
  });

  router.post('/manual', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      const settings = await settingsStore.read();
      const { candidates, failedItems } = await resolveManualCandidates({
        payload: req.body || {},
        settings,
        bitrixClient,
        context: req.bitrixContext || {},
        fallbackUserId: extractUserId(req.user)
      });

      const result = await dispatchService.dispatchBatch({
        candidates,
        trigger: 'manual',
        context: req.bitrixContext || {}
      });

      const items = [
        ...result.items,
        ...failedItems
      ];
      const summary = {
        total: items.length,
        created: Number(result.summary?.created || 0),
        duplicates: Number(result.summary?.duplicates || 0),
        failed: Number(result.summary?.failed || 0) + failedItems.length
      };

      return res.json({
        summary,
        items
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({
        error: error?.code || 'manual_report_failed',
        message: error.message,
        details: error?.details || undefined
      });
    }
  });

  router.post('/:id/photo', upload.single('photo'), async (req, res) => {
    if (!canUseAdminReportTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'AZS administrator access is required'
      });
    }

    try {
      const reportId = Number(req.params.id);
      if (!Number.isFinite(reportId) || reportId <= 0) {
        return res.status(400).json({
          error: 'invalid_report_id',
          message: 'report id must be a positive number'
        });
      }

      const photoCode = normalizePhotoCode(req.body?.photoCode);
      if (!photoCode) {
        return res.status(400).json({
          error: 'invalid_photo_code',
          message: 'photoCode is required'
        });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({
          error: 'photo_file_required'
        });
      }
      if (!isSupportedPhotoUpload({ originalName: file.originalname, mimeType: file.mimetype })) {
        return res.status(400).json({
          error: 'unsupported_photo_type',
          message: 'Поддерживаются только фото: jpg, jpeg, png, webp, heic, heif'
        });
      }

      const report = await reportsStore.getById(reportId);
      if (!report) {
        return res.status(404).json({
          error: 'report_not_found'
        });
      }

      const currentUserId = ensureCurrentUserOwnsReport({ req, report });

      const settings = await settingsStore.read();
      ensureFolderFieldMapping(settings); // guard: throws if folder field not configured
      const requiredPhotos = await readRequiredPhotos({
        bitrixClient,
        settings,
        azsId: report.azsId,
        context: req.bitrixContext || {}
      });
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
      const azsTitle = await resolveAzsTitle(report.azsId);
      const requiredCodes = requiredPhotos.map((item) => item.code);
      if (!requiredCodes.includes(photoCode)) {
        return res.status(400).json({
          error: 'photo_code_not_required',
          message: `photoCode ${photoCode} is not required for this AZS`
        });
      }

      const exifMeta = await exifr.parse(file.buffer, ['DateTimeOriginal', 'CreateDate']).catch(() => ({}));
      const exifDate = exifMeta?.DateTimeOriginal || exifMeta?.CreateDate || null;
      const exifValidation = validateExifDate(exifDate);
      if (!exifValidation.ok) {
        return res.status(400).json({
          error: 'photo_exif_too_old',
          message: exifValidation.message
        });
      }

      const diskContext = req.bitrixContext || {};

      const rootFolderId = await ensureRootFolder(bitrixClient.diskApi, {
        configuredRootFolderId: Number(settings.disk?.rootFolderId || 0),
        storageRootId: Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1),
        appFolderName: process.env.BITRIX_DISK_APP_FOLDER || 'AZS-Photo-Reports'
      }, diskContext);

      const { slotDate, slotHHmm } = parseReportSlotKey(report.slotKey);
      const requiredTitle = requiredPhotos.find((item) => item.code === photoCode)?.title || '';
      const uploaded = await uploadPhoto(bitrixClient.diskApi, {
        rootFolderId,
        azsId: report.azsId,
        azsName: azsTitle,
        slotDate,
        slotHHmm,
        photoCode,
        requiredTitle,
        originalName: file.originalname,
        mimeType: file.mimetype,
        capturedAt: exifValidation.exifAt || new Date(),
        content: file.buffer,
        folderNameTemplate: settings.disk?.folderNameTemplate || '{yyyy-mm}/{dd}/{azs}_{azs_name}'
      }, diskContext);

      await reportsStore.upsertPhoto({
        reportId,
        photoCode,
        fileId: uploaded.fileId,
        fileName: uploaded.fileName,
        diskFolderId: uploaded.folderId,
        diskObjectId: uploaded.diskObjectId,
        uploadedBy: currentUserId,
        exifAt: exifValidation.exifAt
      });

      const currentPhotos = await reportsStore.listPhotos(reportId);
      const uploadedCodes = new Set(currentPhotos.map((photo) => normalizePhotoCode(photo.photoCode)));
      const allRequiredUploaded = requiredCodes.every((code) => uploadedCodes.has(code));
      const nextStatus = 'in_progress';
      await reportsStore.setReportStatus({
        reportId,
        status: nextStatus
      });

      // Durable CRM sync: persist a job; the background worker performs it with
      // retry and survives process restarts. /photo stays fast (returns after Disk+DB).
      await crmSyncJobStore.enqueue({
        reportId,
        payload: {
          status: nextStatus,
          diskFolderId: uploaded.folderId,
          contextKey: req.bitrixContext?.key || ''
        }
      });

      return res.json({
        item: {
          reportId,
          photoCode,
          fileId: uploaded.fileId,
          diskObjectId: uploaded.diskObjectId,
          fileName: uploaded.fileName,
          folderId: uploaded.folderId,
          status: nextStatus,
          completed: false,
          allUploaded: allRequiredUploaded,
          uploadedCount: uploadedCodes.size,
          requiredCount: requiredCodes.length,
          requiredPhotos,
          syncQueued: true
        }
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      const retryable = isRetryableUploadError(error);
      if (statusCode >= 500 || retryable) {
        console.error('report_photo_upload_failed', {
          reportId: Number(req.params?.id || 0) || null,
          photoCode: normalizePhotoCode(req.body?.photoCode || ''),
          slotKey: String(req.body?.slotKey || ''),
          statusCode,
          message: String(error?.message || error || '')
        });
      }
      return res.status(statusCode).json({
        error: error?.code || 'report_photo_upload_failed',
        errorCode: retryable ? 'bitrix_retryable' : undefined,
        message: error.message,
        currentUserId: error?.currentUserId,
        expectedAdminUserId: error?.expectedAdminUserId
      });
    }
  });

  router.post('/:id/submit', async (req, res) => {
    if (!canUseAdminReportTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'AZS administrator access is required'
      });
    }

    try {
      const reportId = Number(req.params.id);
      if (!Number.isFinite(reportId) || reportId <= 0) {
        return res.status(400).json({
          error: 'invalid_report_id',
          message: 'report id must be a positive number'
        });
      }

      const report = await reportsStore.getById(reportId);
      if (!report) {
        return res.status(404).json({
          error: 'report_not_found'
        });
      }

      ensureCurrentUserOwnsReport({ req, report });

      const settings = await settingsStore.read();
      ensureFolderFieldMapping(settings); // guard: throws if folder field not configured
      const requiredPhotos = await readRequiredPhotos({
        bitrixClient,
        settings,
        azsId: report.azsId,
        context: req.bitrixContext || {}
      });
      const requiredCodes = requiredPhotos.map((item) => item.code);
      const currentPhotos = await reportsStore.listPhotos(reportId);
      const uploadedCodes = new Set(currentPhotos.map((photo) => normalizePhotoCode(photo.photoCode)));
      const missingCodes = requiredCodes.filter((code) => !uploadedCodes.has(code));

      if (missingCodes.length > 0) {
        return res.status(409).json({
          error: 'report_photos_missing',
          message: `Cannot submit report: missing photos ${missingCodes.join(', ')}`,
          missingCodes
        });
      }

      const diskFolderId = currentPhotos
        .map((photo) => Number(photo.diskFolderId))
        .find((folderId) => Number.isFinite(folderId) && folderId > 0);

      if (!diskFolderId) {
        throw new ReportSyncError(
          'Cannot submit report: uploaded photos do not contain Bitrix24 Disk folder id',
          'report_folder_missing'
        );
      }

      await reportsStore.setReportStatus({
        reportId,
        status: 'done'
      });

      // Durable CRM sync: persist a job; the background worker performs it with
      // retry and survives process restarts.
      await crmSyncJobStore.enqueue({
        reportId,
        payload: {
          status: 'done',
          diskFolderId,
          contextKey: req.bitrixContext?.key || ''
        }
      });

      const reviewerId = Number(process.env.REPORT_REVIEWER_USER_ID || 0);
      if (reviewerId > 0) {
        const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
        const azsTitle = await resolveAzsTitle(report.azsId);
        await notificationService.notifyReportDone({
          userId: reviewerId,
          azsId: report.azsId,
          azsTitle,
          context: req.bitrixContext || {}
        });
      }

      return res.json({
        item: {
          reportId,
          status: 'done',
          completed: true,
          uploadedCount: uploadedCodes.size,
          requiredCount: requiredCodes.length,
          folderId: diskFolderId
        }
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({
        error: error?.code || 'report_submit_failed',
        message: error.message,
        currentUserId: error?.currentUserId,
        expectedAdminUserId: error?.expectedAdminUserId
      });
    }
  });

  router.post('/:id/resync', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
    }
    try {
      const reportId = Number(req.params.id);
      if (!Number.isFinite(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'invalid_report_id', message: 'report id must be a positive number' });
      }
      const report = await reportsStore.getById(reportId);
      if (!report) {
        return res.status(404).json({ error: 'report_not_found' });
      }
      await crmSyncJobStore.enqueue({
        reportId,
        payload: {
          status: report.status,
          diskFolderId: report.diskFolderId ?? null,
          contextKey: req.bitrixContext?.key || ''
        }
      });
      return res.json({ ok: true, reportId, syncQueued: true });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({ error: error?.code || 'report_resync_failed', message: error.message });
    }
  });

  return router;
};

export default createReportsRouter;
