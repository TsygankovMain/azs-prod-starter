import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsStore } from '../src/reports/reportsStore.js';

const makeFakePool = () => {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(String(sql).replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0 };
    }
  };
};

test('ensurePhotoSchema создаёт таблицу байтов и колонки публикации', async () => {
  const pool = makeFakePool();
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.ensurePhotoSchema();
  const all = pool.statements.join(' | ');

  assert.match(all, /CREATE TABLE IF NOT EXISTS report_photo_blob/);
  assert.match(all, /report_photo_id BIGINT PRIMARY KEY REFERENCES report_photo\(id\) ON DELETE CASCADE/);
  assert.match(all, /ADD COLUMN IF NOT EXISTS publish_state/);
  assert.match(all, /ADD COLUMN IF NOT EXISTS published_at/);
  assert.match(all, /ADD COLUMN IF NOT EXISTS publish_attempts/);
  assert.match(all, /ADD COLUMN IF NOT EXISTS next_attempt_at/);
  assert.match(all, /ADD COLUMN IF NOT EXISTS last_publish_error/);
});

test('исторические строки остаются published, а не встают в очередь', async () => {
  const pool = makeFakePool();
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.ensurePhotoSchema();
  const addColumn = pool.statements.find((s) => s.includes('ADD COLUMN IF NOT EXISTS publish_state'));
  assert.match(addColumn, /DEFAULT 'published'/,
    "дефолт 'accepted' поставил бы весь архив на повторную публикацию");
});

test('есть индекс под выборку очереди', async () => {
  const pool = makeFakePool();
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.ensurePhotoSchema();
  const all = pool.statements.join(' | ');
  assert.match(all, /CREATE INDEX IF NOT EXISTS ix_report_photo_publish_due/);
});

test('состояние отчёта — своя таблица, а не колонки в несуществующей report', async () => {
  const pool = makeFakePool();
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.ensurePhotoSchema();
  const all = pool.statements.join(' | ');
  assert.match(all, /CREATE TABLE IF NOT EXISTS report_local_state/);
  assert.doesNotMatch(all, /ALTER TABLE report ADD/,
    'локальной таблицы отчётов нет — отчёты живут элементами CRM в Битриксе');
});

// ---------------------------------------------------------------------------
// Идемпотентность (не описана в брифе явно, но обязательна: ensureSchema
// должен безопасно переживать повторный запуск на уже смигрированной базе,
// не падая и не меняя данные).
// ---------------------------------------------------------------------------

test('PostgreSQL: повторный вызов ensurePhotoSchema не падает, и весь новый DDL написан идемпотентно', async () => {
  const pool = makeFakePool();
  const store = createReportsStore({ pool, dbType: 'postgres' });

  await store.ensurePhotoSchema();
  await store.ensurePhotoSchema(); // повторный прогон на «уже смигрированной» базе — не должен бросать

  // Postgres поддерживает IF NOT EXISTS и для CREATE TABLE/INDEX, и для ADD COLUMN —
  // если хотя бы один DDL-стейтмент его не использует, повторный запуск на
  // реальной базе упадёт. Проверяем текст SQL, а не только факт отсутствия throw,
  // потому что фейковый пул успешно проглотит любой SQL независимо от идемпотентности.
  const ddlStatements = pool.statements.filter((s) =>
    /^(CREATE TABLE|CREATE INDEX|ALTER TABLE .* ADD COLUMN)/.test(s));
  assert.ok(ddlStatements.length >= 9, `ожидали не меньше 9 DDL-выражений, получили ${ddlStatements.length}`);
  for (const stmt of ddlStatements) {
    assert.match(stmt, /IF NOT EXISTS/, `не идемпотентно на реальной Postgres: ${stmt}`);
  }
});

// MySQL не поддерживает ADD COLUMN IF NOT EXISTS и CREATE INDEX IF NOT EXISTS —
// идемпотентность там держится вручную, на проверке information_schema перед
// каждым ALTER/CREATE INDEX. Это единственное место, где повторный прогон
// реально может сломаться (Duplicate column / Duplicate key name), поэтому
// фейковый пул здесь стейтфул: помнит, какие колонки и индексы уже «созданы»,
// и второй вызов ensurePhotoSchema() должен увидеть их существующими.
const makeStatefulFakeMysqlPool = () => {
  const statements = [];
  // Симулируем базу, уже прошедшую предыдущую миграцию (disk_object_id есть),
  // но без новых колонок публикации — типичное состояние «до» этой задачи.
  const columns = new Set([
    'id', 'report_id', 'photo_code', 'file_id', 'file_name',
    'disk_folder_id', 'disk_object_id', 'uploaded_by', 'exif_at',
    'uploaded_at', 'created_at', 'updated_at'
  ]);
  const indexes = new Set();

  return {
    statements,
    columns,
    indexes,
    async execute(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(text);

      const colCheck = text.match(/COLUMN_NAME = '([^']+)'/);
      if (colCheck) {
        return [[{ c: columns.has(colCheck[1]) ? 1 : 0 }]];
      }
      const idxCheck = text.match(/INDEX_NAME = '([^']+)'/);
      if (idxCheck) {
        return [[{ c: indexes.has(idxCheck[1]) ? 1 : 0 }]];
      }
      const alterAdd = text.match(/^ALTER TABLE report_photo ADD COLUMN (\S+)/);
      if (alterAdd) {
        columns.add(alterAdd[1]);
        return [[]];
      }
      const createIdx = text.match(/^CREATE INDEX (\S+)/);
      if (createIdx) {
        indexes.add(createIdx[1]);
        return [[]];
      }
      // CREATE TABLE IF NOT EXISTS ... — нативно идемпотентно в MySQL, без guard'а.
      return [[]];
    }
  };
};

test('MySQL: первый проход добавляет недостающие колонки, индекс, таблицу байтов и report_local_state', async () => {
  const pool = makeStatefulFakeMysqlPool();
  const store = createReportsStore({ pool, dbType: 'mysql' });
  await store.ensurePhotoSchema();

  const all = pool.statements.join(' | ');
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN publish_state VARCHAR\(16\) NOT NULL DEFAULT 'published'/);
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN published_at DATETIME NULL/);
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN publish_attempts INT NOT NULL DEFAULT 0/);
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN next_attempt_at DATETIME NULL/);
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN last_publish_error LONGTEXT NULL/);
  assert.match(all, /ALTER TABLE report_photo ADD COLUMN slot_verified TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.match(all, /CREATE INDEX ix_report_photo_publish_due ON report_photo \(publish_state, next_attempt_at\)/);
  assert.match(all, /CREATE TABLE IF NOT EXISTS report_photo_blob/);
  assert.match(all, /CREATE TABLE IF NOT EXISTS report_local_state/);
});

test('MySQL: повторный вызов ensurePhotoSchema идемпотентен — второй проход не повторяет ALTER/CREATE INDEX', async () => {
  const pool = makeStatefulFakeMysqlPool();
  const store = createReportsStore({ pool, dbType: 'mysql' });

  await store.ensurePhotoSchema();
  const firstPassAlterCount = pool.statements.filter((s) => /^ALTER TABLE report_photo ADD COLUMN/.test(s)).length;
  assert.ok(firstPassAlterCount > 0, 'первый проход реально добавляет недостающие колонки');

  pool.statements.length = 0; // очищаем лог перед вторым проходом, состояние columns/indexes сохраняется
  await store.ensurePhotoSchema(); // не должно бросать на «уже смигрированной» базе

  const repeatedAlters = pool.statements.filter((s) => /^ALTER TABLE report_photo ADD COLUMN/.test(s));
  const repeatedIndexes = pool.statements.filter((s) => /^CREATE INDEX ix_report_photo_publish_due/.test(s));
  assert.equal(repeatedAlters.length, 0,
    'второй проход не должен пытаться добавить уже существующие колонки — на реальном MySQL это ER_DUP_FIELDNAME (Duplicate column)');
  assert.equal(repeatedIndexes.length, 0,
    'второй проход не должен пытаться создать уже существующий индекс — на реальном MySQL это ER_DUP_KEYNAME (Duplicate key name)');
});
