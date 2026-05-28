const DEFAULT_FOLDER_TEMPLATE = '{yyyy-mm}/{dd}/{azs}';

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

const uploadFileReplacingDuplicate = async (diskApi, { folderId, fileName, content }, context = {}) => {
  await removeExistingFileByName(diskApi, { folderId, fileName }, context);

  try {
    return await diskApi.uploadFile(folderId, { fileName, content }, context);
  } catch (error) {
    if (!isDuplicateFileNameError(error)) {
      throw error;
    }

    // Guard against race condition: a competing upload may create the same
    // file between our pre-check and upload call.
    await removeExistingFileByName(diskApi, { folderId, fileName }, context);
    return diskApi.uploadFile(folderId, { fileName, content }, context);
  }
};

export const buildFolderPath = ({
  capturedAt = new Date(),
  azsId,
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE
} = {}) => {
  const date = isValidDate(capturedAt) ? capturedAt : new Date(capturedAt);
  if (!isValidDate(date)) {
    throw new Error('capturedAt must be a valid date');
  }

  if (String(folderNameTemplate || '').includes('{azs}') && (azsId === undefined || azsId === null || String(azsId).trim() === '')) {
    throw new Error('azsId is required');
  }

  const values = {
    '{yyyy}': String(date.getUTCFullYear()),
    '{mm}': pad2(date.getUTCMonth() + 1),
    '{dd}': pad2(date.getUTCDate()),
    '{yyyy-mm}': `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`,
    '{azs}': sanitizeSegment(azsId, 'AZS')
  };

  let pathValue = folderNameTemplate;
  for (const [token, tokenValue] of Object.entries(values)) {
    pathValue = pathValue.split(token).join(tokenValue);
  }

  return splitPath(pathValue).join('/');
};

export const buildPhotoFileName = ({
  azsId,
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

  const safeAzs = sanitizeFileSegment(azsId, 'AZS');
  const safeSlot = sanitizeFileSegment(slotHHmm, '0000').replace(/[^0-9]/g, '').slice(0, 4) || '0000';
  const safeCategory = buildPhotoCategory({ requiredTitle, photoCode });
  const extension = resolvePhotoFileExtension({ originalName, mimeType });

  return `${safeAzs}_${rawDate}_${safeSlot}_${safeCategory}.${extension}`;
};

export const ensureFolderPath = async (diskApi, { rootFolderId, path }, context = {}) => {
  if (!diskApi || typeof diskApi.findChildFolder !== 'function' || typeof diskApi.createFolder !== 'function') {
    throw new Error('diskApi must provide findChildFolder and createFolder');
  }
  if (!rootFolderId) {
    throw new Error('rootFolderId is required');
  }

  const segments = splitPath(path);
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

  return ensureFolderPath(diskApi, {
    rootFolderId: Number(storageRootId),
    path: sanitizeSegment(appFolderName)
  }, context);
};

export const uploadPhoto = async (diskApi, {
  rootFolderId,
  azsId,
  slotDate,
  slotHHmm,
  photoCode,
  requiredTitle,
  originalName,
  mimeType,
  capturedAt = new Date(),
  content,
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE
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

  const folderPath = buildFolderPath({ capturedAt: folderDate, azsId, folderNameTemplate });
  const targetFolderId = await ensureFolderPath(diskApi, { rootFolderId, path: folderPath }, context);
  const fileName = buildPhotoFileName({ azsId, slotDate, slotHHmm, requiredTitle, photoCode, originalName, mimeType });
  const uploaded = await uploadFileReplacingDuplicate(diskApi, {
    folderId: targetFolderId,
    fileName,
    content
  }, context);

  return {
    folderId: targetFolderId,
    folderPath,
    fileName,
    fileId: uploaded?.id ?? null,
    uploadResult: uploaded ?? null
  };
};

export const diskNaming = {
  DEFAULT_FOLDER_TEMPLATE,
  sanitizeSegment
};
