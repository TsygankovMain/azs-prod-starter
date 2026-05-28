import { normalizeSettings } from './defaultSettings.js';

const DEFAULT_OPTION_KEY = 'azs_photo_report_settings_v1';

const normalizeOptionKey = (value) => {
  const optionKey = String(value || '').trim();
  return optionKey || DEFAULT_OPTION_KEY;
};

const extractOptionValue = (payload, optionKey) => {
  if (typeof payload === 'string') {
    return payload;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, optionKey)) {
    return payload[optionKey];
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'option')) {
    return payload.option;
  }
  return null;
};

const parseOptionSettings = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    return normalizeSettings(parsed, { requireBitrixSyncFields: false });
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeSettings(value, { requireBitrixSyncFields: false });
  }

  return null;
};

export const createBitrixAppSettingsStore = ({
  bitrixClient,
  optionKey = DEFAULT_OPTION_KEY
} = {}) => {
  if (!bitrixClient) {
    throw new Error('bitrixClient is required');
  }

  const resolvedOptionKey = normalizeOptionKey(optionKey);

  return {
    async read({ context = {} } = {}) {
      const result = await bitrixClient.callMethod('app.option.get', {
        option: resolvedOptionKey
      }, context);

      const optionValue = extractOptionValue(result, resolvedOptionKey);
      return parseOptionSettings(optionValue);
    },

    async write(settings, { context = {} } = {}) {
      const normalized = normalizeSettings(settings);
      await bitrixClient.callMethod('app.option.set', {
        options: {
          [resolvedOptionKey]: JSON.stringify(normalized)
        }
      }, context);
      return normalized;
    }
  };
};

export default createBitrixAppSettingsStore;
