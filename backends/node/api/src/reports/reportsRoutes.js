import express from 'express';
import multer from 'multer';
import exifr from 'exifr';
import { ensureRootFolder, uploadPhoto } from '../disk/diskService.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXIF_MAX_AGE_MINUTES = Number(process.env.EXIF_MAX_AGE_MINUTES || 720);
const DEFAULT_REQUIRED_CODES = ['totem', 'columns', 'shop', 'territory'];

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

const parseRequiredCodes = () => {
  const envValue = String(process.env.REPORT_REQUIRED_PHOTO_CODES || '').trim();
  if (!envValue) {
    return DEFAULT_REQUIRED_CODES;
  }
  const items = envValue.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : DEFAULT_REQUIRED_CODES;
};

const normalizePhotoCode = (value) => String(value || '').trim().toLowerCase();

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

export const createReportsRouter = ({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient
}) => {
  if (!reportsStore || !dispatchService || !settingsStore || !bitrixClient) {
    throw new Error('reportsStore, dispatchService, settingsStore and bitrixClient are required');
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

      const photos = await reportsStore.listPhotos(id);
      return res.json({ item, photos });
    } catch (error) {
      return res.status(500).json({
        error: 'report_get_failed',
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
          message: 'Current user is not report administrator'
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

      const settings = await settingsStore.read();
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

      const requiredCodes = parseRequiredCodes();
      const currentPhotos = await reportsStore.listPhotos(reportId);
      const uploadedCodes = new Set(currentPhotos.map((photo) => normalizePhotoCode(photo.photoCode)));
      const allRequiredUploaded = requiredCodes.every((code) => uploadedCodes.has(code));

      const nextStatus = allRequiredUploaded ? 'done' : 'in_progress';
      await reportsStore.setReportStatus({
        reportId,
        status: nextStatus
      });

      if (allRequiredUploaded) {
        const reviewerId = Number(process.env.REPORT_REVIEWER_USER_ID || 0);
        if (reviewerId > 0) {
          await bitrixClient.notifyUser({
            userId: reviewerId,
            message: `Отчёт АЗС ${report.azsId} завершён и готов к проверке.`
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
          requiredCount: requiredCodes.length
        }
      });
    } catch (error) {
      return res.status(500).json({
        error: 'report_photo_upload_failed',
        message: error.message
      });
    }
  });

  return router;
};

export default createReportsRouter;
