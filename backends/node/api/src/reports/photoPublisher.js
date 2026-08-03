// Публикация одного принятого фото в Битрикс + таксономия ошибок публикации.
//
// classifyPublishError решает, стоит ли повторить попытку или считать отказ
// окончательным. Список окончательных ошибок снят с живого портала, а не из
// документации — в этом проекте догадки по документации уже дважды приводили
// к неверным допущениям. Пополнять список можно только по наблюдённой в
// проде ошибке.
//
// Дефолт — 'retryable', и это умышленное, несимметричное решение: неверная
// догадка «повторить» стоит одного лишнего запроса; неверная догадка «отказ
// навсегда» стоит потерянного фото и несданной смены у живого человека.
// Невидимая потеря вместо видимого отказа — главный анти-гол всей задачи.
const PERMANENT_BITRIX_ERRORS = new Set([
  'DISK_QUOTA_EXCEEDED',
  'ERROR_NOT_FOUND_FOLDER',
  'ACCESS_DENIED'
]);

export const classifyPublishError = (error) => {
  const bitrixError = String(error?.bitrixError || error?.error || '').trim();
  if (bitrixError && PERMANENT_BITRIX_ERRORS.has(bitrixError)) return 'permanent';
  return 'retryable';
};

// ---------------------------------------------------------------------------
// publishOne
//
// Переносит цепочку публикации, которая раньше жила прямо в обработчике
// POST /:id/photo (reportsRoutes.js, роут не трогаем — его переписывает
// другая задача): резолвинг корневой папки (с учётом папки бренда) →
// uploadPhoto с folderIdCache. Сам обработчик логики не меняет — меняется
// только то, что каждое обращение к Битриксу теперь проходит под общим
// ограничителем темпа (см. shared/rateLimiter.js).
// ---------------------------------------------------------------------------

import { ensureRootFolder, uploadPhoto } from '../disk/diskService.js';

class ReportSlotKeyError extends Error {
  constructor(slotKey) {
    super(`Report slotKey "${String(slotKey || '')}" is invalid; expected YYYY-MM-DD:HHmm or manual:YYYY-MM-DD:HHmm`);
    this.name = 'ReportSlotKeyError';
    this.code = 'report_slot_key_invalid';
    this.statusCode = 422;
  }
}

// Реплика normalizeSlotHHmm/parseReportSlotKey из reportsRoutes.js. Не импорт:
// тот модуль сейчас переписывает другая задача, и связывать свежий,
// изолированный модуль с файлом, который прямо сейчас меняется параллельно —
// значит рисковать конфликтом с чужой веткой работы ради двух строк логики.
const normalizeSlotHHmm = (value) => {
  const raw = String(value || '').replace(/[^0-9]/g, '').slice(0, 4);
  if (raw.length !== 4) return '';
  const hours = Number(raw.slice(0, 2));
  const minutes = Number(raw.slice(2, 4));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return '';
  }
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
};

const parseSlotKey = (slotKey) => {
  const parts = String(slotKey || '').split(':').map((part) => String(part || '').trim());
  const isManual = String(parts[0] || '').toLowerCase() === 'manual';
  const slotDate = isManual ? String(parts[1] || '').trim() : String(parts[0] || '').trim();
  const rawSlotHHmm = isManual ? String(parts[2] || '').trim() : String(parts[1] || '').trim();
  const slotHHmm = normalizeSlotHHmm(rawSlotHHmm);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !slotHHmm) {
    throw new ReportSlotKeyError(slotKey);
  }

  return { slotDate, slotHHmm };
};

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

// Оборачивает diskApi так, что КАЖДЫЙ его метод сначала берёт токен у общего
// ограничителя темпа, а при ошибке с полем retryAfterMs (портал попросил
// подождать через заголовок Retry-After — см. bitrixRestClient.js, разбор
// около строк 277 и 385) — сообщает об этом ограничителю через penalize(),
// прежде чем пробросить ошибку дальше без изменений.
//
// Оборачиваем ВСЕ методы diskApi обобщённо (Object.keys), а не только те,
// что нужны сегодняшней цепочке (findChildFolder/createFolder/findChildFile/
// markFileDeleted/uploadFile): ensureRootFolder и uploadPhoto — чужой код
// (diskService.js, трогать нельзя), и его набор внутренних вызовов может
// измениться. Жёстко перечисленный список методов здесь означал бы дыру мимо
// лимитера, которую легко не заметить при следующей правке diskService.js.
//
// original.apply(diskApi, args), а не отвязанный original(...args): методы
// diskApi живут в объектном литерале и сегодня не читают this, но полагаться
// на это — случайность реализации, а не контракт; apply сохраняет корректное
// поведение независимо от того, начнёт ли какой-то метод использовать this.
const wrapDiskApiWithLimiter = (diskApi, limiter) => {
  const wrapped = {};
  for (const name of Object.keys(diskApi || {})) {
    const original = diskApi[name];
    if (typeof original !== 'function') {
      wrapped[name] = original;
      continue;
    }
    wrapped[name] = async (...args) => {
      await limiter.acquire();
      try {
        return await original.apply(diskApi, args);
      } catch (error) {
        if (error && error.retryAfterMs != null) {
          limiter.penalize(error.retryAfterMs);
        }
        throw error;
      }
    };
  }
  return wrapped;
};

/**
 * @param {object} deps
 * @param {object} deps.bitrixClient   — должен предоставлять diskApi (см. bitrixRestClient.js)
 * @param {object} deps.settingsStore  — { read(): Promise<settings> }, локальные настройки приложения
 * @param {object} deps.reportsStore   — { getById(reportId) }, локальная БД (не Битрикс)
 * @param {object} [deps.brandStore]   — { getBrandByAzsId(azsId) }, локальная БД; необязателен
 * @param {object} [deps.folderIdCache] — createFolderIdCache(...) из folderIdCache.js; передаётся в uploadPhoto как есть
 * @param {object} deps.limiter        — createRateLimiter(...) из shared/rateLimiter.js; ОДИН общий экземпляр на процесс
 * @param {Function} [deps.resolveContext] — (task) => Promise<bitrixContext> | bitrixContext; по умолчанию {}
 */
export const createPhotoPublisher = ({
  bitrixClient,
  settingsStore,
  reportsStore,
  brandStore = null,
  folderIdCache = null,
  limiter,
  resolveContext = () => ({})
} = {}) => {
  if (!bitrixClient || !bitrixClient.diskApi) {
    throw new Error('bitrixClient with diskApi is required');
  }
  if (!settingsStore || typeof settingsStore.read !== 'function') {
    throw new Error('settingsStore.read() is required');
  }
  if (!limiter || typeof limiter.acquire !== 'function' || typeof limiter.penalize !== 'function') {
    throw new Error('limiter with acquire()/penalize() is required');
  }

  // Один и тот же обёрнутый diskApi используется на все обращения этого
  // publisher — обёртка ставится один раз здесь, а не при каждом publishOne(),
  // но это не имеет значения для контракта «acquire() перед каждым вызовом»:
  // сама обёртка stateless относительно limiter (тот передан снаружи и разделяется
  // между всеми воркерами уже на уровне лимитера, см. rateLimiter.js).
  const rateLimitedDiskApi = wrapDiskApiWithLimiter(bitrixClient.diskApi, limiter);

  const publishOne = async (task = {}) => {
    const reportId = firstDefined(task.reportId, task.report_id);
    const photoCode = firstDefined(task.photoCode, task.photo_code);
    const content = task.content;
    const mimeType = firstDefined(task.mimeType, task.mime_type);
    const originalName = firstDefined(task.originalName, task.original_name);
    const capturedAt = firstDefined(task.capturedAt, task.exifAt, task.exif_at) || new Date();

    if (!content) {
      throw new Error('task.content is required');
    }

    let azsId = firstDefined(task.azsId, task.azs_id);
    let slotDate = hasValue(task.slotDate) ? task.slotDate : undefined;
    let slotHHmm = hasValue(task.slotHHmm) ? task.slotHHmm : undefined;

    // reportsStore — локальная БД (dispatch_log), не Битрикс: обращение сюда
    // НЕ проходит через limiter, он существует только для порталового REST.
    if (!hasValue(azsId) || !slotDate || !slotHHmm) {
      const report = await reportsStore.getById(reportId);
      if (!report) {
        throw new Error(`report ${reportId} not found`);
      }
      if (!hasValue(azsId)) {
        azsId = report.azsId;
      }
      if (!slotDate || !slotHHmm) {
        const parsed = parseSlotKey(report.slotKey);
        slotDate = slotDate || parsed.slotDate;
        slotHHmm = slotHHmm || parsed.slotHHmm;
      }
    }

    const azsName = firstDefined(task.azsName, task.azs_name) || '';
    const requiredTitle = firstDefined(task.requiredTitle, task.required_title) || '';

    const context = (await resolveContext(task)) || {};
    const settings = await settingsStore.read();

    // Учёт папки бренда — та же логика, что была в обработчике: если АЗС
    // принадлежит бренду с настроенной папкой на Диске, она становится корнем
    // вместо общего AZS-Photo-Reports. brandStore — локальная БД, не Битрикс.
    let brandRootFolderId = null;
    if (brandStore && typeof brandStore.getBrandByAzsId === 'function') {
      const brand = await brandStore.getBrandByAzsId(azsId).catch(() => null);
      if (brand && brand.disk_folder_id) {
        brandRootFolderId = Number(brand.disk_folder_id);
      }
    }

    const rootFolderId = brandRootFolderId
      ? brandRootFolderId
      : await ensureRootFolder(rateLimitedDiskApi, {
          configuredRootFolderId: Number(settings.disk?.rootFolderId || 0),
          storageRootId: Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1),
          appFolderName: process.env.BITRIX_DISK_APP_FOLDER || 'AZS-Photo-Reports'
        }, context);

    const uploaded = await uploadPhoto(rateLimitedDiskApi, {
      rootFolderId,
      azsId,
      azsName,
      slotDate,
      slotHHmm,
      photoCode,
      requiredTitle,
      originalName,
      mimeType,
      capturedAt,
      content,
      folderNameTemplate: settings.disk?.folderNameTemplate || '{yyyy-mm}/{dd}/{azs}_{azs_name}',
      folderIdCache
    }, context);

    return {
      fileId: uploaded.fileId,
      fileName: uploaded.fileName,
      diskFolderId: uploaded.folderId,
      diskObjectId: uploaded.diskObjectId
    };
  };

  return { publishOne };
};

export default createPhotoPublisher;
