import { buildPortalKey } from './folderIdCache.js';

const DEFAULT_FOLDER_TEMPLATE = '{yyyy-mm}/{dd}/{azs}_{azs_name}';

const ILLEGAL_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE_RE = /\s+/g;
const MULTI_DASH_RE = /-+/g;
const MULTI_UNDERSCORE_RE = /_+/g;

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'heif'
]);

const pad2 = (value) => String(value).padStart(2, '0');

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const sanitizeSegment = (value, fallback = 'unknown') => {
  const source = String(value ?? '').trim();
  const sanitized = source
    .replace(ILLEGAL_FILE_CHARS, '-')
    .replace(WHITESPACE_RE, ' ')
    .replace(MULTI_DASH_RE, '-')
    .replace(/[. ]+$/g, '')
    .trim();

  return sanitized || fallback;
};

const stripNumericPrefixes = (value) => {
  let result = String(value ?? '').trim();
  // Strip repeated "<number>." prefixes: "3. 3. Title" -> "Title"
  // Only the dot-prefix variant is required by the spec.
  while (/^\d+\.\s*/.test(result)) {
    result = result.replace(/^\d+\.\s*/g, '').trim();
  }
  return result;
};

const sanitizeFileSegment = (value, fallback = 'unknown') => (
  sanitizeSegment(value, fallback)
    .replace(WHITESPACE_RE, '_')
    .replace(MULTI_UNDERSCORE_RE, '_')
);

const normalizeImageExtension = (ext) => {
  const raw = String(ext ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!raw) {
    return '';
  }
  if (!ALLOWED_IMAGE_EXTENSIONS.has(raw)) {
    return '';
  }
  return raw === 'jpeg' ? 'jpg' : raw;
};

const extensionFromOriginalName = (originalName) => {
  const name = String(originalName ?? '').trim();
  if (!name.includes('.')) {
    return '';
  }
  const raw = name.split('.').pop();
  return normalizeImageExtension(raw);
};

const extensionFromMimeType = (mimeType) => {
  const raw = String(mimeType ?? '').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };

  return normalizeImageExtension(map[raw] || '');
};

const hasOriginalExtension = (originalName) => {
  const name = String(originalName ?? '').trim();
  if (!name.includes('.')) {
    return false;
  }
  return Boolean(String(name.split('.').pop() || '').trim());
};

export const resolvePhotoFileExtension = ({ originalName, mimeType } = {}) => (
  extensionFromOriginalName(originalName)
  || extensionFromMimeType(mimeType)
  || 'jpg'
);

export const isSupportedPhotoUpload = ({ originalName, mimeType } = {}) => {
  if (extensionFromOriginalName(originalName) || extensionFromMimeType(mimeType)) {
    return true;
  }

  // Keep the legacy fallback for genuinely unknown browser uploads, but reject
  // files that explicitly identify themselves as unsupported.
  return !hasOriginalExtension(originalName) && !String(mimeType ?? '').trim();
};

const buildPhotoCategory = ({ requiredTitle, photoCode }) => {
  const stripped = stripNumericPrefixes(requiredTitle);
  const candidate = sanitizeFileSegment(stripped, '');
  if (candidate) {
    return candidate;
  }

  const fallback = sanitizeFileSegment(`Фото_${String(photoCode || '').trim()}`, 'Фото');
  return fallback || 'Фото';
};

const splitPath = (pathValue) => String(pathValue || '')
  .split('/')
  .map((segment) => sanitizeSegment(segment))
  .filter(Boolean);

const isDuplicateFileNameError = (error) => {
  const message = String(error?.message || error || '');
  return /DISK_OBJ_22000/i.test(message) || /файл с таким именем уже есть/i.test(message.toLowerCase());
};

// Признак «папки с этим id больше нет» — используется, чтобы понять, что
// закэшированный folderId устарел (папку удалили/перенесли в Bitrix, либо
// приложение переустановили на другой портал), и его нужно сбросить.
//
// ERROR_NOT_FOUND — это НЕ предположение: код и текст описания
// ("Could not find entity with id `X`") взяты из официальной документации
// Bitrix24 REST (b24restdocs) для ВСЕХ трёх disk-методов, которые получают
// наш folderId напрямую как параметр `id` — disk.folder.getchildren
// (findChildFolder/findChildFile), disk.folder.addsubfolder (createFolder) и
// disk.folder.uploadfile (uploadFile). Во всех трёх это единственный код,
// означающий именно «id не найден» (в отличие от ERROR_ARGUMENT — не передан
// параметр, или ACCESS_DENIED — отказано в доступе, которые НЕ означают, что
// папка исчезла, и поэтому намеренно не считаются признаком устаревшего id).
// bitrixRestClient.js прокидывает код Bitrix как есть в message брошенной
// ошибки (`Bitrix REST ${method} error: ${error} ${error_description}`), тем
// же способом, что и isDuplicateFileNameError выше для DISK_OBJ_22000.
const isFolderMissingError = (error) => {
  const message = String(error?.message || error || '');
  return /ERROR_NOT_FOUND/i.test(message);
};

const removeExistingFileByName = async (diskApi, { folderId, fileName }, context = {}) => {
  if (!diskApi || typeof diskApi.findChildFile !== 'function' || typeof diskApi.markFileDeleted !== 'function') {
    return false;
  }

  const existing = await diskApi.findChildFile(folderId, fileName, context);
  if (!existing?.id) {
    return false;
  }

  await diskApi.markFileDeleted(existing.id, context);
  return true;
};

// C2b: hard ceiling on the actual disk.folder.uploadfile round-trip. The REST
// client already bounds a single HTTP call (BITRIX_HTTP_TIMEOUT_MS, 30s
// default) with retries on transient errors, but that retry loop has no
// overall cap — a slow/stuck Disk endpoint can still stack up well past it.
// This wraps the whole upload attempt (including the duplicate-name retry) so
// callers always get a bounded, retryable failure instead of hanging.
const DEFAULT_UPLOAD_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.DISK_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

const withUploadTimeout = (promise, timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Disk upload gateway timeout after ${timeoutMs}ms`);
      error.statusCode = 504;
      error.code = 'disk_upload_timeout';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const uploadFileReplacingDuplicate = async (diskApi, { folderId, fileName, content }, context = {}, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS) => {
  await removeExistingFileByName(diskApi, { folderId, fileName }, context);

  try {
    return await withUploadTimeout(diskApi.uploadFile(folderId, { fileName, content }, context), timeoutMs);
  } catch (error) {
    if (!isDuplicateFileNameError(error)) {
      throw error;
    }

    // Guard against race condition: a competing upload may create the same
    // file between our pre-check and upload call.
    await removeExistingFileByName(diskApi, { folderId, fileName }, context);
    return withUploadTimeout(diskApi.uploadFile(folderId, { fileName, content }, context), timeoutMs);
  }
};

export const buildFolderPath = ({
  capturedAt = new Date(),
  azsId,
  azsName,
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE
} = {}) => {
  const date = isValidDate(capturedAt) ? capturedAt : new Date(capturedAt);
  if (!isValidDate(date)) {
    throw new Error('capturedAt must be a valid date');
  }

  if (String(folderNameTemplate || '').includes('{azs}') && (azsId === undefined || azsId === null || String(azsId).trim() === '')) {
    throw new Error('azsId is required');
  }

  const safeAzsIdSegment = sanitizeSegment(azsId, 'AZS');
  const safeAzsNameSegment = (() => {
    const source = String(azsName ?? '').trim();
    if (source) {
      return sanitizeSegment(source, `AZS_${safeAzsIdSegment}`);
    }
    return sanitizeSegment(`AZS_${safeAzsIdSegment}`, `AZS_${safeAzsIdSegment}`);
  })();

  const values = {
    '{yyyy}': String(date.getUTCFullYear()),
    '{mm}': pad2(date.getUTCMonth() + 1),
    '{dd}': pad2(date.getUTCDate()),
    '{yyyy-mm}': `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`,
    '{azs}': safeAzsIdSegment,
    '{azs_name}': safeAzsNameSegment
  };

  let pathValue = folderNameTemplate;
  for (const [token, tokenValue] of Object.entries(values)) {
    pathValue = pathValue.split(token).join(tokenValue);
  }

  return splitPath(pathValue).join('/');
};

export const buildPhotoFileName = ({
  azsId,
  azsName,
  slotDate,
  slotHHmm,
  requiredTitle,
  photoCode,
  originalName,
  mimeType
}) => {
  if (azsId === undefined || azsId === null || String(azsId).trim() === '') {
    throw new Error('azsId is required');
  }
  if (!slotDate) {
    throw new Error('slotDate is required');
  }
  if (!slotHHmm) {
    throw new Error('slotHHmm is required');
  }

  const rawDate = String(slotDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new Error('slotDate must be YYYY-MM-DD');
  }

  // Filename leads with the AZS NAME (same source as the folder name), not the
  // smart-process item id. Fall back to the id only when no name is available.
  // Keep azsId required above so the fallback always has a value.
  const azsSource = String(azsName ?? '').trim() || azsId;
  const safeAzs = sanitizeFileSegment(azsSource, 'AZS');
  const safeSlot = sanitizeFileSegment(slotHHmm, '0000').replace(/[^0-9]/g, '').slice(0, 4) || '0000';
  const safeCategory = buildPhotoCategory({ requiredTitle, photoCode });
  const extension = resolvePhotoFileExtension({ originalName, mimeType });

  return `${safeAzs}_${rawDate}_${safeSlot}_${safeCategory}.${extension}`;
};

// folderIdCache — необязательный параметр (по умолчанию отсутствует), поэтому
// для всех существующих вызовов без него поведение и сигнатура НЕ меняются:
// ветки кэша ниже просто не выполняются, путь резолвится точно так же, как
// раньше, за findChildFolder/createFolder на каждый сегмент. portalKey сюда
// отдельным параметром не прокидывается — он выводится из того же auth-
// контекста (context), который и так обязателен для похода в Bitrix, чтобы
// нельзя было передать кэш и забыть указать идентичность портала.
export const ensureFolderPath = async (diskApi, { rootFolderId, path, folderIdCache = null } = {}, context = {}) => {
  if (!diskApi || typeof diskApi.findChildFolder !== 'function' || typeof diskApi.createFolder !== 'function') {
    throw new Error('diskApi must provide findChildFolder and createFolder');
  }
  if (!rootFolderId) {
    throw new Error('rootFolderId is required');
  }

  const segments = splitPath(path);
  const normalizedPath = segments.join('/');
  // Пустой portalKey (контекст без memberId/domain) означает «портал не
  // опознан» — в этом случае НЕ кэшируем вовсе, а не кладём запись в общий
  // безымянный бакет: это самый серьёзный риск задачи (см. folderIdCache.js).
  const portalKey = folderIdCache ? buildPortalKey(context) : '';
  const cacheEnabled = Boolean(folderIdCache && portalKey);

  if (cacheEnabled) {
    const cachedFolderId = folderIdCache.get(portalKey, rootFolderId, normalizedPath);
    if (cachedFolderId !== undefined) {
      return cachedFolderId;
    }
  }

  let currentFolderId = Number(rootFolderId);

  for (const segment of segments) {
    const existing = await diskApi.findChildFolder(currentFolderId, segment, context);
    if (existing?.id) {
      currentFolderId = Number(existing.id);
      continue;
    }

    const created = await diskApi.createFolder(currentFolderId, segment, context);
    if (!created?.id) {
      throw new Error(`Unable to create folder "${segment}" under ${currentFolderId}`);
    }
    currentFolderId = Number(created.id);
  }

  if (cacheEnabled) {
    folderIdCache.set(portalKey, rootFolderId, normalizedPath, currentFolderId);
  }

  return currentFolderId;
};

export const ensureRootFolder = async (diskApi, {
  configuredRootFolderId = 0,
  storageRootId,
  appFolderName = 'AZS-Photo-Reports'
}, context = {}) => {
  if (configuredRootFolderId && Number(configuredRootFolderId) > 0) {
    return Number(configuredRootFolderId);
  }
  if (!storageRootId) {
    throw new Error('storageRootId is required when configuredRootFolderId is not set');
  }

  // Намеренно НЕ передаём сюда folderIdCache. Сейчас этот вызов каждый раз
  // заново ходит в findChildFolder(storageRootId, appFolderName) — а значит,
  // если папку приложения ("AZS-Photo-Reports") в Bitrix удалят, следующий же
  // вызов молча пересоздаст её под storageRootId (который сам практически
  // никогда не исчезает). Это бесплатное самовосстановление мы бы потеряли,
  // закэшировав id: кэш-хит вернул бы мёртвый id в обход этого поиска, а
  // единственная точка, где мы умеем детектировать и лечить протухший id
  // (retry в uploadPhoto ниже), работает только для folderId, который сама
  // uploadPhoto передаёт в загрузку — она не в курсе, что rootFolderId вообще
  // мог прийти из кэша. Роль этого вызова в снижении числа REST-запросов и так
  // обычно нулевая: на проде settings.disk.rootFolderId настраивается один раз
  // администратором, и тогда configuredRootFolderId выше отдаёт число без
  // единого похода в Bitrix.
  return ensureFolderPath(diskApi, {
    rootFolderId: Number(storageRootId),
    path: sanitizeSegment(appFolderName)
  }, context);
};

export const uploadPhoto = async (diskApi, {
  rootFolderId,
  azsId,
  azsName,
  slotDate,
  slotHHmm,
  photoCode,
  requiredTitle,
  originalName,
  mimeType,
  capturedAt = new Date(),
  content,
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE,
  uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
  // Опционально: кэш id папок (createFolderIdCache из folderIdCache.js).
  // Не передан -> поведение и число запросов к Bitrix не меняются вовсе.
  folderIdCache = null
}, context = {}) => {
  if (!diskApi || typeof diskApi.uploadFile !== 'function') {
    throw new Error('diskApi must provide uploadFile');
  }
  if (!content) {
    throw new Error('content is required');
  }

  const folderDate = slotDate && /^\d{4}-\d{2}-\d{2}$/.test(String(slotDate).trim())
    ? new Date(`${String(slotDate).trim()}T00:00:00.000Z`)
    : capturedAt;

  const folderPath = buildFolderPath({ capturedAt: folderDate, azsId, azsName, folderNameTemplate });
  const fileName = buildPhotoFileName({ azsId, azsName, slotDate, slotHHmm, requiredTitle, photoCode, originalName, mimeType });
  // buildFolderPath уже возвращает splitPath(...).join('/'), т.е. ту же
  // нормализованную форму, которую ensureFolderPath сам пересчитывает из
  // path внутри себя для ключа кэша — но пересчитываем явно здесь же, а не
  // полагаемся на то, что оба места случайно совпадут: так get/evict ниже
  // гарантированно бьют по тому же ключу, что ensureFolderPath/set используют
  // внутри, а не "обычно совпадают, потому что sanitizeSegment идемпотентна".
  const normalizedFolderPath = splitPath(folderPath).join('/');

  const portalKey = folderIdCache ? buildPortalKey(context) : '';
  const cacheEnabled = Boolean(folderIdCache && portalKey);
  // Узнаём здесь же, был ли это кэш-хит: ensureFolderPath отдаёт наружу
  // только число (id), без пометки "из кэша или только что резолвили" — а
  // ретрай ниже должен сработать ТОЛЬКО когда упавший запрос реально
  // использовал закэшированный id (иначе это не «протухший кэш», а обычная
  // ошибка, и её нужно пробрасывать как раньше, без повторных попыток).
  const usedCachedFolderId = cacheEnabled
    && folderIdCache.get(portalKey, rootFolderId, normalizedFolderPath) !== undefined;

  let targetFolderId = await ensureFolderPath(diskApi, { rootFolderId, path: folderPath, folderIdCache }, context);

  let uploaded;
  try {
    uploaded = await uploadFileReplacingDuplicate(diskApi, {
      folderId: targetFolderId,
      fileName,
      content
    }, context, uploadTimeoutMs);
  } catch (error) {
    if (!usedCachedFolderId || !isFolderMissingError(error)) {
      throw error;
    }

    // Закэшированный folderId устарел (папку удалили/перенесли в Bitrix, либо
    // приложение переустановили на другой портал — см. folderIdCache.js) —
    // сбрасываем запись и ОДИН раз резолвим путь заново без кэша.
    // ensureFolderPath сам досоздаст недостающие сегменты (та же логика
    // самовосстановления, что и до кэширования). Если и повторная попытка
    // упадёт — пробрасываем ошибку как есть, без бесконечных ретраев.
    folderIdCache.evict(portalKey, rootFolderId, normalizedFolderPath);
    targetFolderId = await ensureFolderPath(diskApi, { rootFolderId, path: folderPath, folderIdCache }, context);
    uploaded = await uploadFileReplacingDuplicate(diskApi, {
      folderId: targetFolderId,
      fileName,
      content
    }, context, uploadTimeoutMs);
  }

  return {
    folderId: targetFolderId,
    folderPath,
    fileName,
    // fileId in our domain is the CRM file id (b_file.ID), not disk object id.
    fileId: uploaded?.crmFileId ?? null,
    diskObjectId: uploaded?.diskObjectId ?? null,
    uploadResult: uploaded ?? null
  };
};

export { sanitizeSegment };

export const diskNaming = {
  DEFAULT_FOLDER_TEMPLATE,
  sanitizeSegment
};
