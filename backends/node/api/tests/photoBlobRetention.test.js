// Task 12, часть 1 — очистка байтов report_photo_blob через N дней после
// публикации (PHOTO_BLOB_RETENTION_DAYS, по умолчанию 7).
//
// photoQueueStore.purgePublishedBlobs({ olderThanMs }) уже написан и покрыт
// tests/photoQueueStore.test.js ("purgePublishedBlobs чистит только
// опубликованные и только старые"). Этот файл — ОТДЕЛЬНАЯ, специально
// выделенная регрессия именно на несущее требование задачи: очистка НИКОГДА
// не трогает accepted/failed фото, потому что их байты в нашей базе —
// единственная копия (телефон оператора их уже забыл). Несущий инвариант
// заслуживает собственного файла, который не может незаметно ослабнуть
// вместе с будущим рефакторингом общего photoQueueStore.test.js.
//
// Часть server.js (крон, читающий PHOTO_BLOB_RETENTION_DAYS и вызывающий
// purgePublishedBlobs по расписанию) тестами здесь не покрыта — server.js
// нигде не импортируется тестами этого проекта (весь его верхний уровень —
// живые side-effects: подключение к БД, express.listen(), см. заголовочный
// комментарий src/reports/photoPublishBoot.js), и уже существующая в нём
// точно такая же по форме очистка diag-бандлов (cron.schedule('30 3 * * *',
// ...) чуть выше по файлу) тоже не имеет отдельного теста на саму проводку —
// только на то, что она вызывает (diagStore.deleteOlderThan, см.
// tests/diagStore.test.js). Эти тесты следуют тому же прецеденту и бьют по
// той же точке: реальной deletion-логике, которую крон вызывает.
//
// Приём тестирования — тот же фейковый pool, что и в
// tests/photoQueueStore.test.js (записывает SQL-текст и параметры, отдаёт
// заготовленные ответы по порядку вызовов): без этого — либо реальная БД в
// тестах (запрещено брифом), либо мок-библиотека поверх pg/mysql2 (не даёт
// проверить ФОРМУ реального запроса). Мутационная проверка ниже (см. отчёт
// task-12-report.md) выполнена вручную: условие publish_state = 'published'
// снималось прямо в src/reports/photoQueueStore.js, оба теста "НИКОГДА не
// трогает" ниже краснели, правка отменялась.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoQueueStore } from '../src/reports/photoQueueStore.js';

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
const makeFakePool = (responses = []) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return responses[i++] ?? { rows: [], rowCount: 0 };
    }
  };
};

test('Postgres: purgePublishedBlobs чистит опубликованные старше N дней', async () => {
  const pool = makeFakePool([{ rowCount: 12 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const calledAt = Date.now();
  const removed = await store.purgePublishedBlobs({ olderThanMs: DEFAULT_RETENTION_MS });

  assert.equal(removed, 12, 'возвращает число реально удалённых строк (pool.rowCount), а не true/false');
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /DELETE FROM report_photo_blob/);
  assert.match(sql, /publish_state = 'published'/, 'без этого условия чистка задела бы ещё не опубликованное');
  assert.match(sql, /published_at < /, 'без порога возраста чистило бы даже только что опубликованное');

  // Порог, реально переданный в запрос, обязан быть "сейчас минус N дней" —
  // а не какое-то другое число. Здесь PHOTO_BLOB_RETENTION_DAYS из server.js
  // мог бы молча потеряться (например, если бы кто-то передал дни вместо мс).
  const cutoff = params[0];
  assert.ok(cutoff instanceof Date, 'порог передаётся как Date, а не строка/число');
  assert.ok(
    Math.abs(cutoff.getTime() - (calledAt - DEFAULT_RETENTION_MS)) < 5000,
    `cutoff ${cutoff.toISOString()} должен быть ~7 дней назад от момента вызова`
  );
});

test('Postgres: purgePublishedBlobs НИКОГДА не трогает accepted и failed — единственная копия ещё не доехавшего файла', async () => {
  const pool = makeFakePool([{ rowCount: 0 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.purgePublishedBlobs({ olderThanMs: DEFAULT_RETENTION_MS });
  const sql = pool.calls[0].sql;

  // Позитив: единственное разрешённое условие на publish_state — 'published'.
  assert.match(sql, /publish_state = 'published'/);
  // Негатив — то, что реально ловит мутацию вида «заодно почистим и то, что
  // давно висит в очереди» (например, IN ('published','accepted')): если
  // кто-то допишет accepted/failed в условие, эти assert'ы покраснеют, даже
  // если позитивная проверка выше всё ещё проходит.
  assert.doesNotMatch(sql, /'accepted'/, 'accepted — ещё не доехавшее фото, его байты трогать нельзя');
  assert.doesNotMatch(sql, /'failed'/, 'failed — окончательный отказ, байты в нашей базе всё ещё единственная копия');
  // Чистка обязана удалять только байты (report_photo_blob), а не саму
  // строку report_photo — на факт "код был загружен" опирается POST
  // /:id/submit (см. комментарий над markFailed в photoQueueStore.js).
  assert.doesNotMatch(sql, /DELETE FROM report_photo\b/,
    'чистка обязана удалять только report_photo_blob, а не report_photo');
});

// ---------------------------------------------------------------------------
// MySQL — тот же контракт, другой драйвер (pool.execute вместо pool.query,
// affectedRows вместо rowCount, cutoff — строка 'YYYY-MM-DD HH:mm:ss', а не
// объект Date). См. tests/photoQueueStore.test.js — тот же фейк-пул.
// ---------------------------------------------------------------------------
const makeFakeMysqlPool = (responses = []) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return responses[i++] ?? [[]];
    }
  };
};

// toDateSql (photoQueueStore.js) форматирует как d.toISOString().slice(0,19)
// с заменой 'T' на ' ' — обратное преобразование для сравнения с ожидаемым cutoff.
const parseMysqlDateSql = (value) => new Date(`${String(value).replace(' ', 'T')}Z`);

test('MySQL: purgePublishedBlobs чистит опубликованные старше N дней', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 6 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const calledAt = Date.now();
  const removed = await store.purgePublishedBlobs({ olderThanMs: DEFAULT_RETENTION_MS });

  assert.equal(removed, 6);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /DELETE b FROM report_photo_blob b/);
  assert.match(sql, /publish_state = 'published'/);
  assert.match(sql, /published_at < /);

  const cutoff = parseMysqlDateSql(params[0]);
  assert.ok(
    Math.abs(cutoff.getTime() - (calledAt - DEFAULT_RETENTION_MS)) < 5000,
    `cutoff ${params[0]} должен быть ~7 дней назад от момента вызова`
  );
});

test('MySQL: purgePublishedBlobs НИКОГДА не трогает accepted и failed', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 0 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.purgePublishedBlobs({ olderThanMs: DEFAULT_RETENTION_MS });
  const sql = pool.calls[0].sql;

  assert.match(sql, /publish_state = 'published'/);
  assert.doesNotMatch(sql, /'accepted'/, 'accepted — ещё не доехавшее фото, его байты трогать нельзя');
  assert.doesNotMatch(sql, /'failed'/, 'failed — окончательный отказ, байты всё ещё единственная копия');
  assert.doesNotMatch(sql, /DELETE b FROM report_photo\b(?!_blob)/,
    'чистка обязана удалять только report_photo_blob, а не report_photo');
});

test('олдер-порог 0 дней (гипотетический PHOTO_BLOB_RETENTION_DAYS=0) всё равно требует published_at < cutoff — не превращается в "удалить всё published"', async () => {
  const pool = makeFakePool([{ rowCount: 0 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.purgePublishedBlobs({ olderThanMs: 0 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /published_at < /, 'даже при пороге 0 запрос обязан сравнивать published_at, а не удалять безусловно');
});
