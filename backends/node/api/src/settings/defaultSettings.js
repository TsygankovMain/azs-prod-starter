export class SettingsValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'SettingsValidationError';
    this.errors = errors;
    this.statusCode = 400;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  azs: {
    entityTypeId: 0,
    fields: {
      admin: '',
      reviewers: '',
      photoSet: '',
      enabled: ''
    }
  },
  photoType: {
    entityTypeId: 0,
    fields: {
      code: '',
      title: '',
      sort: '',
      active: ''
    }
  },
  report: {
    entityTypeId: 0,
    fields: {
      azs: '',
      slotTime: '',
      trigger: '',
      folderId: '',
      photos: '',
      photoStatus: ''
    },
    stages: {
      new: '',
      inProgress: '',
      done: '',
      expired: ''
    },
    timeoutMinutes: 60,
    dispatchJitterMinutes: 15
  },
  disk: {
    rootFolderId: 0,
    folderNameTemplate: '{yyyy-mm}/{dd}/{azs}'
  },
  timezone: 'Europe/Moscow'
});

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const clone = (value) => JSON.parse(JSON.stringify(value));

export const deepMerge = (base, override = {}) => {
  const result = clone(base);

  if (!isPlainObject(override)) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
};

export const mergeSettings = (savedSettings = {}) => deepMerge(DEFAULT_SETTINGS, savedSettings);

const validateObject = (settings, key, errors) => {
  if (!isPlainObject(settings[key])) {
    errors.push(`${key} must be an object`);
  }
};

const validateNumber = (value, path, minValue, errors) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
    return;
  }

  if (value < minValue) {
    errors.push(`${path} must be greater than or equal to ${minValue}`);
  }
};

export const validateSettings = (settings) => {
  const errors = [];

  if (!isPlainObject(settings)) {
    throw new SettingsValidationError(['settings must be a JSON object']);
  }

  for (const key of ['azs', 'photoType', 'report', 'disk']) {
    validateObject(settings, key, errors);
  }

  if (typeof settings.timezone !== 'string' || settings.timezone.trim() === '') {
    errors.push('timezone must be a non-empty string');
  }

  if (isPlainObject(settings.azs)) {
    validateNumber(Number(settings.azs.entityTypeId), 'azs.entityTypeId', 0, errors);
    validateObject(settings.azs, 'fields', errors);
  }

  if (isPlainObject(settings.photoType)) {
    validateNumber(Number(settings.photoType.entityTypeId), 'photoType.entityTypeId', 0, errors);
    validateObject(settings.photoType, 'fields', errors);
  }

  if (isPlainObject(settings.report)) {
    validateNumber(Number(settings.report.entityTypeId), 'report.entityTypeId', 0, errors);
    validateNumber(Number(settings.report.timeoutMinutes), 'report.timeoutMinutes', 1, errors);
    validateNumber(Number(settings.report.dispatchJitterMinutes), 'report.dispatchJitterMinutes', 0, errors);
    validateObject(settings.report, 'fields', errors);
    validateObject(settings.report, 'stages', errors);
  }

  if (isPlainObject(settings.disk)) {
    validateNumber(Number(settings.disk.rootFolderId), 'disk.rootFolderId', 0, errors);
    if (typeof settings.disk.folderNameTemplate !== 'string' || settings.disk.folderNameTemplate.trim() === '') {
      errors.push('disk.folderNameTemplate must be a non-empty string');
    }
  }

  if (errors.length > 0) {
    throw new SettingsValidationError(errors);
  }

  return {
    ...settings,
    azs: {
      ...settings.azs,
      entityTypeId: Number(settings.azs.entityTypeId)
    },
    photoType: {
      ...settings.photoType,
      entityTypeId: Number(settings.photoType.entityTypeId)
    },
    report: {
      ...settings.report,
      entityTypeId: Number(settings.report.entityTypeId),
      timeoutMinutes: Number(settings.report.timeoutMinutes),
      dispatchJitterMinutes: Number(settings.report.dispatchJitterMinutes)
    },
    disk: {
      ...settings.disk,
      rootFolderId: Number(settings.disk.rootFolderId)
    },
    timezone: settings.timezone.trim()
  };
};

export const normalizeSettings = (settings = {}) => validateSettings(mergeSettings(settings));
