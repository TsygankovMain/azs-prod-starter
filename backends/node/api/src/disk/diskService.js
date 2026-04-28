const DEFAULT_FOLDER_TEMPLATE = '{yyyy-mm}/{dd}/{azs}';

const ILLEGAL_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE_RE = /\s+/g;
const MULTI_DASH_RE = /-+/g;

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

const splitPath = (pathValue) => String(pathValue || '')
  .split('/')
  .map((segment) => sanitizeSegment(segment))
  .filter(Boolean);

export const buildFolderPath = ({
  capturedAt = new Date(),
  azsName = 'AZS',
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE
} = {}) => {
  const date = isValidDate(capturedAt) ? capturedAt : new Date(capturedAt);
  if (!isValidDate(date)) {
    throw new Error('capturedAt must be a valid date');
  }

  const values = {
    '{yyyy}': String(date.getUTCFullYear()),
    '{mm}': pad2(date.getUTCMonth() + 1),
    '{dd}': pad2(date.getUTCDate()),
    '{yyyy-mm}': `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`,
    '{azs}': sanitizeSegment(azsName, 'AZS')
  };

  let pathValue = folderNameTemplate;
  for (const [token, tokenValue] of Object.entries(values)) {
    pathValue = pathValue.split(token).join(tokenValue);
  }

  return splitPath(pathValue).join('/');
};

export const buildPhotoFileName = ({
  slotHHmm,
  photoCode,
  capturedAt = new Date(),
  extension = 'jpg'
}) => {
  if (!slotHHmm) {
    throw new Error('slotHHmm is required');
  }
  if (!photoCode) {
    throw new Error('photoCode is required');
  }

  const date = isValidDate(capturedAt) ? capturedAt : new Date(capturedAt);
  if (!isValidDate(date)) {
    throw new Error('capturedAt must be a valid date');
  }

  const iso = date.toISOString().replace(/[:]/g, '-');
  const safeSlot = sanitizeSegment(slotHHmm, '0000').replace(/[^0-9]/g, '').slice(0, 4) || '0000';
  const safeCode = sanitizeSegment(photoCode, 'photo').replace(/ /g, '_');
  const safeExt = sanitizeSegment(extension, 'jpg').replace(/^\.+/, '').toLowerCase() || 'jpg';

  return `${safeSlot}_${safeCode}_${iso}.${safeExt}`;
};

export const ensureFolderPath = async (diskApi, { rootFolderId, path }) => {
  if (!diskApi || typeof diskApi.findChildFolder !== 'function' || typeof diskApi.createFolder !== 'function') {
    throw new Error('diskApi must provide findChildFolder and createFolder');
  }
  if (!rootFolderId) {
    throw new Error('rootFolderId is required');
  }

  const segments = splitPath(path);
  let currentFolderId = Number(rootFolderId);

  for (const segment of segments) {
    const existing = await diskApi.findChildFolder(currentFolderId, segment);
    if (existing?.id) {
      currentFolderId = Number(existing.id);
      continue;
    }

    const created = await diskApi.createFolder(currentFolderId, segment);
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
}) => {
  if (configuredRootFolderId && Number(configuredRootFolderId) > 0) {
    return Number(configuredRootFolderId);
  }
  if (!storageRootId) {
    throw new Error('storageRootId is required when configuredRootFolderId is not set');
  }

  return ensureFolderPath(diskApi, {
    rootFolderId: Number(storageRootId),
    path: sanitizeSegment(appFolderName)
  });
};

export const uploadPhoto = async (diskApi, {
  rootFolderId,
  azsName,
  slotHHmm,
  photoCode,
  capturedAt = new Date(),
  extension = 'jpg',
  content,
  folderNameTemplate = DEFAULT_FOLDER_TEMPLATE
}) => {
  if (!diskApi || typeof diskApi.uploadFile !== 'function') {
    throw new Error('diskApi must provide uploadFile');
  }
  if (!content) {
    throw new Error('content is required');
  }

  const folderPath = buildFolderPath({ capturedAt, azsName, folderNameTemplate });
  const targetFolderId = await ensureFolderPath(diskApi, { rootFolderId, path: folderPath });
  const fileName = buildPhotoFileName({ slotHHmm, photoCode, capturedAt, extension });
  const uploaded = await diskApi.uploadFile(targetFolderId, { fileName, content });

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

