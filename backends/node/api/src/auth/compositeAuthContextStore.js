export const createCompositeAuthContextStore = ({
  dbStore,
  fileStore,
  logger = console
} = {}) => {
  if (!dbStore) throw new Error('dbStore is required');
  if (!fileStore) throw new Error('fileStore is required');

  // Fire-and-forget seed of a single context from file into DB.
  // Errors are logged but do not surface to the caller — a read path must
  // never fail just because an opportunistic background write failed.
  const seedToDb = (input) => {
    dbStore.upsertContext(input).catch((error) => {
      logger.warn('compositeAuthContextStore.seed_failed', { message: error.message });
    });
  };

  return {
    // Delegates to dbStore so server.js can call ensureSchema() on the
    // composite without needing to know the underlying store type.
    async ensureSchema() {
      if (typeof dbStore.ensureSchema === 'function') {
        await dbStore.ensureSchema();
      }
    },

    // One-time startup migration: if DB is empty but file has data, copy
    // everything from file into DB. This handles the first deploy after
    // upgrading from file-only mode.
    async seedFromFile() {
      const dbList = await dbStore.listContexts();
      if (dbList.length > 0) {
        return; // DB already has data — skip migration
      }
      const fileList = await fileStore.listContexts();
      for (const { context } of fileList) {
        await dbStore.upsertContext(context).catch((error) => {
          logger.warn('compositeAuthContextStore.seed_entry_failed', { message: error.message });
        });
      }
    },

    // Write to both stores. DB is authoritative; file is a warm backup so
    // the old flush-on-shutdown path keeps working.
    async upsertContext(contextInput) {
      const result = await dbStore.upsertContext(contextInput);
      // File write failure is non-fatal
      await fileStore.upsertContext(contextInput).catch((error) => {
        logger.warn('compositeAuthContextStore.file_write_failed', { message: error.message });
      });
      return result;
    },

    async getContextByKey(key) {
      const dbResult = await dbStore.getContextByKey(key);
      if (dbResult !== null) {
        return dbResult;
      }
      const fileResult = await fileStore.getContextByKey(key);
      if (fileResult !== null) {
        // Seed the DB transparently so future reads hit the DB
        seedToDb(fileResult);
      }
      return fileResult;
    },

    async getContext({ memberId, domain, userId } = {}) {
      const dbResult = await dbStore.getContext({ memberId, domain, userId });
      if (dbResult !== null) {
        return dbResult;
      }
      const fileResult = await fileStore.getContext({ memberId, domain, userId });
      if (fileResult !== null) {
        seedToDb(fileResult);
      }
      return fileResult;
    },

    async getLastAdminContext() {
      const dbEntry = await dbStore.getLastAdminContext();
      if (dbEntry !== null) {
        return dbEntry;
      }
      const fileEntry = await fileStore.getLastAdminContext();
      if (fileEntry !== null) {
        // Seed the admin context so the DB becomes self-sufficient after one hit
        seedToDb(fileEntry.context);
      }
      return fileEntry;
    },

    // listContexts always reads from DB (canonical). File is used only for
    // seeding. tokenRefreshScheduler uses listContexts — DB is sufficient.
    async listContexts() {
      return dbStore.listContexts();
    },

    // Flush both stores to ensure no pending file writes are lost on shutdown.
    async flush() {
      await Promise.all([
        dbStore.flush(),
        fileStore.flush()
      ]);
    }
  };
};

export default createCompositeAuthContextStore;
