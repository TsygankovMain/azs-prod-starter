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

test('buildReportCrmUpdateFields maps status=rejected to the «Брак» stage', () => {
  const fields = buildReportCrmUpdateFields({
    settings: {
      report: {
        entityTypeId: 163,
        fields: { reason: 'UF_REASON' },
        stages: { expired: 'DT163_1:EXPIRED', rejected: 'DT163_1:REJECTED' }
      }
    },
    status: 'rejected',
    reasonValue: 'Очередь на мойке'
  });
  assert.equal(fields.stageId, 'DT163_1:REJECTED', 'rejected → stages.rejected');
  assert.equal(fields['UF_REASON'], 'Очередь на мойке', 'reason UF written alongside the stage');
});

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

// ---- BUG-P1: crm_photos_dropped observability ----

const makeLoggerSpy = () => {
  const calls = { warn: [], error: [] };
  return {
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
    calls
  };
};

const makeFakeBitrixClientWithDisk = () => {
  const updateCalls = [];
  return {
    client: {
      diskApi: {
        async downloadFileContent(id) {
          return { base64: `b64_${id}`, name: `disk_${id}.jpg` };
        }
      },
      async updateReportItem(payload) {
        updateCalls.push(payload);
        return { ok: true };
      }
    },
    updateCalls
  };
};

// Test A: total loss — all photos lack diskObjectId
test('updateReportCrmItem on done with ALL photos missing diskObjectId logs warn+error and does NOT set photos field', async () => {
  const { client, updateCalls } = makeFakeBitrixClientWithDisk();
  const logger = makeLoggerSpy();

  const photos = [
    { diskObjectId: 0, fileName: 'a.jpg' },
    { diskObjectId: undefined, fileName: 'b.jpg' }
  ];

  await updateReportCrmItem({
    bitrixClient: client,
    settings,
    report: { id: 42, reportItemId: 9010 },
    status: 'done',
    photos,
    logger
  });

  // updateReportItem must still be called (done sync must NOT be blocked)
  assert.equal(updateCalls.length, 1, 'updateReportItem must still be called');

  // photos field must NOT be set (empty pairs → do not overwrite CRM)
  assert.equal(updateCalls[0].fields['UF_PHOTOS'], undefined, 'photos field must NOT be set on total loss');

  // warn must be called with crm_photos_dropped event and correct counts
  assert.equal(logger.calls.warn.length, 1, 'warn must be called exactly once');
  const warnArg = logger.calls.warn[0];
  assert.equal(warnArg[0], 'crm_photos_dropped');
  assert.equal(warnArg[1].event, 'crm_photos_dropped');
  assert.equal(warnArg[1].expected, 2);
  assert.equal(warnArg[1].attached, 0);
  assert.equal(warnArg[1].reportId, 42);

  // error must also be called for total loss (data-integrity alarm)
  assert.equal(logger.calls.error.length, 1, 'error must be called for total loss');
  const errArg = logger.calls.error[0];
  assert.equal(errArg[0], 'crm_photos_all_dropped');
  assert.equal(errArg[1].event, 'crm_photos_all_dropped');
  assert.equal(errArg[1].expected, 2);
  assert.equal(errArg[1].reportId, 42);
});

// Test B: partial loss — 1 out of 3 photos has diskObjectId
test('updateReportCrmItem on done with PARTIAL photo loss logs warn (no error) and sets the surviving pair', async () => {
  const { client, updateCalls } = makeFakeBitrixClientWithDisk();
  const logger = makeLoggerSpy();

  const photos = [
    { diskObjectId: 55, fileName: 'good.jpg' },
    { diskObjectId: 0, fileName: 'bad1.jpg' },
    { diskObjectId: null, fileName: 'bad2.jpg' }
  ];

  await updateReportCrmItem({
    bitrixClient: client,
    settings,
    report: { id: 77, reportItemId: 9011 },
    status: 'done',
    photos,
    logger
  });

  assert.equal(updateCalls.length, 1, 'updateReportItem must be called');

  // photos field must be set with the 1 surviving pair
  const capturedPhotos = updateCalls[0].fields['UF_PHOTOS'];
  assert.ok(Array.isArray(capturedPhotos), 'UF_PHOTOS must be an array');
  assert.equal(capturedPhotos.length, 1, 'only the 1 valid pair');
  assert.equal(capturedPhotos[0][0], 'good.jpg');

  // warn must be called with correct counts
  assert.equal(logger.calls.warn.length, 1, 'warn must be called for partial loss');
  const warnArg = logger.calls.warn[0];
  assert.equal(warnArg[0], 'crm_photos_dropped');
  assert.equal(warnArg[1].expected, 3);
  assert.equal(warnArg[1].attached, 1);

  // no error for partial loss
  assert.equal(logger.calls.error.length, 0, 'error must NOT be called for partial loss');
});

// Test C: no loss — all photos have diskObjectId
test('updateReportCrmItem on done with NO photo loss emits no warn/error and sets all pairs', async () => {
  const { client, updateCalls } = makeFakeBitrixClientWithDisk();
  const logger = makeLoggerSpy();

  const photos = [
    { diskObjectId: 10, fileName: 'p1.jpg' },
    { diskObjectId: 11, fileName: 'p2.jpg' }
  ];

  await updateReportCrmItem({
    bitrixClient: client,
    settings,
    report: { id: 99, reportItemId: 9012 },
    status: 'done',
    photos,
    logger
  });

  assert.equal(updateCalls.length, 1, 'updateReportItem must be called');

  const capturedPhotos = updateCalls[0].fields['UF_PHOTOS'];
  assert.ok(Array.isArray(capturedPhotos), 'UF_PHOTOS must be an array');
  assert.equal(capturedPhotos.length, 2, 'all 2 pairs present');

  // no logging at all when no photos are lost
  assert.equal(logger.calls.warn.length, 0, 'no warn when no loss');
  assert.equal(logger.calls.error.length, 0, 'no error when no loss');
});
