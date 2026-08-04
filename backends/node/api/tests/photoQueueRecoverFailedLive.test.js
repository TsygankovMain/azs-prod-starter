import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPhotoQueueStore } from '../src/reports/photoQueueStore.js';
import { createReportsStore } from '../src/reports/reportsStore.js';

// ---------------------------------------------------------------------------
// C4 (финальное ревью ветки) — рычаг возврата из publish_state='failed'.
// Поведенческое доказательство на живом Postgре: строка, доведённая до
// 'failed' исчерпанием попыток (ровно то, что происходит в проде после
// длительного простоя портала — QUERY_LIMIT_EXCEEDED обоих инцидентов),
// НЕ видна claimBatch, ВИДНА после recoverFailed(), и получает полный новый
// круг попыток (publish_attempts сброшен), а не немедленно уходит обратно в
// failed на первой же следующей осечке.
//
// Требует живой Postgres — см. заголовок tests/photoQueueClaimBatchLive.test.js
// за инструкцией, как поднять локально; пропускается, если недоступен.
// Изоляция — отдельная Postgres-схема, безопасно даже на не-пустой базе.
// ---------------------------------------------------------------------------

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'appdb',
  user: process.env.DB_USER || 'appuser',
  password: process.env.DB_PASSWORD || 'apppass',
  connectionTimeoutMillis: 2000
};

const TEST_SCHEMA = 'photo_queue_recover_failed_live_test';
const SKIP_REASON = 'живой Postgres недоступен (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) — см. заголовок tests/photoQueueClaimBatchLive.test.js';

const probe = async () => {
  const probePool = new pg.Pool(connectionConfig);
  try {
    await probePool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end().catch(() => {});
  }
};

const dbAvailable = await probe();
const skip = dbAvailable ? false : SKIP_REASON;

let pool = null;

if (dbAvailable) {
  const rootPool = new pg.Pool(connectionConfig);
  await rootPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await rootPool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await rootPool.end();

  pool = new pg.Pool({ ...connectionConfig, options: `-c search_path=${TEST_SCHEMA},public` });
  const schemaStore = createReportsStore({ pool, dbType: 'postgres' });
  await schemaStore.ensurePhotoSchema();
}

const store = pool ? createPhotoQueueStore({ pool, dbType: 'postgres' }) : null;

const resetRows = async () => {
  await pool.query('TRUNCATE report_photo_blob, report_photo RESTART IDENTITY CASCADE');
};

const seedFailed = async ({ reportId, photoCode, attempts = 8, error = 'QUERY_LIMIT_EXCEEDED' }) => {
  const inserted = await pool.query(
    `INSERT INTO report_photo (report_id, photo_code, publish_state, uploaded_by, publish_attempts, last_publish_error, next_attempt_at, uploaded_at)
     VALUES ($1, $2, 'failed', 1, $3, $4, NULL, NOW() - interval '1 hour') RETURNING id`,
    [reportId, photoCode, attempts, error]
  );
  const id = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO report_photo_blob (report_photo_id, content, mime_type, byte_size, original_name)
     VALUES ($1, $2, 'image/jpeg', 3, 'x.jpg')`,
    [id, Buffer.from('abc')]
  );
  return Number(id);
};

test('C4: failed-строка невидима claimBatch — ровно то, из-за чего рычаг возврата вообще нужен', { skip }, async () => {
  await resetRows();
  await seedFailed({ reportId: 1, photoCode: 'FRONT' });
  const rows = await store.claimBatch({ limit: 3, now: new Date() });
  assert.equal(rows.length, 0, 'failed-строка обязана быть невидима claimBatch — reclaimStale тоже её не видит (см. её собственный тест)');
});

test('C4: recoverFailed({reportId}) возвращает failed-строки в оборот, claimBatch снова их видит', { skip }, async () => {
  await resetRows();
  const id = await seedFailed({ reportId: 42, photoCode: 'FRONT' });

  const recovered = await store.recoverFailed({ reportId: 42 });
  assert.equal(recovered.length, 1);
  assert.equal(Number(recovered[0].id), id);

  const claimed = await store.claimBatch({ limit: 3, now: new Date() });
  assert.equal(claimed.length, 1, 'после recoverFailed строка обязана снова стать видна claimBatch');
  assert.equal(Number(claimed[0].id), id);
});

test('C4: recoverFailed сбрасывает publish_attempts — без сброса следующая осечка немедленно вернула бы строку в failed', { skip }, async () => {
  await resetRows();
  // attempts=8 — уже НА пороге DEFAULT_MAX_ATTEMPTS воркера (8): без сброса
  // handleError() увидел бы attempts+1>=maxAttempts на первой же следующей
  // ошибке и увёл бы строку обратно в failed немедленно, а не дал ей полный
  // новый круг ретраев.
  await seedFailed({ reportId: 7, photoCode: 'BACK', attempts: 8 });
  await store.recoverFailed({ reportId: 7 });

  const { rows } = await pool.query('SELECT publish_attempts, last_publish_error FROM report_photo WHERE report_id = 7');
  assert.equal(rows[0].publish_attempts, 0, 'publish_attempts обязан быть сброшен в 0 — иначе возврат бесполезен');
  // last_publish_error намеренно НЕ трогаем — полезный след до первого
  // реального нового исхода.
  assert.equal(rows[0].last_publish_error, 'QUERY_LIMIT_EXCEEDED');
});

test('C4: recoverFailed НЕ трогает failed-строки других отчётов/id (избирательность реальна, не только заявлена)', { skip }, async () => {
  await resetRows();
  const targetId = await seedFailed({ reportId: 1, photoCode: 'A' });
  const otherId = await seedFailed({ reportId: 2, photoCode: 'B' });

  const recovered = await store.recoverFailed({ reportId: 1 });
  assert.deepEqual(recovered.map((r) => Number(r.id)), [targetId]);

  const { rows } = await pool.query('SELECT id, publish_state FROM report_photo WHERE id = $1', [otherId]);
  assert.equal(rows[0].publish_state, 'failed', 'чужой отчёт обязан остаться нетронутым');
});

test('C4: recoverFailed({ids}) — список охватывает несколько отчётов, остальные failed-строки не трогает', { skip }, async () => {
  await resetRows();
  const idA = await seedFailed({ reportId: 1, photoCode: 'A' });
  const idB = await seedFailed({ reportId: 2, photoCode: 'B' });
  const idC = await seedFailed({ reportId: 3, photoCode: 'C' });

  const recovered = await store.recoverFailed({ ids: [idA, idC] });
  assert.deepEqual(recovered.map((r) => Number(r.id)).sort((a, b) => a - b), [idA, idC].sort((a, b) => a - b));

  const { rows } = await pool.query('SELECT id, publish_state FROM report_photo ORDER BY id');
  const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r.publish_state]));
  assert.equal(byId[idA], 'accepted');
  assert.equal(byId[idB], 'failed', 'не входил в ids — обязан остаться нетронутым');
  assert.equal(byId[idC], 'accepted');
});

test('C4: recoverFailed не трогает НЕ-failed строки (accepted/published) даже если они входят в reportId/ids', { skip }, async () => {
  await resetRows();
  const failedId = await seedFailed({ reportId: 9, photoCode: 'FAILED_ONE' });
  // Здоровая, уже опубликованная строка того же отчёта.
  const publishedInsert = await pool.query(
    `INSERT INTO report_photo (report_id, photo_code, publish_state, uploaded_by, published_at)
     VALUES (9, 'ALREADY_PUBLISHED', 'published', 1, NOW()) RETURNING id`
  );
  const publishedId = Number(publishedInsert.rows[0].id);

  const recovered = await store.recoverFailed({ reportId: 9 });
  assert.deepEqual(recovered.map((r) => Number(r.id)), [failedId]);

  const { rows } = await pool.query('SELECT id, publish_state FROM report_photo WHERE id = $1', [publishedId]);
  assert.equal(rows[0].publish_state, 'published', 'уже опубликованная строка не должна быть задета возвратом failed-строк того же отчёта');
});
