import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsStore } from '../src/reports/analyticsStore.js';

// Fake Postgres pool — returns predefined rows matched by SQL substring
function fakePool(rowsByQuery) {
  return {
    query(sql, params) {
      for (const [pattern, rows] of rowsByQuery) {
        if (sql.includes(pattern)) return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    }
  };
}

test('getRating returns sorted aggregates', async () => {
  const pool = fakePool([
    ['GROUP BY azs_id', [
      { azs_id: '12', total: 10, on_time: 8, late: 2, avg_minutes: 23 },
      { azs_id: '7',  total: 10, on_time: 6, late: 4, avg_minutes: 37 },
    ]]
  ]);
  const store = createAnalyticsStore({ pool, dbType: 'postgres' });
  const rows = await store.getRating({ dateFrom: '2026-06-01', dateTo: '2026-06-04' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].azsId, '12');
  assert.equal(rows[0].onTime, 8);
  assert.equal(rows[0].avgMinutes, 23);
});

test('getTrend returns one row per day', async () => {
  const pool = fakePool([
    ['GROUP BY 1', [
      { day: '2026-06-01', total: 7, done: 5, expired: 1, open: 1 },
      { day: '2026-06-02', total: 8, done: 7, expired: 0, open: 1 },
    ]]
  ]);
  const store = createAnalyticsStore({ pool, dbType: 'postgres' });
  const rows = await store.getTrend({ dateFrom: '2026-06-01', dateTo: '2026-06-02' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-06-01');
  assert.equal(rows[1].done, 7);
});

test('getDayPhotos groups photos by reportId', async () => {
  const pool = fakePool([
    ['JOIN report_photo', [
      { report_id: 1, azs_id: '12', done_at: new Date('2026-06-04T09:12:00Z'),
        photo_code: 'hall', disk_object_id: 999, disk_folder_id: 100,
        exif_at: new Date('2026-06-04T09:10:00Z'), uploaded_at: new Date('2026-06-04T09:11:00Z') },
      { report_id: 1, azs_id: '12', done_at: new Date('2026-06-04T09:12:00Z'),
        photo_code: 'wc', disk_object_id: 1000, disk_folder_id: 100,
        exif_at: null, uploaded_at: new Date('2026-06-04T09:11:30Z') },
    ]]
  ]);
  const store = createAnalyticsStore({ pool, dbType: 'postgres' });
  const result = await store.getDayPhotos({ date: '2026-06-04' });
  assert.equal(result.length, 1);
  assert.equal(result[0].photos.length, 2);
  assert.equal(result[0].photos[0].photoCode, 'hall');
});
