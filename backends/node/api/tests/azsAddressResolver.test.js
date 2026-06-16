/**
 * TDD tests for FEED-3 (BE-1): резолвер АЗС тянет адрес UF_CRM_10_1773914353
 * и прокидывает azsAddress в элементы фотоленты и витрины day-photos.
 *
 * Covers:
 *  1. batchResolveAzsTitles: при наличии UF_CRM_10_1773914353 в ответе — address
 *  2. batchResolveAzsTitles: пустое/отсутствующее UF — address = null (без ошибок)
 *  3. batchResolveAzsTitles: select включает UF_CRM_10_1773914353
 *  4. batchResolveAzsTitles: возвращает Map id→{title, address}
 *  5. GET /feed: элементы включают azsAddress
 *  6. GET /feed: azsAddress = null при пустом UF
 *  7. GET /analytics/day-photos: элементы включают azsAddress
 *  8. GET /analytics/day-photos: azsAddress = null при пустом UF
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { batchResolveAzsTitles } from '../src/reports/reportsRoutes.js';
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
// Unit tests: batchResolveAzsTitles — address field
// ---------------------------------------------------------------------------

test('FEED-3: batchResolveAzsTitles — select includes UF_CRM_10_1773914353', async () => {
  let capturedSelect = null;
  const bitrixClient = {
    async listCrmItems(params) {
      capturedSelect = params.select;
      return [{ id: 1, title: 'АЗС 1', ufCrm10_1773914353: 'ул. Ленина, 1' }];
    }
  };

  const settings = makeSettings(145);
  await batchResolveAzsTitles(['1'], { bitrixClient, settings, context: {} });

  assert.ok(capturedSelect, 'listCrmItems must be called');
  const selectStr = JSON.stringify(capturedSelect);
  assert.ok(
    selectStr.includes('UF_CRM_10_1773914353') || selectStr.includes('ufCrm10_1773914353'),
    `select must include UF_CRM_10_1773914353 (got: ${selectStr})`
  );
});

test('FEED-3: batchResolveAzsTitles — returns Map id→{title,address} when UF present', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [
        { id: 10, title: 'АЗС Север', ufCrm10_1773914353: 'ул. Мира, 10' },
        { id: 20, title: 'АЗС Юг', ufCrm10_1773914353: 'пр. Победы, 20' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['10', '20'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'result must be a Map');

  const entry10 = map.get('10');
  assert.ok(entry10 && typeof entry10 === 'object', 'map entry must be an object');
  assert.equal(entry10.title, 'АЗС Север', 'title must be resolved');
  assert.equal(entry10.address, 'ул. Мира, 10', 'address must be resolved from UF_CRM_10_1773914353');

  const entry20 = map.get('20');
  assert.ok(entry20 && typeof entry20 === 'object', 'map entry must be an object');
  assert.equal(entry20.title, 'АЗС Юг', 'title must be resolved');
  assert.equal(entry20.address, 'пр. Победы, 20', 'address must be resolved from UF_CRM_10_1773914353');
});

test('FEED-3: batchResolveAzsTitles — address = null when UF field absent', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [
        // Row without UF_CRM_10_1773914353
        { id: 5, title: 'АЗС 5' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['5'], { bitrixClient, settings, context: {} });

  const entry = map.get('5');
  assert.ok(entry && typeof entry === 'object', 'map entry must be an object');
  assert.equal(entry.title, 'АЗС 5', 'title must be resolved');
  assert.equal(entry.address, null, 'address must be null when UF field is absent');
});

test('FEED-3: batchResolveAzsTitles — address = null when UF field is empty string', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [
        { id: 7, title: 'АЗС 7', ufCrm10_1773914353: '' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['7'], { bitrixClient, settings, context: {} });

  const entry = map.get('7');
  assert.ok(entry && typeof entry === 'object', 'map entry must be an object');
  assert.equal(entry.title, 'АЗС 7', 'title must be resolved');
  assert.equal(entry.address, null, 'address must be null when UF field is empty string');
});

test('FEED-3: batchResolveAzsTitles — address = null when UF field is null', async () => {
  const bitrixClient = {
    async listCrmItems() {
      return [
        { id: 9, title: 'АЗС 9', ufCrm10_1773914353: null }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['9'], { bitrixClient, settings, context: {} });

  const entry = map.get('9');
  assert.ok(entry && typeof entry === 'object', 'map entry must be an object');
  assert.equal(entry.title, 'АЗС 9', 'title must be resolved');
  assert.equal(entry.address, null, 'address must be null when UF field is null');
});

test('FEED-3: batchResolveAzsTitles — also accepts UF_CRM_10_1773914353 original-case form', async () => {
  // Bitrix может вернуть в оригинальном регистре при useOriginalUfNames:'Y'
  // Резолвер должен понимать оба варианта
  const bitrixClient = {
    async listCrmItems() {
      return [
        { id: 11, title: 'АЗС 11', 'UF_CRM_10_1773914353': 'ул. Советская, 11' }
      ];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['11'], { bitrixClient, settings, context: {} });

  const entry = map.get('11');
  assert.ok(entry && typeof entry === 'object', 'map entry must be an object');
  assert.equal(entry.address, 'ул. Советская, 11', 'address must be resolved from UF_CRM_10_1773914353 in original-case form');
});

test('FEED-3: batchResolveAzsTitles — backward compat: .get still works for string key (existing code)', async () => {
  // Проверяем что Map.get('id') всё ещё работает
  const bitrixClient = {
    async listCrmItems() {
      return [{ id: 42, title: 'АЗС 42', ufCrm10_1773914353: 'ул. Пушкина, 42' }];
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['42'], { bitrixClient, settings, context: {} });

  // New contract: value is object {title, address}
  const entry = map.get('42');
  assert.ok(entry && typeof entry === 'object', 'map entry must be an object with title and address');
  assert.equal(entry.title, 'АЗС 42');
  assert.equal(entry.address, 'ул. Пушкина, 42');
});

test('FEED-3: batchResolveAzsTitles — fallback entry has address=null when CRM not reachable', async () => {
  const bitrixClient = {
    async listCrmItems() {
      throw new Error('network timeout');
    }
  };

  const settings = makeSettings(145);
  const map = await batchResolveAzsTitles(['3'], { bitrixClient, settings, context: {} });

  assert.ok(map instanceof Map, 'must return Map even when listCrmItems throws');
  const entry = map.get('3');
  assert.ok(entry && typeof entry === 'object', 'fallback entry must be an object');
  assert.ok(typeof entry.title === 'string', 'fallback title must be a string');
  assert.equal(entry.address, null, 'fallback address must be null');
});

// ---------------------------------------------------------------------------
// Integration: GET /feed — azsAddress in items
// ---------------------------------------------------------------------------

test('FEED-3: GET /feed — items include azsAddress from UF_CRM_10_1773914353', async () => {
  const feedItems = [
    { reportId: 10, azsId: '70', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-12T10:00:00.000Z', photoRowId: 1, remark: null }
  ];

  const deps = {
    reportsStore: {
      async listPhotosFeed() { return { items: feedItems, nextCursor: null }; }
    },
    settingsStore: {
      async read() {
        return { azs: { entityTypeId: 145 }, photoType: { entityTypeId: 200 } };
      }
    },
    bitrixClient: {
      async listCrmItems() {
        return [{ id: 70, title: 'АЗС Горная', ufCrm10_1773914353: 'ул. Горная, 5' }];
      }
    },
    getAdminContext: async () => ({ authId: 'admin-token', domain: 'test.bitrix24.ru' })
  };

  const router = createPhotoFeedRouter(deps);
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
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  assert.equal(res._payload.items[0].azsAddress, 'ул. Горная, 5', 'azsAddress must be present in feed items');
});

test('FEED-3: GET /feed — azsAddress = null when UF field absent', async () => {
  const feedItems = [
    { reportId: 11, azsId: '71', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-12T10:00:00.000Z', photoRowId: 2, remark: null }
  ];

  const deps = {
    reportsStore: {
      async listPhotosFeed() { return { items: feedItems, nextCursor: null }; }
    },
    settingsStore: {
      async read() {
        return { azs: { entityTypeId: 145 }, photoType: { entityTypeId: 200 } };
      }
    },
    bitrixClient: {
      async listCrmItems() {
        // No UF field in response
        return [{ id: 71, title: 'АЗС Без адреса' }];
      }
    },
    getAdminContext: null
  };

  const router = createPhotoFeedRouter(deps);
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
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items[0].azsAddress, null, 'azsAddress must be null when UF is absent');
});

// ---------------------------------------------------------------------------
// Integration: GET /analytics/day-photos — azsAddress in items
// ---------------------------------------------------------------------------

test('FEED-3: GET /analytics/day-photos — items include azsAddress from UF_CRM_10_1773914353', async () => {
  const deps = {
    analyticsStore: {
      async getRating() { return []; },
      async getTrend() { return []; },
      async getDayPhotos() {
        return [
          { azsId: '80', date: '2026-06-16', count: 3 }
        ];
      }
    },
    reportsStore: { async listPhotos() { return []; } },
    bitrixClient: {
      async getCrmItem() { return null; },
      async listCrmItems() {
        return [{ id: 80, title: 'АЗС Центр', ufCrm10_1773914353: 'пл. Центральная, 1' }];
      }
    },
    settingsStore: { async read() { return { azs: { entityTypeId: 145 } }; } },
    diskApi: null
  };

  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/day-photos')?.route?.stack[0]?.handle;
  if (!handler) return;

  const req = makeReq({ query: { date: '2026-06-16' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  assert.equal(res._payload.items[0].azsAddress, 'пл. Центральная, 1', 'azsAddress must be present in day-photos items');
});

test('FEED-3: GET /analytics/day-photos — azsAddress = null when UF field absent', async () => {
  const deps = {
    analyticsStore: {
      async getRating() { return []; },
      async getTrend() { return []; },
      async getDayPhotos() {
        return [{ azsId: '81', date: '2026-06-16', count: 1 }];
      }
    },
    reportsStore: { async listPhotos() { return []; } },
    bitrixClient: {
      async getCrmItem() { return null; },
      async listCrmItems() {
        // No UF field in response
        return [{ id: 81, title: 'АЗС Без адреса 2' }];
      }
    },
    settingsStore: { async read() { return { azs: { entityTypeId: 145 } }; } },
    diskApi: null
  };

  const router = createAnalyticsRouter(deps);
  const handler = router.stack.find(l => l.route?.path === '/analytics/day-photos')?.route?.stack[0]?.handle;
  if (!handler) return;

  const req = makeReq({ query: { date: '2026-06-16' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items[0].azsAddress, null, 'azsAddress must be null when UF is absent');
});
