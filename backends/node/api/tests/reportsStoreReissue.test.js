import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsStore } from '../src/reports/reportsStore.js';

// LIKE c '%'-вайлдкардами → RegExp
const like = (val, pattern) =>
  new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$')
    .test(String(val ?? ''));

export const createFakePgPool = (seed = []) => {
  const rows = seed.map((r, i) => ({ id: i + 1, report_item_id: null, deadline_at: null, ...r }));
  const matchDay = (r, p1, p2, p3) => (like(r.slot_key, p1) || like(r.slot_key, p2)) && !like(r.slot_key, p3);
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const [p1, p2, p3] = params;
      if (text.startsWith('SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log')) {
        return { rows: rows.filter((r) => matchDay(r, p1, p2, p3) && !['done', 'cancelled'].includes(r.status)) };
      }
      if (text.startsWith("UPDATE dispatch_log SET status='cancelled'")) {
        let n = 0;
        for (const r of rows) if (matchDay(r, p1, p2, p3) && !['done', 'cancelled'].includes(r.status)) { r.status = 'cancelled'; n += 1; }
        return { rowCount: n };
      }
      if (text.startsWith('SELECT DISTINCT azs_id FROM dispatch_log')) {
        const set = [...new Set(rows.filter((r) => matchDay(r, p1, p2, p3) && r.status === 'done').map((r) => r.azs_id))];
        return { rows: set.map((azs_id) => ({ azs_id })) };
      }
      // getActiveReportForAzsOnDate: SELECT * ... WHERE azs_id=$1 ... AND status <> 'cancelled'
      if (text.startsWith('SELECT * FROM dispatch_log')) {
        const live = rows.filter((r) => String(r.azs_id) === String(params[0])
          && (like(r.slot_key, params[1]) || like(r.slot_key, params[2]))
          && !like(r.slot_key, params[3]) && r.status !== 'cancelled');
        return { rows: live.length ? [live[0]] : [] };
      }
      throw new Error('unexpected SQL: ' + text);
    },
  };
};

const SEED = [
  { slot_key: '2026-06-26:0900', azs_id: '101', admin_user_id: 11, status: 'new' },
  { slot_key: '2026-06-26:1400', azs_id: '102', admin_user_id: 12, status: 'reserved' },
  { slot_key: '2026-06-26:0900', azs_id: '103', admin_user_id: 13, status: 'done' },
  { slot_key: 'manual:2026-06-26:1600', azs_id: '104', admin_user_id: 14, status: 'expired' },
  { slot_key: '2026-06-26:0900:reminder:1', azs_id: '101', admin_user_id: 11, status: 'new' },
  { slot_key: '2026-06-25:0900', azs_id: '105', admin_user_id: 15, status: 'new' },
];

test('listNotSubmittedForDate: сегодняшние не-done/не-cancelled, без reminder и чужих дней', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  const rows = await store.listNotSubmittedForDate({ planDate: '2026-06-26' });
  assert.deepEqual(rows.map((r) => r.azsId).sort(), ['101', '102', '104']);
  assert.equal(rows.every((r) => typeof r.adminUserId === 'number'), true);
});

test('listSubmittedAzsForDate: только сданные АЗС', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  assert.deepEqual(await store.listSubmittedAzsForDate({ planDate: '2026-06-26' }), ['103']);
});

test('cancelNotSubmittedForDate: помечает и идемпотентен', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  assert.equal(await store.cancelNotSubmittedForDate({ planDate: '2026-06-26' }), 3);
  assert.equal((await store.listNotSubmittedForDate({ planDate: '2026-06-26' })).length, 0);
  assert.equal(await store.cancelNotSubmittedForDate({ planDate: '2026-06-26' }), 0);
});

test('getActiveReportForAzsOnDate: только cancelled → null', async () => {
  const pool = createFakePgPool([
    { slot_key: '2026-06-26:0900', azs_id: '101', admin_user_id: 11, status: 'cancelled' },
  ]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const r = await store.getActiveReportForAzsOnDate({ azsId: '101', planDate: '2026-06-26' });
  assert.equal(r, null);
});
