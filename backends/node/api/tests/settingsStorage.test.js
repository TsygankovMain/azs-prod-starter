import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/settings/defaultSettings.js';
import { createBitrixAppSettingsStore } from '../src/settings/bitrixAppSettingsStore.js';
import { createCompositeSettingsStore } from '../src/settings/compositeSettingsStore.js';
import { createDatabaseSettingsStore } from '../src/settings/databaseSettingsStore.js';

test('bitrix app settings store reads JSON from app.option.get payload', async () => {
  const optionKey = 'azs_photo_report_settings_v1';
  const expected = normalizeSettings({
    report: {
      fields: {
        folderId: 'UF_CRM_1'
      }
    }
  });

  const client = {
    async callMethod(method) {
      assert.equal(method, 'app.option.get');
      return {
        [optionKey]: JSON.stringify(expected)
      };
    }
  };

  const store = createBitrixAppSettingsStore({
    bitrixClient: client,
    optionKey
  });

  const settings = await store.read({ context: {} });
  assert.equal(settings.report.fields.folderId, 'UF_CRM_1');
});

test('bitrix app settings store returns null when option is missing', async () => {
  const client = {
    async callMethod() {
      return {};
    }
  };

  const store = createBitrixAppSettingsStore({
    bitrixClient: client,
    optionKey: 'azs_photo_report_settings_v1'
  });

  const settings = await store.read({ context: {} });
  assert.equal(settings, null);
});

test('bitrix app settings store supports string payload from app.option.get', async () => {
  const client = {
    async callMethod() {
      return JSON.stringify({
        report: {
          fields: {
            folderId: 'UF_CRM_STRING'
          }
        }
      });
    }
  };

  const store = createBitrixAppSettingsStore({
    bitrixClient: client,
    optionKey: 'azs_photo_report_settings_v1'
  });

  const settings = await store.read({ context: {} });
  assert.equal(settings.report.fields.folderId, 'UF_CRM_STRING');
});

test('composite settings store prefers bitrix and syncs db on read', async () => {
  const expected = normalizeSettings({
    report: {
      fields: {
        folderId: 'UF_CRM_999'
      }
    }
  });
  const calls = [];

  const store = createCompositeSettingsStore({
    bitrixStore: {
      async read() {
        return expected;
      },
      async write() {
        throw new Error('not used');
      }
    },
    dbStore: {
      async read() {
        throw new Error('db read should not be called');
      },
      async write(settings) {
        calls.push(settings);
      }
    }
  });

  const settings = await store.read({ context: { domain: 'example.bitrix24.ru' } });
  assert.equal(settings.report.fields.folderId, 'UF_CRM_999');
  assert.equal(calls.length, 1);
});

test('composite settings store falls back to db when bitrix read fails', async () => {
  const expected = normalizeSettings({
    report: {
      fields: {
        folderId: 'UF_CRM_DB'
      }
    }
  });
  let dbReadCalled = 0;

  const store = createCompositeSettingsStore({
    bitrixStore: {
      async read() {
        throw new Error('bitrix denied');
      },
      async write() {
        throw new Error('not used');
      }
    },
    dbStore: {
      async read() {
        dbReadCalled += 1;
        return expected;
      },
      async write() {
        throw new Error('not used');
      }
    },
    logger: {
      warn() {}
    }
  });

  const settings = await store.read({ context: { domain: 'example.bitrix24.ru' } });
  assert.equal(settings.report.fields.folderId, 'UF_CRM_DB');
  assert.equal(dbReadCalled, 1);
});

test('composite settings store returns defaults when both bitrix and db reads fail', async () => {
  const store = createCompositeSettingsStore({
    bitrixStore: {
      async read() {
        throw new Error('bitrix unavailable');
      },
      async write() {
        throw new Error('not used');
      }
    },
    dbStore: {
      async read() {
        throw new Error('db unavailable');
      },
      async write() {
        throw new Error('not used');
      }
    },
    logger: {
      warn() {}
    }
  });

  const settings = await store.read({ context: { domain: 'example.bitrix24.ru' } });
  assert.equal(settings.report.fields.folderId, '');
  assert.equal(settings.timezone, 'Europe/Moscow');
});

test('composite settings store writes into bitrix and db', async () => {
  const calls = [];
  const store = createCompositeSettingsStore({
    bitrixStore: {
      async read() {
        return null;
      },
      async write(settings, { context }) {
        calls.push(['bitrix', context?.domain || '', settings.report.fields.folderId]);
        return normalizeSettings(settings);
      }
    },
    dbStore: {
      async read() {
        return normalizeSettings({});
      },
      async write(settings, { context }) {
        calls.push(['db', context?.domain || '', settings.report.fields.folderId]);
        return normalizeSettings(settings);
      }
    }
  });

  const payload = normalizeSettings({
    report: {
      fields: {
        folderId: 'UF_CRM_SAVE'
      }
    }
  });

  const settings = await store.write(payload, {
    context: { domain: 'example.bitrix24.ru' }
  });

  assert.equal(settings.report.fields.folderId, 'UF_CRM_SAVE');
  assert.deepEqual(calls, [
    ['bitrix', 'example.bitrix24.ru', 'UF_CRM_SAVE'],
    ['db', 'example.bitrix24.ru', 'UF_CRM_SAVE']
  ]);
});

test('composite settings store keeps bitrix write successful even if db write fails', async () => {
  const payload = normalizeSettings({
    report: {
      fields: {
        folderId: 'UF_CRM_BITRIX_ONLY'
      }
    }
  });

  const store = createCompositeSettingsStore({
    bitrixStore: {
      async read() {
        return null;
      },
      async write(settings) {
        return normalizeSettings(settings);
      }
    },
    dbStore: {
      async read() {
        return normalizeSettings({});
      },
      async write() {
        throw new Error('db write failed');
      }
    },
    logger: {
      warn() {}
    }
  });

  const settings = await store.write(payload, {
    context: { domain: 'example.bitrix24.ru' }
  });

  assert.equal(settings.report.fields.folderId, 'UF_CRM_BITRIX_ONLY');
});

test('database settings store uses portal scope and falls back to global scope', async () => {
  const queryCalls = [];
  const pool = {
    async query(sql, params) {
      queryCalls.push([sql, params]);
      if (params[0] === 'mid:portal.bitrix24.ru') {
        return { rows: [] };
      }
      if (params[0] === 'global') {
        return {
          rows: [{
            settings_json: JSON.stringify({
              report: {
                fields: {
                  folderId: 'UF_CRM_GLOBAL'
                }
              }
            })
          }]
        };
      }
      return { rows: [] };
    }
  };

  const store = createDatabaseSettingsStore({ pool, dbType: 'postgresql' });
  const settings = await store.read({
    context: {
      memberId: 'mid',
      domain: 'portal.bitrix24.ru'
    }
  });

  assert.equal(settings.report.fields.folderId, 'UF_CRM_GLOBAL');
  assert.equal(queryCalls.length, 2);
  assert.equal(queryCalls[0][1][0], 'mid:portal.bitrix24.ru');
  assert.equal(queryCalls[1][1][0], 'global');
});
