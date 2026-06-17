/**
 * usersSearch.test.js — тесты GET /api/users/search (FEED-2 BE-2).
 *
 * Покрываемые сценарии:
 *   - маппинг user.search → { id, name, position }
 *   - пустой q → [] без вызова Bitrix
 *   - q < 2 символа → [] без вызова Bitrix
 *   - ошибка Bitrix → [] + не бросает (деградация)
 *   - исключение не-активных (ACTIVE !== 'Y')
 *   - доступ только reviewer/settings (403 иначе)
 *   - name = NAME + LAST_NAME, фоллбек на LOGIN
 *   - position = WORK_POSITION (null если пусто)
 *   - id — number
 *   - лимит: не более 20 результатов
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsersRouter } from '../src/users/usersRoutes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this._payload = p; return p; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b) { this._body = b; }
  };
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    user: { id: 3, user_id: 3 },
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const makeUser = (overrides = {}) => ({
  ID: 1,
  NAME: 'Иван',
  LAST_NAME: 'Петров',
  ACTIVE: 'Y',
  WORK_POSITION: 'Менеджер',
  ...overrides
});

function makeFakeBitrixClient(users = [], throwError = null) {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async callMethod(method, _params, _context) {
      if (throwError) throw throwError;
      callCount += 1;
      if (method === 'user.search') {
        return users;
      }
      return [];
    }
  };
}

const stubDeps = {
  bitrixClient: makeFakeBitrixClient([makeUser()]),
  getAdminContext: async () => ({ authId: 'admin-token', domain: 'test.bitrix24.ru' })
};

// ---------------------------------------------------------------------------
// Route handler helper (same pattern as photoRemarkRoutes.test.js)
// ---------------------------------------------------------------------------

function findRoute(router, method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const route = layer.route;
      if (route.path === pathPattern) {
        const h = route.stack.find((l) => l.method === method.toLowerCase());
        return h?.handle || null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests — access guard
// ---------------------------------------------------------------------------

test('GET /search returns 403 without reviewer or settings capability', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');
  assert.ok(handler, 'route /search should exist');

  const req = makeReq({ query: { q: 'Иван' }, accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET /search allows settings capability (admin)', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({
    query: { q: 'Ив' },
    accessContext: { capabilities: { settings: true } }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Tests — short/empty q → [] without Bitrix call
// ---------------------------------------------------------------------------

test('GET /search with empty q returns {items:[]} without calling Bitrix', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: '' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload, { items: [] });
  assert.equal(client.callCount, 0, 'Bitrix must not be called for empty q');
});

test('GET /search with q of 1 char returns {items:[]} without calling Bitrix', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'И' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload, { items: [] });
  assert.equal(client.callCount, 0, 'Bitrix must not be called for 1-char q');
});

test('GET /search with missing q returns {items:[]} without calling Bitrix', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload, { items: [] });
  assert.equal(client.callCount, 0, 'Bitrix must not be called for missing q');
});

// ---------------------------------------------------------------------------
// Tests — mapping user.search result → { id, name, position }
// ---------------------------------------------------------------------------

test('GET /search maps user fields to {id, name, position}', async () => {
  const users = [
    makeUser({ ID: 7, NAME: 'Анна', LAST_NAME: 'Сидорова', WORK_POSITION: 'Директор', ACTIVE: 'Y' })
  ];
  const client = makeFakeBitrixClient(users);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Ан' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  const item = res._payload.items[0];
  assert.equal(typeof item.id, 'number', 'id must be a number');
  assert.equal(item.id, 7);
  assert.equal(item.name, 'Анна Сидорова');
  assert.equal(item.position, 'Директор');
});

test('GET /search sets name to LOGIN when NAME and LAST_NAME are both empty', async () => {
  const users = [
    makeUser({ ID: 5, NAME: '', LAST_NAME: '', LOGIN: 'user5', ACTIVE: 'Y' })
  ];
  const client = makeFakeBitrixClient(users);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'us' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.equal(item.name, 'user5', 'should fall back to LOGIN');
});

test('GET /search returns position as null when WORK_POSITION is empty', async () => {
  const users = [
    makeUser({ ID: 3, NAME: 'Борис', LAST_NAME: 'К', WORK_POSITION: '', ACTIVE: 'Y' })
  ];
  const client = makeFakeBitrixClient(users);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Бо' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.equal(item.position, null, 'position should be null when WORK_POSITION is empty');
});

// ---------------------------------------------------------------------------
// Tests — only active users
// ---------------------------------------------------------------------------

test('GET /search filters out non-active users (ACTIVE !== Y)', async () => {
  const users = [
    makeUser({ ID: 1, NAME: 'Активный', ACTIVE: 'Y' }),
    makeUser({ ID: 2, NAME: 'Неактивный', ACTIVE: 'N' }),
    makeUser({ ID: 3, NAME: 'Без флага', ACTIVE: undefined })
  ];
  const client = makeFakeBitrixClient(users);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'ти' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 1, 'only 1 active user');
  assert.equal(res._payload.items[0].id, 1);
});

// ---------------------------------------------------------------------------
// Tests — Bitrix error → graceful degradation
// ---------------------------------------------------------------------------

test('GET /search returns {items:[]} on Bitrix error (no 500)', async () => {
  const errorClient = makeFakeBitrixClient([], new Error('Bitrix REST user.search error: ACCESS_DENIED'));
  const router = createUsersRouter({ bitrixClient: errorClient, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Иван' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, 'must not return 500 on Bitrix error');
  assert.deepEqual(res._payload, { items: [] });
});

test('GET /search returns {items:[]} when getAdminContext throws', async () => {
  const client = makeFakeBitrixClient([makeUser()]);
  const router = createUsersRouter({
    bitrixClient: client,
    getAdminContext: async () => { throw new Error('context_unavailable'); }
  });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Иван' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, 'must not 500 when admin context fails');
  assert.ok(Array.isArray(res._payload?.items));
});

// ---------------------------------------------------------------------------
// Tests — limit to 20
// ---------------------------------------------------------------------------

test('GET /search returns at most 20 items', async () => {
  const manyUsers = Array.from({ length: 30 }, (_, i) => makeUser({ ID: i + 1, NAME: `User${i}`, ACTIVE: 'Y' }));
  const client = makeFakeBitrixClient(manyUsers);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Us' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res._payload.items.length <= 20, 'must not return more than 20');
});

// ---------------------------------------------------------------------------
// Tests — factory validation
// ---------------------------------------------------------------------------

test('createUsersRouter throws when bitrixClient is missing', () => {
  assert.throws(
    () => createUsersRouter({ getAdminContext: async () => ({}) }),
    /bitrixClient is required/
  );
});

// ---------------------------------------------------------------------------
// FEED-USERS fix — контекст авторизации и параметры запроса
// ---------------------------------------------------------------------------

// Capturing client — фиксирует method/params/context каждого вызова
function makeCapturingClient(users = []) {
  const calls = [];
  return {
    calls,
    async callMethod(method, params, context) {
      calls.push({ method, params, context });
      return users;
    }
  };
}

test('GET /search: при пустом admin-контексте ищет под OAuth проверяющего (а не под пустым)', async () => {
  const client = makeCapturingClient([makeUser()]);
  const router = createUsersRouter({
    bitrixClient: client,
    getAdminContext: async () => ({}) // admin протух (BUG-022) → пустой объект
  });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({
    query: { q: 'Иван' },
    bitrixContext: { authId: 'reviewer-token', domain: 'p.bitrix24.ru' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(client.calls.length, 1, 'user.search должен быть вызван');
  assert.equal(
    client.calls[0].context?.authId,
    'reviewer-token',
    'при пустом admin-контексте поиск идёт под OAuth проверяющего, иначе уходит без авторизации → пусто'
  );
});

test('GET /search: использует валидный admin-контекст, когда он есть', async () => {
  const client = makeCapturingClient([makeUser()]);
  const router = createUsersRouter({
    bitrixClient: client,
    getAdminContext: async () => ({ authId: 'admin-token', domain: 'p.bitrix24.ru' })
  });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Иван' }, bitrixContext: { authId: 'reviewer-token' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(client.calls[0].context?.authId, 'admin-token', 'живой admin-контекст имеет приоритет');
});

test('GET /search: шлёт FIND без конфликтующих ACTIVE/START (Б24: FIND только один)', async () => {
  const client = makeCapturingClient([makeUser()]);
  const router = createUsersRouter({ bitrixClient: client, getAdminContext: stubDeps.getAdminContext });
  const handler = findRoute(router, 'get', '/search');

  const req = makeReq({ query: { q: 'Иван' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].params.FIND, 'Иван', 'должен искать по FIND');
  assert.equal(client.calls[0].params.ACTIVE, undefined, 'ACTIVE не должен идти рядом с FIND');
  assert.equal(client.calls[0].params.START, undefined, 'START не должен идти рядом с FIND');
});
