import { normalizeSettings } from './defaultSettings.js';
import { createThrottledLog } from '../shared/throttledLogger.js';

const normalizeContext = (value) => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
);

export const createCompositeSettingsStore = ({
  bitrixStore,
  dbStore,
  getDefaultContext = null,
  logger = console
} = {}) => {
  // Throttle repetitive background-read errors to one summary per 5 minutes so
  // a settings.bitrix_read_failed storm (2000+ lines/hour) becomes manageable.
  const throttledLog = createThrottledLog({ logger });
  if (!bitrixStore || !dbStore) {
    throw new Error('bitrixStore and dbStore are required');
  }

  const resolveContext = async (options = {}) => {
    const directContext = normalizeContext(options.context);
    if (Object.keys(directContext).length > 0) {
      return directContext;
    }
    if (typeof getDefaultContext === 'function') {
      return normalizeContext(await getDefaultContext());
    }
    return {};
  };

  return {
    async ensureSchema() {
      if (typeof dbStore.ensureSchema === 'function') {
        await dbStore.ensureSchema();
      }
    },

    async read(options = {}) {
      const context = await resolveContext(options);

      try {
        // Source of truth: Bitrix app storage. Local DB is a warm fallback cache.
        const bitrixSettings = await bitrixStore.read({ context });
        if (bitrixSettings) {
          // Keep local DB in sync with the source-of-truth storage.
          await dbStore.write(bitrixSettings, { context }).catch((error) => {
            logger.warn('settings.db_sync_failed', { message: error.message });
          });
          return bitrixSettings;
        }
      } catch (error) {
        throttledLog('settings.bitrix_read_failed', 'warn', 'settings.bitrix_read_failed', { message: error.message });
      }

      try {
        return await dbStore.read({ context });
      } catch (error) {
        logger.warn('settings.db_read_failed', { message: error.message });
        return normalizeSettings({}, { requireBitrixSyncFields: false });
      }
    },

    async write(settings, options = {}) {
      const context = await resolveContext(options);
      const normalized = await bitrixStore.write(settings, { context });
      await dbStore.write(normalized, { context }).catch((error) => {
        logger.warn('settings.db_write_failed', { message: error.message });
      });
      return normalized;
    }
  };
};

export default createCompositeSettingsStore;
