/**
 * LOGIC-D3: Tests for status decision in POST /:id/photo handler.
 *
 * When the last required photo is uploaded, the handler must:
 *   - call setReportStatus with status='done'
 *   - enqueue CRM sync with payload.status='done'
 *   - return JSON with status='done', completed=true, allUploaded=true
 *
 * When not all required photos are present, status must stay 'in_progress'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure (mirrors reportsPhotoCrmContext.test.js pattern)
// ---------------------------------------------------------------------------

function makePhotoRouteHandler(overrides = {}) {
  const {
    reportId = 77,
    azsId = '7',
    adminUserId = 10,
    photoCode = '42',
    requiredPhotoIds = [42], // photo type ids returned by AZS card
    currentPhotosAfterUpload = [],
    uploadedFolderId = 700
  } = overrides;

  const setStatusCalls = [];
  const enqueueCalls = [];

  const reportsStore = {
    async getById(id) {
      if (Number(id) !== reportId) return null;
      return {
        id: reportId,
        slotKey: '2026-05-28:1414',
        azsId,
        adminUserId,
        status: 'in_progress',
        reportItemId: 999,
        deadlineAt: new Date().toISOString()
      };
    },
    async upsertPhoto() {},
    // Returns photos currently in DB *after* upsert (determines allRequiredUploaded)
    async listPhotos() {
      return currentPhotosAfterUpload;
    },
    async setReportStatus(args) {
      setStatusCalls.push(args);
    }
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
      async createFolder() { return { id: uploadedFolderId }; },
      async markFileDeleted() { return { id: 1 }; },
      async uploadFile(folderId, { fileName }) {
        return { diskObjectId: 901, crmFileId: 501, fileName, folderId: uploadedFolderId };
      }
    },
    async getCrmItem({ entityTypeId, id }) {
      // AZS card with the configured required photo set
      if (entityTypeId === 145) {
        return { id, title: 'АЗС Тест', UF_PHOTO_SET: requiredPhotoIds };
      }
      // Photo-type records — each required photo id
      if (entityTypeId === 1112) {
        const found = requiredPhotoIds.find((rid) => Number(rid) === Number(id));
        if (found) return { id: Number(id), title: `${id}. Фото` };
        return null;
      }
      return null;
    },
    async updateReportItem() { return { ok: true }; }
  };

  const crmSyncJobStore = {
    async enqueue(job) { enqueueCalls.push(job); return { id: 1 }; },
    async listByReport() { return []; }
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
    authContextStore: {
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
    },
    crmSyncJobStore
  });

  const layer = router.stack.find((l) => l?.route?.path === '/:id/photo');
  assert.ok(layer, 'photo route must exist');
  const handlers = layer.route.stack.map((s) => s.handle);
  const handler = handlers[handlers.length - 1];

  const makeReq = () => ({
    params: { id: String(reportId) },
    body: { photoCode },
    file: { originalname: 'upload.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('mock-image') },
    user: { id: adminUserId },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {
      memberId: 'member-1',
      domain: 'example.bitrix24.ru',
      userId: adminUserId,
      authId: 'user-auth',
      refreshToken: 'user-refresh',
      isAdmin: false,
      key: 'user-ctx-key'
    }
  });

  const responses = [];
  const makeRes = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { responses.push({ statusCode: this.statusCode, payload }); return payload; }
  });

  return { handler, makeReq, makeRes, responses, setStatusCalls, enqueueCalls };
}

// ---------------------------------------------------------------------------
// LOGIC-D3 — Test 1 (RED): uploading the LAST required photo → status 'done'
// ---------------------------------------------------------------------------

test('LOGIC-D3: uploading last required photo sets status=done in store, CRM sync payload, and JSON response', async () => {
  // Required photos: [42, 44]. After upload, both 42 and 44 are present.
  const { handler, makeReq, makeRes, responses, setStatusCalls, enqueueCalls } = makePhotoRouteHandler({
    reportId: 101,
    azsId: '7',
    adminUserId: 10,
    photoCode: '44', // uploading the last one
    requiredPhotoIds: [42, 44],
    currentPhotosAfterUpload: [
      // listPhotos returns both after upsert — all required are now uploaded
      { reportId: 101, photoCode: '42', fileId: 501, fileName: 'a.jpg', diskFolderId: 700, uploadedBy: 10 },
      { reportId: 101, photoCode: '44', fileId: 502, fileName: 'b.jpg', diskFolderId: 700, uploadedBy: 10 }
    ]
  });

  await handler(makeReq(), makeRes());

  assert.equal(responses.length, 1, 'handler must respond once');
  assert.equal(responses[0].statusCode, 200, 'should succeed');

  // setReportStatus must be called with 'done'
  assert.equal(setStatusCalls.length, 1, 'setReportStatus must be called once');
  assert.equal(setStatusCalls[0].status, 'done', 'setReportStatus must use done when all required uploaded');

  // CRM sync enqueue must carry status='done'
  assert.equal(enqueueCalls.length, 1, 'must enqueue exactly one CRM sync job');
  assert.equal(enqueueCalls[0].payload.status, 'done', 'enqueue payload.status must be done');

  // JSON response fields
  const item = responses[0].payload?.item;
  assert.ok(item, 'response must have item');
  assert.equal(item.status, 'done', 'response item.status must be done');
  assert.equal(item.completed, true, 'response item.completed must be true when all uploaded');
  assert.equal(item.allUploaded, true, 'response item.allUploaded must be true');
});

// ---------------------------------------------------------------------------
// LOGIC-D3 — Test 2 (RED): uploading a photo when NOT all required present → in_progress
// ---------------------------------------------------------------------------

test('LOGIC-D3: uploading a photo when not all required photos present keeps status=in_progress', async () => {
  // Required photos: [42, 44]. After upload, only 42 is present — 44 still missing.
  const { handler, makeReq, makeRes, responses, setStatusCalls, enqueueCalls } = makePhotoRouteHandler({
    reportId: 102,
    azsId: '8',
    adminUserId: 10,
    photoCode: '42', // uploading first, second still missing
    requiredPhotoIds: [42, 44],
    currentPhotosAfterUpload: [
      // Only photo 42 uploaded, 44 still missing
      { reportId: 102, photoCode: '42', fileId: 503, fileName: 'a.jpg', diskFolderId: 700, uploadedBy: 10 }
    ]
  });

  await handler(makeReq(), makeRes());

  assert.equal(responses.length, 1, 'handler must respond once');
  assert.equal(responses[0].statusCode, 200, 'should succeed');

  // setReportStatus must be called with 'in_progress'
  assert.equal(setStatusCalls.length, 1, 'setReportStatus must be called once');
  assert.equal(setStatusCalls[0].status, 'in_progress', 'setReportStatus must use in_progress when not all uploaded');

  // CRM sync enqueue must carry status='in_progress'
  assert.equal(enqueueCalls.length, 1, 'must enqueue exactly one CRM sync job');
  assert.equal(enqueueCalls[0].payload.status, 'in_progress', 'enqueue payload.status must be in_progress when not done');

  // JSON response fields
  const item = responses[0].payload?.item;
  assert.ok(item, 'response must have item');
  assert.equal(item.status, 'in_progress', 'response item.status must be in_progress');
  assert.equal(item.completed, false, 'response item.completed must be false when not all uploaded');
  assert.equal(item.allUploaded, false, 'response item.allUploaded must be false');
});
