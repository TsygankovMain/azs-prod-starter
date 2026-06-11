import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseAuthContextStore } from '../src/auth/databaseAuthContextStore.js';

// ---------------------------------------------------------------------------
// Fake pool helpers
// ---------------------------------------------------------------------------
const makePgPool = (rows = []) => ({
  _calls: [],
  async query(sql, params) {
    this._calls.push({ sql, params });
    return { rows };
  }
});

const makeMysqlPool = (rows = []) => ({
  _calls: [],
  async execute(sql, params) {
    this._calls.push({ sql, params });
    return [rows];
  }
});

// ---------------------------------------------------------------------------
// ensureSchema — PostgreSQL
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: ensureSchema creates auth_context table (pg)', async () => {
  const pool = makePgPool();
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  assert.ok(pool._calls.length >= 1, 'expected at least one query call');
  const ddl = pool._calls[0].sql;
  assert.ok(ddl.includes('auth_context'), 'DDL must reference auth_context table');
  assert.ok(ddl.includes('key'), 'DDL must define key column');
  assert.ok(ddl.includes('is_admin'), 'DDL must define is_admin column');
});

// ---------------------------------------------------------------------------
// ensureSchema — MySQL
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: ensureSchema creates auth_context table (mysql)', async () => {
  const pool = makeMysqlPool();
  const store = createDatabaseAuthContextStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  assert.ok(pool._calls.length >= 1);
  const ddl = pool._calls[0].sql;
  assert.ok(ddl.includes('auth_context'));
  assert.ok(ddl.includes('is_admin'));
});

// ---------------------------------------------------------------------------
// upsertContext + getContextByKey — PG
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: upsertContext stores and getContextByKey retrieves (pg)', async () => {
  const stored = {};
  const pool = {
    _calls: [],
    async query(sql, params) {
      this._calls.push({ sql, params });
      if (/ON CONFLICT/i.test(sql)) {
        const key = params[0];
        stored[key] = { payload: params[1], is_admin: params[2] };
        return { rows: [] };
      }
      if (/SELECT.*WHERE/i.test(sql)) {
        const key = params[0];
        if (stored[key]) {
          return {
            rows: [{
              key,
              payload: stored[key].payload,
              is_admin: stored[key].is_admin,
              updated_at: new Date().toISOString(),
              last_admin_at: null
            }]
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  const { key } = await store.upsertContext({
    memberId: 'm1',
    domain: 'a.bitrix24.ru',
    userId: 1,
    authId: 'tok-1',
    refreshToken: 'ref-1',
    isAdmin: true
  });
  assert.equal(key, 'm1:a.bitrix24.ru:1');

  const ctx = await store.getContextByKey(key);
  assert.ok(ctx, 'context should be found');
  assert.equal(ctx.authId, 'tok-1');
  assert.equal(ctx.refreshToken, 'ref-1');
  assert.equal(ctx.isAdmin, true);
});

// ---------------------------------------------------------------------------
// Partial upsert does NOT wipe refreshToken (key merge-semantics test)
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: partial upsert preserves refreshToken and isAdmin (pg)', async () => {
  const stored = {};
  const pool = {
    _calls: [],
    async query(sql, params) {
      this._calls.push({ sql, params });
      if (/SELECT.*WHERE/i.test(sql)) {
        const key = params[0];
        const row = stored[key];
        if (!row) return { rows: [] };
        return {
          rows: [{
            key,
            payload: row.payload,
            is_admin: row.is_admin,
            updated_at: new Date().toISOString(),
            last_admin_at: null
          }]
        };
      }
      if (/ON CONFLICT/i.test(sql)) {
        const key = params[0];
        stored[key] = { payload: params[1], is_admin: params[2] };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });

  // Full upsert — sets refreshToken and isAdmin
  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 'old-tok', refreshToken: 'keep-me', isAdmin: true
  });

  // Partial upsert — only a new authId, no refreshToken
  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 'new-tok'
  });

  const ctx = await store.getContextByKey('m1:a.bitrix24.ru:1');
  assert.equal(ctx.authId, 'new-tok', 'authId should update');
  assert.equal(ctx.refreshToken, 'keep-me', 'refreshToken must be preserved');
  assert.equal(ctx.isAdmin, true, 'isAdmin must be preserved');
});

// ---------------------------------------------------------------------------
// getContext (by identity tuple) — PG
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: getContext returns null for unknown identity (pg)', async () => {
  const pool = makePgPool([]);
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  const result = await store.getContext({ memberId: 'x', domain: 'y.bitrix24.ru', userId: 1 });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// getLastAdminContext — PG
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: getLastAdminContext returns the last admin row (pg)', async () => {
  const now = new Date().toISOString();
  const ctx = {
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 'tok', refreshToken: 'r', isAdmin: true,
    verifiedAt: '', appSid: '', refreshTokenIssuedAt: '', updatedAt: now
  };
  const row = {
    key: 'm1:a.bitrix24.ru:1',
    payload: JSON.stringify(ctx),
    is_admin: true,
    updated_at: now,
    last_admin_at: now
  };
  const pool = makePgPool([row]);
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  const entry = await store.getLastAdminContext();
  assert.ok(entry, 'should return an entry');
  assert.equal(entry.context.isAdmin, true);
  assert.equal(entry.key, 'm1:a.bitrix24.ru:1');
});

test('databaseAuthContextStore: getLastAdminContext returns null when no admin row (pg)', async () => {
  const pool = makePgPool([]);
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  const result = await store.getLastAdminContext();
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// listContexts — PG
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: listContexts returns all rows (pg)', async () => {
  const now = new Date().toISOString();
  const mkCtx = (userId) => ({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId,
    authId: `t${userId}`, refreshToken: `r${userId}`,
    isAdmin: false, verifiedAt: '', appSid: '', refreshTokenIssuedAt: '', updatedAt: now
  });
  const rows = [
    { key: 'm1:a.bitrix24.ru:1', payload: JSON.stringify(mkCtx(1)), is_admin: false, updated_at: now, last_admin_at: null },
    { key: 'm1:a.bitrix24.ru:2', payload: JSON.stringify(mkCtx(2)), is_admin: false, updated_at: now, last_admin_at: null }
  ];
  const pool = makePgPool(rows);
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  const list = await store.listContexts();
  assert.equal(list.length, 2);
  assert.ok(list.every((e) => typeof e.key === 'string' && e.context));
});

// ---------------------------------------------------------------------------
// flush — no-op (returns resolved promise)
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: flush resolves immediately (pg)', async () => {
  const pool = makePgPool();
  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });
  await assert.doesNotReject(() => store.flush());
});

// ---------------------------------------------------------------------------
// MySQL variant — partial coverage to confirm SQL dialect
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: upsertContext works with mysql pool', async () => {
  const stored = {};
  const pool = {
    _calls: [],
    async execute(sql, params) {
      this._calls.push({ sql, params });
      if (/SELECT.*WHERE/i.test(sql)) {
        const key = params[0];
        const row = stored[key];
        if (!row) return [[]];
        return [[{
          key,
          payload: row.payload,
          is_admin: row.is_admin,
          updated_at: new Date().toISOString(),
          last_admin_at: null
        }]];
      }
      if (/ON DUPLICATE/i.test(sql)) {
        const key = params[0];
        stored[key] = { payload: params[1], is_admin: params[2] };
        return [[]];
      }
      return [[]];
    }
  };

  const store = createDatabaseAuthContextStore({ pool, dbType: 'mysql' });
  const { key } = await store.upsertContext({
    memberId: 'm1', domain: 'b.bitrix24.ru', userId: 7,
    authId: 'mysql-tok', refreshToken: 'mysql-ref', isAdmin: false
  });
  assert.equal(key, 'm1:b.bitrix24.ru:7');
  const ctx = await store.getContextByKey(key);
  assert.equal(ctx.authId, 'mysql-tok');
});

// ---------------------------------------------------------------------------
// Missing pool → throws
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: throws when pool is missing', () => {
  assert.throws(
    () => createDatabaseAuthContextStore({}),
    /pool is required/i
  );
});

// ---------------------------------------------------------------------------
// Concurrent upserts do not lose fields (C1 — serialisation regression test)
//
// Simulates the token-rotation race: a background onTokenRefreshed and an
// in-flight /api/getToken each call upsertContext concurrently.
// Without the writeChain serialisation the two calls both read the same
// pre-write snapshot and the slower write silently overwrites the faster one,
// losing the refreshToken OR the verifiedAt update.
//
// The fake pool introduces a one-tick await-hop between SELECT and INSERT so
// the race window is clearly open at test time.
// ---------------------------------------------------------------------------
test('databaseAuthContextStore: handles concurrent upserts without loss (pg)', async () => {
  const stored = {};

  // Pool with explicit microtask delay between SELECT and INSERT to reproduce
  // the interleaving that causes data loss without the writeChain fix.
  const pool = {
    _calls: [],
    async query(sql, params) {
      this._calls.push({ sql, params });

      if (/SELECT.*WHERE/i.test(sql)) {
        // Yield to the event loop so the second concurrent call can start its
        // SELECT before either write has committed.
        await new Promise((r) => setImmediate(r));
        const key = params[0];
        const row = stored[key];
        if (!row) return { rows: [] };
        return {
          rows: [{
            key,
            payload: row.payload,
            is_admin: row.is_admin,
            updated_at: new Date().toISOString(),
            last_admin_at: null
          }]
        };
      }

      if (/ON CONFLICT/i.test(sql)) {
        await new Promise((r) => setImmediate(r));
        const key = params[0];
        stored[key] = { payload: params[1], is_admin: params[2] };
        return { rows: [] };
      }

      return { rows: [] };
    }
  };

  const store = createDatabaseAuthContextStore({ pool, dbType: 'postgresql' });

  // Seed full context first (sequential — baseline state)
  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 'old-tok', refreshToken: 'original-ref',
    isAdmin: true, verifiedAt: '2026-01-01T00:00:00.000Z'
  });

  const verifiedAtNew = '2026-06-11T12:00:00.000Z';

  // Fire both concurrent partial upserts simultaneously — the race window is
  // open: without serialisation one will read stale data and overwrite the
  // other's field.
  await Promise.all([
    // Simulates onTokenRefreshed: only updates refreshToken
    store.upsertContext({
      memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
      authId: 'old-tok', refreshToken: 'NEW-refresh-token'
    }),
    // Simulates getToken: only updates verifiedAt
    store.upsertContext({
      memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
      authId: 'old-tok', verifiedAt: verifiedAtNew
    })
  ]);

  const ctx = await store.getContextByKey('m1:a.bitrix24.ru:1');
  assert.ok(ctx, 'context must exist');
  assert.equal(ctx.refreshToken, 'NEW-refresh-token', 'refreshToken must not be lost after concurrent writes');
  assert.equal(ctx.verifiedAt, verifiedAtNew, 'verifiedAt must not be lost after concurrent writes');
  assert.equal(ctx.isAdmin, true, 'isAdmin must be preserved');
});
