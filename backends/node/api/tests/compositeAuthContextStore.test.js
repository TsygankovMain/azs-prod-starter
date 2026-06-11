import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompositeAuthContextStore } from '../src/auth/compositeAuthContextStore.js';

// ---------------------------------------------------------------------------
// Minimal fake file store
// ---------------------------------------------------------------------------
const makeFileStore = (initialContexts = {}) => {
  const state = {
    contexts: { ...initialContexts },
    _upsertCalls: [],
    _flushCalled: false
  };

  return {
    state,
    async getContextByKey(key) {
      return state.contexts[key] || null;
    },
    async getContext({ memberId, domain, userId }) {
      const key = `${memberId}:${domain}:${userId}`;
      return state.contexts[key] || null;
    },
    async getLastAdminContext() {
      const entry = Object.entries(state.contexts)
        .find(([, ctx]) => ctx?.isAdmin);
      if (!entry) return null;
      return { key: entry[0], context: entry[1] };
    },
    async listContexts() {
      return Object.entries(state.contexts).map(([key, context]) => ({ key, context }));
    },
    async upsertContext(input) {
      state._upsertCalls.push({ ...input });
      const key = `${input.memberId}:${input.domain}:${input.userId}`;
      state.contexts[key] = { ...input };
      return { key, context: state.contexts[key] };
    },
    async flush() {
      state._flushCalled = true;
    }
  };
};

// ---------------------------------------------------------------------------
// Minimal fake DB store
// ---------------------------------------------------------------------------
const makeDbStore = (initialContexts = {}) => {
  const state = {
    contexts: { ...initialContexts },
    _upsertCalls: [],
    _flushCalled: false
  };

  return {
    state,
    async getContextByKey(key) {
      return state.contexts[key] || null;
    },
    async getContext({ memberId, domain, userId }) {
      const key = `${memberId}:${domain}:${userId}`;
      return state.contexts[key] || null;
    },
    async getLastAdminContext() {
      const entry = Object.entries(state.contexts)
        .find(([, ctx]) => ctx?.isAdmin);
      if (!entry) return null;
      return { key: entry[0], context: entry[1] };
    },
    async listContexts() {
      return Object.entries(state.contexts).map(([key, context]) => ({ key, context }));
    },
    async upsertContext(input) {
      state._upsertCalls.push({ ...input });
      const key = `${input.memberId}:${input.domain}:${input.userId}`;
      state.contexts[key] = { ...input };
      return { key, context: state.contexts[key] };
    },
    async flush() {
      state._flushCalled = true;
    },
    async ensureSchema() {}
  };
};

// ---------------------------------------------------------------------------
// Read from DB when DB has data
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: getContextByKey reads from DB first', async () => {
  const dbCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'db-tok', refreshToken: 'db-ref', isAdmin: true };
  const fileCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'file-tok', refreshToken: 'file-ref', isAdmin: true };

  const db = makeDbStore({ 'm1:a.bitrix24.ru:1': dbCtx });
  const file = makeFileStore({ 'm1:a.bitrix24.ru:1': fileCtx });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const ctx = await store.getContextByKey('m1:a.bitrix24.ru:1');
  assert.equal(ctx.authId, 'db-tok', 'DB takes priority over file');
  assert.equal(db.state._upsertCalls.length, 0, 'no seeding when DB already has data');
});

// ---------------------------------------------------------------------------
// Read from file when DB is empty, seed DB transparently
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: getContextByKey falls back to file and seeds DB', async () => {
  const fileCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'file-tok', refreshToken: 'file-ref', isAdmin: false };

  const db = makeDbStore({});
  const file = makeFileStore({ 'm1:a.bitrix24.ru:1': fileCtx });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const ctx = await store.getContextByKey('m1:a.bitrix24.ru:1');
  assert.equal(ctx.authId, 'file-tok', 'should return file value');
  // Seeding is fire-and-forget — drain microtasks
  await new Promise((r) => setImmediate(r));
  assert.equal(db.state._upsertCalls.length, 1, 'should have seeded DB with file value');
  assert.equal(db.state._upsertCalls[0].authId, 'file-tok');
});

// ---------------------------------------------------------------------------
// getContextByKey returns null when both stores are empty
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: getContextByKey returns null when both stores empty', async () => {
  const db = makeDbStore({});
  const file = makeFileStore({});
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const result = await store.getContextByKey('missing:key:1');
  assert.equal(result, null);
  assert.equal(db.state._upsertCalls.length, 0);
});

// ---------------------------------------------------------------------------
// upsertContext writes to BOTH stores
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: upsertContext writes to both DB and file', async () => {
  const db = makeDbStore({});
  const file = makeFileStore({});
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const { key } = await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 'tok', refreshToken: 'ref', isAdmin: true
  });

  assert.equal(key, 'm1:a.bitrix24.ru:1');
  assert.equal(db.state._upsertCalls.length, 1, 'DB must receive upsert');
  assert.equal(file.state._upsertCalls.length, 1, 'file must receive upsert');
});

// ---------------------------------------------------------------------------
// getLastAdminContext — DB first, fallback file + seed
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: getLastAdminContext uses DB', async () => {
  const dbCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'admin-db', refreshToken: 'r', isAdmin: true };
  const db = makeDbStore({ 'm1:a.bitrix24.ru:1': dbCtx });
  const file = makeFileStore({});
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const entry = await store.getLastAdminContext();
  assert.ok(entry, 'should return admin entry');
  assert.equal(entry.context.authId, 'admin-db');
  assert.equal(db.state._upsertCalls.length, 0, 'no seeding needed');
});

test('compositeAuthContextStore: getLastAdminContext falls back to file and seeds DB', async () => {
  const fileCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'admin-file', refreshToken: 'r', isAdmin: true };
  const db = makeDbStore({});
  const file = makeFileStore({ 'm1:a.bitrix24.ru:1': fileCtx });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const entry = await store.getLastAdminContext();
  assert.ok(entry, 'should return admin entry from file');
  assert.equal(entry.context.authId, 'admin-file');
  // Seeding is fire-and-forget — drain microtasks
  await new Promise((r) => setImmediate(r));
  assert.equal(db.state._upsertCalls.length, 1, 'DB should have been seeded with file entry');
});

test('compositeAuthContextStore: getLastAdminContext returns null when no admin anywhere', async () => {
  const db = makeDbStore({});
  const file = makeFileStore({
    'm1:a.bitrix24.ru:1': { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 't', isAdmin: false }
  });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const result = await store.getLastAdminContext();
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// startup seed: if DB is empty and file has data — copy all to DB
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: seedFromFile copies all file entries to empty DB', async () => {
  const fileCtxA = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'ta', isAdmin: true, refreshToken: 'ra' };
  const fileCtxB = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 2, authId: 'tb', isAdmin: false, refreshToken: 'rb' };

  const db = makeDbStore({});
  const file = makeFileStore({
    'm1:a.bitrix24.ru:1': fileCtxA,
    'm1:a.bitrix24.ru:2': fileCtxB
  });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  await store.seedFromFile();

  assert.equal(db.state._upsertCalls.length, 2, 'both file entries should be seeded');
});

test('compositeAuthContextStore: seedFromFile skips when DB already has data', async () => {
  const dbCtx = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'db-exists', isAdmin: true, refreshToken: 'r' };
  const fileCtx = { memberId: 'm2', domain: 'b.bitrix24.ru', userId: 3, authId: 'file-new', isAdmin: false, refreshToken: 'r2' };

  const db = makeDbStore({ 'm1:a.bitrix24.ru:1': dbCtx });
  const file = makeFileStore({ 'm2:b.bitrix24.ru:3': fileCtx });
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  await store.seedFromFile();

  assert.equal(db.state._upsertCalls.length, 0, 'should not seed when DB already has entries');
});

// ---------------------------------------------------------------------------
// listContexts — DB primary
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: listContexts reads from DB', async () => {
  const db = makeDbStore({
    'm1:a.bitrix24.ru:1': { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 't1', isAdmin: false, refreshToken: 'r1' },
    'm1:a.bitrix24.ru:2': { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 2, authId: 't2', isAdmin: false, refreshToken: 'r2' }
  });
  const file = makeFileStore({});
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  const list = await store.listContexts();
  assert.equal(list.length, 2);
});

// ---------------------------------------------------------------------------
// flush — calls both stores
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: flush calls both DB and file flush', async () => {
  const db = makeDbStore({});
  const file = makeFileStore({});
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file });

  await store.flush();

  assert.equal(db.state._flushCalled, true);
  assert.equal(file.state._flushCalled, true);
});

// ---------------------------------------------------------------------------
// ensureSchema delegates to dbStore
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: ensureSchema delegates to dbStore', async () => {
  let called = false;
  const db = { ...makeDbStore(), async ensureSchema() { called = true; } };
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: makeFileStore() });
  await store.ensureSchema();
  assert.equal(called, true);
});

// ---------------------------------------------------------------------------
// Missing stores → throws
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: throws when dbStore is missing', () => {
  assert.throws(
    () => createCompositeAuthContextStore({ fileStore: makeFileStore() }),
    /dbStore.*required/i
  );
});

test('compositeAuthContextStore: throws when fileStore is missing', () => {
  assert.throws(
    () => createCompositeAuthContextStore({ dbStore: makeDbStore() }),
    /fileStore.*required/i
  );
});

// ---------------------------------------------------------------------------
// I1 resilience: DB fails → file still written, no throw (single failure)
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: DB write fails → file is written, does not throw', async () => {
  const warnCalls = [];
  const logger = { warn: (msg, meta) => warnCalls.push({ msg, meta }) };

  const input = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'tok', refreshToken: 'ref', isAdmin: false };

  const db = {
    ...makeDbStore(),
    async upsertContext() {
      throw new Error('connection refused');
    }
  };
  const file = makeFileStore();
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file, logger });

  // Must not throw — DB failure is non-fatal when file succeeds
  await assert.doesNotReject(() => store.upsertContext(input));

  // File must have been written despite DB failure
  assert.equal(file.state._upsertCalls.length, 1, 'file must receive upsert even when DB fails');
  assert.equal(file.state._upsertCalls[0].authId, 'tok');

  // DB failure must be logged
  const dbWarn = warnCalls.find((c) => c.msg === 'compositeAuthContextStore.db_write_failed');
  assert.ok(dbWarn, 'DB failure must be logged');
  assert.match(dbWarn.meta.message, /connection refused/i);
});

// ---------------------------------------------------------------------------
// I1 resilience: both stores fail → throws
// ---------------------------------------------------------------------------
test('compositeAuthContextStore: both stores fail → throws', async () => {
  const warnCalls = [];
  const logger = { warn: (msg, meta) => warnCalls.push({ msg, meta }) };

  const input = { memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 'tok', refreshToken: 'ref', isAdmin: false };

  const db = {
    ...makeDbStore(),
    async upsertContext() { throw new Error('db down'); }
  };
  const file = {
    ...makeFileStore(),
    async upsertContext() { throw new Error('disk full'); }
  };
  const store = createCompositeAuthContextStore({ dbStore: db, fileStore: file, logger });

  await assert.rejects(
    () => store.upsertContext(input),
    /db down/i,
    'must throw when both stores fail'
  );

  // Both failures must be logged
  assert.ok(warnCalls.some((c) => c.msg === 'compositeAuthContextStore.db_write_failed'), 'DB failure must be logged');
  assert.ok(warnCalls.some((c) => c.msg === 'compositeAuthContextStore.file_write_failed'), 'file failure must be logged');
});
