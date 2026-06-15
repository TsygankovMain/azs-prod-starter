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
  logger = console,
  maxWriteAttempts = 3,
  writeRetryDelayMs = 200
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

      // Bounded retry on the Bitrix write — it is the source of truth.
      let lastError;
      for (let attempt = 1; attempt <= maxWriteAttempts; attempt++) {
        try {
          const normalized = await bitrixStore.write(settings, { context });
          // Success — best-effort DB sync (non-fatal).
          await dbStore.write(normalized, { context }).catch((error) => {
            logger.warn('settings.db_write_failed', { message: error.message });
          });
          return normalized;
        } catch (error) {
          lastError = error;
          logger.warn('settings.bitrix_write_retry', { attempt, message: error.message });
          if (attempt < maxWriteAttempts && writeRetryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, writeRetryDelayMs));
          }
        }
      }

      // All attempts exhausted — throw a clear typed error.
      // Do NOT write DB: a DB-only write would be clobbered by stale Bitrix data
      // on the next successful read() (Bitrix is source-of-truth).
      logger.error('settings.bitrix_write_failed', { attempts: maxWriteAttempts, message: lastError?.message });
      const err = new Error('Не удалось сохранить настройки в Bitrix (источник истины). Повторите попытку.', { cause: lastError });
      err.code = 'settings_bitrix_write_failed';
      throw err;
    }
  };
};

export default createCompositeSettingsStore;
