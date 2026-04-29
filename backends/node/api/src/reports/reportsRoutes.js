import express from 'express';
import multer from 'multer';
import exifr from 'exifr';
import { ensureRootFolder, uploadPhoto } from '../disk/diskService.js';
import { updateReportCrmItem } from './reportCrmSync.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXIF_MAX_AGE_MINUTES = Number(process.env.EXIF_MAX_AGE_MINUTES || 720);

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

const normalizePhotoCode = (value) => String(value || '').trim().toLowerCase();

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }

  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
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
  return item[fieldCode] ?? item[fieldCode.toLowerCase()] ?? item[fieldCode.toUpperCase()];
};

const readRequiredPhotos = async ({ bitrixClient, settings, azsId }) => {
  const azsEntityTypeId = Number(settings.azs?.entityTypeId || 0);
  const photoSetField = String(settings.azs?.fields?.photoSet || '').trim();
  const photoTypeEntityTypeId = Number(settings.photoType?.entityTypeId || 0);
  const photoTypeFields = settings.photoType?.fields || {};
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
    id: azsItemId
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
    id
  })));

  const requiredPhotos = items
    .filter(Boolean)
    .map((item, index) => {
      const code = normalizePhotoCode(getFieldValue(item, photoTypeFields.code));
      const title = String(getFieldValue(item, photoTypeFields.title) || code).trim();
      const sort = Number(getFieldValue(item, photoTypeFields.sort) ?? ((index + 1) * 10));
      const activeValue = getFieldValue(item, photoTypeFields.active);
      const isInactive = ['N', 'n', '0', 'false', 'нет'].includes(String(activeValue ?? 'Y').trim());
      return {
        code,
        title: title || code,
        sort: Number.isFinite(sort) ? sort : ((index + 1) * 10),
        active: !isInactive
      };
    })
    .filter((item) => item.code && item.active)
    .sort((a, b) => a.sort - b.sort)
    .map(({ code, title, sort }) => ({ code, title, sort }));

  if (!requiredPhotos.length) {
    throw new ReportConfigError(
      'No active photo types resolved from AZS photo set',
      'required_photo_types_empty'
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

export const createReportsRouter = ({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService
}) => {
  if (!reportsStore || !dispatchService || !settingsStore || !bitrixClient || !notificationService) {
    throw new Error('reportsStore, dispatchService, settingsStore, bitrixClient and notificationService are required');
  }

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_BYTES
    }
  });

  router.get('/', async (req, res) => {
    try {
      const items = await reportsStore.list({
        dateFrom: normalizeDateFilter(req.query.dateFrom),
        dateTo: normalizeDateFilter(req.query.dateTo),
        status: String(req.query.status || '').trim(),
        azsId: String(req.query.azsId || '').trim(),
        limit: normalizeLimit(req.query.limit)
      });

      return res.json({
        items,
        total: items.length
      });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_list_failed',
        message: error.message
      });
    }
  });

  router.get('/summary', async (req, res) => {
    try {
      const summary = await reportsStore.getSummary({
        dateFrom: normalizeDateFilter(req.query.dateFrom),
        dateTo: normalizeDateFilter(req.query.dateTo),
        azsId: String(req.query.azsId || '').trim()
      });

      return res.json({ summary });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_summary_failed',
        message: error.message
      });
    }
  });

  router.get('/:id', async (req, res) => {
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
      const [photos, requiredPhotos] = await Promise.all([
        reportsStore.listPhotos(id),
        readRequiredPhotos({
          bitrixClient,
          settings,
          azsId: item.azsId
        })
      ]);
      return res.json({ item, photos, requiredPhotos });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({
        error: error?.code || 'report_get_failed',
        message: error.message
      });
    }
  });

  router.post('/manual', async (req, res) => {
    try {
      const candidate = req.body?.candidate;
      if (!candidate || typeof candidate !== 'object') {
        return res.status(400).json({
          error: 'invalid_candidate',
          message: 'POST /api/reports/manual expects body.candidate'
        });
      }

      const result = await dispatchService.dispatchBatch({
        candidates: [candidate],
        trigger: 'manual'
      });

      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: 'manual_report_failed',
        message: error.message
      });
    }
  });

  router.post('/:id/photo', upload.single('photo'), async (req, res) => {
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

      const report = await reportsStore.getById(reportId);
      if (!report) {
        return res.status(404).json({
          error: 'report_not_found'
        });
      }

      const currentUserId = extractUserId(req.user);
      if (!currentUserId || currentUserId !== Number(report.adminUserId)) {
        return res.status(403).json({
          error: 'forbidden_user',
          message: 'Current user is not report administrator',
          currentUserId,
          expectedAdminUserId: Number(report.adminUserId)
        });
      }

      const settings = await settingsStore.read();
      const folderFieldCode = ensureFolderFieldMapping(settings);
      const requiredPhotos = await readRequiredPhotos({
        bitrixClient,
        settings,
        azsId: report.azsId
      });
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

      const rootFolderId = await ensureRootFolder(bitrixClient.diskApi, {
        configuredRootFolderId: Number(settings.disk?.rootFolderId || 0),
        storageRootId: Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1),
        appFolderName: process.env.BITRIX_DISK_APP_FOLDER || 'AZS-Photo-Reports'
      });

      const slotHHmm = String(report.slotKey || '').split(':')[1] || '0000';
      const uploaded = await uploadPhoto(bitrixClient.diskApi, {
        rootFolderId,
        azsName: report.azsId,
        slotHHmm,
        photoCode,
        capturedAt: exifValidation.exifAt || new Date(),
        extension: file.originalname.split('.').pop() || 'jpg',
        content: file.buffer,
        folderNameTemplate: settings.disk?.folderNameTemplate || '{yyyy-mm}/{dd}/{azs}'
      });

      await reportsStore.upsertPhoto({
        reportId,
        photoCode,
        fileId: uploaded.fileId,
        fileName: uploaded.fileName,
        diskFolderId: uploaded.folderId,
        uploadedBy: currentUserId,
        exifAt: exifValidation.exifAt
      });

      const currentPhotos = await reportsStore.listPhotos(reportId);
      const uploadedCodes = new Set(currentPhotos.map((photo) => normalizePhotoCode(photo.photoCode)));
      const allRequiredUploaded = requiredCodes.every((code) => uploadedCodes.has(code));

      const nextStatus = allRequiredUploaded ? 'done' : 'in_progress';
      await reportsStore.setReportStatus({
        reportId,
        status: nextStatus
      });

      await updateReportCrmItem({
        bitrixClient,
        settings,
        report,
        status: nextStatus,
        photos: currentPhotos,
        diskFolderId: uploaded.folderId,
        requireReportItem: true
      });

      const syncedCrmItem = await bitrixClient.getCrmItem({
        entityTypeId: Number(settings.report?.entityTypeId || 0),
        id: Number(report.reportItemId || 0)
      });
      const syncedFolderId = String(getFieldValue(syncedCrmItem, folderFieldCode) ?? '').trim();
      if (syncedFolderId !== String(uploaded.folderId)) {
        throw new ReportSyncError(
          `Report CRM folder field "${folderFieldCode}" was not synced. Expected "${String(uploaded.folderId)}", got "${syncedFolderId || '<empty>'}"`,
          'report_folder_sync_failed'
        );
      }

      if (allRequiredUploaded) {
        const reviewerId = Number(process.env.REPORT_REVIEWER_USER_ID || 0);
        if (reviewerId > 0) {
          await notificationService.notifyReportDone({
            userId: reviewerId,
            reportId,
            azsId: report.azsId
          });
        }
      }

      return res.json({
        item: {
          reportId,
          photoCode,
          fileId: uploaded.fileId,
          fileName: uploaded.fileName,
          folderId: uploaded.folderId,
          status: nextStatus,
          completed: allRequiredUploaded,
          uploadedCount: uploadedCodes.size,
          requiredCount: requiredCodes.length,
          requiredPhotos
        }
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(statusCode).json({
        error: error?.code || 'report_photo_upload_failed',
        message: error.message
      });
    }
  });

  return router;
};

export default createReportsRouter;
