import { DEFAULT_REASONS_SEED } from '../reports/reasonCatalog.js';

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
      enabled: '',
      manager: ''
    }
  },
  photoType: {
    entityTypeId: 0
  },
  report: {
    entityTypeId: 0,
    fields: {
      azs: '',
      trigger: '',
      folderId: '',
      photos: '',
      reason: '' // NEW: код строкового UF причины на карточке отчёта
    },
    stages: {
      new: '',
      inProgress: '',
      done: '',
      expired: '',
      rejected: '' // NEW: стадия «Брак» — карточка бракуется после ответа причины через бота
    },
    timeoutMinutes: 60,
    dispatchJitterMinutes: 15,
    dispatchTimes: [],
    workWindow: { start: '07:00', end: '22:00' },
    reasons: DEFAULT_REASONS_SEED.map(r => ({ ...r })), // NEW: seed из единого источника
    responsibleChatId: '' // NEW: id общего чата ответственных
  },
  disk: {
    rootFolderId: 0,
    folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}'
  },
  timezone: 'Europe/Moscow',
  access: {
    adminUserIds: [],
    reviewerUserIds: [],
    azsAdminUserIds: []
  },
  photoFeed: {
    remarkTemplates: [
      'Переделайте выкладку промо-товара',
      'Перегрузите правый монитор — старая реклама'
    ]
  },
  dispatchProfiles: []
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

const normalizeUserIdList = (value) => {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n;]+/g);

  return [...new Set(
    source
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0)
      .map((item) => Math.floor(item))
  )];
};

const validateUserIdList = (value, path, errors) => {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of positive integers`);
    return;
  }

  const hasInvalid = value.some((item) => {
    const parsed = Number(item);
    return !Number.isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed;
  });
  if (hasInvalid) {
    errors.push(`${path} contains invalid values, expected positive integers`);
  }
};

const normalizeDispatchTimes = (value) => {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n;]+/g);

  const result = [...new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => {
        const match = item.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          return '';
        }
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
          return '';
        }
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      })
      .filter(Boolean)
  )];

  return result.sort();
};

export const validateSettings = (settings, {
  requireBitrixSyncFields = true
} = {}) => {
  const errors = [];
  const bitrixSyncRequired = String(process.env.BITRIX_SYNC_REQUIRED || '').trim().toLowerCase();
  const isProductionBitrixSync = requireBitrixSyncFields
    && (
      bitrixSyncRequired === 'true'
      || bitrixSyncRequired === '1'
      || String(process.env.BITRIX_REST_ENDPOINT || '').trim() !== ''
    );

  if (!isPlainObject(settings)) {
    throw new SettingsValidationError(['settings must be a JSON object']);
  }

  for (const key of ['azs', 'photoType', 'report', 'disk', 'access']) {
    validateObject(settings, key, errors);
  }

  if (settings.photoFeed !== undefined) {
    if (!isPlainObject(settings.photoFeed)) {
      errors.push('photoFeed must be an object');
    } else if (settings.photoFeed.remarkTemplates !== undefined) {
      if (!Array.isArray(settings.photoFeed.remarkTemplates)) {
        errors.push('photoFeed.remarkTemplates must be an array');
      } else {
        if (settings.photoFeed.remarkTemplates.length > 10) {
          errors.push('photoFeed.remarkTemplates must contain at most 10 items');
        }
        const hasInvalidTemplate = settings.photoFeed.remarkTemplates.some(
          (t) => typeof t !== 'string' || !t.trim() || t.length > 200
        );
        if (hasInvalidTemplate) {
          errors.push('photoFeed.remarkTemplates items must be non-empty strings of at most 200 characters');
        }
      }
    }
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
  }

  if (isPlainObject(settings.report)) {
    validateNumber(Number(settings.report.entityTypeId), 'report.entityTypeId', 0, errors);
    validateNumber(Number(settings.report.timeoutMinutes), 'report.timeoutMinutes', 1, errors);
    validateNumber(Number(settings.report.dispatchJitterMinutes), 'report.dispatchJitterMinutes', 0, errors);
    validateObject(settings.report, 'fields', errors);
    validateObject(settings.report, 'stages', errors);
    if (!Array.isArray(settings.report.dispatchTimes)) {
      errors.push('report.dispatchTimes must be an array of HH:mm strings');
    } else {
      const hasInvalidTimes = settings.report.dispatchTimes
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .some((item) => !/^\d{1,2}:\d{2}$/.test(item));
      if (hasInvalidTimes) {
        errors.push('report.dispatchTimes contains invalid values, expected HH:mm');
      }
    }
    if (settings.report.workWindow !== undefined) {
      const ww = settings.report.workWindow;
      const timeRe = /^\d{1,2}:\d{2}$/;
      const parseTime = (s) => {
        const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h < 0 || h > 23 || min < 0 || min > 59) return null;
        return h * 60 + min;
      };
      if (!isPlainObject(ww) || typeof ww.start !== 'string' || typeof ww.end !== 'string') {
        errors.push('report.workWindow must be an object with string start and end');
      } else if (!timeRe.test(ww.start) || !timeRe.test(ww.end)) {
        errors.push('report.workWindow start and end must match HH:mm');
      } else {
        const startMinutes = parseTime(ww.start);
        const endMinutes = parseTime(ww.end);
        if (startMinutes === null) {
          errors.push('report.workWindow.start is not a valid time');
        } else if (endMinutes === null) {
          errors.push('report.workWindow.end is not a valid time');
        } else if (startMinutes >= endMinutes) {
          errors.push('report.workWindow.start must be earlier than report.workWindow.end');
        }
      }
    }
    if (isProductionBitrixSync) {
      const folderFieldCode = String(settings.report?.fields?.folderId || '').trim();
      if (!folderFieldCode) {
        errors.push('report.fields.folderId is required when Bitrix sync is enabled');
      }
    }

    // NEW: report.reasons — массив объектов { code: string, label: string }
    if (settings.report.reasons !== undefined) {
      if (!Array.isArray(settings.report.reasons)) {
        errors.push('report.reasons must be an array');
      } else {
        const hasInvalidReason = settings.report.reasons.some(
          r => !r || typeof r.code !== 'string' || !r.code.trim()
             || typeof r.label !== 'string' || !r.label.trim()
        );
        if (hasInvalidReason) {
          errors.push('report.reasons items must have non-empty string code and label');
        }
      }
    }

    // NEW: report.responsibleChatId — строка или число, опционально
    if (settings.report.responsibleChatId !== undefined
        && settings.report.responsibleChatId !== null
        && settings.report.responsibleChatId !== '') {
      const chatIdStr = String(settings.report.responsibleChatId || '').trim();
      if (chatIdStr && !/^\d+$/.test(chatIdStr)) {
        errors.push('report.responsibleChatId must be a numeric string or empty');
      }
    }
  }

  if (isPlainObject(settings.disk)) {
    validateNumber(Number(settings.disk.rootFolderId), 'disk.rootFolderId', 0, errors);
    if (typeof settings.disk.folderNameTemplate !== 'string' || settings.disk.folderNameTemplate.trim() === '') {
      errors.push('disk.folderNameTemplate must be a non-empty string');
    }
  }

  if (isPlainObject(settings.access)) {
    validateUserIdList(settings.access.adminUserIds, 'access.adminUserIds', errors);
    validateUserIdList(settings.access.reviewerUserIds, 'access.reviewerUserIds', errors);
    validateUserIdList(settings.access.azsAdminUserIds, 'access.azsAdminUserIds', errors);
  }

  // ─── dispatchProfiles ──────────────────────────────────────────────────────
  if (settings.dispatchProfiles !== undefined) {
    if (!Array.isArray(settings.dispatchProfiles)) {
      errors.push('dispatchProfiles must be an array');
    } else {
      const timeRe = /^\d{2}:\d{2}$/;

      const parseTimeMinutes = (s) => {
        const m = String(s || '').match(/^(\d{2}):(\d{2})$/);
        if (!m) return null;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h < 0 || h > 23 || min < 0 || min > 59) return null;
        return h * 60 + min;
      };

      // Проверяем уникальность azsIds по всем профилям (AC-6, OR-4)
      const seenAzsIds = new Map(); // azsId → первый profileIndex

      for (let i = 0; i < settings.dispatchProfiles.length; i++) {
        const profile = settings.dispatchProfiles[i];
        const prefix = `dispatchProfiles[${i}]`;

        // id
        if (!profile || typeof profile.id !== 'string' || !profile.id.trim()) {
          errors.push(`${prefix}.id must be a non-empty string`);
        }

        // name
        if (!profile || typeof profile.name !== 'string' || !profile.name.trim()) {
          errors.push(`${prefix}.name must be a non-empty string`);
        }

        // azsIds
        if (!profile || !Array.isArray(profile.azsIds)) {
          errors.push(`${prefix}.azsIds must be an array of strings`);
        } else {
          for (const azsId of profile.azsIds) {
            if (typeof azsId !== 'string') {
              errors.push(`${prefix}.azsIds must be an array of strings`);
              break;
            }
            if (seenAzsIds.has(azsId)) {
              errors.push(`dispatchProfiles: azsId '${azsId}' appears in multiple profiles (profiles[${seenAzsIds.get(azsId)}] and [${i}])`);
            } else {
              seenAzsIds.set(azsId, i);
            }
          }
        }

        // mode
        if (!profile || (profile.mode !== 'A' && profile.mode !== 'B')) {
          errors.push(`${prefix}.mode must be 'A' or 'B'`);
          continue; // Остальные проверки конфига зависят от mode
        }

        // config
        if (!profile.config || typeof profile.config !== 'object' || Array.isArray(profile.config)) {
          errors.push(`${prefix}.config must be an object`);
          continue;
        }

        if (profile.mode === 'A') {
          // slots — непустой массив HH:mm
          if (!Array.isArray(profile.config.slots) || profile.config.slots.length === 0) {
            errors.push(`${prefix}.config.slots must be a non-empty array of HH:mm strings`);
          } else {
            const hasInvalidSlot = profile.config.slots.some(
              (s) => !timeRe.test(String(s || ''))
            );
            if (hasInvalidSlot) {
              errors.push(`${prefix}.config.slots contains invalid values, expected HH:mm`);
            }
          }

          // jitterMinutes — число >= 0
          if (typeof profile.config.jitterMinutes !== 'number'
              || !Number.isFinite(profile.config.jitterMinutes)
              || profile.config.jitterMinutes < 0) {
            errors.push(`${prefix}.config.jitterMinutes must be >= 0`);
          }
        } else {
          // mode === 'B'
          // windows — непустой массив { from, to } с HH:mm и from < to
          if (!Array.isArray(profile.config.windows) || profile.config.windows.length === 0) {
            errors.push(`${prefix}.config.windows must be a non-empty array`);
          } else {
            for (let j = 0; j < profile.config.windows.length; j++) {
              const win = profile.config.windows[j];
              const winPrefix = `${prefix}.config.windows[${j}]`;

              if (!win || typeof win.from !== 'string' || typeof win.to !== 'string') {
                errors.push(`${winPrefix} must have string from and to`);
                continue;
              }

              if (!timeRe.test(win.from) || !timeRe.test(win.to)) {
                errors.push(`${winPrefix} from and to must match HH:mm`);
                continue;
              }

              const fromMin = parseTimeMinutes(win.from);
              const toMin = parseTimeMinutes(win.to);

              if (fromMin === null) {
                errors.push(`${winPrefix}.from is not a valid time`);
              } else if (toMin === null) {
                errors.push(`${winPrefix}.to is not a valid time`);
              } else if (fromMin >= toMin) {
                errors.push(`${winPrefix}: from must be earlier than to`);
              }
            }
          }

          // escalateUntilDone — опциональный boolean
          if (profile.config.escalateUntilDone !== undefined
              && typeof profile.config.escalateUntilDone !== 'boolean') {
            errors.push(`${prefix}.config.escalateUntilDone must be a boolean`);
          }
        }
      }
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
      dispatchJitterMinutes: Number(settings.report.dispatchJitterMinutes),
      dispatchTimes: normalizeDispatchTimes(settings.report.dispatchTimes),
      reasons: Array.isArray(settings.report.reasons)
        ? settings.report.reasons.map(r => ({
            code: String(r.code || '').trim(),
            label: String(r.label || '').trim()
          })).filter(r => r.code && r.label)
        : [],
      responsibleChatId: String(settings.report.responsibleChatId || '').trim()
    },
    disk: {
      ...settings.disk,
      rootFolderId: Number(settings.disk.rootFolderId)
    },
    timezone: settings.timezone.trim(),
    access: {
      adminUserIds: normalizeUserIdList(settings.access.adminUserIds),
      reviewerUserIds: normalizeUserIdList(settings.access.reviewerUserIds),
      azsAdminUserIds: normalizeUserIdList(settings.access.azsAdminUserIds)
    },
    photoFeed: {
      remarkTemplates: Array.isArray(settings.photoFeed?.remarkTemplates)
        ? settings.photoFeed.remarkTemplates
            .filter((t) => typeof t === 'string' && t.trim())
            .map((t) => t.trim())
        : DEFAULT_SETTINGS.photoFeed.remarkTemplates.slice()
    },
    dispatchProfiles: Array.isArray(settings.dispatchProfiles)
      ? settings.dispatchProfiles
      : []
  };
};

export const normalizeSettings = (settings = {}, options = {}) => validateSettings(mergeSettings(settings), options);
