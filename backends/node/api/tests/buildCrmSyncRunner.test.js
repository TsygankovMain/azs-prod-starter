import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmSyncRunner } from '../src/reports/reportsRoutes.js';

const baseSettings = { report: { entityTypeId: 199, fields: { folderId: 'UF_FOLDER' } } };

// ---------------------------------------------------------------------------
// BUG-P6: Portal isolation — admin context must come from the JOB's portal
// ---------------------------------------------------------------------------

// Test A: store has admins for portal A AND portal B (B inserted last).
// A job on portal A must resolve A's admin — NOT B's, even though B is "last".
test('BUG-P6 Test A: runner uses admin context of the job portal, not the globally-last admin', async () => {
  const calls = { updates: [] };
  const reportsStore = {
    async getById(id) {
      return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 };
    },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };

  // Portal A admin stored first; portal B admin stored last (would be returned by unscoped getLastAdminContext).
  // Domains are lowercase to match normalization in the runner.
  const adminA = { key: 'memberA:domaina.bitrix24.ru:1', context: { authId: 'admin-tok-A', domain: 'domaina.bitrix24.ru', memberId: 'memberA', isAdmin: true } };
  const adminB = { key: 'memberB:domainb.bitrix24.ru:1', context: { authId: 'admin-tok-B', domain: 'domainb.bitrix24.ru', memberId: 'memberB', isAdmin: true } };

  const authContextStore = {
    // Unscoped: returns B (inserted last) — the OLD broken behaviour
    async getLastAdminContext() { return adminB; },
    // Portal-scoped: must return A's admin for portal A's job
    async getLastAdminContextForPortal({ domain, memberId }) {
      if (domain === 'domaina.bitrix24.ru' && memberId === 'memberA') return adminA;
      if (domain === 'domainb.bitrix24.ru' && memberId === 'memberB') return adminB;
      return null;
    },
    async getContextByKey() { return null; }
  };

  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  // Job belongs to portal A (contextKey encodes memberA:domaina.bitrix24.ru:99)
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({
    report_id: 42,
    payload: JSON.stringify({
      status: 'in_progress',
      diskFolderId: 555,
      contextKey: 'memberA:domaina.bitrix24.ru:99',
      domain: 'domaina.bitrix24.ru',
      memberId: 'memberA'
    })
  });

  assert.equal(calls.updates.length, 1, 'exactly one CRM update expected');
  assert.equal(
    calls.updates[0].context.authId,
    'admin-tok-A',
    'must use portal A admin token, not the globally-last admin from portal B'
  );
});

// Test B: job on portal C where no admin context is stored → skip+warn, do NOT fall through to A/B.
test('BUG-P6 Test B: runner skips sync and warns when no admin context exists for the job portal', async () => {
  const calls = { updates: [], warns: [] };
  const reportsStore = {
    async getById(id) {
      return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 };
    },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };

  const authContextStore = {
    async getLastAdminContext() {
      // Portal A or B admin exists globally — must NOT be used for portal C
      return { key: 'memberA:domainA.bitrix24.ru:1', context: { authId: 'admin-tok-A', domain: 'domainA.bitrix24.ru', memberId: 'memberA', isAdmin: true } };
    },
    async getLastAdminContextForPortal({ domain, memberId }) {
      // Portal C has no admin context
      if (domain === 'domainC.bitrix24.ru' && memberId === 'memberC') return null;
      return null;
    },
    async getContextByKey() { return null; }
  };

  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  const logger = {
    warn(...args) { calls.warns.push(args); },
    info() {},
    error() {}
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, logger });
  // Job belongs to portal C — no admin for it
  await runSync({
    report_id: 55,
    payload: JSON.stringify({
      status: 'in_progress',
      diskFolderId: 555,
      contextKey: 'memberC:domainC.bitrix24.ru:7',
      domain: 'domainC.bitrix24.ru',
      memberId: 'memberC'
    })
  });

  assert.equal(calls.updates.length, 0, 'CRM update must NOT be called when no portal admin context exists');
  assert.ok(
    calls.warns.some((args) => {
      const tag = String(args[0] || '');
      return tag === 'crm_sync_no_admin_context_for_portal';
    }),
    'must emit crm_sync_no_admin_context_for_portal warning'
  );
});

// Test C: single-portal install — still resolves correctly (no regression).
test('BUG-P6 Test C: single-portal install still resolves admin context correctly', async () => {
  const calls = { updates: [] };
  const reportsStore = {
    async getById(id) {
      return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 };
    },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };

  const singleAdmin = { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } };

  const authContextStore = {
    async getLastAdminContext() { return singleAdmin; },
    async getLastAdminContextForPortal({ domain, memberId }) {
      if (domain === 'solo.bitrix24.ru' && memberId === 'mX') return singleAdmin;
      return null;
    },
    async getContextByKey() { return null; }
  };

  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({
    report_id: 10,
    payload: JSON.stringify({
      status: 'in_progress',
      diskFolderId: 555,
      contextKey: 'mX:solo.bitrix24.ru:1',
      domain: 'solo.bitrix24.ru',
      memberId: 'mX'
    })
  });

  assert.equal(calls.updates.length, 1, 'CRM update must happen for single portal');
  assert.equal(calls.updates[0].context.authId, 'solo-admin-tok', 'must use the single portal admin token');
});

test('runner syncs under the portal ADMIN context, not the uploader token', async () => {
  const calls = { updates: [], gets: [] };
  const reportsStore = {
    async getById(id) { calls.gets.push(id); return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos(id) { return [{ photoCode: 'a', fileId: 1 }]; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  // The uploader (ctx-1) is a non-admin AZS user; CRM writes to the report SPA
  // require admin scope, so the runner must use the admin context instead.
  const authContextStore = {
    async getLastAdminContext() { return { key: 'admin-key', context: { authId: 'admin-tok', domain: 'x.bitrix24.ru', isAdmin: true } }; },
    async getContextByKey(key) { return key === 'ctx-1' ? { authId: 'uploader-tok', domain: 'x.bitrix24.ru' } : null; }
  };
  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    // getCrmItem must return an object where item['UF_FOLDER'] === '555' so verifyCrmFolderSync passes
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({ report_id: 42, payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'ctx-1' }) });

  assert.deepEqual(calls.gets, [42]);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].context.authId, 'admin-tok'); // ADMIN context, not uploader
  assert.equal(calls.updates[0].context.key, 'admin-key');
});

// BUG-P6: This test previously asserted that the runner falls back to the uploader
// context when no admin context is available. That behavior was the bug itself —
// on a multi-portal install the uploader could belong to a different portal than
// the admin context that was globally "last", causing cross-tenant data writes.
//
// New behavior (fixed): when portal identity is present in the payload and
// getLastAdminContextForPortal returns null, the runner skips the sync and warns.
// It does NOT fall back to the uploader token or to any other portal's admin.
test('runner skips sync and warns (no uploader fallback) when portal has no admin context', async () => {
  const calls = { updates: [], warns: [] };
  const reportsStore = {
    async getById(id) { return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  const authContextStore = {
    async getLastAdminContext() { return null; },
    async getLastAdminContextForPortal() { return null; },
    async getContextByKey(key) { return key === 'ctx-1' ? { authId: 'uploader-tok', domain: 'x.bitrix24.ru' } : null; }
  };
  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };
  const logger = { warn(...args) { calls.warns.push(args); }, info() {}, error() {} };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, logger });
  // Job has portal identity in payload — portal-scoped path is taken
  await runSync({ report_id: 42, payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'mX:x.bitrix24.ru:1', domain: 'x.bitrix24.ru', memberId: 'mX' }) });

  // Must skip CRM write (not fall back to uploader)
  assert.equal(calls.updates.length, 0, 'CRM update must be skipped when no portal admin context exists');
  assert.ok(
    calls.warns.some((args) => String(args[0] || '') === 'crm_sync_no_admin_context_for_portal'),
    'must warn crm_sync_no_admin_context_for_portal'
  );
});

test('runner is a no-op when the report no longer exists', async () => {
  const reportsStore = { async getById() { return null; }, async listPhotos() { return []; } };
  const settingsStore = { async read() { return baseSettings; } };
  const authContextStore = { async getLastAdminContext() { return null; }, async getContextByKey() { return null; } };
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
  const authContextStore = { async getLastAdminContext() { return null; }, async getContextByKey() { return null; } };
  const bitrixClient = { async updateReportItem() { return {}; }, async getCrmItem() { return {}; } };
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await assert.rejects(() => runSync({ report_id: 1, payload: 'not-json' }));
});
