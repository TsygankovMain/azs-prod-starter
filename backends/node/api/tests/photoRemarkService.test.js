import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRemarkService } from '../src/notifications/photoRemarkService.js';

// ---------------------------------------------------------------------------
// Fake remarkStore
// ---------------------------------------------------------------------------

const createFakeRemarkStore = () => {
  let seq = 0;
  const records = new Map();

  return {
    async insertRemark(data) {
      seq += 1;
      const record = {
        id: seq,
        createdAt: new Date().toISOString(),
        azsId: data.azsId || '',
        azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole,
        recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null,
        message: data.message || '',
        senderUserId: data.senderUserId ?? null,
        senderName: data.senderName ?? null,
        deliveryStatus: 'sent',
        deliveryError: null,
        photos: data.photos || []
      };
      records.set(seq, { ...record });
      return record;
    },
    async markDelivery(id, status, error = null) {
      const r = records.get(id);
      if (r) { r.deliveryStatus = status; r.deliveryError = error; }
    },
    async getById(id) {
      return records.get(id) ?? null;
    },
    records
  };
};

// ---------------------------------------------------------------------------
// Fake reportsStore
// ---------------------------------------------------------------------------

const createFakeReportsStore = (photosByKey = {}) => ({
  async getPhoto(reportId, photoCode) {
    return photosByKey[`${reportId}:${photoCode}`] ?? null;
  }
});

// ---------------------------------------------------------------------------
// Fake settingsStore
// ---------------------------------------------------------------------------

const makeSettings = (overrides = {}) => ({
  azs: {
    entityTypeId: 145,
    fields: { manager: 'UF_CRM_1_1000', admin: 'UF_CRM_1_2000' },
    ...overrides.azs
  },
  ...overrides
});

const createFakeSettingsStore = (settings = makeSettings()) => ({
  async read() { return settings; }
});

// ---------------------------------------------------------------------------
// Fake bitrixClient
// ---------------------------------------------------------------------------

const createFakeBitrixClient = ({
  azsItem = { id: 42, ufCrm1_1000: 10, ufCrm1_2000: 20 },
  managerName = 'Менеджер И.',
  adminName = 'Админ П.',
  uploadCalls = [],
  commitCalls = [],
  failOnUploadIndex = -1 // which upload call (0-based) should throw
} = {}) => ({
  async getCrmItem({ id }) {
    return id === 42 ? azsItem : null;
  },
  async callMethod(method, params) {
    if (method === 'user.get') {
      const id = Number(params?.ID || 0);
      if (id === 10) return [{ ID: 10, NAME: managerName.split(' ')[0], LAST_NAME: managerName.split(' ')[1] || '' }];
      if (id === 20) return [{ ID: 20, NAME: adminName.split(' ')[0], LAST_NAME: adminName.split(' ')[1] || '' }];
      return [];
    }
    if (method === 'imbot.v2.File.upload') {
      const idx = uploadCalls.length;
      uploadCalls.push(params);
      if (idx === failOnUploadIndex) throw new Error('upload_failed_on_second');
    }
    if (method === 'im.disk.file.commit') {
      commitCalls.push(params);
    }
    return {};
  },
  diskApi: {
    async downloadFileContent(diskObjectId) {
      return { base64: Buffer.from(`content_${diskObjectId}`).toString('base64'), name: `file_${diskObjectId}.jpg` };
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeService = (overrides = {}) => {
  const remarkStore = overrides.remarkStore ?? createFakeRemarkStore();
  const reportsStore = overrides.reportsStore ?? createFakeReportsStore({
    '10:front': { diskObjectId: 1001, fileName: 'front.jpg', fileId: 9001 },
    '10:side':  { diskObjectId: 1002, fileName: 'side.jpg',  fileId: 9002 },
    '10:back':  { diskObjectId: 1003, fileName: 'back.jpg',  fileId: 9003 }
  });
  const settingsStore = overrides.settingsStore ?? createFakeSettingsStore();
  const bitrixClient = overrides.bitrixClient ?? createFakeBitrixClient();
  const getAdminContext = overrides.getAdminContext ?? (async () => ({ authId: 'admin-token' }));

  const svc = createPhotoRemarkService({
    bitrixClient,
    remarkStore,
    reportsStore,
    settingsStore,
    getAdminContext,
    mode: overrides.mode ?? 'bot',
    botId: overrides.botId ?? 5
  });

  return { svc, remarkStore, bitrixClient };
};

// ---------------------------------------------------------------------------
// Tests — bot mode
// ---------------------------------------------------------------------------

test('bot mode: 3 photos → 3 upload calls, text on first only', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    message: 'Плохой порядок',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'side' },
      { reportId: 10, photoCode: 'back' }
    ],
    sender: { id: 3, name: 'Проверяющий А.' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(uploadCalls.length, 3, 'should be 3 upload calls');

  // Text only on first file
  assert.ok(uploadCalls[0].fields.FILE.message, 'first upload should have message');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('АЗС Север'), 'message contains azsTitle');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('Проверяющий А.'), 'message contains sender name');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('Плохой порядок'), 'message contains text');
  assert.equal(uploadCalls[1].fields.FILE.message, undefined, 'second upload should have no message');
  assert.equal(uploadCalls[2].fields.FILE.message, undefined, 'third upload should have no message');

  // Journal record
  const stored = remarkStore.records.get(result.id);
  assert.equal(stored.deliveryStatus, 'sent');
});

test('bot mode: failure on 2nd upload → status failed, record exists', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls, failOnUploadIndex: 1 });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: null, recipientRole: 'manager',
    message: 'Test failure',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'side' }
    ],
    sender: { id: 3, name: 'Тест' }
  });

  assert.equal(result.deliveryStatus, 'failed', 'should be failed on upload error');
  assert.ok(result.deliveryError, 'should have error text');
  // Journal record must exist
  assert.ok(remarkStore.records.size > 0, 'record must be written even on failure');
  const stored = [...remarkStore.records.values()][0];
  assert.equal(stored.deliveryStatus, 'failed');
});

test('bot mode: RECIPIENT_NOT_SET when manager not in AZS card', async () => {
  const bitrixClient = createFakeBitrixClient({
    azsItem: { id: 42 } // no manager field
  });
  const { svc } = makeService({ bitrixClient });

  await assert.rejects(
    () => svc.sendRemark({
      azsId: '42', recipientRole: 'manager', message: 'test',
      photos: [{ reportId: 10, photoCode: 'front' }],
      sender: { id: 1, name: 'Кто-то' }
    }),
    (err) => {
      assert.equal(err.errorCode, 'RECIPIENT_NOT_SET');
      return true;
    }
  );
});

test('commit mode: single im.disk.file.commit with FILE_ID array', async () => {
  const commitCalls = [];
  const bitrixClient = createFakeBitrixClient({ commitCalls });
  const { svc } = makeService({ bitrixClient, mode: 'commit' });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Юг', recipientRole: 'admin',
    message: 'Грязь на колонках',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'back' }
    ],
    sender: { id: 5, name: 'Ревизор' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(commitCalls.length, 1, 'only one commit call');
  assert.ok(Array.isArray(commitCalls[0].FILE_ID), 'FILE_ID should be array');
  assert.equal(commitCalls[0].FILE_ID.length, 2, 'two file ids');
  assert.ok(commitCalls[0].MESSAGE.includes('АЗС Юг'));
});

test('retry: re-sending a failed remark → markDelivery called with sent', async () => {
  const uploadCalls = [];
  const remarkStore = createFakeRemarkStore();
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc } = makeService({ remarkStore, bitrixClient });

  // First send succeeds
  const first = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС', recipientRole: 'manager',
    message: 'msg', photos: [{ reportId: 10, photoCode: 'front' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  // Simulate marking as failed manually
  await remarkStore.markDelivery(first.id, 'failed', 'network error');

  // Retry (resend same data)
  const retried = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС', recipientRole: 'manager',
    message: 'msg', photos: [{ reportId: 10, photoCode: 'front' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  assert.equal(retried.deliveryStatus, 'sent', 'retry should succeed');
});
