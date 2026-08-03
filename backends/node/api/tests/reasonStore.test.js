import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonStore } from '../src/reports/reasonStore.js';

// --- Fake PG pool ---
const createFakePgPool = () => {
  const rows = [];
  // scope_key -> settings_json, имитирует таблицу app_settings (общую с
  // settingsStore) — маркер бэкафилла живёт в ней же, см. reasonStore.js.
  const appSettingsRows = new Map();
  let seq = 0;
  return {
    rows,
    appSettingsRows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return { rows: [] };

      // isBackfillDone / markBackfillDone — маркер в app_settings
      if (text.startsWith('SELECT 1 FROM app_settings')) {
        return { rows: appSettingsRows.has(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (text.startsWith('INSERT INTO app_settings')) {
        appSettingsRows.set(params[0], params[1]);
        return { rows: [] };
      }

      // upsert: INSERT INTO report_reason ... ON CONFLICT(report_id) DO UPDATE ...
      if (text.startsWith('INSERT INTO report_reason')) {
        const existing = rows.find(r => r.report_id === params[0]);
        if (existing) {
          existing.azs_id = params[1]; existing.admin_user_id = params[2];
          existing.reason_code = params[3]; existing.reason_text = params[4];
          existing.source = params[5]; existing.updated_at = new Date();
          return { rows: [existing] };
        }
        seq += 1;
        const row = {
          id: seq, report_id: params[0], azs_id: params[1],
          admin_user_id: params[2], reason_code: params[3],
          reason_text: params[4], source: params[5],
          created_at: new Date(), updated_at: new Date()
        };
        rows.push(row);
        return { rows: [row] };
      }
      // getByReport
      if (text.startsWith('SELECT * FROM report_reason WHERE report_id')) {
        return { rows: rows.filter(r => r.report_id === params[0]) };
      }
      // countsByCode
      if (text.includes('GROUP BY reason_code')) {
        const counts = {};
        rows.forEach(r => { counts[r.reason_code] = (counts[r.reason_code] || 0) + 1; });
        return { rows: Object.entries(counts).map(([reason_code, count]) => ({ reason_code, count })) };
      }
      // countEmpty
      if (text.includes('COUNT(*)') && text.includes('report_reason')) {
        return { rows: [{ count: rows.length }] };
      }
      return { rows: [] };
    }
  };
};

test('upsert creates a new reason row', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const row = await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'queue', reasonText: null, source: 'app' });
  assert.ok(row, 'row returned');
  assert.equal(row.reason_code, 'queue');
  assert.equal(row.report_id, 1);
});

test('upsert overwrites existing reason for same reportId', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'queue', reasonText: null, source: 'app' });
  const row2 = await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'other', reasonText: 'пример', source: 'app' });
  assert.equal(row2.reason_code, 'other');
  const fetched = await store.getByReport(1);
  assert.equal(fetched?.reason_code, 'other');
});

test('getByReport returns null for unknown report', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const result = await store.getByReport(999);
  assert.equal(result, null);
});

test('countsByCode returns grouped counts over date range', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 1, reasonCode: 'queue', reasonText: null, source: 'app' });
  await store.upsert({ reportId: 2, azsId: 'AZS-01', adminUserId: 1, reasonCode: 'queue', reasonText: null, source: 'app' });
  await store.upsert({ reportId: 3, azsId: 'AZS-02', adminUserId: 2, reasonCode: 'staff', reasonText: null, source: 'expiry' });
  const counts = await store.countsByCode({});
  assert.ok(counts.find(c => c.reason_code === 'queue')?.count >= 2);
});

// ---------------------------------------------------------------------------
// Маркер бэкафилла (isBackfillDone / markBackfillDone) — см. отчёт
// reason-rehydrate-report.md: countEmpty()===0 путает «пусто и всегда было»
// с «прогнали и не нашли», маркер в app_settings различает эти два факта.
// ---------------------------------------------------------------------------

test('isBackfillDone: false до markBackfillDone, true после — для того же портала', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const context = { memberId: 'm1', domain: 'portal-one.bitrix24.ru' };

  assert.equal(await store.isBackfillDone({ context }), false, 'до первого прогона маркера ещё нет');
  await store.markBackfillDone({ context });
  assert.equal(await store.isBackfillDone({ context }), true, 'после markBackfillDone маркер должен читаться как done');
});

test('isBackfillDone: маркер портал-скоуплен — второй портал не наследует чужой флаг', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const portalA = { memberId: 'a', domain: 'a.bitrix24.ru' };
  const portalB = { memberId: 'b', domain: 'b.bitrix24.ru' };

  await store.markBackfillDone({ context: portalA });

  assert.equal(await store.isBackfillDone({ context: portalA }), true, 'портал A помечен выполненным');
  assert.equal(
    await store.isBackfillDone({ context: portalB }),
    false,
    'портал B не должен видеть флаг портала A — иначе один global-маркер подавил бы бэкафилл для второго портала'
  );
});

test('isBackfillDone: маркер живёт в app_settings под своим префиксом и не путается с реальной строкой настроек', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  // Кладём «настоящую» строку настроек с scope_key='global' напрямую в тот
  // же fake app_settings — маркер бэкафилла должен использовать отдельный
  // namespace-префикс и не считать эту строку своим флагом.
  pool.appSettingsRows.set('global', JSON.stringify({ report: { fields: {} } }));

  assert.equal(await store.isBackfillDone({}), false, 'реальная строка настроек не должна восприниматься как маркер бэкафилла');
  await store.markBackfillDone({});
  assert.equal(await store.isBackfillDone({}), true);
  // и «настоящая» строка настроек должна остаться нетронутой
  assert.ok(pool.appSettingsRows.get('global').includes('report'), 'запись реальных настроек не должна быть затёрта маркером');
});

test('MySQL driver: isBackfillDone/markBackfillDone работают через ON DUPLICATE KEY UPDATE', async () => {
  const appSettingsRows = new Map();
  const mysqlPool = {
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE')) return [[{ c: 1 }]];
      if (text.startsWith('SELECT 1 FROM app_settings')) {
        return [appSettingsRows.has(params[0]) ? [{ '1': 1 }] : []];
      }
      if (text.startsWith('INSERT INTO app_settings')) {
        appSettingsRows.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };
  const store = createReasonStore({ pool: mysqlPool, dbType: 'mysql' });
  await store.ensureSchema();
  const context = { memberId: 'm2', domain: 'portal-two.bitrix24.ru' };

  assert.equal(await store.isBackfillDone({ context }), false);
  await store.markBackfillDone({ context });
  assert.equal(await store.isBackfillDone({ context }), true);
});

test('MySQL driver: upsert and getByReport work via ON DUPLICATE KEY UPDATE', async () => {
  // Fake MySQL pool
  const rows = [];
  let seq = 0;
  const mysqlPool = {
    rows,
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE') || text.includes('information_schema')) return [[{ c: 1 }]];
      if (text.startsWith('INSERT INTO report_reason')) {
        const ex = rows.find(r => r.report_id === params[0]);
        if (ex) { ex.reason_code = params[3]; ex.reason_text = params[4]; return [{ affectedRows: 1 }]; }
        seq += 1;
        rows.push({ id: seq, report_id: params[0], azs_id: params[1], admin_user_id: params[2], reason_code: params[3], reason_text: params[4], source: params[5] });
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('SELECT * FROM report_reason WHERE report_id')) {
        return [rows.filter(r => r.report_id === params[0])];
      }
      return [[]];
    }
  };
  const store = createReasonStore({ pool: mysqlPool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 5, azsId: 'AZS-05', adminUserId: 50, reasonCode: 'delivery', reasonText: null, source: 'app' });
  const row = await store.getByReport(5);
  assert.equal(row?.reason_code, 'delivery');
});
