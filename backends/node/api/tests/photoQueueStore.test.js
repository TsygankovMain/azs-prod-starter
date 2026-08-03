import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoQueueStore } from '../src/reports/photoQueueStore.js';

// ---------------------------------------------------------------------------
// PostgreSQL: минимальный фейк pg.Pool — запоминает SQL и параметры, отдаёт
// заранее заготовленные ответы по порядку вызовов. Тесты ниже проверяют форму
// SQL (regex), а не эмулируют реальную базу — так же, как в брифе: мутации,
// которые обязаны ловиться этим файлом, все ломают именно текст SQL.
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

test('claimBatch берёт задачи через SKIP LOCKED — два экземпляра не возьмут одну', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1 }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 3, now: new Date(0) });
  const sql = pool.calls[0].sql;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /publish_state = 'accepted'/);
});

test('claimBatch отдаёт байты вместе с задачей — воркер не делает второй запрос', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 1, now: new Date(0) });
  assert.match(pool.calls[0].sql, /JOIN report_photo_blob/);
});

test('claimBatch не берёт задачи, чей срок ещё не наступил', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 1, now: new Date(1234) });
  assert.match(pool.calls[0].sql, /next_attempt_at IS NULL OR next_attempt_at <= /);
});

test('markPublished проставляет published_at и не трогает байты', async () => {
  const pool = makeFakePool([{ rowCount: 1 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.markPublished({ id: 5, fileId: 11, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'published'/);
  assert.match(sql, /published_at = NOW\(\)/);
  assert.doesNotMatch(sql, /DELETE FROM report_photo_blob/,
    'байты удаляет отдельная очистка через N дней, а не публикация');
  // MUTATION-GAP (проверено мутацией на этапе разработки, не догадка): проверка
  // одного только pool.calls[0].sql слепа к DELETE, дописанному ВТОРЫМ,
  // отдельным вызовом pool.query после update — ровно так выглядела бы
  // случайная регрессия («заодно почистим блоб»). Явно фиксируем, что вызов
  // ровно один, и что ни в одном из вызовов нет DELETE — это ловит оба вида
  // мутации (правку того же выражения и добавление отдельного запроса).
  assert.equal(pool.calls.length, 1, 'markPublished не должен делать второй запрос к БД');
  assert.ok(
    pool.calls.every((c) => !/DELETE FROM report_photo_blob/.test(c.sql)),
    'байты удаляет отдельная очистка через N дней, а не публикация'
  );
});

test('reschedule увеличивает счётчик попыток и оставляет фото в очереди', async () => {
  const pool = makeFakePool([{ rowCount: 1 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.reschedule({ id: 5, nextAttemptAt: new Date(9), error: 'boom' });
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_attempts = publish_attempts \+ 1/);
  assert.match(sql, /publish_state = 'accepted'/);
});

test('purgePublishedBlobs чистит только опубликованные и только старые', async () => {
  const pool = makeFakePool([{ rowCount: 4 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const removed = await store.purgePublishedBlobs({ olderThanMs: 7 * 24 * 3600 * 1000 });
  assert.equal(removed, 4);
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'published'/);
  assert.match(sql, /published_at </);
});

test('фото без байтов не попадает в очередь, но и не теряется', async () => {
  // claimBatch не возвращает такую строку (JOIN её отбрасывает),
  // а listStuck — возвращает, чтобы сторож о ней сообщил
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.listStuck({ olderThanMs: 0, limit: 10 });
  assert.match(pool.calls[0].sql, /LEFT JOIN report_photo_blob/,
    'сторож обязан видеть фото, у которого пропали байты');
});

// ---------------------------------------------------------------------------
// Дополнительные тесты PostgreSQL — брифом не продиктованы дословно (в нём нет
// готового текста для accept/markFailed/reclaimStale/countByState и полного
// listStuck), но методы часть продюсируемого интерфейса и должны быть
// реализованы и проверены так же строго.
// ---------------------------------------------------------------------------

test('accept вставляет фото в состоянии accepted и байты вместе с ним, возвращает id', async () => {
  const pool = makeFakePool([{ rows: [{ id: 42 }] }, { rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const content = Buffer.from('hello-jpeg-bytes');
  const { id } = await store.accept({
    reportId: 1,
    photoCode: 'FRONT',
    uploadedBy: 7,
    exifAt: new Date(100),
    content,
    mimeType: 'image/jpeg',
    originalName: 'a.jpg'
  });
  assert.equal(id, 42);
  assert.equal(pool.calls.length, 2);

  const photoSql = pool.calls[0].sql;
  assert.match(photoSql, /INSERT INTO report_photo/);
  assert.match(photoSql, /'accepted'/);
  assert.match(photoSql, /ON CONFLICT\s*\(report_id, photo_code\)/);

  const blobSql = pool.calls[1].sql;
  assert.match(blobSql, /INSERT INTO report_photo_blob/);
  assert.match(blobSql, /ON CONFLICT\s*\(report_photo_id\)/);
  assert.deepEqual(pool.calls[1].params, [42, content, 'image/jpeg', Buffer.byteLength(content), 'a.jpg']);
});

test('accept на повторной загрузке того же кода сбрасывает счётчик попыток и ошибку', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1 }] }, { rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.accept({
    reportId: 1, photoCode: 'FRONT', uploadedBy: 7, exifAt: null,
    content: Buffer.from('x'), mimeType: 'image/jpeg', originalName: null
  });
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_attempts = 0/, 'ретейк — новая попытка публикации, а не продолжение старой серии');
  assert.match(sql, /last_publish_error = NULL/);
  assert.match(sql, /next_attempt_at = NULL/);
});

test('markFailed переводит фото в failed и запоминает ошибку', async () => {
  const pool = makeFakePool([{ rowCount: 1 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.markFailed({ id: 9, error: 'портал недоступен' });
  const sql = pool.calls[0].sql;
  const params = pool.calls[0].params;
  assert.match(sql, /publish_state = 'failed'/);
  assert.match(sql, /last_publish_error = \$1/);
  assert.deepEqual(params, ['портал недоступен', 9]);
});

test('reclaimStale возвращает число вернувшихся в оборот строк', async () => {
  const pool = makeFakePool([{ rowCount: 2 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const n = await store.reclaimStale({ staleMs: 10 * 60 * 1000 });
  assert.equal(n, 2);
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'accepted'/);
  assert.match(sql, /updated_at <= /);
});

test('countByState группирует фото по состоянию публикации', async () => {
  const pool = makeFakePool([{ rows: [{ publish_state: 'accepted', count: '3' }, { publish_state: 'published', count: '40' }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const counts = await store.countByState();
  assert.deepEqual(counts, { accepted: 3, published: 40 });
  assert.match(pool.calls[0].sql, /GROUP BY publish_state/);
});

test('listStuck отбирает не опубликованные фото старше порога, лимитируя выборку', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.listStuck({ olderThanMs: 3600_000, limit: 5 });
  const sql = pool.calls[0].sql;
  const params = pool.calls[0].params;
  assert.match(sql, /publish_state <> 'published'/);
  assert.match(sql, /LIMIT \$2/);
  assert.equal(params[1], 5);
});

// ---------------------------------------------------------------------------
// MySQL: фейк mysql2/promise-пула в том же духе — записывает вызовы execute(),
// отдаёт канонические ответы по порядку. Формат ответа — [rows] для SELECT,
// [result] для INSERT/UPDATE/DELETE, как у настоящего mysql2.
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

test('MySQL: claimBatch запрашивает кандидатов JOIN’ом на байты и ничего не обновляет, если пусто', async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const rows = await store.claimBatch({ limit: 3, now: new Date(0) });
  assert.deepEqual(rows, []);
  assert.equal(pool.calls.length, 1, 'пустая выборка кандидатов не должна порождать лишние UPDATE/SELECT');
  assert.match(pool.calls[0].sql, /JOIN report_photo_blob/);
  assert.match(pool.calls[0].sql, /publish_state = 'accepted'/);
});

test('MySQL: claimBatch пропускает фото, которое увёл конкурентный воркер (affectedRows=0) — двойного взятия нет', async () => {
  const pool = makeFakeMysqlPool([
    [[{ id: 10 }, { id: 20 }]],           // кандидаты
    [{ affectedRows: 0 }],                // update id=10 — кто-то забрал раньше
    [{ affectedRows: 1 }],                // update id=20 — мы успели первыми
    [[{ id: 20, report_id: 1, photo_code: 'FRONT', publish_attempts: 0, exif_at: null, slot_verified: 1, content: Buffer.from('x'), mime_type: 'image/jpeg', original_name: 'x.jpg' }]]
  ]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const rows = await store.claimBatch({ limit: 2, now: new Date(0) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 20);

  // Второй update (за id=20) обязан по-прежнему перепроверять due-условие —
  // без транзакции это единственное, что не даёт забрать фото дважды.
  assert.match(pool.calls[2].sql, /publish_state = 'accepted'/);
  assert.match(pool.calls[2].sql, /next_attempt_at IS NULL OR next_attempt_at <= /);

  const finalSelectParams = pool.calls[3].params;
  assert.deepEqual(finalSelectParams, [20], 'в финальный SELECT должен попасть только реально забранный id');
});

test('MySQL: accept возвращает id и на INSERT, и на конфликт по (report_id, photo_code)', async () => {
  const pool = makeFakeMysqlPool([[{ insertId: 77 }], [{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const content = Buffer.from('bytes');
  const { id } = await store.accept({
    reportId: 3, photoCode: 'BACK', uploadedBy: 2, exifAt: new Date(500),
    content, mimeType: 'image/png', originalName: 'b.png'
  });
  assert.equal(id, 77);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(pool.calls[0].sql, /id = LAST_INSERT_ID\(id\)/,
    'без этого трюка insertId будет 0 на ветке обновления, а не вставки');
  assert.match(pool.calls[1].sql, /INSERT INTO report_photo_blob/);
});

test('MySQL: markPublished не трогает байты', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.markPublished({ id: 5, fileId: 11, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'published'/);
  assert.doesNotMatch(sql, /DELETE FROM report_photo_blob/);
  // См. комментарий у PG-версии этого теста: один запрос, и ни в одном из
  // вызовов нет DELETE — иначе проверка слепа ко второму, отдельному вызову.
  assert.equal(pool.calls.length, 1, 'markPublished не должен делать второй запрос к БД');
  assert.ok(pool.calls.every((c) => !/DELETE FROM report_photo_blob/.test(c.sql)));
});

test('MySQL: reschedule увеличивает попытки и оставляет фото в очереди', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.reschedule({ id: 5, nextAttemptAt: new Date(9000), error: 'boom' });
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_attempts = publish_attempts \+ 1/);
  assert.match(sql, /publish_state = 'accepted'/);
});

test('MySQL: markFailed переводит фото в failed', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.markFailed({ id: 9, error: 'timeout' });
  assert.match(pool.calls[0].sql, /publish_state = 'failed'/);
});

test('MySQL: reclaimStale возвращает affectedRows', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 3 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const n = await store.reclaimStale({ staleMs: 60_000 });
  assert.equal(n, 3);
  assert.match(pool.calls[0].sql, /publish_state = 'accepted'/);
});

test('MySQL: countByState группирует по состоянию', async () => {
  const pool = makeFakeMysqlPool([[[{ publish_state: 'failed', count: 2 }]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const counts = await store.countByState();
  assert.deepEqual(counts, { failed: 2 });
});

test('MySQL: listStuck использует LEFT JOIN — фото без байтов не теряется', async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.listStuck({ olderThanMs: 0, limit: 10 });
  assert.match(pool.calls[0].sql, /LEFT JOIN report_photo_blob/);
});

test('MySQL: purgePublishedBlobs чистит только опубликованные и только старые', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 6 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const removed = await store.purgePublishedBlobs({ olderThanMs: 7 * 24 * 3600 * 1000 });
  assert.equal(removed, 6);
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'published'/);
  assert.match(sql, /published_at < /);
});
