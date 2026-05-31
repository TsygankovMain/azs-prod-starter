import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportCrmUpdateFields,
  buildReportPhotoFieldValue,
  updateReportCrmItem
} from '../src/reports/reportCrmSync.js';

const settings = {
  report: {
    entityTypeId: 163,
    fields: {
      folderId: 'UF_FOLDER',
      photos: 'UF_PHOTOS'
    },
    stages: {
      inProgress: 'DT163_1:IN_PROGRESS',
      done: 'DT163_1:DONE',
      expired: 'DT163_1:EXPIRED'
    }
  }
};

// buildReportCrmUpdateFields no longer sets UF_PHOTOS — photos moved to the async builder.
test('buildReportCrmUpdateFields maps status, folder and unique file ids', () => {
  const fields = buildReportCrmUpdateFields({
    settings,
    status: 'done',
    diskFolderId: 700,
    photos: [
      { fileId: 1001 },
      { fileId: '1002' },
      { fileId: 1001 },
      { fileId: null }
    ]
  });

  // photos field is no longer set by the pure sync builder
  assert.equal(fields['UF_PHOTOS'], undefined);
  assert.equal(fields.stageId, 'DT163_1:DONE');
  assert.equal(fields['UF_FOLDER'], '700');
});

test('buildReportCrmUpdateFields returns only configured fields', () => {
  const fields = buildReportCrmUpdateFields({
    settings: {
      report: {
        fields: {},
        stages: {
          expired: 'DT163_1:EXPIRED'
        }
      }
    },
    status: 'expired',
    diskFolderId: 700,
    photos: [{ fileId: 1001 }]
  });

  // UF_PHOTOS not configured → must not appear; only stageId
  assert.equal(fields['UF_PHOTOS'], undefined);
  assert.deepEqual(fields, {
    stageId: 'DT163_1:EXPIRED'
  });
});

test('updateReportCrmItem skips call without crm report id', async () => {
  let called = false;

  const result = await updateReportCrmItem({
    bitrixClient: {
      async updateReportItem() {
        called = true;
      }
    },
    settings,
    report: { reportItemId: null },
    status: 'done'
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test('updateReportCrmItem throws without crm report id in strict mode', async () => {
  await assert.rejects(
    updateReportCrmItem({
      bitrixClient: {
        async updateReportItem() {}
      },
      settings,
      report: { reportItemId: null },
      status: 'done',
      requireReportItem: true
    }),
    /reportItemId is missing or invalid/
  );
});

test('updateReportCrmItem sends crm.item.update payload (in_progress — no photos field)', async () => {
  const calls = [];

  const result = await updateReportCrmItem({
    bitrixClient: {
      async updateReportItem(payload) {
        calls.push(payload);
        return { ok: true };
      }
    },
    settings,
    report: { reportItemId: 9001 },
    status: 'in_progress',
    diskFolderId: 501,
    photos: [{ fileId: 42, diskObjectId: 5 }]
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fields['UF_PHOTOS'], undefined, 'in_progress must not touch photos field');
  assert.equal(calls[0].fields.stageId, 'DT163_1:IN_PROGRESS');
  assert.equal(calls[0].fields['UF_FOLDER'], '501');
});

// ---- buildReportPhotoFieldValue ----

test('buildReportPhotoFieldValue downloads disk content and returns [name, base64] pairs', async () => {
  const fakeDiskApi = {
    async downloadFileContent(id) {
      return { base64: 'QkFTRTY0', name: `n${id}.jpg` };
    }
  };

  const photos = [
    { diskObjectId: 5, fileName: 'АЗС_17_front.jpg' },
    { diskObjectId: 6, fileName: '' }
  ];

  const result = await buildReportPhotoFieldValue({ photos, diskApi: fakeDiskApi });

  assert.deepEqual(result, [
    ['АЗС_17_front.jpg', 'QkFTRTY0'],
    ['n6.jpg', 'QkFTRTY0']
  ]);
});

test('buildReportPhotoFieldValue skips photos without diskObjectId', async () => {
  const fakeDiskApi = {
    async downloadFileContent(id) {
      return { base64: 'QkFTRTY0', name: `n${id}.jpg` };
    }
  };

  const photos = [
    { diskObjectId: null, fileName: 'no_disk.jpg' },
    { diskObjectId: 0, fileName: 'zero.jpg' },
    { diskObjectId: 7, fileName: 'valid.jpg' }
  ];

  const result = await buildReportPhotoFieldValue({ photos, diskApi: fakeDiskApi });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], ['valid.jpg', 'QkFTRTY0']);
});

test('buildReportPhotoFieldValue returns empty array when no diskApi', async () => {
  const result = await buildReportPhotoFieldValue({
    photos: [{ diskObjectId: 5, fileName: 'x.jpg' }],
    diskApi: null
  });
  assert.deepEqual(result, []);
});

// ---- updateReportCrmItem with photos ----

test('updateReportCrmItem on done attaches photo file pairs to the photos field', async () => {
  const calls = [];

  const fakeBitrixClient = {
    diskApi: {
      async downloadFileContent(id) {
        return { base64: `base64_${id}`, name: `disk_${id}.jpg` };
      }
    },
    async updateReportItem(payload) {
      calls.push(payload);
      return { ok: true };
    }
  };

  const photos = [
    { diskObjectId: 10, fileName: 'photo_a.jpg' },
    { diskObjectId: 11, fileName: '' }
  ];

  const result = await updateReportCrmItem({
    bitrixClient: fakeBitrixClient,
    settings,
    report: { reportItemId: 9002 },
    status: 'done',
    diskFolderId: 600,
    photos
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);

  const capturedPhotos = calls[0].fields['UF_PHOTOS'];
  assert.ok(Array.isArray(capturedPhotos), 'UF_PHOTOS must be an array');
  assert.equal(capturedPhotos.length, 2);

  // Each element must be a [name, base64] pair — NOT bare integers
  assert.ok(Array.isArray(capturedPhotos[0]), 'each element must be a [name,base64] pair');
  assert.equal(capturedPhotos[0][0], 'photo_a.jpg');
  assert.equal(capturedPhotos[0][1], 'base64_10');
  assert.ok(Array.isArray(capturedPhotos[1]), 'each element must be a [name,base64] pair');
  assert.equal(capturedPhotos[1][1], 'base64_11');
});

test('updateReportCrmItem on in_progress does NOT touch photos field', async () => {
  const calls = [];

  const fakeBitrixClient = {
    diskApi: {
      async downloadFileContent(id) {
        return { base64: `base64_${id}`, name: `disk_${id}.jpg` };
      }
    },
    async updateReportItem(payload) {
      calls.push(payload);
      return { ok: true };
    }
  };

  const photos = [
    { diskObjectId: 10, fileName: 'photo_a.jpg' },
    { diskObjectId: 11, fileName: 'photo_b.jpg' }
  ];

  await updateReportCrmItem({
    bitrixClient: fakeBitrixClient,
    settings,
    report: { reportItemId: 9003 },
    status: 'in_progress',
    diskFolderId: 600,
    photos
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fields['UF_PHOTOS'], undefined, 'in_progress must not set photos field');
});
