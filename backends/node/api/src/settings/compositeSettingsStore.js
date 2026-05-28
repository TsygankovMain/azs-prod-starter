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
        const bitrixSettings = await bitrixStore.read({ context });
        if (bitrixSettings) {
          // Keep local DB in sync with the source-of-truth storage.
          await dbStore.write(bitrixSettings, { context }).catch((error) => {
            logger.warn('settings.db_sync_failed', { message: error.message });
          });
          return bitrixSettings;
        }
      } catch (error) {
        logger.warn('settings.bitrix_read_failed', { message: error.message });
      }

      return dbStore.read({ context });
    },

    async write(settings, options = {}) {
      const context = await resolveContext(options);
      const normalized = await bitrixStore.write(settings, { context });
      await dbStore.write(normalized, { context });
      return normalized;
    }
  };
};

export default createCompositeSettingsStore;
