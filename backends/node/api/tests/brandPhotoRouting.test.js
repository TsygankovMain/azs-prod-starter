/**
 * S8-B2b: Роутинг новых фото АЗС бренда в папку бренда.
 *
 * Три сценария:
 *   1. АЗС принадлежит бренду, у бренда есть disk_folder_id=777 →
 *      дневная папка создаётся ВНУТРИ 777 (не под общим корнем).
 *   2. АЗС без бренда → под общим корнем (регресс-гард).
 *   3. АЗС в бренде, но у бренда ещё нет disk_folder_id (ссылку не получали) →
 *      фоллбек под общим корнем.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._payload = payload; return payload; }
  };
  return res;
}

/**
 * Строим минимальный набор зависимостей для теста загрузки фото.
 * azsId отчёта = '42'.
 *
 * @param {object} opts
 * @param {Function} opts.getBrandByAzsId   — мок brandStore.getBrandByAzsId
 * @param {Function} [opts.createFolder]    — мок diskApi.createFolder (записывает вызовы)
 */
function makePhotoDeps({ getBrandByAzsId, createFolder }) {
  const createdFolders = [];

  const defaultCreateFolder = async (parentId, { name }) => {
    createdFolders.push({ parentId, name });
    return { id: parentId * 10 + 1 };
  };

  const resolvedCreateFolder = createFolder || defaultCreateFolder;

  return {
    deps: {
      reportsStore: {
        async getById(id) {
          return {
            id: Number(id),
            slotKey: '2026-06-15:0900',
            azsId: '42',
            adminUserId: 10,
            status: 'new',
            reportItemId: 500,
            deadlineAt: new Date().toISOString()
          };
        },
        async upsertPhoto() {},
        async listPhotos() {
          return [{ reportId: Number(1), photoCode: '1', fileId: 1, fileName: 'f.jpg', diskFolderId: 1, uploadedBy: 10 }];
        },
        async setReportStatus() {}
      },
      settingsStore: {
        async read() {
          return {
            azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
            photoType: { entityTypeId: 1112 },
            report: {
              entityTypeId: 163,
              fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
              stages: { inProgress: 'DT163_1:IN_PROGRESS' }
            },
            disk: {
              rootFolderId: 0,
              folderNameTemplate: '{azs}_{azs_name}/{yyyy-mm}/{dd}'
            }
          };
        }
      },
      bitrixClient: {
        diskApi: {
          async findChildFolder() { return null; },
          async findChildFile() { return null; },
          async createFolder(parentId, opts) {
            return resolvedCreateFolder(parentId, opts);
          },
          async markFileDeleted() { return { id: 1 }; },
          async uploadFile(folderId, { fileName }) {
            return { diskObjectId: 901, crmFileId: 501, fileName };
          }
        },
        async getCrmItem({ entityTypeId, id }) {
          if (entityTypeId === 145) return { id, title: 'АЗС Тест', UF_PHOTO_SET: [1] };
          if (entityTypeId === 1112) return { id, title: '1. Стойка' };
          return null;
        },
        async updateReportItem() { return { ok: true }; }
      },
      notificationService: {
        async notifyReportDone() {},
        async notifyDispatch() {},
        async notifyReportExpired() {}
      },
      authContextStore: {
        async getLastAdminContext() {
          return {
            key: 'admin:ctx',
            context: {
              memberId: 'mem-1',
              domain: 'test.bitrix24.ru',
              userId: 1,
              authId: 'admin-auth',
              refreshToken: 'admin-ref',
              isAdmin: true
            }
          };
        }
      },
      dispatchService: {},
      crmSyncJobStore: {
        async enqueue() { return { id: 1 }; }
      },
      brandStore: {
        getBrandByAzsId
      }
    },
    createdFolders
  };
}

function makeUploadReq(overrides = {}) {
  return {
    params: { id: '99' },
    body: { photoCode: '1' },
    file: {
      originalname: 'upload.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('mock-image-data')
    },
    user: { id: 10 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'mem-1',
      domain: 'test.bitrix24.ru',
      userId: 10,
      authId: 'user-auth',
      refreshToken: 'user-ref',
      isAdmin: false,
      key: 'user-ctx-key'
    },
    ...overrides
  };
}

function getPhotoHandler(router) {
  const layer = router.stack.find((l) => l?.route?.path === '/:id/photo');
  assert.ok(layer, 'Route /:id/photo must exist');
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

// ---------------------------------------------------------------------------
// Тест 1: АЗС в бренде с disk_folder_id=777 → папка создаётся ВНУТРИ 777
// ---------------------------------------------------------------------------

test('S8-B2b: фото АЗС бренда (disk_folder_id=777) — дневная папка создаётся под папкой бренда, не под общим корнем', async () => {
  const folderCreationCalls = [];

  const { deps } = makePhotoDeps({
    getBrandByAzsId: async (azsId) => {
      assert.equal(String(azsId), '42', 'getBrandByAzsId должен вызываться с azsId отчёта');
      return { id: 5, name: 'ТестБренд', disk_folder_id: 777 };
    },
    createFolder: async (parentId, { name }) => {
      folderCreationCalls.push({ parentId, name });
      return { id: parentId * 10 + 1 };
    }
  });

  const router = createReportsRouter(deps);
  const handler = getPhotoHandler(router);

  const req = makeUploadReq();
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200, `Ожидали 200, получили ${res.statusCode}: ${JSON.stringify(res._payload)}`);

  // Первая createFolder должна быть вызвана с parentId=777 (корень бренда)
  assert.ok(
    folderCreationCalls.length > 0,
    'Должен быть хотя бы один вызов createFolder'
  );
  const rootCall = folderCreationCalls[0];
  assert.equal(
    rootCall.parentId,
    777,
    `Первая папка должна создаваться внутри бренд-папки 777, а не под общим корнем. Реальный parentId: ${rootCall.parentId}`
  );
});

// ---------------------------------------------------------------------------
// Тест 2: АЗС без бренда → под общим корнем (регресс-гард)
// ---------------------------------------------------------------------------

test('S8-B2b: фото АЗС без бренда — папка создаётся под общим корнем (регресс-гард)', async () => {
  const folderCreationCalls = [];
  const STORAGE_ROOT_ID = Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1);

  const { deps } = makePhotoDeps({
    getBrandByAzsId: async () => null, // АЗС не в бренде
    createFolder: async (parentId, { name }) => {
      folderCreationCalls.push({ parentId, name });
      return { id: parentId * 10 + 1 };
    }
  });

  const router = createReportsRouter(deps);
  const handler = getPhotoHandler(router);

  const req = makeUploadReq();
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200, `Ожидали 200, получили ${res.statusCode}: ${JSON.stringify(res._payload)}`);

  // Путь без бренда: первый createFolder — корневая папка AZS-Photo-Reports внутри STORAGE_ROOT_ID
  assert.ok(folderCreationCalls.length > 0, 'Должен быть хотя бы один вызов createFolder');
  const rootCall = folderCreationCalls[0];
  // Не должен использовать 777 как parentId
  assert.notEqual(
    rootCall.parentId,
    777,
    'Без бренда папка НЕ должна создаваться внутри 777'
  );
  // Должен использовать STORAGE_ROOT_ID как первый родитель
  assert.equal(
    rootCall.parentId,
    STORAGE_ROOT_ID,
    `Без бренда первый создаваемый элемент должен быть внутри STORAGE_ROOT_ID (${STORAGE_ROOT_ID}), получили: ${rootCall.parentId}`
  );
});

// ---------------------------------------------------------------------------
// Тест 3: АЗС в бренде, но disk_folder_id=null → фоллбек под общим корнем
// ---------------------------------------------------------------------------

test('S8-B2b: фото АЗС бренда БЕЗ disk_folder_id — фоллбек под общим корнем (ссылку не получали)', async () => {
  const folderCreationCalls = [];
  const STORAGE_ROOT_ID = Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1);

  const { deps } = makePhotoDeps({
    getBrandByAzsId: async () => ({ id: 5, name: 'БрендБезПапки', disk_folder_id: null }),
    createFolder: async (parentId, { name }) => {
      folderCreationCalls.push({ parentId, name });
      return { id: parentId * 10 + 1 };
    }
  });

  const router = createReportsRouter(deps);
  const handler = getPhotoHandler(router);

  const req = makeUploadReq();
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200, `Ожидали 200, получили ${res.statusCode}: ${JSON.stringify(res._payload)}`);

  assert.ok(folderCreationCalls.length > 0, 'Должен быть хотя бы один вызов createFolder');
  const rootCall = folderCreationCalls[0];
  assert.notEqual(
    rootCall.parentId,
    777,
    'При disk_folder_id=null папка НЕ должна создаваться внутри 777'
  );
  assert.equal(
    rootCall.parentId,
    STORAGE_ROOT_ID,
    `При disk_folder_id=null должен использоваться STORAGE_ROOT_ID (${STORAGE_ROOT_ID}), получили: ${rootCall.parentId}`
  );
});
