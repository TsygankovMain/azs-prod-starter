/**
 * TDD tests for batchResolveAzsTitles — BUG-021.
 *
 * Covers:
 *  1. Single listCrmItems call (no per-row getCrmItem)
 *  2. Returns Map<id, title>
 *  3. Rows decorated from the map in GET /analytics/rating (R2)
 *  4. Rows decorated from the map in GET /analytics/day-photos (R2)
 *  5. Rows decorated from the map in GET / (R4 reports list)
 *  6. Graceful fallback on empty listCrmItems result
 *  7. Graceful fallback when listCrmItems throws
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { batchResolveAzsTitles, createReportsRouter } from '../src/reports/reportsRoutes.js';
import { createAnalyticsRouter } from '../src/reports/analyticsRoutes.js';
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

function makeSettings(entityTypeId = 145) {
  return { azs: { entityTypeId } };
}

// ---------------------------------------------------------------------------
// Unit tests: batchResolveAzsTitles itself
// ---------------------------------------------------------------------------

test('batchResolveAzsTitles: calls listCrmItems ONCE (not getCrmItem per id)', async () => {
  let getCrmItemCallCount = 0;
  let listCrmItemsCallCount = 0;
  let capturedListParams = null;

  const bitrixClient = {
    async getCrmItem() {
      getCrmItemCallCount++;
      return null;
    },
    async listCrmItems(params) {
      listCrmItemsCallCount++;
      capturedListParams = params;
      return [
        { id: 1, title: 'АЗС Север' },
        { id: 2, title: 'АЗС Юг' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['1', '2'], { bitrixClient, settings, context: {} });

  assert.equal(listCrmItemsCallCount, 1, 'listCrmItems must be called exactly once');
  assert.equal(getCrmItemCallCount, 0, 'getCrmItem must NOT be called');
  assert.ok(capturedListParams, 'listCrmItems must receive params');
  assert.equal(capturedListParams.entityTypeId, 145);
  assert.ok(capturedListParams.select.includes('id') || capturedListParams.select.includes('ID'), 'select must include id');
  assert.ok(capturedListParams.select.includes('title') || capturedListParams.select.includes('TITLE'), 'select must include title');
});

test('batchResolveAzsTitles: returns Map<string, {title,address}> id→{title,address}', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [
        { id: 10, title: 'АЗС Петрово' },
        { id: 20, title: 'АЗС Иваново' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['10', '20'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'result must be a Map');
  assert.equal(map.get('10')?.title, 'АЗС Петрово');
  assert.equal(map.get('20')?.title, 'АЗС Иваново');
});

test('batchResolveAzsTitles: numeric id keys in map (stringified)', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [{ id: 42, title: 'АЗС 42' }];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['42'], { bitrixClient, settings, context: {} });

  assert.equal(map.get('42')?.title, 'АЗС 42', 'map key must be string id, value.title must be resolved');
});

test('batchResolveAzsTitles: fallback title when item not found in list', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [{ id: 10, title: 'АЗС 10' }];
    }
  };

  const settings = makeSettings(145);
  // ID 99 not in the batch result
  const map = await batchResolveAzsTitles(['10', '99'], { bitrixClient, settings, context: {} });

  assert.equal(map.get('10')?.title, 'АЗС 10');
  // For missing id, fallback must be set (not undefined)
  assert.ok(map.has('99'), 'map must have entry for all requested ids');
  const fallback99 = map.get('99');
  assert.ok(fallback99 && typeof fallback99 === 'object', 'fallback must be an object');
  assert.ok(typeof fallback99.title === 'string', 'fallback.title must be a string');
  assert.ok(fallback99.title.includes('99'), 'fallback.title must reference the id');
});

test('batchResolveAzsTitles: graceful fallback on empty listCrmItems result', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['5'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'must return Map even on empty result');
  assert.ok(map.has('5'), 'map must have entry for all requested ids');
  const fallback5 = map.get('5');
  assert.ok(fallback5 && typeof fallback5 === 'object', 'fallback must be an object');
  assert.ok(typeof fallback5.title === 'string', 'fallback.title must be a string');
});

test('batchResolveAzsTitles: graceful fallback when listCrmItems throws', async () => {
  const bitrixClient = {
    async listCrmItems() {
      throw new Error('Bitrix network error');
    }
  };

  const settings = makeSettings(145);
  // Must not throw — returns fallback map
  const map = await batchResolveAzsTitles(['7'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'must return Map even when listCrmItems throws');
  assert.ok(map.has('7'), 'map must have entry for all requested ids');
  const fallback7 = map.get('7');
  assert.ok(fallback7 && typeof fallback7 === 'object', 'fallback must be an object');
  assert.ok(typeof fallback7.title === 'string', 'fallback.title must be a string');
});

test('batchResolveAzsTitles: returns empty Map when azsIds is empty array', async () => {
  let listCrmItemsCalled = false;
  const bitrixClient = {
    async listCrmItems() {
      listCrmItemsCalled = true;
      return [];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles([], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'must return Map');
  assert.equal(map.size, 0, 'must be empty for empty input');
  assert.equal(listCrmItemsCalled, false, 'should not call listCrmItems for empty input');
});

test('batchResolveAzsTitles: returns empty Map when entityTypeId not configured', async () => {
  let listCrmItemsCalled = false;
  const bitrixClient = {
    async listCrmItems() {
      listCrmItemsCalled = true;
      return [];
    }
  };

  const settings = makeSettings(0); // no entityTypeId
  const map = await batchResolveAzsTitles(['1'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'must return Map');
  assert.equal(listCrmItemsCalled, false, 'should not call listCrmItems when entityTypeId=0');
});

test('batchResolveAzsTitles: passes context to listCrmItems', async () => {
  let capturedContext = null;
  const bitrixClient = {
    async listCrmItems(params) {
      capturedContext = params.context;
      return [{ id: 1, title: 'АЗС' }];
    }
  };

  const settings = makeSettings(145);
  const ctx = { authId: 'test-admin', domain: 'test.bitrix24.ru' };
  await batchResolveAzsTitles(['1'], { bitrixClient, settings, context: ctx });

  assert.deepEqual(capturedContext, ctx, 'context must be passed to listCrmItems');
});

test('batchResolveAzsTitles: uses start:-1 (huge-data mode) via listCrmItems', async () => {
  // The spec says "huge-data start=-1 path". listCrmItems in bitrixRestClient
  // activates that path when order is {id:ASC} — our batch call must not pass
  // a custom order or a '>id' filter so the client takes the huge-data branch.
  let capturedParams = null;
  const bitrixClient = {
    async listCrmItems(params) {
      capturedParams = params;
      return [{ id: 5, title: 'АЗС Тест' }];
    }
  };

  const settings = makeSettings(145);
  await batchResolveAzsTitles(['5'], { bitrixClient, settings, context: {} });

  assert.ok(capturedParams, 'listCrmItems must be called');
  // Must use default id:ASC order (triggers huge-data path inside bitrixRestClient)
  const orderVal = capturedParams.order;
  const isDefaultOrder = orderVal && (orderVal.id === 'ASC' || orderVal.ID === 'ASC');
  assert.ok(isDefaultOrder, 'order must be {id:ASC} to trigger huge-data path');
  // Must have a high limit
  assert.ok(Number(capturedParams.limit) >= 1000, 'limit should be large for batch fetch');
});

// ---------------------------------------------------------------------------
// Integration: GET /analytics/rating uses batch (one listCrmItems call, not per-row getCrmItem)
// ---------------------------------------------------------------------------

test('GET /analytics/rating: uses single batchResolveAzsTitles call, not per-row getCrmItem', async () => {
  let getCrmItemCallCount = 0;
  let listCrmItemsCallCount = 0;

  const deps = {
    analyticsStore: {
      async getRating() {
        return [
          { azsId: '10', total: 5, onTime: 4, late: 1, avgMinutes: 10 },
          { azsId: '20', total: 3, onTime: 2, late: 1, avgMinutes: 15 }
        ];
      },
      async getTrend() { return []; },
      async getDayPhotos() { return []; }
    },
    reportsStore: { async listPhotos() { return []; } },
    bitrixClient: {
      async getCrmItem() {
        getCrmItemCallCount++;
        return null;
      },
      async listCrmItems() {
        listCrmItemsCallCount++;
        return [
          { id: 10, title: 'АЗС Северная' },
          { id: 20, title: 'АЗС Южная' }
        ];
      }
    },
    settingsStore: { async read() { return { azs: { entityTypeId: 145 } }; } },
    diskApi: null
  };

  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/rating')?.route?.stack[0]?.handle;
  if (!handler) return;

  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 2);

  // Key assertion: one batch call, not per-row
  assert.equal(listCrmItemsCallCount, 1, 'must use ONE listCrmItems call for all rows');
  assert.equal(getCrmItemCallCount, 0, 'must NOT use getCrmItem per row');

  // Titles must be resolved
  const azsIds = res._payload.items.map(i => i.azsId);
  const titles = res._payload.items.map(i => i.azsTitle);
  assert.ok(titles.includes('АЗС Северная'), 'title АЗС Северная must be resolved');
  assert.ok(titles.includes('АЗС Южная'), 'title АЗС Южная must be resolved');
});

// ---------------------------------------------------------------------------
// Integration: GET /analytics/day-photos uses batch
// ---------------------------------------------------------------------------

test('GET /analytics/day-photos: uses single batchResolveAzsTitles call, not per-row getCrmItem', async () => {
  let getCrmItemCallCount = 0;
  let listCrmItemsCallCount = 0;

  const deps = {
    analyticsStore: {
      async getRating() { return []; },
      async getTrend() { return []; },
      async getDayPhotos() {
        return [
          { azsId: '30', date: '2026-06-12', count: 2 },
          { azsId: '40', date: '2026-06-12', count: 1 }
        ];
      }
    },
    reportsStore: { async listPhotos() { return []; } },
    bitrixClient: {
      async getCrmItem() {
        getCrmItemCallCount++;
        return null;
      },
      async listCrmItems() {
        listCrmItemsCallCount++;
        return [
          { id: 30, title: 'АЗС Восток' },
          { id: 40, title: 'АЗС Запад' }
        ];
      }
    },
    settingsStore: { async read() { return { azs: { entityTypeId: 145 } }; } },
    diskApi: null
  };

  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/day-photos')?.route?.stack[0]?.handle;
  if (!handler) return;

  const req = makeReq({ query: { date: '2026-06-12' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(listCrmItemsCallCount, 1, 'must use ONE listCrmItems call for all rows');
  assert.equal(getCrmItemCallCount, 0, 'must NOT use getCrmItem per row');

  const titles = res._payload.items.map(i => i.azsTitle);
  assert.ok(titles.includes('АЗС Восток'), 'title must be resolved');
  assert.ok(titles.includes('АЗС Запад'), 'title must be resolved');
});

// ---------------------------------------------------------------------------
// Integration: GET / (reports list / R4) uses batch
// ---------------------------------------------------------------------------

function makeMinimalDeps(overrides = {}) {
  return {
    reportsStore: {
      async list() { return []; },
      async getById() { return null; },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    settingsStore: {
      async read() {
        return {
          timezone: 'Europe/Moscow',
          azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET', admin: 'UF_ADMIN' } },
          photoType: { entityTypeId: 1112 },
          report: { entityTypeId: 163, fields: { folderId: 'UF_FOLDER' } }
        };
      }
    },
    bitrixClient: {
      diskApi: {},
      async getCrmItem() { return null; },
      async listCrmItems() { return []; }
    },
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore: { async getLastAdminContext() { return null; } },
    dispatchService: {},
    crmSyncJobStore: {
      async enqueue() { return { id: 1 }; },
      async listByReport() { return []; }
    },
    ...overrides
  };
}

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l?.route?.path === path && l?.route?.methods?.[method]
  );
  if (!layer) return null;
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

test('GET / (reports list): uses single batchResolveAzsTitles call, not per-row getCrmItem', async () => {
  let getCrmItemCallCount = 0;
  let listCrmItemsCallCount = 0;

  const fakeItems = [
    { id: 1, slotKey: '2026-06-12:0800', azsId: '50', adminUserId: 10, status: 'done', errorText: null, reportItemId: null, jitterMinutes: null, scheduledAt: null, deadlineAt: null, diskFolderId: null, createdAt: null, updatedAt: null },
    { id: 2, slotKey: '2026-06-12:1000', azsId: '60', adminUserId: 11, status: 'done', errorText: null, reportItemId: null, jitterMinutes: null, scheduledAt: null, deadlineAt: null, diskFolderId: null, createdAt: null, updatedAt: null }
  ];

  const deps = makeMinimalDeps({
    reportsStore: {
      async list() { return fakeItems; },
      async getById() { return null; },
      async listPhotos() { return []; },
      async setReportStatus() {}
    },
    bitrixClient: {
      diskApi: {},
      async getCrmItem() {
        getCrmItemCallCount++;
        return null;
      },
      async listCrmItems() {
        listCrmItemsCallCount++;
        return [
          { id: 50, title: 'АЗС Центр' },
          { id: 60, title: 'АЗС Окраина' }
        ];
      }
    }
  });

  const router = createReportsRouter(deps);
  const handler = findHandler(router, 'get', '/');
  if (!handler) return;

  const req = makeReq({
    accessContext: { capabilities: { reviewer: true } },
    query: {}
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 2);

  assert.equal(listCrmItemsCallCount, 1, 'must use ONE listCrmItems call for the page');
  assert.equal(getCrmItemCallCount, 0, 'must NOT use getCrmItem per row');

  const titles = res._payload.items.map(i => i.azsTitle);
  assert.ok(titles.includes('АЗС Центр'), 'title must be resolved');
  assert.ok(titles.includes('АЗС Окраина'), 'title must be resolved');
});

// ---------------------------------------------------------------------------
// Integration: GET /feed (photoFeed) uses batch
// ---------------------------------------------------------------------------

test('GET /feed: uses single batchResolveAzsTitles call, not per-row getCrmItem', async () => {
  let getCrmItemCallCount = 0;
  let listCrmItemsCallCount = 0;

  const feedItems = [
    { reportId: 10, azsId: '70', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-12T10:00:00.000Z', photoRowId: 1, remark: null },
    { reportId: 11, azsId: '80', azsTitle: null, photoCode: 'side',  exifAt: null, uploadedAt: '2026-06-12T11:00:00.000Z', photoRowId: 2, remark: null }
  ];

  const deps = {
    reportsStore: {
      async listPhotosFeed() {
        return { items: feedItems, nextCursor: null };
      }
    },
    settingsStore: {
      async read() {
        return {
          azs: { entityTypeId: 145, fields: { admin: 'UF_CRM_1_123' } },
          photoType: { entityTypeId: 200 }
        };
      }
    },
    bitrixClient: {
      async getCrmItem() {
        getCrmItemCallCount++;
        return null;
      },
      async listCrmItems() {
        listCrmItemsCallCount++;
        return [
          { id: 70, title: 'АЗС Река' },
          { id: 80, title: 'АЗС Горная' }
        ];
      }
    },
    getAdminContext: async () => ({ authId: 'admin-token', domain: 'test.bitrix24.ru' })
  };

  const router = createPhotoFeedRouter(deps);
  // Get /feed handler
  let handler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/feed') {
      handler = layer.route.stack[0]?.handle || null;
      break;
    }
  }
  if (!handler) return;

  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 2);

  assert.equal(listCrmItemsCallCount, 1, 'must use ONE listCrmItems call for the page');
  assert.equal(getCrmItemCallCount, 0, 'must NOT use getCrmItem per row');

  const titles = res._payload.items.map(i => i.azsTitle);
  assert.ok(titles.includes('АЗС Река'), 'title must be resolved');
  assert.ok(titles.includes('АЗС Горная'), 'title must be resolved');
});
