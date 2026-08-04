import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmSyncRunner } from '../src/reports/reportsRoutes.js';

const baseSettings = { report: { entityTypeId: 199, fields: { folderId: 'UF_FOLDER' } } };

// ---------------------------------------------------------------------------
// Important 2 (раунд правок 1, ревью Task 8): payload.diskFolderId
// замораживается на момент ПОСТАНОВКИ задачи (например, ручной /resync,
// вызванный до завершения публикации, — там diskFolderId ещё пуст). Раньше
// раннер брал payload.diskFolderId ?? report.diskFolderId ?? null и никогда
// не пересчитывал его из уже прочитанных в этой же функции свежих `photos` —
// хотя все данные для этого уже под рукой. Итог: карточка в CRM могла
// навсегда остаться без ссылки на папку Диска, даже когда фото давно
// опубликовались, потому что раннер писал устаревшее значение из payload.
// ---------------------------------------------------------------------------

test('Important 2: runner пересчитывает diskFolderId из СВЕЖИХ photos, а не берёт устаревший payload.diskFolderId', async () => {
  const calls = { updates: [] };
  const reportsStore = {
    async getById(id) { return { id, reportItemId: 77, status: 'done', diskFolderId: null }; },
    // Фото опубликовалось ПОСЛЕ постановки задачи (например, ручной /resync
    // был вызван раньше, пока фото ещё не было опубликовано) — свежий
    // diskFolderId появился только сейчас, к моменту ВЫПОЛНЕНИЯ задачи.
    async listPhotos() { return [{ photoCode: 'a', diskFolderId: 4242 }]; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  const singleAdmin = { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } };
  const authContextStore = {
    async getLastAdminContext() { return singleAdmin; },
    async getLastAdminContextForPortal({ domain, memberId }) {
      return (domain === 'solo.bitrix24.ru' && memberId === 'mX') ? singleAdmin : null;
    },
    async getContextByKey() { return null; }
  };
  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    // Подтверждает, что записано СВЕЖЕЕ значение (4242), а не устаревшее из payload.
    async getCrmItem() { return { UF_FOLDER: '4242' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  // payload.diskFolderId — устаревший null (задача была поставлена ДО публикации).
  await runSync({
    report_id: 10,
    payload: JSON.stringify({ status: 'done', diskFolderId: null, contextKey: 'mX:solo.bitrix24.ru:1', domain: 'solo.bitrix24.ru', memberId: 'mX' })
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].fields.UF_FOLDER, '4242', 'обязан записать СВЕЖИЙ diskFolderId из photos, а не устаревший null из payload');
});

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

// ---------------------------------------------------------------------------
// FIX 3: Test the REAL production path — contextKey-only (no explicit domain/memberId).
// Before FIX 1, jobs were enqueued with only contextKey. This test proves that
// parsePortalFromContextKey is exercised correctly: portal A is resolved from the
// contextKey even when portal B's admin is the globally-last stored admin.
// ---------------------------------------------------------------------------

test('FIX-3 contextKey-only path: runner resolves portal A admin via contextKey, not globally-last portal B admin', async () => {
  const calls = { updates: [], portalLookups: [] };
  const reportsStore = {
    async getById(id) {
      return { id, reportItemId: 88, status: 'in_progress', diskFolderId: 111 };
    },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };

  const adminA = { key: 'memberA:domaina.bitrix24.ru:99', context: { authId: 'admin-tok-A', domain: 'domaina.bitrix24.ru', memberId: 'memberA', isAdmin: true } };
  const adminB = { key: 'memberB:domainb.bitrix24.ru:1', context: { authId: 'admin-tok-B', domain: 'domainb.bitrix24.ru', memberId: 'memberB', isAdmin: true } };

  const authContextStore = {
    // Unscoped: returns B (stored last) — would be used by the broken legacy path
    async getLastAdminContext() { return adminB; },
    // Portal-scoped: returns correct admin per portal
    async getLastAdminContextForPortal({ domain, memberId }) {
      calls.portalLookups.push({ domain, memberId });
      if (domain === 'domaina.bitrix24.ru' && memberId === 'memberA') return adminA;
      if (domain === 'domainb.bitrix24.ru' && memberId === 'memberB') return adminB;
      return null;
    },
    async getContextByKey() { return null; }
  };

  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 88 }; },
    async getCrmItem() { return { UF_FOLDER: '111' }; }
  };

  // REAL production job shape (pre-FIX-1): only contextKey, NO explicit domain/memberId.
  // contextKey encodes portal A identity: 'memberA:domaina.bitrix24.ru:99'
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({
    report_id: 42,
    payload: JSON.stringify({
      status: 'in_progress',
      diskFolderId: 111,
      contextKey: 'memberA:domaina.bitrix24.ru:99'
      // NO explicit domain / memberId — the old enqueue shape
    })
  });

  // Must have used portal-scoped lookup (not legacy unscoped)
  assert.ok(
    calls.portalLookups.length >= 1,
    'getLastAdminContextForPortal must be called (contextKey was parsed into domain+memberId)'
  );
  assert.ok(
    calls.portalLookups.some((l) => l.domain === 'domaina.bitrix24.ru' && l.memberId === 'memberA'),
    'portal lookup must be for portal A (parsed from contextKey)'
  );

  // Must have used portal A's admin token, NOT portal B's
  assert.equal(calls.updates.length, 1, 'exactly one CRM update expected');
  assert.equal(
    calls.updates[0].context.authId,
    'admin-tok-A',
    'must use portal A admin token (from contextKey parse), NOT globally-last portal B admin'
  );
  assert.notEqual(
    calls.updates[0].context.authId,
    'admin-tok-B',
    'portal B admin (globally last) must NOT be used for a portal A job'
  );
});

// FIX 3 (bonus): Legacy warn fires when contextKey is empty/unparseable (no portal identity at all).
test('FIX-3 legacy warn: runner emits crm_sync_legacy_unscoped_context when contextKey is empty', async () => {
  const calls = { updates: [], warns: [] };
  const reportsStore = {
    async getById(id) {
      return { id, reportItemId: 55, status: 'in_progress', diskFolderId: 222 };
    },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };

  const singleAdmin = { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } };

  const authContextStore = {
    async getLastAdminContext() { return singleAdmin; },
    async getLastAdminContextForPortal() { return null; },
    async getContextByKey() { return null; }
  };

  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 55 }; },
    async getCrmItem() { return { UF_FOLDER: '222' }; }
  };

  const logger = {
    warn(...args) { calls.warns.push(args); },
    info() {},
    error() {}
  };

  // Job has NO contextKey (empty), NO domain, NO memberId — true legacy job
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, logger });
  await runSync({
    report_id: 77,
    payload: JSON.stringify({
      status: 'in_progress',
      diskFolderId: 222,
      contextKey: ''
    })
  });

  // Legacy path must warn before using unscoped context
  assert.ok(
    calls.warns.some((args) => String(args[0] || '') === 'crm_sync_legacy_unscoped_context'),
    'must emit crm_sync_legacy_unscoped_context warning on legacy fallback'
  );

  // Still performs the CRM update (single-portal safe behavior is preserved)
  assert.equal(calls.updates.length, 1, 'CRM update must still happen on single-portal legacy path');
  assert.equal(calls.updates[0].context.authId, 'solo-tok', 'must use the unscoped admin token');
});

// ---------------------------------------------------------------------------
// I1 (финальное ревью ветки, "CRM-синк идёт мимо ограничителя, и это создала
// именно эта ветка") — до этой правки ни один реальный вызов Битрикса внутри
// runSync (updateReportItem, getCrmItem внутри verifyCrmFolderSync, а на
// status='done' ещё и до 40 downloadFileContent) не проходил через общий
// ограничитель темпа. crmSyncWorker.drain() крутит tick() без пауз — на
// сливе бэклога парка это ~5900 неограниченных запросов одновременно с
// аккуратным потоком публикации фото (1.4/с). Ниже — доказательство, что
// buildCrmSyncRunner({..., limiter}) реально прогоняет через него КАЖДЫЙ
// такой вызов, а не только часть.
// ---------------------------------------------------------------------------

test('I1: buildCrmSyncRunner с limiter берёт токен на КАЖДЫЙ реальный вызов Битрикса (updateReportItem + getCrmItem verifyCrmFolderSync)', async () => {
  const acquireCalls = [];
  const limiter = { async acquire() { acquireCalls.push(Date.now()); } };

  const reportsStore = {
    async getById(id) { return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  const singleAdmin = { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } };
  const authContextStore = {
    async getLastAdminContext() { return singleAdmin; },
    async getLastAdminContextForPortal({ domain, memberId }) {
      return (domain === 'solo.bitrix24.ru' && memberId === 'mX') ? singleAdmin : null;
    },
    async getContextByKey() { return null; }
  };
  const bitrixClient = {
    async updateReportItem() { return { id: 77 }; },
    // Отдаёт значение, совпадающее с diskFolderId=555 из payload — иначе
    // verifyCrmFolderSync бросит ДО того, как runSync успеет вернуть
    // управление, и тест не увидит оба acquire().
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore, limiter });
  await runSync({
    report_id: 10,
    payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'mX:solo.bitrix24.ru:1', domain: 'solo.bitrix24.ru', memberId: 'mX' })
  });

  // updateReportItem (1) + getCrmItem внутри verifyCrmFolderSync (1) = 2.
  // status='in_progress' — фото не проверяются (photos пуст), поэтому
  // downloadFileContent здесь не участвует.
  assert.equal(acquireCalls.length, 2,
    'лимитер обязан быть взят и на updateReportItem, и на getCrmItem verifyCrmFolderSync — оба реальных похода к порталу');
});

test('I1: buildCrmSyncRunner БЕЗ limiter (не передан) работает как раньше — обратная совместимость', async () => {
  const reportsStore = {
    async getById(id) { return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos() { return []; }
  };
  const settingsStore = { async read() { return baseSettings; } };
  const singleAdmin = { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } };
  const authContextStore = {
    async getLastAdminContext() { return singleAdmin; },
    async getLastAdminContextForPortal() { return singleAdmin; },
    async getContextByKey() { return null; }
  };
  const calls = { updates: [] };
  const bitrixClient = {
    async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
    async getCrmItem() { return { UF_FOLDER: '555' }; }
  };

  // limiter НЕ передан — не должно ни бросать, ни как-либо иначе ломаться.
  const runSync = buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore });
  await runSync({
    report_id: 11,
    payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'mX:solo.bitrix24.ru:1', domain: 'solo.bitrix24.ru', memberId: 'mX' })
  });
  assert.equal(calls.updates.length, 1);
});

// ---------------------------------------------------------------------------
// I1, РАУНД ПРАВОК 2 (финальное ревью ветки) — settingsStore.read() внутри
// runSync теперь кэшируется (createSettingsCache, src/shared/settingsCache.js
// — тот же приём, что photoPublisher.js уже применяет для publishOne).
// Композитный стор пробует ПОРТАЛ первым и кэша не имеет вовсе — переревью
// посчитало реальные походы к порталу против взятых токенов на настоящем
// раннере и нашло 1 неоплаченный запрос на КАЖДУЮ задачу (settingsStore.read()
// шёл ДО какой-либо другой логики, включая ветку "нет admin-контекста", где
// это оставался ЕДИНСТВЕННЫЙ запрос задачи — while(worked) в
// crmSyncWorker.drain() крутит такие на скорости базы, залп в момент, когда
// портал уже нездоров). Ниже — прямое доказательство: несколько job подряд
// делают ОДИН settingsStore.read(), а не по одному на каждую.
// ---------------------------------------------------------------------------

const makeSingleAdminDeps = ({ settingsStore, getCrmItemResult = { UF_FOLDER: '555' } } = {}) => ({
  reportsStore: {
    async getById(id) { return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
    async listPhotos() { return []; }
  },
  settingsStore,
  authContextStore: {
    async getLastAdminContext() { return { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } }; },
    async getLastAdminContextForPortal({ domain, memberId }) {
      return (domain === 'solo.bitrix24.ru' && memberId === 'mX')
        ? { key: 'mX:solo.bitrix24.ru:1', context: { authId: 'solo-admin-tok', domain: 'solo.bitrix24.ru', memberId: 'mX', isAdmin: true } }
        : null;
    },
    async getContextByKey() { return null; }
  },
  bitrixClient: {
    async updateReportItem() { return { id: 77 }; },
    async getCrmItem() { return getCrmItemResult; }
  }
});

const makeJobPayload = (reportId) => ({
  report_id: reportId,
  payload: JSON.stringify({ status: 'in_progress', diskFolderId: 555, contextKey: 'mX:solo.bitrix24.ru:1', domain: 'solo.bitrix24.ru', memberId: 'mX' })
});

test('I1/раунд2: buildCrmSyncRunner кэширует settingsStore.read() — два job подряд делают ОДИН реальный запрос настроек, а не два', async () => {
  let settingsReadCalls = 0;
  const settingsStore = { async read() { settingsReadCalls += 1; return baseSettings; } };

  const runSync = buildCrmSyncRunner(makeSingleAdminDeps({ settingsStore }));
  await runSync(makeJobPayload(10));
  await runSync(makeJobPayload(11));

  assert.equal(settingsReadCalls, 1,
    'до фикса КАЖДАЯ задача делала свой собственный, неоплаченный лимитером запрос настроек — второй job обязан переиспользовать кэш');
});

test('I1/раунд2: кэш настроек реально закрывает залп на ветке "нет admin-контекста" — несколько job подряд, НОЛЬ походов к порталу за настройками после первого', async () => {
  // Именно та ветка, где ревьюер нашёл настоящий всплеск: задача тратит НОЛЬ
  // токенов лимитера (skip+warn до единого реального вызова Битрикса) и БЕЗ
  // кэша делала бы РОВНО ОДИН неоплаченный запрос каждая — while(worked) крутит
  // такие на скорости базы. С кэшем — один реальный запрос суммарно на всю пачку.
  let settingsReadCalls = 0;
  const settingsStore = { async read() { settingsReadCalls += 1; return baseSettings; } };
  const calls = { updates: [] };

  const deps = {
    reportsStore: {
      async getById(id) { return { id, reportItemId: 77, status: 'in_progress', diskFolderId: 555 }; },
      async listPhotos() { return []; }
    },
    settingsStore,
    authContextStore: {
      async getLastAdminContext() { return null; },
      async getLastAdminContextForPortal() { return null; }, // ни у одного job нет admin-контекста
      async getContextByKey() { return null; }
    },
    bitrixClient: {
      async updateReportItem(args) { calls.updates.push(args); return { id: 77 }; },
      async getCrmItem() { return { UF_FOLDER: '555' }; }
    },
    logger: { warn() {}, info() {}, error() {} }
  };

  const runSync = buildCrmSyncRunner(deps);
  await runSync(makeJobPayload(20));
  await runSync(makeJobPayload(21));
  await runSync(makeJobPayload(22));

  assert.equal(calls.updates.length, 0, 'ни один из трёх job не должен был дойти до updateReportItem — контекста нет ни у одного');
  assert.equal(settingsReadCalls, 1,
    'до фикса это были бы 3 неоплаченных запроса (по одному на job); с кэшем — ровно 1 на всю пачку, независимо от её размера');
});

test('I1/раунд2: кэш настроек перечитывает после истечения TTL, но не раньше (граница, не просто "кэш есть")', async () => {
  let settingsReadCalls = 0;
  const settingsStore = { async read() { settingsReadCalls += 1; return baseSettings; } };
  let clock = 0;

  const runSync = buildCrmSyncRunner({
    ...makeSingleAdminDeps({ settingsStore }),
    settingsCacheTtlMs: 1000,
    now: () => clock
  });

  await runSync(makeJobPayload(30));
  assert.equal(settingsReadCalls, 1);

  clock += 500; // внутри TTL
  await runSync(makeJobPayload(31));
  assert.equal(settingsReadCalls, 1, 'вызов внутри TTL не должен перечитывать настройки');

  clock += 600; // суммарно 1100 — за пределами TTL=1000
  await runSync(makeJobPayload(32));
  assert.equal(settingsReadCalls, 2, 'вызов после истечения TTL обязан перечитать настройки');
});

test('I1/раунд2: buildCrmSyncRunner БЕЗ явного settingsCacheTtlMs/now — использует дефолты и не ломается (обратная совместимость)', async () => {
  let settingsReadCalls = 0;
  const settingsStore = { async read() { settingsReadCalls += 1; return baseSettings; } };
  const runSync = buildCrmSyncRunner(makeSingleAdminDeps({ settingsStore }));
  await runSync(makeJobPayload(40));
  assert.equal(settingsReadCalls, 1);
});
