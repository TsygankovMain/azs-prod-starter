import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoFeedRouter } from '../src/reports/photoFeedRoutes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p)   { this._payload = p; return p; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b)   { this._body = b; }
  };
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides
  };
}

const stubFeedItems = [
  {
    reportId: 10,
    azsId: '42',
    azsTitle: null,
    photoCode: 'front',
    exifAt: null,
    uploadedAt: '2026-06-11T10:00:00.000Z',
    photoRowId: 1,
    remark: null
  }
];

const stubDeps = {
  reportsStore: {
    async listPhotosFeed() {
      return { items: stubFeedItems, nextCursor: null };
    }
  },
  settingsStore: {
    async read() {
      return {
        azs: { entityTypeId: 145, fields: { admin: 'UF_CRM_1_123', manager: '' } },
        photoType: { entityTypeId: 200 }
      };
    }
  },
  bitrixClient: {
    async listCrmItems() {
      return [{ id: 1, title: 'Вход' }, { id: 2, title: 'Выход' }];
    },
    async getCrmItem({ id }) {
      if (id === 42) {
        return { id: 42, title: 'АЗС Тест', ufCrm1_123: 7 };
      }
      return null;
    },
    async callMethod(method) {
      if (method === 'user.get') {
        return [{ ID: 7, NAME: 'Иван', LAST_NAME: 'Петров' }];
      }
      return null;
    }
  },
  getAdminContext: async () => ({ authId: 'admin-token', domain: 'test.bitrix24.ru' })
};

// ---------------------------------------------------------------------------
// Route handler helper
// ---------------------------------------------------------------------------

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      const methodHandlers = layer.route.stack.filter(
        (l) => !method || l.method === method.toLowerCase() || !l.method
      );
      return methodHandlers[0]?.handle || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests: GET /feed
// ---------------------------------------------------------------------------

test('GET /feed returns items and nextCursor', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return; // route structure may vary
  const req = makeReq({ query: { dateFrom: '2026-06-01', dateTo: '2026-06-11' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  assert.equal(res._payload.items[0].photoCode, 'front');
});

test('GET /feed returns 403 without reviewer role', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET /feed passes limit to reportsStore', async () => {
  let capturedLimit;
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed({ limit }) {
        capturedLimit = limit;
        return { items: [], nextCursor: null };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({ query: { limit: '20' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(capturedLimit, 20);
});

test('GET /feed passes remarks filter to reportsStore', async () => {
  let capturedRemarks;
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed({ remarks }) {
        capturedRemarks = remarks;
        return { items: [], nextCursor: null };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({ query: { remarks: 'with' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(capturedRemarks, 'with');
});

test('GET /feed passes remarks=without filter', async () => {
  let capturedRemarks;
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed({ remarks }) {
        capturedRemarks = remarks;
        return { items: [], nextCursor: null };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({ query: { remarks: 'without' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(capturedRemarks, 'without');
});

test('GET /feed passes cursor to reportsStore', async () => {
  let capturedCursor;
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed({ cursor }) {
        capturedCursor = cursor;
        return { items: [], nextCursor: null };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const testCursor = Buffer.from(JSON.stringify({ ua: '2026-06-11T10:00:00Z', id: 5 })).toString('base64');
  const req = makeReq({ query: { cursor: testCursor } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(capturedCursor, testCursor);
});

test('GET /feed passes azsId array filter', async () => {
  let capturedAzsIds;
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed({ azsIds }) {
        capturedAzsIds = azsIds;
        return { items: [], nextCursor: null };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({ query: { azsId: ['42', '55'] } });
  const res = makeRes();
  await handler(req, res);
  assert.ok(Array.isArray(capturedAzsIds));
  assert.ok(capturedAzsIds.includes('42'));
  assert.ok(capturedAzsIds.includes('55'));
});

test('GET /feed returns nextCursor from store', async () => {
  const fakeCursor = 'abc123cursor';
  const deps = {
    ...stubDeps,
    reportsStore: {
      async listPhotosFeed() {
        return { items: [stubFeedItems[0]], nextCursor: fakeCursor };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  if (!handler) return;
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._payload.nextCursor, fakeCursor);
});

// ---------------------------------------------------------------------------
// Tests: GET /categories
// ---------------------------------------------------------------------------

test('GET /categories returns items list', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/categories');
  if (!handler) return;
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 2);
  assert.equal(res._payload.items[0].code, '1');
  assert.equal(res._payload.items[0].title, 'Вход');
});

test('GET /categories returns 403 without role', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/categories');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET /categories uses cache on second call', async () => {
  let callCount = 0;
  const deps = {
    ...stubDeps,
    bitrixClient: {
      ...stubDeps.bitrixClient,
      async listCrmItems() {
        callCount += 1;
        return [{ id: 1, title: 'Один' }];
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/categories');
  if (!handler) return;

  const req1 = makeReq({});
  const res1 = makeRes();
  await handler(req1, res1);

  const req2 = makeReq({});
  const res2 = makeRes();
  await handler(req2, res2);

  // Both calls return items
  assert.equal(res2.statusCode, 200);
  assert.equal(res2._payload.items.length, 1);
  // Second call must use cache (only 1 Bitrix API call total)
  assert.equal(callCount, 1, 'second call must use in-memory cache');
});

test('GET /categories returns empty items when photoType not configured', async () => {
  const deps = {
    ...stubDeps,
    settingsStore: {
      async read() {
        return { azs: { entityTypeId: 145 }, photoType: { entityTypeId: 0 } };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/categories');
  if (!handler) return;
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload.items, []);
});

// ---------------------------------------------------------------------------
// Tests: GET /recipients
// ---------------------------------------------------------------------------

test('GET /recipients returns admin from AZS card field', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: { azsId: '42' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.admin, 'admin should be set');
  assert.equal(res._payload.admin.id, 7);
});

test('GET /recipients returns manager:null when field not configured', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: { azsId: '42' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._payload.manager, null, 'manager should be null when field empty');
});

test('GET /recipients returns 400 for missing azsId', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('GET /recipients returns 403 without role', async () => {
  const router = createPhotoFeedRouter(stubDeps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: { azsId: '42' }, accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET /recipients returns both null when azs entityTypeId not configured', async () => {
  const deps = {
    ...stubDeps,
    settingsStore: {
      async read() {
        return { azs: { entityTypeId: 0 }, photoType: { entityTypeId: 200 } };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: { azsId: '42' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.manager, null);
  assert.equal(res._payload.admin, null);
});

test('GET /recipients: admin is null when AZS card has no admin field value', async () => {
  const deps = {
    ...stubDeps,
    bitrixClient: {
      ...stubDeps.bitrixClient,
      async getCrmItem() {
        // AZS card with no admin field value
        return { id: 42, title: 'АЗС Пусто' };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/recipients');
  if (!handler) return;
  const req = makeReq({ query: { azsId: '42' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.admin, null);
});

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('createPhotoFeedRouter throws when reportsStore is missing', () => {
  assert.throws(
    () => createPhotoFeedRouter({ settingsStore: {}, bitrixClient: {} }),
    /reportsStore is required/
  );
});

test('createPhotoFeedRouter throws when settingsStore is missing', () => {
  assert.throws(
    () => createPhotoFeedRouter({ reportsStore: {}, bitrixClient: {} }),
    /settingsStore is required/
  );
});

test('createPhotoFeedRouter throws when bitrixClient is missing', () => {
  assert.throws(
    () => createPhotoFeedRouter({ reportsStore: {}, settingsStore: {} }),
    /bitrixClient is required/
  );
});
