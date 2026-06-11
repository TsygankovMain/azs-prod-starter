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
      const r = {
        id: seq, createdAt: new Date().toISOString(),
        azsId: data.azsId, azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole, recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null, message: data.message,
        senderUserId: data.senderUserId ?? null, senderName: data.senderName ?? null,
        deliveryStatus: 'sent', deliveryError: null, photos: data.photos || []
      };
      records.set(seq, { ...r });
      return r;
    },
    async markDelivery(id, status, error = null) {
      const r = records.get(id);
      if (r) { r.deliveryStatus = status; r.deliveryError = error; }
    },
    async getById(id) { return records.get(id) ?? null; },
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
      message: params.message, deliveryStatus: 'sent', deliveryError: null,
      photos: params.photos || [], createdAt: new Date().toISOString()
    };
  },
  async retryRemark(record) {
    if (overrides.retryThrow) throw new Error(overrides.retryThrow);
    return { ...record, deliveryStatus: 'sent', deliveryError: null };
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

test('POST / returns 400 when message is empty', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: '', photos: [{ reportId: 1, photoCode: 'a' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res._payload?.message?.includes('message'));
});

test('POST / returns 400 when photos is empty array', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 400 when photos has more than 20 items', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const photos = Array.from({ length: 21 }, (_, i) => ({ reportId: 1, photoCode: String(i) }));
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos }
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
    body: { azsId: '42', recipientRole: 'owner', message: 'test', photos: [{ reportId: 1, photoCode: 'a' }] }
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
    body: { azsId: '42', recipientRole: 'manager', message: 'Замечание', photos: [{ reportId: 10, photoCode: 'front' }] }
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
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [{ reportId: 1, photoCode: 'a' }] }
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
  await remarkStore.insertRemark({ azsId: '1', recipientRole: 'admin', message: 'a', photos: [] });
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
    azsId: '42', recipientRole: 'admin', message: 'test', photos: [{ reportId: 10, photoCode: 'front' }]
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
    }
  };
  const inserted = await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'admin', message: 'test',
    recipientUserId: 99, recipientName: 'Stored User',
    photos: [{ reportId: 10, photoCode: 'front' }]
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
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [{ reportId: 10, photoCode: 'front' }] }
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
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [{ reportId: 10, photoCode: 'front' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.item, 'response should have item');
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
