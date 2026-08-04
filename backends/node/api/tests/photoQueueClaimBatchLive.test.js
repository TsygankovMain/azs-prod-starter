import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPhotoQueueStore, CLAIM_LEASE_MS } from '../src/reports/photoQueueStore.js';
import { createReportsStore } from '../src/reports/reportsStore.js';

// ---------------------------------------------------------------------------
// C1 (финальное ревью ветки, FIX_BASE 8cc9d94) — единственный тест на
// claimBatch, который РЕАЛЬНО его вызывает, на ЖИВОМ Postgres, а не на
// фейковом пуле с regex по тексту SQL.
//
// Почему это обязательно, а не "было бы неплохо": tests/photoQueueStore.test.js
// нарочно проверяет только ФОРМУ SQL (см. заголовок того файла) — а разница
// между «JOIN report_photo_blob внутри CTE due, до LIMIT» и «JOIN только в
// финальном UPDATE, после LIMIT» для regex НЕВИДИМА: обе формы содержат
// подстроку "JOIN report_photo_blob". Десятый декоративный тест, из-за
// которого C1 дожил до финального ревью, был именно там —
// tests/photoQueueStore.test.js:87-95 называется «фото без байтов не
// попадает в очередь, но и не теряется», а claimBatch не вызывает вовсе,
// проверяет только listStuck.
//
// Мутационная защита (координатор, мутационный прогон финального ревью):
// мутация "JOIN -> LEFT JOIN" внутри due проходила БЫ зелёной на одном только
// regex-тесте (LEFT JOIN тоже содержит подстроку "JOIN report_photo_blob").
// Здесь она ловится ПОВЕДЕНЧЕСКИ: с LEFT JOIN строки без байтов снова попадут
// в due и снова займут слот LIMIT — 'здоровые фото без байтов не блокируют
// очередь' ниже перестанет быть true и тест покраснеет.
//
// Требует живой Postgres. Пропускается (не падает), если недоступен — см.
// dbAvailable ниже. Поднять локально (те же переменные и дефолты, что
// server.js и корневой .env.example; DB_HOST по умолчанию 'localhost', а не
// 'database', потому что тест выполняется на хосте, а не в сети
// docker-compose):
//   docker run --rm -d -p 5432:5432 -e POSTGRES_USER=appuser \
//     -e POSTGRES_PASSWORD=apppass -e POSTGRES_DB=appdb postgres:16-alpine
//
// Изоляция: вся схема живёт в ОТДЕЛЬНОЙ Postgres-схеме (пересоздаётся с нуля
// через search_path соединения) — тест никогда не трогает public и безопасен,
// даже если DB_* случайно укажут на не-пустую базу.
// ---------------------------------------------------------------------------

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'appdb',
  user: process.env.DB_USER || 'appuser',
  password: process.env.DB_PASSWORD || 'apppass',
  connectionTimeoutMillis: 2000
};

const TEST_SCHEMA = 'photo_queue_claim_batch_live_test';
const SKIP_REASON = 'живой Postgres недоступен (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) — см. заголовок файла, как поднять';

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

// Top-level await: выполняется ДО регистрации test() ниже — гарантирует
// детерминированный порядок (проба доступности -> подготовка схемы -> тесты),
// независимо от конкурентности рантайма node:test.
const dbAvailable = await probe();
const skip = dbAvailable ? false : SKIP_REASON;

let pool = null;

if (dbAvailable) {
  const rootPool = new pg.Pool(connectionConfig);
  await rootPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await rootPool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await rootPool.end();

  pool = new pg.Pool({ ...connectionConfig, options: `-c search_path=${TEST_SCHEMA},public` });
  // Настоящая ensurePhotoSchema — та же самая функция, что вызывает server.js
  // при старте (reportsStore.js). Схема теста всегда буквально совпадает с
  // прод-схемой, а не с её ручной, могущей отстать копией.
  const schemaStore = createReportsStore({ pool, dbType: 'postgres' });
  await schemaStore.ensurePhotoSchema();
}

const store = pool ? createPhotoQueueStore({ pool, dbType: 'postgres' }) : null;

const resetRows = async () => {
  await pool.query('TRUNCATE report_photo_blob, report_photo RESTART IDENTITY CASCADE');
};

// secondsAgoStart убывает с ростом i — то есть каждая следующая вставленная
// строка "новее" предыдущей в рамках СВОЕЙ группы; offset между группами
// (blobless вызывается с большим secondsAgoStart, чем healthy) гарантирует,
// что дефектные строки старше и оказываются ПЕРВЫМИ в ORDER BY uploaded_at
// ASC — ровно сценарий ревьюера ("дефектная строка в голове очереди").
const seedBlobless = async (n, { secondsAgoStart = 1000 } = {}) => {
  for (let i = 0; i < n; i += 1) {
    await pool.query(
      `INSERT INTO report_photo (report_id, photo_code, publish_state, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'accepted', 1, NOW() - ($3 || ' seconds')::interval)`,
      [90000 + i, `BLOBLESS_${i}`, String(secondsAgoStart - i)]
    );
  }
};

const seedHealthy = async (n, { secondsAgoStart = 500 } = {}) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const inserted = await pool.query(
      `INSERT INTO report_photo (report_id, photo_code, publish_state, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'accepted', 1, NOW() - ($3 || ' seconds')::interval) RETURNING id`,
      [80000 + i, `OK_${i}`, String(secondsAgoStart - i)]
    );
    const id = inserted.rows[0].id;
    await pool.query(
      `INSERT INTO report_photo_blob (report_photo_id, content, mime_type, byte_size, original_name)
       VALUES ($1, $2, 'image/jpeg', 3, 'x.jpg')`,
      [id, Buffer.from('abc')]
    );
    // Number(): pg отдаёт BIGINT как строку по умолчанию — приводим сразу,
    // чтобы сравнение с claimBatch (тоже Number(row.id) на вызывающей
    // стороне) не спотыкалось о string-vs-number или о лексикографическую
    // сортировку многозначных id ("10" < "9" строками).
    ids.push(Number(id));
  }
  return ids;
};

// ---------------------------------------------------------------------------
// Основная находка C1: N дефектных строк ВПЕРЕДИ очереди не мешают здоровым
// строкам ПОЗАДИ них быть забранными — ни при каком N относительно LIMIT.
// Таблица ниже повторяет ровно то, что измерил ревьюер на живом Postgres 16.
// ---------------------------------------------------------------------------
for (const bloblessCount of [0, 1, 2, 3, 5]) {
  test(`claimBatch: ${bloblessCount} строк без байтов впереди очереди не блокируют 3 здоровых фото позади (LIMIT 3)`, { skip }, async () => {
    await resetRows();
    await seedBlobless(bloblessCount);
    const healthyIds = await seedHealthy(3);

    const rows = await store.claimBatch({ limit: 3, now: new Date() });

    assert.equal(rows.length, 3,
      `ожидалось 3 здоровых фото забрано за тик независимо от ${bloblessCount} дефектных строк впереди — ` +
      'до фикса C1 это было 3,2,1,0,0 соответственно (0 при bloblessCount>=3, очередь стоит навсегда)');
    const returnedIds = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    assert.deepEqual(returnedIds, [...healthyIds].sort((a, b) => a - b),
      'обязаны быть забраны именно здоровые строки, а не что-то ещё');
    for (const row of rows) {
      assert.ok(Buffer.isBuffer(row.content) && row.content.length > 0, 'claimBatch обязан отдавать байты вместе с задачей');
    }
  });
}

test('claimBatch: дефектные строки остаются в 5 тиков подряд — очередь НЕ саморазблокируется без фикса (регрессия C1 "навсегда")', { skip }, async () => {
  await resetRows();
  await seedBlobless(3);
  await seedHealthy(3);

  const claimedPerTick = [];
  for (let tick = 0; tick < 5; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await store.claimBatch({ limit: 3, now: new Date() });
    claimedPerTick.push(rows.length);
    if (rows.length > 0) break; // здоровые нашлись — дальше можно не тикать
  }
  assert.ok(claimedPerTick.some((n) => n === 3), `здоровые фото обязаны найтись хотя бы на одном из тиков: ${JSON.stringify(claimedPerTick)}`);
});

// ---------------------------------------------------------------------------
// Координатор, мутационный прогон финального ревью: "снятие аренды в
// claimBatch — сдвига next_attempt_at на пять минут — проходит зелёным.
// Теста нет вовсе." Без аренды взятая строка немедленно снова готова к
// взятию -> двойная публикация. Тест ниже вызывает claimBatch дважды подряд
// и проверяет, что второй вызов НЕ перезабирает те же строки, плюс проверяет
// САМ next_attempt_at напрямую в базе.
// ---------------------------------------------------------------------------
test('claimBatch: аренда — next_attempt_at сдвигается вперёд, иммедиатный повторный вызов не перезабирает те же строки (двойная публикация)', { skip }, async () => {
  await resetRows();
  const before = new Date();
  await seedHealthy(3);

  const first = await store.claimBatch({ limit: 3, now: before });
  assert.equal(first.length, 3, 'тест бессмыслен, если первый тик не забрал все три строки');

  // Иммедиатный повторный вызов той же секундой — без аренды претендовал бы
  // на ТЕ ЖЕ строки снова (публикация ещё не завершилась, publish_state
  // всё ещё 'accepted').
  const second = await store.claimBatch({ limit: 3, now: before });
  assert.equal(second.length, 0, 'без аренды это были бы ТЕ ЖЕ строки — двойная публикация одного и того же фото');

  const { rows } = await pool.query('SELECT id, next_attempt_at FROM report_photo ORDER BY id');
  for (const row of rows) {
    const leaseMs = new Date(row.next_attempt_at).getTime() - before.getTime();
    assert.ok(
      Math.abs(leaseMs - CLAIM_LEASE_MS) < 2000,
      `next_attempt_at обязан быть сдвинут примерно на CLAIM_LEASE_MS (${CLAIM_LEASE_MS} мс) от момента claim, получили сдвиг ${leaseMs} мс`
    );
  }

  // После истечения аренды строка обязана снова стать доступной — иначе это
  // была бы уже не аренда, а случайная потеря строки навсегда.
  const afterLease = new Date(before.getTime() + CLAIM_LEASE_MS + 1000);
  const third = await store.claimBatch({ limit: 3, now: afterLease });
  assert.equal(third.length, 3, 'после истечения аренды строки обязаны снова стать доступны для claim');
});

// ---------------------------------------------------------------------------
// Конкурентная защита (Task 4/7 гарантия) не должна была пострадать от
// переноса FOR UPDATE SKIP LOCKED на FOR UPDATE OF rp SKIP LOCKED.
// ---------------------------------------------------------------------------
test('claimBatch: два конкурентных вызова не забирают одну и ту же строку (FOR UPDATE OF rp SKIP LOCKED)', { skip }, async () => {
  await resetRows();
  const ids = await seedHealthy(6);

  const [a, b] = await Promise.all([
    store.claimBatch({ limit: 3, now: new Date() }),
    store.claimBatch({ limit: 3, now: new Date() })
  ]);

  const idsA = a.map((r) => Number(r.id));
  const idsB = b.map((r) => Number(r.id));
  const overlap = idsA.filter((id) => idsB.includes(id));

  assert.equal(overlap.length, 0, 'ни одна строка не должна быть забрана дважды двумя конкурентными вызовами');
  assert.equal(idsA.length + idsB.length, ids.length, 'все 6 строк должны разойтись между двумя вызовами без потерь');
});

// ---------------------------------------------------------------------------
// Минор (раунд правок 2, финальное ревью ветки) — countPendingByState()
// заменил countByState() в периодическом логе глубины очереди именно
// потому, что последний без reportId сканирует ВСЮ таблицу report_photo
// (ни один из двух существующих частичных индексов не обслуживает запрос
// без предиката). Ниже — не только корректность результата, но и EXPLAIN
// на живом Postgres: запрос обязан использовать Index Scan/Bitmap Index Scan
// по ix_report_photo_stuck, а НЕ Seq Scan.
// ---------------------------------------------------------------------------

test('countPendingByState: считает только НЕ-published строки, published не искажает результат', { skip }, async () => {
  await resetRows();
  // 5 строк за один вызов seedHealthy (она не поддерживает накопление между
  // вызовами в одном тесте — report_id/photo_code внутри неё всегда
  // начинаются с одного и того же смещения, повторный вызов после первого
  // столкнётся по уникальному индексу (report_id, photo_code)).
  await seedHealthy(5);
  const claimed = await store.claimBatch({ limit: 3, now: new Date() });
  assert.equal(claimed.length, 3, 'тест бессмыслен, если не забрали ровно 3 из 5');
  for (const row of claimed) {
    await pool.query(`UPDATE report_photo SET publish_state = 'published' WHERE id = $1`, [row.id]);
  }
  // Оставшиеся 2 строки из тех же 5 так и не были claimBatch'нуты — остались 'accepted'.

  const counts = await store.countPendingByState();
  assert.deepEqual(counts, { accepted: 2 }, 'published не должен попасть в результат вовсе (не 0 — отсутствующий ключ)');
});

test('countPendingByState: EXPLAIN подтверждает использование ix_report_photo_stuck при РЕАЛИСТИЧНОМ распределении (много published, мало pending)', { skip }, async () => {
  await resetRows();
  // Реалистичное распределение — вот что именно чинит этот минор: таблица,
  // где подавляющее большинство строк УЖЕ published (не удаляются никогда,
  // растут без предела — см. комментарий над countPendingByState в
  // photoQueueStore.js), и лишь единицы pending в любой момент времени. При
  // 100% pending (как было бы, если засеять только accepted-строки) Seq Scan
  // ЗАКОНОМЕРНО дешевле индекса — читать почти всё равно пришлось бы читать
  // почти всю таблицу. Именно раздутый published и делает индекс выгодным.
  const PUBLISHED_COUNT = 2000;
  const PENDING_COUNT = 5;
  for (let batch = 0; batch < PUBLISHED_COUNT / 100; batch += 1) {
    const values = [];
    const params = [];
    for (let i = 0; i < 100; i += 1) {
      const n = batch * 100 + i;
      values.push(`($${params.length + 1}, $${params.length + 2}, 'published', 1)`);
      params.push(90000 + n, `PUB_${n}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO report_photo (report_id, photo_code, publish_state, uploaded_by) VALUES ${values.join(', ')}`,
      params
    );
  }
  await seedHealthy(PENDING_COUNT);

  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM report_photo');
  assert.equal(countRows[0].n, PUBLISHED_COUNT + PENDING_COUNT, 'тест бессмыслен, если распределение не установилось как задумано');

  await pool.query('ANALYZE report_photo'); // планировщик должен знать актуальную статистику, не только что вставленную

  const { rows } = await pool.query(
    `EXPLAIN SELECT publish_state, COUNT(*) AS count FROM report_photo WHERE publish_state <> 'published' GROUP BY publish_state`
  );
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.doesNotMatch(plan, /Seq Scan on report_photo/,
    `при ${PUBLISHED_COUNT} published и ${PENDING_COUNT} pending планировщик обязан выбрать индекс ix_report_photo_stuck, а не читать всю таблицу. План:\n${plan}`);
});
