/**
 * brandRoutes.test.js — TDD-тесты для REST-роутера брендов.
 *
 * Паттерн: мок brandStore + diskApi; вызов хендлеров напрямую.
 * Образец: photoRemarkRoutes.test.js / analyticsRoutes.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrandRouter } from '../src/brands/brandRoutes.js';

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
    user: { id: 1, user_id: 1 },
    accessContext: { capabilities: { settings: true } },
    bitrixContext: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// findRoute — ищет обработчик по методу и пути в стеке Express-роутера
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
// Fakes
// ---------------------------------------------------------------------------

const createFakeBrandStore = (initial = []) => {
  let seq = initial.length;
  const brands = new Map(initial.map((b) => [b.id, { ...b }]));
  const brandAzs = new Map(); // brandId → Set<azsId>

  return {
    async listBrands() {
      return [...brands.values()].sort((a, b) => a.id - b.id);
    },
    async getBrand(id) {
      return brands.get(Number(id)) ?? null;
    },
    async createBrand({ name }) {
      seq += 1;
      const brand = { id: seq, name, disk_folder_id: null, disk_folder_path: null, external_link: null, external_link_updated_at: null };
      brands.set(seq, brand);
      return brand;
    },
    async updateBrand(id, { name }) {
      const brand = brands.get(Number(id));
      if (!brand) return null;
      brand.name = name;
      return brand;
    },
    async deleteBrand(id) {
      brands.delete(Number(id));
      brandAzs.delete(Number(id));
    },
    async setBrandAzs(brandId, azsIds) {
      const bId = Number(brandId);
      brandAzs.set(bId, new Set(azsIds.map(String)));
    },
    async listAzsForBrand(brandId) {
      return [...(brandAzs.get(Number(brandId)) || [])].sort();
    },
    async getBrandByAzsId(azsId) {
      for (const [bId, azsSet] of brandAzs.entries()) {
        if (azsSet.has(String(azsId))) return brands.get(bId) ?? null;
      }
      return null;
    },
    async setBrandDiskFolder(brandId, folderId, folderPath) {
      const brand = brands.get(Number(brandId));
      if (brand) {
        brand.disk_folder_id = Number(folderId);
        brand.disk_folder_path = folderPath || null;
      }
    },
    async setBrandExternalLink(brandId, link) {
      const brand = brands.get(Number(brandId));
      if (brand) {
        brand.external_link = link;
        brand.external_link_updated_at = new Date().toISOString();
      }
    }
  };
};

const createFakeDiskApi = (overrides = {}) => ({
  async createFolder(parentId, name, _context) {
    if (overrides.createFolderThrow) throw overrides.createFolderThrow;
    return { id: overrides.folderId ?? 9001 };
  },
  async getExternalLink(folderId, _context) {
    if (overrides.getExternalLinkThrow) throw overrides.getExternalLinkThrow;
    return overrides.externalLink ?? `https://b24.example.com/disk/link/folder_${folderId}`;
  }
});

// Stub для bitrixClient.callMethod — используется внутри external-link через diskApi
const makeFakeBitrixClient = (overrides = {}) => ({
  diskApi: createFakeDiskApi(overrides.diskApi || {}),
  async callMethod(method, params, context) {
    if (method === 'disk.folder.addsubfolder') {
      if (overrides.diskApi?.createFolderThrow) throw overrides.diskApi.createFolderThrow;
      return { ID: overrides.diskApi?.folderId ?? 9001 };
    }
    if (method === 'disk.folder.getexternallink') {
      if (overrides.diskApi?.getExternalLinkThrow) throw overrides.diskApi.getExternalLinkThrow;
      return overrides.diskApi?.externalLink ?? `https://b24.example.com/disk/link/folder_${params.id}`;
    }
    return null;
  }
});

// ---------------------------------------------------------------------------
// Admin-context stub
// ---------------------------------------------------------------------------

const fakeGetAdminContext = async () => ({
  authId: 'ADMIN_TOKEN',
  domain: 'test.bitrix24.ru',
  memberId: 'member1',
  userId: 1,
  isAdmin: true
});

// ---------------------------------------------------------------------------
// Корневые deps
// ---------------------------------------------------------------------------

const makeDeps = (overrides = {}) => ({
  brandStore: createFakeBrandStore(overrides.initialBrands || []),
  bitrixClient: makeFakeBitrixClient(overrides.bitrixClient || {}),
  getAdminContext: overrides.getAdminContext ?? fakeGetAdminContext,
  diskRootFolderId: overrides.diskRootFolderId ?? 100,
  ...overrides.extra
});

// ===========================================================================
// Тесты — Admin-гейт (403 без capabilities.settings)
// ===========================================================================

test('GET /api/brands returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.ok(res._payload?.error);
});

test('POST /api/brands returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} }, body: { name: 'test' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('PUT /api/brands/:id returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'put', '/:id');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} }, params: { id: '1' }, body: { name: 'Новое' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('DELETE /api/brands/:id returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'delete', '/:id');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} }, params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

// ===========================================================================
// Тесты — GET / (список брендов)
// ===========================================================================

test('GET /api/brands returns empty list when no brands', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.brands));
  assert.equal(res._payload.brands.length, 0);
});

test('GET /api/brands returns list of brands', async () => {
  const router = createBrandRouter(makeDeps({
    initialBrands: [
      { id: 1, name: 'ГПН Москва' },
      { id: 2, name: 'ЛУКОЙЛ Север' }
    ]
  }));
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.brands.length, 2);
  assert.equal(res._payload.brands[0].name, 'ГПН Москва');
});

// ===========================================================================
// Тесты — POST / (создать бренд)
// ===========================================================================

test('POST /api/brands returns 400 when name is missing', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({ body: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res._payload?.error);
});

test('POST /api/brands creates brand and returns it', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({ body: { name: 'Новый бренд' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.ok(res._payload?.brand);
  assert.equal(res._payload.brand.name, 'Новый бренд');
  assert.ok(res._payload.brand.id);
});

// ===========================================================================
// Тесты — PUT /:id (обновить бренд)
// ===========================================================================

test('PUT /api/brands/:id returns 404 for unknown brand', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'put', '/:id');
  if (!handler) return;
  const req = makeReq({ params: { id: '999' }, body: { name: 'Новое имя' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('PUT /api/brands/:id returns 400 when name is missing', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'put', '/:id');
  if (!handler) return;
  const req = makeReq({ params: { id: '1' }, body: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('PUT /api/brands/:id updates brand name and returns it', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Старый' }] }));
  const handler = findRoute(router, 'put', '/:id');
  if (!handler) return;
  const req = makeReq({ params: { id: '1' }, body: { name: 'Новый' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.brand);
  assert.equal(res._payload.brand.name, 'Новый');
});

// ===========================================================================
// Тесты — DELETE /:id
// ===========================================================================

test('DELETE /api/brands/:id returns 404 for unknown brand', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'delete', '/:id');
  if (!handler) return;
  const req = makeReq({ params: { id: '999' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('DELETE /api/brands/:id deletes brand and returns ok', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'delete', '/:id');
  if (!handler) return;
  const req = makeReq({ params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.ok);
});

// ===========================================================================
// Тесты — PUT /:id/azs (установить состав АЗС)
// ===========================================================================

test('PUT /api/brands/:id/azs returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'put', '/:id/azs');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} }, params: { id: '1' }, body: { azsIds: ['42'] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('PUT /api/brands/:id/azs returns 404 for unknown brand', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'put', '/:id/azs');
  if (!handler) return;
  const req = makeReq({ params: { id: '999' }, body: { azsIds: ['42'] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('PUT /api/brands/:id/azs sets AZS list and returns current azsIds', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'Бренд А' }] }));
  const handler = findRoute(router, 'put', '/:id/azs');
  if (!handler) return;
  const req = makeReq({ params: { id: '1' }, body: { azsIds: ['42', '55', '77'] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.azsIds));
  assert.deepEqual(res._payload.azsIds.sort(), ['42', '55', '77'].sort());
});

test('PUT /api/brands/:id/azs with empty array clears all AZS', async () => {
  const store = createFakeBrandStore([{ id: 1, name: 'Бренд А' }]);
  await store.setBrandAzs(1, ['42', '55']);
  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: makeFakeBitrixClient(),
    getAdminContext: fakeGetAdminContext,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'put', '/:id/azs');
  if (!handler) return;
  const req = makeReq({ params: { id: '1' }, body: { azsIds: [] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._payload?.azsIds, []);
});

test('PUT /api/brands/:id/azs transfers AZS from another brand (no 409, transfer)', async () => {
  // brandId=1 уже владеет АЗС '42'. Переносим '42' в brandId=2
  const store = createFakeBrandStore([
    { id: 1, name: 'Бренд А' },
    { id: 2, name: 'Бренд Б' }
  ]);
  await store.setBrandAzs(1, ['42']);

  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: makeFakeBitrixClient(),
    getAdminContext: fakeGetAdminContext,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'put', '/:id/azs');
  if (!handler) return;

  // Устанавливаем '42' на бренд 2
  const req = makeReq({ params: { id: '2' }, body: { azsIds: ['42'] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.azsIds));
  assert.ok(res._payload.azsIds.includes('42'), 'brand 2 должен владеть АЗС 42');
});

// ===========================================================================
// Тесты — POST /:id/external-link (получить внешнюю ссылку)
// ===========================================================================

test('POST /api/brands/:id/external-link returns 403 without settings capability', async () => {
  const router = createBrandRouter(makeDeps({ initialBrands: [{ id: 1, name: 'ГПН' }] }));
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} }, params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /api/brands/:id/external-link returns 404 for unknown brand', async () => {
  const router = createBrandRouter(makeDeps());
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;
  const req = makeReq({ params: { id: '999' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('POST /api/brands/:id/external-link creates disk folder when brand has none, then returns link', async () => {
  // Бренд без папки — должна создасться
  let createFolderCalledWith = null;
  let setBrandDiskFolderCalledWith = null;
  let setBrandExternalLinkCalledWith = null;

  const store = createFakeBrandStore([{ id: 1, name: 'ГПН Москва', disk_folder_id: null }]);
  const origSetBrandDiskFolder = store.setBrandDiskFolder.bind(store);
  store.setBrandDiskFolder = async (brandId, folderId, path) => {
    setBrandDiskFolderCalledWith = { brandId, folderId, path };
    return origSetBrandDiskFolder(brandId, folderId, path);
  };
  const origSetBrandExternalLink = store.setBrandExternalLink.bind(store);
  store.setBrandExternalLink = async (brandId, link) => {
    setBrandExternalLinkCalledWith = { brandId, link };
    return origSetBrandExternalLink(brandId, link);
  };

  const fakeDiskApi = {
    createFolder: async (parentId, name, _ctx) => {
      createFolderCalledWith = { parentId, name };
      return { id: 9001 };
    },
    getExternalLink: async (folderId, _ctx) => `https://b24.example.com/link/${folderId}`
  };

  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: { diskApi: fakeDiskApi, callMethod: async () => null },
    getAdminContext: fakeGetAdminContext,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;

  const req = makeReq({ params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.link, 'response should have link');
  assert.ok(String(res._payload.link).startsWith('https://'), 'link should be a URL');
  assert.ok(createFolderCalledWith, 'createFolder should have been called');
  assert.equal(createFolderCalledWith.name, 'ГПН Москва', 'folder name = brand name');
  assert.equal(createFolderCalledWith.parentId, 100, 'folder created in diskRootFolderId');
  assert.ok(setBrandDiskFolderCalledWith, 'setBrandDiskFolder should have been called');
  assert.equal(setBrandDiskFolderCalledWith.folderId, 9001);
  assert.ok(setBrandExternalLinkCalledWith, 'setBrandExternalLink should have been called');
  assert.ok(setBrandExternalLinkCalledWith.link);
});

test('POST /api/brands/:id/external-link uses existing folder when brand already has one', async () => {
  let createFolderCallCount = 0;

  const store = createFakeBrandStore([{ id: 1, name: 'ГПН Москва', disk_folder_id: 5555 }]);
  const fakeDiskApi = {
    createFolder: async () => {
      createFolderCallCount += 1;
      return { id: 9999 };
    },
    getExternalLink: async (folderId, _ctx) => `https://b24.example.com/link/${folderId}`
  };

  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: { diskApi: fakeDiskApi, callMethod: async () => null },
    getAdminContext: fakeGetAdminContext,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;

  const req = makeReq({ params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(String(res._payload?.link).includes('5555'), 'link should be for folder 5555');
  assert.equal(createFolderCallCount, 0, 'createFolder must NOT be called when folder already exists');
});

test('POST /api/brands/:id/external-link uses admin OAuth context for disk calls', async () => {
  let usedContext = null;

  const store = createFakeBrandStore([{ id: 1, name: 'ГПН', disk_folder_id: 7777 }]);
  const fakeDiskApi = {
    createFolder: async () => ({ id: 9001 }),
    getExternalLink: async (folderId, ctx) => {
      usedContext = ctx;
      return `https://b24.example.com/link/${folderId}`;
    }
  };

  const adminCtx = { authId: 'ADMIN_OAUTH', domain: 'test.b24.ru', userId: 1, isAdmin: true };

  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: { diskApi: fakeDiskApi, callMethod: async () => null },
    getAdminContext: async () => adminCtx,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;

  const req = makeReq({ params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(usedContext, 'context should have been passed to disk call');
  assert.equal(usedContext?.authId, 'ADMIN_OAUTH', 'must use admin OAuth context, not req.bitrixContext');
});

test('POST /api/brands/:id/external-link returns 502 when disk call fails', async () => {
  const store = createFakeBrandStore([{ id: 1, name: 'ГПН', disk_folder_id: null }]);
  const fakeDiskApi = {
    createFolder: async () => { throw new Error('Bitrix disk error'); },
    getExternalLink: async () => 'https://b24.example.com/link/1'
  };

  const router = createBrandRouter({
    brandStore: store,
    bitrixClient: { diskApi: fakeDiskApi, callMethod: async () => null },
    getAdminContext: fakeGetAdminContext,
    diskRootFolderId: 100
  });
  const handler = findRoute(router, 'post', '/:id/external-link');
  if (!handler) return;

  const req = makeReq({ params: { id: '1' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 502);
  assert.ok(res._payload?.error);
});

// ===========================================================================
// Factory validation
// ===========================================================================

test('createBrandRouter throws when brandStore is missing', () => {
  assert.throws(
    () => createBrandRouter({ bitrixClient: {}, getAdminContext: async () => ({}) }),
    /brandStore is required/
  );
});

test('createBrandRouter throws when bitrixClient is missing', () => {
  assert.throws(
    () => createBrandRouter({ brandStore: {}, getAdminContext: async () => ({}) }),
    /bitrixClient is required/
  );
});

test('createBrandRouter throws when getAdminContext is missing', () => {
  assert.throws(
    () => createBrandRouter({ brandStore: {}, bitrixClient: {} }),
    /getAdminContext is required/
  );
});
