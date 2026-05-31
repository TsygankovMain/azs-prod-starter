import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReportSlotKey,
  createReportsRouter,
  resolveAdminCrmSyncContext,
  resolveReportCrmAndDiskContexts
} from '../src/reports/reportsRoutes.js';
import { updateReportCrmItem } from '../src/reports/reportCrmSync.js';

test('parseReportSlotKey handles auto and manual slot keys', () => {
  assert.deepEqual(parseReportSlotKey('2026-05-28:1414'), {
    slotDate: '2026-05-28',
    slotHHmm: '1414'
  });
  assert.deepEqual(parseReportSlotKey('manual:2026-05-28:1414'), {
    slotDate: '2026-05-28',
    slotHHmm: '1414'
  });
});

test('parseReportSlotKey rejects malformed slot keys with typed config error', () => {
  assert.throws(
    () => parseReportSlotKey('legacy-slot'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
  assert.throws(
    () => parseReportSlotKey('2026-05-28:'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
  assert.throws(
    () => parseReportSlotKey('manual:2026-05-28:'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
});

test('photo flow CRM sync uses Bitrix portal-admin context (not current AZS user context)', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const requestContext = {
    memberId: 'member-1',
    domain: 'example.bitrix24.ru',
    userId: 777,
    authId: 'user-auth',
    refreshToken: 'user-refresh',
    isAdmin: false
  };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.ok(crmContext);
  assert.equal(crmContext.authId, 'admin-auth');
  assert.notEqual(crmContext.authId, requestContext.authId);

  const calls = [];
  const bitrixClient = {
    async updateReportItem(payload) {
      calls.push(payload);
      return { reportItemId: Number(payload.id), raw: {} };
    }
  };

  const settings = {
    report: {
      entityTypeId: 999,
      fields: { folderId: 'ufCrm999Folder' },
      stages: { inProgress: 'STAGE_IN_PROGRESS' }
    }
  };
  const report = { reportItemId: 123 };

  await updateReportCrmItem({
    bitrixClient,
    settings,
    report,
    status: 'in_progress',
    diskFolderId: 42,
    requireReportItem: true,
    context: crmContext
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.authId, 'admin-auth');
});

test('resolveAdminCrmSyncContext returns null when admin context is missing', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return null;
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.equal(crmContext, null);
});

test('resolveReportCrmAndDiskContexts uses current request context for Disk and portal-admin for CRM sync', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const requestContext = {
    memberId: 'member-1',
    domain: 'example.bitrix24.ru',
    userId: 777,
    authId: 'user-auth',
    refreshToken: 'user-refresh',
    isAdmin: false
  };

  const { diskContext, crmSyncContext } = await resolveReportCrmAndDiskContexts({ authContextStore, requestContext });
  assert.equal(diskContext, requestContext);
  assert.equal(crmSyncContext.authId, 'admin-auth');
  assert.notEqual(crmSyncContext.authId, diskContext.authId);
});

test('resolveReportCrmAndDiskContexts throws admin_context_missing when admin context is missing', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return null;
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  await assert.rejects(
    () => resolveReportCrmAndDiskContexts({ authContextStore, requestContext }),
    (error) => error?.code === 'admin_context_missing' && error?.statusCode === 502
  );
});

test('resolveAdminCrmSyncContext requires current request portal identity', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const crmContext = await resolveAdminCrmSyncContext({
    authContextStore,
    requestContext: {}
  });
  assert.equal(crmContext, null);
});

test('resolveAdminCrmSyncContext returns null when admin context belongs to another portal', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:other',
        context: {
          memberId: 'member-2',
          domain: 'other.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.equal(crmContext, null);
});

test('photo upload response returns crm fileId and diskObjectId, and store persists crm fileId', async () => {
  const uploads = [];
  const upsertCalls = [];

  const reportsStore = {
    async getById(id) {
      if (Number(id) !== 77) {
        return null;
      }
      return {
        id: 77,
        slotKey: '2026-05-28:1414',
        azsId: '7',
        adminUserId: 10,
        status: 'new',
        reportItemId: 999,
        deadlineAt: new Date().toISOString()
      };
    },
    async upsertPhoto(payload) {
      upsertCalls.push(payload);
    },
    async listPhotos() {
      return [
        { reportId: 77, photoCode: '42', fileId: 1902, fileName: 'name.jpg', diskFolderId: 555, uploadedBy: 10 }
      ];
    },
    async setReportStatus() {}
  };

  const settingsStore = {
    async read() {
      return {
        azs: {
          entityTypeId: 145,
          fields: { photoSet: 'UF_PHOTO_SET' }
        },
        photoType: {
          entityTypeId: 1112
        },
        report: {
          entityTypeId: 163,
          fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
          stages: { inProgress: 'DT163_1:IN_PROGRESS' }
        },
        disk: {
          rootFolderId: 0,
          folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}'
        },
        timezone: 'Europe/Moscow'
      };
    }
  };

  const bitrixClient = {
    diskApi: {
      async findChildFolder() { return null; },
      async findChildFile() { return null; },
      async createFolder() { return { id: 555 }; },
      async markFileDeleted() { return { id: 1 }; },
      async uploadFile(folderId, { fileName, content }) {
        uploads.push({ folderId, fileName, content });
        return { diskObjectId: 902, crmFileId: 1902, fileName };
      }
    },
    async getCrmItem({ entityTypeId, id }) {
      if (entityTypeId === 145) {
        return { id, title: 'АЗС №14', UF_PHOTO_SET: [42] };
      }
      if (entityTypeId === 1112) {
        return { id, title: '42. Колонки' };
      }
      if (entityTypeId === 163) {
        return { id, UF_FOLDER: '555' };
      }
      return null;
    },
    async updateReportItem() {
      return { ok: true };
    }
  };

  const notificationService = {
    async notifyReportDone() {},
    async notifyDispatch() {},
    async notifyReportExpired() {}
  };

  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore,
    bitrixClient,
    notificationService,
    authContextStore,
    crmSyncJobStore: { async enqueue() {} }
  });

  const layer = router.stack.find((l) => l?.route?.path === '/:id/photo');
  assert.ok(layer, 'photo route must exist');
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];

  const jsonResponses = [];
  const req = {
    params: { id: '77' },
    body: { photoCode: '42' },
    file: {
      originalname: 'upload.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('mock-image')
    },
    user: { id: 10 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'member-1',
      domain: 'example.bitrix24.ru',
      userId: 10,
      authId: 'user-auth',
      refreshToken: 'user-refresh',
      isAdmin: false
    }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { jsonResponses.push({ status: this.statusCode, payload }); return payload; }
  };

  await handler(req, res);

  assert.equal(jsonResponses.length, 1);
  assert.equal(jsonResponses[0].status, 200);
  assert.equal(jsonResponses[0].payload?.item?.fileId, 1902);
  assert.equal(jsonResponses[0].payload?.item?.diskObjectId, 902);
  assert.equal(jsonResponses[0].payload?.item?.syncQueued, true);

  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].fileId, 1902);
});

test('photo route enqueues a durable CRM sync job with correct payload', async () => {
  const enqueueCalls = [];

  const reportsStore = {
    async getById() {
      return {
        id: 88,
        slotKey: '2026-05-29:1010',
        azsId: '8',
        adminUserId: 10,
        status: 'new',
        reportItemId: 1001,
        deadlineAt: new Date().toISOString()
      };
    },
    async upsertPhoto() {},
    async listPhotos() {
      return [{ reportId: 88, photoCode: '42', fileId: 501, fileName: 'f.jpg', diskFolderId: 700, uploadedBy: 10 }];
    },
    async setReportStatus() {}
  };

  const settingsStore = {
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
          folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}'
        }
      };
    }
  };

  const bitrixClient = {
    diskApi: {
      async findChildFolder() { return null; },
      async findChildFile() { return null; },
      async createFolder() { return { id: 700 }; },
      async markFileDeleted() { return { id: 1 }; },
      async uploadFile(folderId, { fileName }) {
        return { diskObjectId: 901, crmFileId: 501, fileName, folderId };
      }
    },
    async getCrmItem({ entityTypeId, id }) {
      if (entityTypeId === 145) return { id, title: 'АЗС Тест', UF_PHOTO_SET: [42] };
      if (entityTypeId === 1112) return { id, title: '42. Колонки' };
      return null;
    },
    async updateReportItem() { return { ok: true }; }
  };

  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const crmSyncJobStore = {
    async enqueue(job) { enqueueCalls.push(job); }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore,
    bitrixClient,
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore,
    crmSyncJobStore
  });

  const layer = router.stack.find((l) => l?.route?.path === '/:id/photo');
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];

  const responses = [];
  const req = {
    params: { id: '88' },
    body: { photoCode: '42' },
    file: { originalname: 'upload.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('mock-image') },
    user: { id: 10 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'member-1',
      domain: 'example.bitrix24.ru',
      userId: 10,
      authId: 'user-auth',
      refreshToken: 'user-refresh',
      isAdmin: false,
      key: 'user-ctx-key'
    }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { responses.push({ status: this.statusCode, payload }); return payload; }
  };

  await handler(req, res);

  assert.equal(responses[0]?.status, 200);
  assert.equal(responses[0]?.payload?.item?.syncQueued, true);
  assert.equal(enqueueCalls.length, 1, 'must enqueue exactly one durable job');
  assert.equal(enqueueCalls[0].reportId, 88);
  assert.equal(enqueueCalls[0].payload.status, 'in_progress');
  assert.equal(enqueueCalls[0].payload.contextKey, 'user-ctx-key');
});

test('photo route returns structured retryable errorCode for transient Bitrix upload failures', async () => {
  const reportsStore = {
    async getById() {
      return {
        id: 89,
        slotKey: '2026-05-29:1015',
        azsId: '8',
        adminUserId: 10,
        status: 'new',
        reportItemId: 1002
      };
    },
    async upsertPhoto() {},
    async listPhotos() { return []; },
    async setReportStatus() {}
  };

  const settingsStore = {
    async read() {
      return {
        azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
        photoType: { entityTypeId: 1112 },
        report: {
          entityTypeId: 163,
          fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
          stages: { inProgress: 'DT163_1:IN_PROGRESS' }
        },
        disk: { rootFolderId: 0, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' }
      };
    }
  };

  const bitrixClient = {
    diskApi: {
      async findChildFolder() { return null; },
      async findChildFile() { return null; },
      async createFolder() { return { id: 700 }; },
      async markFileDeleted() { return { id: 1 }; },
      async uploadFile() {
        throw new Error('Bitrix REST disk.folder.uploadfile failed with HTTP 504: gateway timeout');
      }
    },
    async getCrmItem({ entityTypeId, id }) {
      if (entityTypeId === 145) return { id, title: 'АЗС Тест', UF_PHOTO_SET: [42] };
      if (entityTypeId === 1112) return { id, title: '42. Колонки' };
      return null;
    },
    async updateReportItem() {
      return { ok: true };
    }
  };

  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const router = createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore,
    bitrixClient,
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore,
    crmSyncJobStore: { async enqueue() {} }
  });

  const layer = router.stack.find((l) => l?.route?.path === '/:id/photo');
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];

  const responses = [];
  const req = {
    params: { id: '89' },
    body: { photoCode: '42' },
    file: { originalname: 'upload.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('mock-image') },
    user: { id: 10 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'member-1',
      domain: 'example.bitrix24.ru',
      userId: 10,
      authId: 'user-auth',
      refreshToken: 'user-refresh',
      isAdmin: false
    }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { responses.push({ status: this.statusCode, payload }); return payload; }
  };

  await handler(req, res);

  assert.equal(responses[0]?.status, 500);
  assert.equal(responses[0]?.payload?.errorCode, 'bitrix_retryable');
});
