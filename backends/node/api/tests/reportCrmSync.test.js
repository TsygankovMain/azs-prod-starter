import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportCrmUpdateFields,
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

  assert.deepEqual(fields, {
    stageId: 'DT163_1:DONE',
    UF_FOLDER: '700',
    UF_PHOTOS: [1001, 1002]
  });
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

test('updateReportCrmItem sends crm.item.update payload', async () => {
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
    photos: [{ fileId: 42 }]
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    entityTypeId: 163,
    id: 9001,
    fields: {
      stageId: 'DT163_1:IN_PROGRESS',
      UF_FOLDER: '501',
      UF_PHOTOS: [42]
    }
  }]);
});
