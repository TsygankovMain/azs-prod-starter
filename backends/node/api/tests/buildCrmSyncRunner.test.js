import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmSyncRunner } from '../src/reports/reportsRoutes.js';

const baseSettings = { report: { entityTypeId: 199, fields: { folderId: 'UF_FOLDER' } } };

test('runner reloads report/settings/photos and calls sync with resolved context', async () => {
  const calls = { updates: [], gets: [] };
  const reportsStore = {
    async getById(id) { calls.gets.push(id); return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos(id) { return [{ photoCode: 'a', fileId: 1 }]; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  const authContextStore = { async getContextByKey(key) { return key === 'ctx-1' ? { authId: 'tok', domain: 'x.bitrix24.ru' } : null; } };
  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    // getCrmItem must return an object where item['UF_FOLDER'] === '555' so verifyCrmFolderSync passes
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({ report_id: 42, payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'ctx-1' }) });

  assert.deepEqual(calls.gets, [42]);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].context.authId, 'tok'); // context resolved & passed through
});

test('runner is a no-op when the report no longer exists', async () => {
  const reportsStore = { async getById() { return null; }, async listPhotos() { return []; } };
  const settingsStore = { async read() { return baseSettings; } };
  const authContextStore = { async getContextByKey() { return null; } };
  const bitrixClient = {
    async updateReportItem() { throw new Error('should not be called'); },
    async getCrmItem() { throw new Error('nope'); }
  };
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({ report_id: 999, payload: '{}' }); // must resolve without throwing
});

test('runner rejects on malformed JSON payload', async () => {
  const reportsStore = { async getById() { return { id: 1, reportItemId: 1, status: 'new', diskFolderId: 1 }; }, async listPhotos() { return []; } };
  const settingsStore = { async read() { return { report: { entityTypeId: 199, fields: { folderId: 'UF_FOLDER' } } }; } };
  const authContextStore = { async getContextByKey() { return null; } };
  const bitrixClient = { async updateReportItem() { return {}; }, async getCrmItem() { return {}; } };
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await assert.rejects(() => runSync({ report_id: 1, payload: 'not-json' }));
});
