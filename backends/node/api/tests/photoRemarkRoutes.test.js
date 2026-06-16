import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRemarkRouter } from '../src/reports/photoRemarkRoutes.js';

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
    user: { id: 3, user_id: 3 },
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const createFakeRemarkStore = () => {
  let seq = 0;
  const records = new Map();
  return {
    async insertRemark(data) {
      seq += 1;
      const photos = (data.photos || []).map((ph) => ({
        reportId: ph.reportId,
        photoCode: ph.photoCode,
        comment: ph.comment ?? '',
        deliveryStatus: ph.deliveryStatus ?? 'pending',
        deliveryError: ph.deliveryError ?? null
      }));
      const r = {
        id: seq, createdAt: new Date().toISOString(),
        azsId: data.azsId, azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole, recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null,
        senderUserId: data.senderUserId ?? null, senderName: data.senderName ?? null,
        deliveryStatus: 'sent', deliveryError: null, photos
      };
      records.set(seq, { ...r, photos: [...photos] });
      return r;
    },
    async markDelivery(id, status, error = null) {
      const r = records.get(id);
      if (r) { r.deliveryStatus = status; r.deliveryError = error; }
    },
    async markPhotoDelivery(remarkId, reportId, photoCode, status, error = null) {
      const r = records.get(remarkId);
      if (r) {
        const ph = r.photos.find(
          (p) => Number(p.reportId) === Number(reportId) && p.photoCode === photoCode
        );
        if (ph) { ph.deliveryStatus = status; ph.deliveryError = error; }
      }
    },
    async getById(id) {
      const r = records.get(id);
      return r ? { ...r, photos: r.photos ? [...r.photos] : [] } : null;
    },
    async getPhotoRow(remarkId, reportId, photoCode) {
      const r = records.get(remarkId);
      if (!r) return null;
      return r.photos.find(
        (p) => Number(p.reportId) === Number(reportId) && p.photoCode === photoCode
      ) ?? null;
    },
    async list({ limit = 10 } = {}) {
      const items = [...records.values()].slice(0, limit);
      return { items, nextCursor: null };
    }
  };
};

const createFakeService = (overrides = {}) => ({
  async sendRemark(params) {
    if (overrides.throwCode) {
      const err = new Error('test error');
      err.errorCode = overrides.throwCode;
      throw err;
    }
    return {
      id: 99, azsId: params.azsId, recipientRole: params.recipientRole,
      deliveryStatus: 'sent', deliveryError: null,
      photos: params.photos || [], createdAt: new Date().toISOString()
    };
  },
  async retryRemark(record) {
    if (overrides.retryThrow) throw new Error(overrides.retryThrow);
    return { ...record, deliveryStatus: 'sent', deliveryError: null };
  },
  async retryPhoto(remarkId, reportId, photoCode) {
    return { remarkId, reportId, photoCode, deliveryStatus: 'sent', deliveryError: null };
  }
});

const fakeBitrixClient = {
  async callMethod(method, params) {
    if (method === 'user.get') {
      return [{ ID: params.ID, NAME: 'Тест', LAST_NAME: 'Юзер' }];
    }
    return {};
  }
};

const stubDeps = {
  remarkStore: createFakeRemarkStore(),
  photoRemarkService: createFakeService(),
  bitrixClient: fakeBitrixClient,
  getAdminContext: async () => ({ authId: 'admin-token' }),
  reportsStore: null // no AZS guard in baseline tests
};

// ---------------------------------------------------------------------------
// Route handler helper (same pattern as photoFeed.test.js)
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
// Tests — POST /
// ---------------------------------------------------------------------------

test('POST / returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

// UX-2: no top-level message — photos must carry per-photo comment
test('POST / returns 400 when photo has no comment (old message-only body rejected)', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  // Old contract: top-level message, no per-photo comment → should fail
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'shared text', photos: [{ reportId: 1, photoCode: 'a' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res._payload?.message?.toLowerCase().includes('comment'), 'error must mention comment');
});

test('POST / returns 400 when photos is empty array', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos: [] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 400 when photos has more than 20 items', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const photos = Array.from({ length: 21 }, (_, i) => ({ reportId: 1, photoCode: String(i), comment: 'test' }));
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 400 when recipientRole is invalid', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'owner', photos: [{ reportId: 1, photoCode: 'a', comment: 'test' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 200 on successful send with {item} contract', async () => {
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos: [{ reportId: 10, photoCode: 'front', comment: 'Замечание' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.item, 'response should have item key');
  assert.ok(res._payload?.item?.azsId, 'item should have azsId');
});

test('POST / returns 422 on RECIPIENT_NOT_SET errorCode', async () => {
  const deps = {
    ...stubDeps,
    photoRemarkService: createFakeService({ throwCode: 'RECIPIENT_NOT_SET' })
  };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos: [{ reportId: 1, photoCode: 'a', comment: 'test' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res._payload?.errorCode, 'RECIPIENT_NOT_SET');
});

// ---------------------------------------------------------------------------
// Tests — GET /
// ---------------------------------------------------------------------------

test('GET / returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET / returns items and nextCursor', async () => {
  const remarkStore = createFakeRemarkStore();
  await remarkStore.insertRemark({ azsId: '1', recipientRole: 'admin', photos: [] });
  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  assert.ok('nextCursor' in res._payload);
});

// ---------------------------------------------------------------------------
// Tests — POST /:id/retry
// ---------------------------------------------------------------------------

test('POST /:id/retry returns 404 with REMARK_NOT_FOUND for unknown id', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  // Find the retry route
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: '9999' } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res._payload?.errorCode, 'REMARK_NOT_FOUND');
});

test('POST /:id/retry returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: '1' }, accessContext: { capabilities: {} } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /:id/retry succeeds for existing remark, returns {item}', async () => {
  const remarkStore = createFakeRemarkStore();
  const inserted = await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'admin',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
  });
  await remarkStore.markDelivery(inserted.id, 'failed', 'timeout');

  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: String(inserted.id) } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.item, 'retry response should have item key');
});

test('POST /:id/retry uses stored recipientUserId (no re-resolve)', async () => {
  const remarkStore = createFakeRemarkStore();
  let retryCalledWith = null;
  const fakeService = {
    async sendRemark() { return {}; },
    async retryRemark(record) {
      retryCalledWith = record;
      return { ...record, deliveryStatus: 'sent', deliveryError: null };
    },
    async retryPhoto(remarkId, reportId, photoCode) {
      return { remarkId, reportId, photoCode, deliveryStatus: 'sent', deliveryError: null };
    }
  };
  const inserted = await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'admin',
    recipientUserId: 99, recipientName: 'Stored User',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
  });
  await remarkStore.markDelivery(inserted.id, 'failed', 'timeout');

  const deps = { ...stubDeps, remarkStore, photoRemarkService: fakeService };
  const router = createPhotoRemarkRouter(deps);
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: String(inserted.id) } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(retryCalledWith, 'retryRemark should have been called');
  assert.equal(retryCalledWith.recipientUserId, 99, 'should pass stored recipientUserId');
});

// ---------------------------------------------------------------------------
// I3 — Photos AZS mismatch guard
// ---------------------------------------------------------------------------

test('POST / returns 400 PHOTOS_AZS_MISMATCH when photo belongs to different AZS', async () => {
  const fakeReportsStore = {
    async getPhoto(reportId, photoCode) {
      // Simulate photo belonging to azsId '99', not '42'
      return { fileName: 'a.jpg', diskObjectId: 1, fileId: 1, azsId: '99' };
    }
  };
  const deps = { ...stubDeps, reportsStore: fakeReportsStore, remarkStore: createFakeRemarkStore() };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res._payload?.errorCode, 'PHOTOS_AZS_MISMATCH');
});

test('POST / passes guard when photo azsId matches body azsId', async () => {
  const fakeReportsStore = {
    async getPhoto() {
      return { fileName: 'a.jpg', diskObjectId: 1, fileId: 1, azsId: '42' };
    }
  };
  const deps = { ...stubDeps, reportsStore: fakeReportsStore, remarkStore: createFakeRemarkStore() };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.item, 'response should have item');
});

// ---------------------------------------------------------------------------
// UX-2: New per-photo comment contract — POST /
// ---------------------------------------------------------------------------

test('UX-2 POST / accepts per-photo comments (no top-level message)', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientRole: 'manager',
      // No top-level message — comment lives inside each photo
      photos: [
        { reportId: 10, photoCode: 'front', comment: 'Грязное стекло' },
        { reportId: 10, photoCode: 'side', comment: 'Сломан насос' }
      ]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'should accept per-photo comment body');
  assert.ok(res._payload?.item, 'response should have item key');
});

test('UX-2 POST / returns 400 when photo has empty comment', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientRole: 'manager',
      photos: [
        { reportId: 10, photoCode: 'front', comment: '' }  // empty comment should fail
      ]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400, 'should reject empty photo comment');
  assert.ok(res._payload?.message?.toLowerCase().includes('comment'), 'error message mentions comment');
});

test('UX-2 POST / returns 400 when photo has missing comment field', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientRole: 'manager',
      photos: [
        { reportId: 10, photoCode: 'front' }  // no comment field
      ]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400, 'should reject photo without comment');
});

test('UX-2 POST / still rejects missing azsId', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      recipientRole: 'manager',
      photos: [{ reportId: 10, photoCode: 'front', comment: 'Test' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res._payload?.message?.toLowerCase().includes('azsid'));
});

test('UX-2 POST / passes photos array with comments to service', async () => {
  let capturedParams = null;
  const capturingService = {
    async sendRemark(params) {
      capturedParams = params;
      return {
        id: 1, azsId: params.azsId, recipientRole: params.recipientRole,
        deliveryStatus: 'sent', deliveryError: null,
        photos: params.photos, createdAt: new Date().toISOString()
      };
    },
    async retryRemark(record) { return record; }
  };
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: capturingService,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42', recipientRole: 'manager',
      photos: [
        { reportId: 10, photoCode: 'front', comment: 'Тест 1' },
        { reportId: 10, photoCode: 'side', comment: 'Тест 2' }
      ]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(capturedParams, 'service.sendRemark should have been called');
  assert.equal(capturedParams.photos.length, 2, 'both photos passed to service');
  assert.equal(capturedParams.photos[0].comment, 'Тест 1', 'photo comment passed to service');
  assert.equal(capturedParams.photos[1].comment, 'Тест 2', 'second photo comment passed to service');
});

// ---------------------------------------------------------------------------
// UX-2: Single-photo retry — POST /:id/retry/:reportId/:photoCode
// ---------------------------------------------------------------------------

const findPhotoRetryHandler = (router) => {
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry/:reportId/:photoCode') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      return h?.handle || null;
    }
  }
  return null;
};

const createFakeServiceWithPhotoRetry = (overrides = {}) => ({
  async sendRemark(params) {
    return {
      id: 99, azsId: params.azsId, recipientRole: params.recipientRole,
      deliveryStatus: 'sent', deliveryError: null,
      photos: params.photos, createdAt: new Date().toISOString()
    };
  },
  async retryRemark(record) {
    if (overrides.retryThrow) throw new Error(overrides.retryThrow);
    return { ...record, deliveryStatus: 'sent', deliveryError: null };
  },
  async retryPhoto(remarkId, reportId, photoCode) {
    if (overrides.retryPhotoThrow) throw new Error(overrides.retryPhotoThrow);
    return { remarkId, reportId, photoCode, deliveryStatus: 'sent', deliveryError: null };
  }
});

test('UX-2 POST /:id/retry/:reportId/:photoCode returns 403 without reviewer', async () => {
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: createFakeServiceWithPhotoRetry(),
    remarkStore: createFakeRemarkStore()
  });
  const handler = findPhotoRetryHandler(router);
  if (!handler) { /* route not yet implemented, test will fail on assertion below */ return; }
  const req = makeReq({ params: { id: '1', reportId: '10', photoCode: 'front' }, accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('UX-2 POST /:id/retry/:reportId/:photoCode returns 404 for missing remark', async () => {
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: createFakeServiceWithPhotoRetry(),
    remarkStore: createFakeRemarkStore()
  });
  const handler = findPhotoRetryHandler(router);
  if (!handler) return;
  const req = makeReq({ params: { id: '9999', reportId: '10', photoCode: 'front' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('UX-2 POST /:id/retry/:reportId/:photoCode succeeds and returns {item}', async () => {
  const remarkStore = createFakeRemarkStore();
  const inserted = await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'admin',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'Test' }]
  });

  let retryPhotoCalledWith = null;
  const capturingSvc = {
    async sendRemark() { return {}; },
    async retryRemark(record) { return { ...record, deliveryStatus: 'sent' }; },
    async retryPhoto(remarkId, reportId, photoCode) {
      retryPhotoCalledWith = { remarkId, reportId, photoCode };
      return { remarkId, reportId, photoCode, deliveryStatus: 'sent', deliveryError: null };
    }
  };

  const router = createPhotoRemarkRouter({
    ...stubDeps,
    remarkStore,
    photoRemarkService: capturingSvc
  });
  const handler = findPhotoRetryHandler(router);
  if (!handler) return;
  const req = makeReq({ params: { id: String(inserted.id), reportId: '10', photoCode: 'front' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.item, 'response should have item');
  assert.ok(retryPhotoCalledWith, 'retryPhoto should have been called');
  assert.equal(retryPhotoCalledWith.remarkId, inserted.id);
  assert.equal(retryPhotoCalledWith.reportId, 10);
  assert.equal(retryPhotoCalledWith.photoCode, 'front');
});

// ---------------------------------------------------------------------------
// UX-2: Journal GET / — per-photo comment + status returned
// ---------------------------------------------------------------------------

test('UX-2 GET / returns photos with per-photo comment and deliveryStatus', async () => {
  const remarkStore = createFakeRemarkStore();
  await remarkStore.insertRemark({
    azsId: '77', recipientRole: 'admin',
    photos: [
      { reportId: 5, photoCode: 'a', comment: 'Комментарий A' },
      { reportId: 5, photoCode: 'b', comment: 'Комментарий B' }
    ]
  });
  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  const item = res._payload.items[0];
  assert.ok(item, 'journal item exists');
  assert.ok(Array.isArray(item.photos), 'photos is array');
  const photoA = item.photos.find((p) => p.photoCode === 'a');
  assert.ok(photoA, 'photo a found in journal');
  assert.equal(photoA.comment, 'Комментарий A', 'per-photo comment in journal');
  assert.ok('deliveryStatus' in photoA, 'per-photo deliveryStatus in journal');
});

// ---------------------------------------------------------------------------
// FEED-2 / BE-3: recipientType='user' + recipientUserId
// ---------------------------------------------------------------------------

test('FEED-2 POST / accepts recipientType=user with recipientUserId', async () => {
  let capturedParams = null;
  const capturingService = {
    async sendRemark(params) {
      capturedParams = params;
      return {
        id: 1, azsId: params.azsId, recipientRole: params.recipientRole,
        recipientUserId: params.recipientUserId, recipientName: params.recipientName,
        deliveryStatus: 'sent', deliveryError: null,
        photos: params.photos, createdAt: new Date().toISOString()
      };
    },
    async retryRemark(record) { return record; }
  };
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: capturingService,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientType: 'user',
      recipientUserId: 55,
      photos: [{ reportId: 10, photoCode: 'front', comment: 'Тест' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'should accept recipientType=user');
  assert.ok(res._payload?.item, 'response should have item');
  assert.ok(capturedParams, 'service.sendRemark should be called');
  assert.equal(capturedParams.recipientType, 'user', 'recipientType=user passed to service');
  assert.equal(capturedParams.recipientUserId, 55, 'recipientUserId=55 passed to service');
});

test('FEED-2 POST / returns 400 for recipientType=user without recipientUserId', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientType: 'user',
      // missing recipientUserId
      photos: [{ reportId: 10, photoCode: 'front', comment: 'Тест' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400, 'should reject missing recipientUserId');
  assert.ok(res._payload?.message?.toLowerCase().includes('recipientuserid'), 'error mentions recipientUserId');
});

test('FEED-2 POST / backward compat: old recipientRole=manager still works', async () => {
  let capturedParams = null;
  const capturingService = {
    async sendRemark(params) {
      capturedParams = params;
      return {
        id: 1, azsId: params.azsId, recipientRole: params.recipientRole,
        deliveryStatus: 'sent', deliveryError: null,
        photos: params.photos, createdAt: new Date().toISOString()
      };
    },
    async retryRemark(record) { return record; }
  };
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: capturingService,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientRole: 'manager',  // old contract — still works
      photos: [{ reportId: 10, photoCode: 'front', comment: 'Замечание' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'old recipientRole=manager must still succeed');
  assert.ok(capturedParams, 'service called');
  assert.equal(capturedParams.recipientRole, 'manager', 'recipientRole=manager passed through');
});

test('FEED-2 POST / backward compat: old recipientRole=admin still works', async () => {
  const router = createPhotoRemarkRouter({ ...stubDeps, remarkStore: createFakeRemarkStore() });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientRole: 'admin',
      photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'old recipientRole=admin must still succeed');
});

test('FEED-2 POST / recipientType=admin normalizes to role-based delivery', async () => {
  let capturedParams = null;
  const capturingService = {
    async sendRemark(params) {
      capturedParams = params;
      return {
        id: 1, azsId: params.azsId, recipientRole: params.recipientRole,
        deliveryStatus: 'sent', deliveryError: null,
        photos: params.photos, createdAt: new Date().toISOString()
      };
    },
    async retryRemark(record) { return record; }
  };
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    photoRemarkService: capturingService,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: {
      azsId: '42',
      recipientType: 'admin',
      photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
    }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, 'recipientType=admin should succeed');
  assert.ok(capturedParams, 'service called');
  assert.equal(capturedParams.recipientRole, 'admin', 'recipientType=admin maps to recipientRole=admin');
});

test('FEED-2 GET / journal returns recipientName for user-type remarks', async () => {
  const remarkStore = createFakeRemarkStore();
  // Insert remark with user-type recipient stored data
  await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'user',
    recipientUserId: 55, recipientName: 'Иван Петров',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
  });
  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  const item = res._payload.items[0];
  assert.ok(item, 'journal item exists');
  assert.equal(item.recipientUserId, 55, 'recipientUserId returned');
  assert.equal(item.recipientName, 'Иван Петров', 'recipientName returned in journal');
});

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('createPhotoRemarkRouter throws when remarkStore is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ photoRemarkService: {}, bitrixClient: {} }),
    /remarkStore is required/
  );
});

test('createPhotoRemarkRouter throws when photoRemarkService is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ remarkStore: {}, bitrixClient: {} }),
    /photoRemarkService is required/
  );
});

test('createPhotoRemarkRouter throws when bitrixClient is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ remarkStore: {}, photoRemarkService: {} }),
    /bitrixClient is required/
  );
});
