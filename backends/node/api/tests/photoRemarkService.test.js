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
      // UX-2: photos now carry comment + per-photo delivery_status
      const photos = (data.photos || []).map((ph) => ({
        reportId: ph.reportId,
        photoCode: ph.photoCode,
        comment: ph.comment ?? '',
        deliveryStatus: ph.deliveryStatus ?? 'pending',
        deliveryError: ph.deliveryError ?? null
      }));
      const record = {
        id: seq,
        createdAt: new Date().toISOString(),
        azsId: data.azsId || '',
        azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole,
        recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null,
        senderUserId: data.senderUserId ?? null,
        senderName: data.senderName ?? null,
        deliveryStatus: 'sent',
        deliveryError: null,
        photos
      };
      records.set(seq, { ...record, photos: [...photos] });
      return record;
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
      if (!r) return null;
      return { ...r, photos: r.photos ? [...r.photos] : [] };
    },
    async getPhotoRow(remarkId, reportId, photoCode) {
      const r = records.get(remarkId);
      if (!r) return null;
      return r.photos.find(
        (p) => Number(p.reportId) === Number(reportId) && p.photoCode === photoCode
      ) ?? null;
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

// UX-2: updated — now each photo carries its OWN message (per-photo comment)
test('bot mode: 3 photos → 3 upload calls, each with its own message', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Грязь на стекле' },
      { reportId: 10, photoCode: 'side',  comment: 'Сломан насос' },
      { reportId: 10, photoCode: 'back',  comment: 'Мусор за колонкой' }
    ],
    sender: { id: 3, name: 'Проверяющий А.' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(uploadCalls.length, 3, 'should be 3 upload calls');

  // EACH upload has its OWN message (per-photo comment)
  assert.ok(uploadCalls[0].fields.message, 'first upload should have message');
  assert.ok(uploadCalls[0].fields.message.includes('АЗС Север'), 'message contains azsTitle');
  assert.ok(uploadCalls[0].fields.message.includes('Проверяющий А.'), 'message contains sender name');
  assert.ok(uploadCalls[0].fields.message.includes('Грязь на стекле'), 'first message contains front comment');
  assert.ok(uploadCalls[0].fields.content, 'first upload should have base64 content');
  assert.ok(uploadCalls[1].fields.message, 'second upload has its own message');
  assert.ok(uploadCalls[1].fields.message.includes('Сломан насос'), 'second message contains side comment');
  assert.ok(uploadCalls[2].fields.message, 'third upload has its own message');
  assert.ok(uploadCalls[2].fields.message.includes('Мусор за колонкой'), 'third message contains back comment');

  // Journal record
  const stored = remarkStore.records.get(result.id);
  assert.equal(stored.deliveryStatus, 'sent');
});

test('bot mode: failure on 2nd upload → overall status failed, record exists', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls, failOnUploadIndex: 1 });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: null, recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Тест 1' },
      { reportId: 10, photoCode: 'side',  comment: 'Тест 2' }
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
      azsId: '42', recipientRole: 'manager',
      photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }],
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
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Грязь на колонках' },
      { reportId: 10, photoCode: 'back',  comment: 'Мусор' }
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
    photos: [{ reportId: 10, photoCode: 'front', comment: 'msg' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  // Simulate marking as failed manually
  await remarkStore.markDelivery(first.id, 'failed', 'network error');

  // Retry (resend same data via new sendRemark)
  const retried = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС', recipientRole: 'manager',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'msg' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  assert.equal(retried.deliveryStatus, 'sent', 'retry should succeed');
});

// ---------------------------------------------------------------------------
// UX-2 service tests: per-photo comments, per-photo delivery status
// ---------------------------------------------------------------------------

test('UX-2 bot mode: 2 photos → 2 messages each with its OWN comment', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Грязное стекло' },
      { reportId: 10, photoCode: 'side',  comment: 'Сломан насос' }
    ],
    sender: { id: 3, name: 'Проверяющий А.' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(uploadCalls.length, 2, 'should be 2 upload calls');

  // EACH upload must carry its own comment (not shared text on first only)
  assert.ok(uploadCalls[0].fields.message, 'first upload has message');
  assert.ok(uploadCalls[0].fields.message.includes('Грязное стекло'), 'first message contains front comment');
  assert.ok(uploadCalls[1].fields.message, 'second upload has its own message');
  assert.ok(uploadCalls[1].fields.message.includes('Сломан насос'), 'second message contains side comment');
});

test('UX-2: per-photo delivery status written for each photo on success', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const remarkStore = createFakeRemarkStore();
  const { svc } = makeService({ remarkStore, bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: null, recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Тест 1' },
      { reportId: 10, photoCode: 'side',  comment: 'Тест 2' }
    ],
    sender: { id: 3, name: 'Ревизор' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  // Each photo should have its own deliveryStatus in the journal
  const stored = remarkStore.records.get(result.id);
  assert.ok(stored, 'record stored');
  // photos must have per-photo status
  assert.ok(Array.isArray(stored.photos), 'photos is array in record');
  const frontPhoto = stored.photos.find((p) => p.photoCode === 'front');
  assert.ok(frontPhoto, 'front photo in record');
  assert.equal(frontPhoto.deliveryStatus, 'sent', 'front photo delivery_status is sent');
  const sidePhoto = stored.photos.find((p) => p.photoCode === 'side');
  assert.equal(sidePhoto.deliveryStatus, 'sent', 'side photo delivery_status is sent');
});

test('UX-2: per-photo delivery status is failed for errored photo', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls, failOnUploadIndex: 1 }); // 2nd upload fails
  const remarkStore = createFakeRemarkStore();
  const { svc } = makeService({ remarkStore, bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: null, recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Тест 1' },
      { reportId: 10, photoCode: 'side',  comment: 'Тест 2' }
    ],
    sender: { id: 3, name: 'Ревизор' }
  });

  // Overall status failed since not all succeeded
  assert.equal(result.deliveryStatus, 'failed');

  const stored = remarkStore.records.get(result.id);
  const frontPhoto = stored.photos.find((p) => p.photoCode === 'front');
  assert.equal(frontPhoto.deliveryStatus, 'sent', 'front photo succeeded');
  const sidePhoto = stored.photos.find((p) => p.photoCode === 'side');
  assert.equal(sidePhoto.deliveryStatus, 'failed', 'side photo failed');
  assert.ok(sidePhoto.deliveryError, 'side photo has error text');
});

test('UX-2: retryPhoto re-sends single photo with its stored comment', async () => {
  const uploadCalls = [];
  const remarkStore = createFakeRemarkStore();
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc } = makeService({ remarkStore, bitrixClient });

  // Insert a remark with two photos, mark one as failed
  const initialRecord = await remarkStore.insertRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    recipientUserId: 10, recipientName: 'Менеджер И.',
    senderUserId: 3, senderName: 'Ревизор',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Грязь', deliveryStatus: 'sent', deliveryError: null },
      { reportId: 10, photoCode: 'side',  comment: 'Сломан', deliveryStatus: 'failed', deliveryError: 'timeout' }
    ]
  });

  uploadCalls.length = 0; // reset so we count only retry calls

  const result = await svc.retryPhoto(initialRecord.id, 10, 'side');

  assert.ok(result, 'retryPhoto returns result');
  assert.equal(result.deliveryStatus, 'sent', 'retried photo now sent');
  assert.equal(uploadCalls.length, 1, 'only 1 upload call for single photo retry');
  assert.ok(uploadCalls[0].fields.message.includes('Сломан'), 'retry uses the stored per-photo comment');
});

// ---------------------------------------------------------------------------
// BUG-P4: commit-mode must mark ONLY actually-included photos as 'sent';
//         photos dropped because they lack diskObjectId must be marked 'failed'.
// ---------------------------------------------------------------------------

// Test A — RED: commit-mode batch with 2 photos: one WITH diskObjectId, one WITHOUT.
// The without-diskObjectId photo must be marked 'failed', NOT 'sent'.
test('BUG-P4 commit mode: photo without diskObjectId is marked failed, not sent', async () => {
  const commitCalls = [];
  const bitrixClient = createFakeBitrixClient({ commitCalls });
  const remarkStore = createFakeRemarkStore();

  // reportsStore: 'front' has diskObjectId, 'side' does NOT
  const reportsStore = createFakeReportsStore({
    '10:front': { diskObjectId: 1001, fileName: 'front.jpg', fileId: 9001 }
    // '10:side' is absent → getPhoto returns null → no diskObjectId
  });

  const { svc } = makeService({ bitrixClient, remarkStore, reportsStore, mode: 'commit' });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Тест', recipientRole: 'admin',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Есть фото' },
      { reportId: 10, photoCode: 'side',  comment: 'Нет фото на диске' }
    ],
    sender: { id: 5, name: 'Ревизор' }
  });

  // Overall status: failed because not all photos could be included
  assert.equal(result.deliveryStatus, 'failed', 'overall status should be failed when a photo is dropped');

  // im.disk.file.commit was still called (with the 1 file that had diskObjectId)
  assert.equal(commitCalls.length, 1, 'commit called once');
  assert.deepEqual(commitCalls[0].FILE_ID, [1001], 'only the photo with diskObjectId included');

  const stored = remarkStore.records.get(result.id);
  assert.ok(stored, 'record exists in store');

  const frontPhoto = stored.photos.find((p) => p.photoCode === 'front');
  assert.ok(frontPhoto, 'front photo is in record');
  assert.equal(frontPhoto.deliveryStatus, 'sent', 'front photo (with diskObjectId) is marked sent');

  const sidePhoto = stored.photos.find((p) => p.photoCode === 'side');
  assert.ok(sidePhoto, 'side photo is in record');
  assert.equal(sidePhoto.deliveryStatus, 'failed', 'side photo (no diskObjectId) must be marked failed, NOT sent');
  assert.ok(sidePhoto.deliveryError, 'side photo has an error message');
});

// Test B — regression guard: all photos have diskObjectId → all marked sent.
test('BUG-P4 commit mode: all photos with diskObjectId → all marked sent (no regression)', async () => {
  const commitCalls = [];
  const bitrixClient = createFakeBitrixClient({ commitCalls });
  const remarkStore = createFakeRemarkStore();
  const reportsStore = createFakeReportsStore({
    '10:front': { diskObjectId: 1001, fileName: 'front.jpg', fileId: 9001 },
    '10:back':  { diskObjectId: 1003, fileName: 'back.jpg',  fileId: 9003 }
  });

  const { svc } = makeService({ bitrixClient, remarkStore, reportsStore, mode: 'commit' });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Юг', recipientRole: 'admin',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Ок' },
      { reportId: 10, photoCode: 'back',  comment: 'Ок' }
    ],
    sender: { id: 5, name: 'Ревизор' }
  });

  assert.equal(result.deliveryStatus, 'sent', 'overall status sent when all photos included');
  assert.equal(commitCalls.length, 1, 'one commit call');
  assert.deepEqual(commitCalls[0].FILE_ID, [1001, 1003], 'both file IDs included');

  const stored = remarkStore.records.get(result.id);
  const frontPhoto = stored.photos.find((p) => p.photoCode === 'front');
  const backPhoto  = stored.photos.find((p) => p.photoCode === 'back');
  assert.equal(frontPhoto.deliveryStatus, 'sent', 'front photo marked sent');
  assert.equal(backPhoto.deliveryStatus,  'sent', 'back photo marked sent');
});

test('retryRemark: sends to stored recipientUserId, no new insertRemark', async () => {
  const uploadCalls = [];
  const remarkStore = createFakeRemarkStore();
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc } = makeService({ remarkStore, bitrixClient });

  // Create an initial record directly
  const originalRecord = await remarkStore.insertRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    recipientUserId: 10, recipientName: 'Менеджер И.',
    senderUserId: 3, senderName: 'Ревизор',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test msg' }]
  });
  await remarkStore.markDelivery(originalRecord.id, 'failed', 'timeout');

  const countBefore = remarkStore.records.size;

  // retryRemark uses stored recipient, no new record
  const retried = await svc.retryRemark({
    ...originalRecord,
    deliveryStatus: 'failed',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test msg' }]
  });

  assert.equal(retried.deliveryStatus, 'sent', 'retryRemark should succeed');
  assert.equal(remarkStore.records.size, countBefore, 'no new insert on retry');

  // Verify it sent to the stored recipientUserId (dialogId = '10')
  assert.ok(uploadCalls.length > 0, 'should have upload calls');
  assert.equal(uploadCalls[0].dialogId, '10', 'should send to stored recipient id');
});
