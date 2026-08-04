import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoQueueStore, CLAIM_LEASE_MS, MIN_RECLAIM_STALE_MS } from '../src/reports/photoQueueStore.js';

// ---------------------------------------------------------------------------
// PostgreSQL: минимальный фейк pg.Pool — запоминает SQL и параметры, отдаёт
// заранее заготовленные ответы по порядку вызовов. Тесты ниже проверяют форму
// SQL (regex) — быстро, без инфраструктуры, но СЛЕПО к семантике (порядок
// операций, реальный результат JOIN/LIMIT). C1 (финальное ревью ветки) было
// именно такой слепотой: JOIN стоял ПОСЛЕ LIMIT вместо ДО, а форма
// "JOIN report_photo_blob где-то в тексте" была неотличима от правильной —
// строки без байтов останавливали publikацию всего парка навсегда, и все
// тесты здесь были зелёными. claimBatch — единственный метод, где этот файл
// теперь СОЗНАТЕЛЬНО дублируется на форме SQL (порядок JOIN/LIMIT, SET-часть
// UPDATE) — это быстрый companion, а не замена поведенческой проверке:
// см. tests/photoQueueClaimBatchLive.test.js — тот файл вызывает claimBatch
// по-настоящему, на живом Postgres, и именно он решает, чинит ли SQL C1.
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

test('claimBatch берёт задачи через SKIP LOCKED (только report_photo, C1) — два экземпляра не возьмут одну', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1 }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 3, now: new Date(0) });
  const sql = pool.calls[0].sql;
  // OF rp — C1: лочим только report_photo, а не и report_photo_blob заодно
  // (теперь в CTE due участвуют обе таблицы через JOIN).
  assert.match(sql, /FOR UPDATE OF rp SKIP LOCKED/);
  assert.match(sql, /publish_state = 'accepted'/);
});

test('claimBatch отдаёт байты вместе с задачей — воркер не делает второй запрос', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 1, now: new Date(0) });
  assert.match(pool.calls[0].sql, /JOIN report_photo_blob/);
});

// ---------------------------------------------------------------------------
// C1 (финальное ревью ветки) — регрессионный тест на САМ ДЕФЕКТ, а не только
// на его симптом. Поведенческое доказательство (реальный Postgres, реальные
// строки без байтов) живёт в tests/photoQueueClaimBatchLive.test.js — оно
// единственное по-настоящему решает вопрос "чинит ли этот SQL C1". Тест ниже
// — быстрый, синхронный companion на форму SQL, нужен по отдельной причине:
// координатор мутационного прогона финального ревью нашёл, что мутация
// "JOIN -> LEFT JOIN" внутри due проходит ЗЕЛЁНОЙ на исходном regex-тесте
// выше (":36", `/JOIN report_photo_blob/`) — LEFT JOIN тоже содержит эту
// подстроку. Ниже — ИМЕННО то различение, которого не хватало.
// ---------------------------------------------------------------------------
test('claimBatch: JOIN на report_photo_blob стоит ВНУТРИ CTE due, ДО LIMIT — не только в финальном UPDATE (C1)', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 3, now: new Date(0) });
  const sql = pool.calls[0].sql;

  // C1 дословно: до фикса JOIN стоял ТОЛЬКО в финальном UPDATE, ПОСЛЕ LIMIT —
  // строка без байтов всё равно занимала слот окна выборки due и вымывалась
  // только из РЕЗУЛЬТАТА, но не из окна (см. заголовочный комментарий
  // claimBatch в photoQueueStore.js). "JOIN где-то в тексте" эту разницу не
  // видит — здесь явно проверяется ПОРЯДОК: подстрока ДО первого LIMIT уже
  // обязана содержать JOIN.
  const beforeLimit = sql.slice(0, sql.indexOf('LIMIT'));
  assert.match(beforeLimit, /JOIN report_photo_blob/,
    'JOIN обязан стоять внутри CTE due, ДО LIMIT — иначе дефектная строка без байтов всё равно займёт слот окна выборки и заблокирует здоровые строки позади себя (C1)');

  // Мутационная защита: LEFT JOIN тоже содержит подстроку "JOIN
  // report_photo_blob" и тоже прошёл бы проверку выше (строка без байтов
  // всё ещё попадёт в due, просто с NULL-полями блоба) — то есть заново
  // открыл бы C1. Явно требуем отсутствие LEFT JOIN где бы то ни было в
  // ЭТОМ запросе: единственный уместный здесь JOIN — обычный (INNER), в
  // обоих местах (due и финальный UPDATE).
  assert.doesNotMatch(sql, /LEFT JOIN/,
    'claimBatch не имеет права видеть строки без байтов вообще — LEFT JOIN втащил бы их обратно в due (C1)');
});

test('claimBatch: порядок выборки — сначала САМЫЕ СТАРЫЕ (ORDER BY uploaded_at ASC)', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 3, now: new Date(0) });
  assert.match(pool.calls[0].sql, /ORDER BY rp\.uploaded_at ASC/,
    'DESC отдавал бы недавно принятые фото раньше давно застрявших — противоречит FIFO и усиливает голодание старых строк');
});

// Координатор, мутационный прогон финального ревью: "снятие аренды в
// claimBatch — сдвига next_attempt_at на пять минут — проходит зелёным.
// Теста нет вовсе." Без сдвига next_attempt_at забранная строка немедленно
// снова видна следующему claimBatch — двойная публикация (то, против чего
// построен весь стор). Поведенческое доказательство (реальная база, второй
// вызов сразу за первым не перезабирает те же строки, next_attempt_at
// проверен напрямую) — tests/photoQueueClaimBatchLive.test.js. Здесь —
// быстрый companion на форму SQL: UPDATE обязан реально присваивать
// next_attempt_at новое значение, а не просто содержать эту подстроку
// где-то в тексте (WHERE-условие тоже содержит "next_attempt_at").
test('claimBatch: аренда — UPDATE реально сдвигает next_attempt_at вперёд (SET-часть, не просто присутствие в тексте)', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 3, now: new Date(0) });
  const sql = pool.calls[0].sql;
  const setClause = sql.slice(sql.indexOf('UPDATE report_photo'), sql.indexOf('FROM due'));
  assert.match(setClause, /SET next_attempt_at = \$1 \+ INTERVAL '5 minutes'/,
    'без сдвига next_attempt_at забранная строка немедленно снова готова к claim — двойная публикация');
});

test('claimBatch не берёт задачи, чей срок ещё не наступил', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.claimBatch({ limit: 1, now: new Date(1234) });
  assert.match(pool.calls[0].sql, /rp\.next_attempt_at IS NULL OR rp\.next_attempt_at <= /);
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

// ---------------------------------------------------------------------------
// accept({ slotVerified }) — Task 5 (приём фото без Битрикса) расширяет
// accept() признаком непроверенного слота: список требуемых фото иногда
// неизвестен локально (ни в report_local_state, ни в кэше), и тогда фото всё
// равно принимается, но с slot_verified=false — проверку выполнит воркер
// публикации. Брифом Task 4 этот параметр не задавался (задача написана
// раньше Task 5), поэтому тестов на него в исходном файле не было — добавлены
// здесь вместе с самим параметром.
// ---------------------------------------------------------------------------

test('accept проставляет slot_verified=false явным параметром запроса, когда слот не проверен', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1 }] }, { rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.accept({
    reportId: 1, photoCode: 'FRONT', uploadedBy: 7, exifAt: null,
    content: Buffer.from('x'), mimeType: 'image/jpeg', originalName: null,
    slotVerified: false
  });
  assert.match(pool.calls[0].sql, /slot_verified/,
    'INSERT обязан явно проставлять slot_verified — полагаться на DEFAULT колонки нельзя: ретейк идёт через ON CONFLICT DO UPDATE, а не INSERT');
  assert.deepEqual(pool.calls[0].params, [1, 'FRONT', 7, null, false]);
});

// ---------------------------------------------------------------------------
// Координатор, мутационный прогон финального ревью: две находки на ветку
// ПОВТОРНОЙ загрузки (ON CONFLICT DO UPDATE), обе проходили зелёными без
// теста, который различает "колонка есть в SQL где-то" от "ветка ОБНОВЛЕНИЯ
// её реально переприсваивает":
//   - slot_verified выброшен из ветки обновления — тест ":229" выше
//     проверяет только присутствие подстроки "slot_verified", которая
//     совпадает и со списком колонок INSERT, слепа к самой SET-части UPDATE;
//   - uploaded_at не обновляется при повторной загрузке — теста не было
//     вовсе. От него зависят и порог сторожа (listStuck сравнивает
//     uploaded_at с olderThanMs), и порядок выборки claimBatch (ORDER BY
//     uploaded_at ASC) — переснятое фото без обновления uploaded_at выглядело
//     бы мгновенно застрявшим и уходило бы в конец очереди публикации вместо
//     начала.
// ---------------------------------------------------------------------------
test('accept: ветка ПОВТОРНОЙ загрузки (ON CONFLICT DO UPDATE) реально переприсваивает slot_verified и uploaded_at', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1 }] }, { rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.accept({
    reportId: 1, photoCode: 'FRONT', uploadedBy: 7, exifAt: null,
    content: Buffer.from('x'), mimeType: 'image/jpeg', originalName: null,
    slotVerified: false
  });
  const sql = pool.calls[0].sql;
  const updateBranch = sql.slice(sql.indexOf('DO UPDATE'));

  assert.match(updateBranch, /slot_verified = EXCLUDED\.slot_verified/,
    'ветка ОБНОВЛЕНИЯ обязана переприсваивать slot_verified — иначе повторная загрузка того же кода молча оставит старое значение слота из первой попытки');
  assert.match(updateBranch, /uploaded_at = NOW\(\)/,
    'ветка ОБНОВЛЕНИЯ обязана переприсваивать uploaded_at — от него зависят порог сторожа (listStuck) и порядок claimBatch (ORDER BY uploaded_at ASC); без этого переснятое фото выглядело бы мгновенно застрявшим');
});

test('accept по умолчанию (slotVerified не передан) считает слот проверенным', async () => {
  const pool = makeFakePool([{ rows: [{ id: 2 }] }, { rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.accept({
    reportId: 1, photoCode: 'BACK', uploadedBy: 7, exifAt: null,
    content: Buffer.from('y'), mimeType: 'image/jpeg', originalName: null
  });
  assert.deepEqual(pool.calls[0].params, [1, 'BACK', 7, null, true],
    'дефолт slotVerified=true — самый частый случай, список известен локально');
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
  // Заведомо безопасный порог — выше MIN_RECLAIM_STALE_MS, не только на грани.
  const n = await store.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS + 60_000 });
  assert.equal(n, 2);
  const sql = pool.calls[0].sql;
  assert.match(sql, /publish_state = 'accepted'/);
  assert.match(sql, /updated_at <= /);
});

// ---------------------------------------------------------------------------
// reclaimStale — защита от отбора живой аренды (Раунд правок 1, Important 1).
//
// Единственный маркер, отличающий "давно забытую" строку от "прямо сейчас в
// аренде", — updated_at (своего статуса running у этой очереди по конструкции
// нет). Если staleMs меньше нескольких аренд подряд, только что
// перезапустившийся экземпляр может отобрать аренду у фото, которое в этот
// момент публикует другой живой экземпляр — ровно та двойная публикация,
// против которой построен весь стор. Особо реалистичный сценарий: автор
// будущего воркера копирует STALE_RUNNING_TIMEOUT_MS = 5 минут из
// crmSyncWorker.js — то есть ровно CLAIM_LEASE_MS. Обе проверки ниже —
// именно на этот случай и на границу минимума.
// ---------------------------------------------------------------------------

test('reclaimStale отклоняет порог размером в одну аренду (типичная ошибка копипаста из crmSyncWorker)', async () => {
  // reclaimStale — async: синхронный throw внутри нём превращается в отклонённый
  // промис, а не в исключение, брошенное вызовом напрямую — отсюда assert.rejects,
  // а не assert.throws(() => store.reclaimStale(...)) (последнее не сработает,
  // потому что store.reclaimStale(...) сам по себе не бросает, а возвращает
  // (уже отклонённый) промис).
  const pool = makeFakePool([{ rowCount: 0 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await assert.rejects(
    store.reclaimStale({ staleMs: CLAIM_LEASE_MS }),
    RangeError,
    'staleMs в размер одной аренды — самая опасная и самая вероятная ошибка вызывающего'
  );
});

test('reclaimStale отклоняет промис и не делает запрос к БД при опасно малом staleMs', async () => {
  const pool = makeFakePool([{ rowCount: 0 }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await assert.rejects(store.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS - 1 }));
  assert.equal(pool.calls.length, 0, 'нельзя даже пытаться выполнить запрос с небезопасным порогом');
});

test('reclaimStale — граница: ровно MIN_RECLAIM_STALE_MS проходит, на 1мс меньше — нет', async () => {
  const okPool = makeFakePool([{ rowCount: 0 }]);
  const okStore = createPhotoQueueStore({ pool: okPool, dbType: 'postgres' });
  await assert.doesNotReject(okStore.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS }));

  const badPool = makeFakePool([{ rowCount: 0 }]);
  const badStore = createPhotoQueueStore({ pool: badPool, dbType: 'postgres' });
  await assert.rejects(badStore.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS - 1 }));
});

// ---------------------------------------------------------------------------
// C4 (финальное ревью ветки) — рычаг возврата из publish_state='failed'.
// Поведенческое доказательство (реальная база, реально забуксовавший потом
// снова взятый claimBatch'ем ряд) — tests/photoQueueRecoverFailedLive.test.js.
// Здесь — форма SQL и обязательная избирательность.
// ---------------------------------------------------------------------------

test('recoverFailed({reportId}): переводит failed обратно в accepted, сбрасывает попытки и next_attempt_at, только для этого отчёта', async () => {
  const pool = makeFakePool([{ rows: [{ id: 1, report_id: 501, photo_code: 'FRONT' }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const rows = await store.recoverFailed({ reportId: 501 });
  assert.deepEqual(rows, [{ id: 1, report_id: 501, photo_code: 'FRONT' }]);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /publish_state = 'failed'/, 'обязан трогать ТОЛЬКО failed-строки, не любые незавершённые');
  assert.match(sql, /publish_state = 'accepted'/);
  assert.match(sql, /publish_attempts = 0/,
    'без сброса первая же попытка после возврата немедленно уткнётся в maxAttempts и уйдёт обратно в failed');
  assert.match(sql, /next_attempt_at = NULL/);
  assert.match(sql, /report_id = \$1/);
  assert.doesNotMatch(sql, /uploaded_at/, 'uploaded_at не трогаем — иначе застрявшая повторно строка не попадёт под критерий возраста сторожа');
  assert.deepEqual(params, [501]);
});

test('recoverFailed({ids}): избирательный список строк, может охватывать несколько отчётов', async () => {
  const pool = makeFakePool([{ rows: [{ id: 7, report_id: 1 }, { id: 9, report_id: 2 }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const rows = await store.recoverFailed({ ids: [7, 9] });
  assert.equal(rows.length, 2);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /id = ANY\(\$1::bigint\[\]\)/);
  assert.match(sql, /publish_state = 'failed'/);
  assert.deepEqual(params, [[7, 9]]);
});

test('recoverFailed: и reportId, и ids одновременно — бросает, не делает запрос (неоднозначный вызов)', async () => {
  const pool = makeFakePool();
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await assert.rejects(store.recoverFailed({ reportId: 1, ids: [2, 3] }), RangeError);
  assert.equal(pool.calls.length, 0);
});

test('recoverFailed: ни reportId, ни ids — бросает, не делает запрос (глобальный возврат без выбора запрещён)', async () => {
  const pool = makeFakePool();
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await assert.rejects(store.recoverFailed({}), RangeError);
  await assert.rejects(store.recoverFailed(), RangeError);
  await assert.rejects(store.recoverFailed({ ids: [] }), RangeError, 'пустой список ids — тоже отсутствие выбора');
  assert.equal(pool.calls.length, 0);
});

test('recoverFailed: некорректные значения в ids/reportId отклоняются до запроса', async () => {
  const pool = makeFakePool();
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await assert.rejects(store.recoverFailed({ reportId: -5 }), RangeError);
  await assert.rejects(store.recoverFailed({ reportId: 'abc' }), RangeError);
  await assert.rejects(store.recoverFailed({ ids: [1, -2, 3] }), RangeError);
  await assert.rejects(store.recoverFailed({ ids: ['x'] }), RangeError);
  assert.equal(pool.calls.length, 0);
});

test('countByState группирует фото по состоянию публикации', async () => {
  const pool = makeFakePool([{ rows: [{ publish_state: 'accepted', count: '3' }, { publish_state: 'published', count: '40' }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const counts = await store.countByState();
  assert.deepEqual(counts, { accepted: 3, published: 40 });
  assert.match(pool.calls[0].sql, /GROUP BY publish_state/);
  assert.doesNotMatch(pool.calls[0].sql, /WHERE/, 'без reportId — глобальная сводка, без фильтра');
  assert.deepEqual(pool.calls[0].params, [], 'без reportId — без параметров');
});

// Task 8: syncReportToCrmIfComplete (photoPublishCompletion.js) обязан
// проверять комплект ОДНОГО отчёта, а не всей таблицы — иначе "40 из 40
// published" у одного отчёта ложно засчитает завершённость чужому.
test('countByState({reportId}) считает только фото этого отчёта', async () => {
  const pool = makeFakePool([{ rows: [{ publish_state: 'published', count: '2' }] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const counts = await store.countByState({ reportId: 501 });
  assert.deepEqual(counts, { published: 2 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE report_id = \$1/);
  assert.match(sql, /GROUP BY publish_state/);
  assert.deepEqual(params, [501]);
});

// ---------------------------------------------------------------------------
// Минор (раунд правок 2, финальное ревью ветки, подтверждено живьём) —
// countByState() без reportId сканирует ВСЮ таблицу (оба существующих
// индекса частичные, ни один не обслуживает запрос без предиката). Метод
// специально под periodic-лог глубины очереди (photoPublishBoot.js):
// считает только НЕ-published строки — тот же предикат, что уже есть у
// ix_report_photo_stuck, планировщик способен использовать индекс.
// ---------------------------------------------------------------------------

test('countPendingByState фильтрует publish_state <> \'published\' — под индекс ix_report_photo_stuck, без полного скана', async () => {
  const pool = makeFakePool([{ rows: [
    { publish_state: 'accepted', count: '3' },
    { publish_state: 'failed', count: '1' }
  ] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const counts = await store.countPendingByState();
  assert.deepEqual(counts, { accepted: 3, failed: 1 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /publish_state <> 'published'/,
    'обязан фильтровать по тому же предикату, что и ix_report_photo_stuck — иначе снова полный скан');
  assert.match(sql, /GROUP BY publish_state/);
  assert.ok(!params || params.length === 0, 'countPendingByState не принимает reportId — это глобальный диагностический счётчик, без параметров запроса');
});

test('countPendingByState никогда не запрашивает published напрямую (WHERE, а не фильтрация в JS)', async () => {
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.countPendingByState();
  assert.doesNotMatch(pool.calls[0].sql, /publish_state = 'published'/,
    'фильтрация обязана быть в самом SQL (WHERE), не постфактум в JS — иначе строки published всё равно читаются с диска');
});

// Важно 3 (раунд правок 1): агрегат (countByState) недостаточен для проверки
// комплекта отчёта построчно — количество может совпасть, а конкретные коды
// не совпасть (лишний код на непроверенном слоте; сменившийся состав
// обязательных кодов при том же их числе). photoPublishCompletion.js
// обязан сверять КОНКРЕТНЫЕ коды, для чего и нужен построчный список.
test('listPhotoStates({reportId}) отдаёт коды с их publish_state построчно', async () => {
  const pool = makeFakePool([{ rows: [
    { photo_code: '1', publish_state: 'published' },
    { photo_code: '2', publish_state: 'accepted' }
  ] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  const states = await store.listPhotoStates({ reportId: 501 });
  assert.deepEqual(states, [
    { photoCode: '1', publishState: 'published' },
    { photoCode: '2', publishState: 'accepted' }
  ]);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE report_id = \$1/);
  assert.match(sql, /photo_code/);
  assert.match(sql, /publish_state/);
  assert.deepEqual(params, [501]);
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

test("listStuck показывает 'failed' сразу, не дожидаясь olderThanMs (Раунд правок 1, Important 2)", async () => {
  // markFailed ставится только на окончательные ошибки (квота Диска, удалённая
  // папка, нет прав) — это уже точно сломано, а не "ещё ретраится". Ждать
  // olderThanMs (типично часы), чтобы сторож заметил заведомо мёртвую строку,
  // не нужно — то же исключение, что уже сделано для строк без байтов.
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.listStuck({ olderThanMs: 999_999_999, limit: 10 });
  assert.match(
    pool.calls[0].sql,
    /b\.report_photo_id IS NULL OR rp\.publish_state = 'failed' OR rp\.uploaded_at <= /,
    "'failed' обязан быть в том же OR, что и отсутствие байтов, а не только за порогом возраста"
  );
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
  // Мутационная защита (координатор, финальный мутационный прогон): та же
  // находка, что и в PostgreSQL-варианте выше — "JOIN где-то в тексте" не
  // отличает обычный JOIN от LEFT JOIN. Здесь JOIN уже стоит в выборке
  // кандидатов ДО LIMIT (в отличие от исходного PostgreSQL-дефекта C1), но
  // LEFT JOIN пропустил бы строки без байтов дальше по цепочке точно так же.
  assert.doesNotMatch(pool.calls[0].sql, /LEFT JOIN/,
    'кандидатом на claim не имеет права стать строка без байтов — LEFT JOIN пропустил бы её в выборку');
  assert.match(pool.calls[0].sql, /ORDER BY rp\.uploaded_at ASC/,
    'DESC отдавал бы недавно принятые фото раньше давно застрявших — противоречит FIFO');
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
  // Координатор, мутационный прогон: аренда — тот же per-row UPDATE обязан
  // реально сдвигать next_attempt_at вперёд, не только перепроверять его в
  // WHERE. Без этого забранная строка немедленно снова видна следующему
  // claimBatch (двойная публикация).
  assert.match(pool.calls[2].sql, /SET next_attempt_at = DATE_ADD\(\?, INTERVAL 5 MINUTE\)/,
    'без сдвига next_attempt_at забранная строка немедленно снова готова к claim — двойная публикация');

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

test('MySQL: accept передаёт slot_verified=0 явным параметром, когда слот не проверен', async () => {
  const pool = makeFakeMysqlPool([[{ insertId: 78 }], [{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.accept({
    reportId: 3, photoCode: 'BACK', uploadedBy: 2, exifAt: null,
    content: Buffer.from('bytes'), mimeType: 'image/png', originalName: null,
    slotVerified: false
  });
  assert.match(pool.calls[0].sql, /slot_verified/);
  assert.deepEqual(pool.calls[0].params, [3, 'BACK', 2, null, 0],
    'MySQL BOOLEAN — алиас TINYINT(1): false обязан попасть в параметры как 0, а не как JS false');

  // Координатор, мутационный прогон: та же находка, что и в PostgreSQL-
  // варианте — "slot_verified где-то в SQL" совпадает и со списком колонок
  // INSERT, слепа к ветке ОБНОВЛЕНИЯ (ON DUPLICATE KEY UPDATE). Явно
  // проверяем именно её, плюс uploaded_at (порог сторожа, порядок claimBatch).
  const updateBranch = pool.calls[0].sql.slice(pool.calls[0].sql.indexOf('ON DUPLICATE KEY UPDATE'));
  assert.match(updateBranch, /slot_verified = VALUES\(slot_verified\)/,
    'ветка ОБНОВЛЕНИЯ обязана переприсваивать slot_verified — иначе повторная загрузка молча оставит старое значение слота');
  assert.match(updateBranch, /uploaded_at = CURRENT_TIMESTAMP/,
    'ветка ОБНОВЛЕНИЯ обязана переприсваивать uploaded_at — иначе переснятое фото выглядело бы мгновенно застрявшим');
});

test('MySQL: accept по умолчанию (slotVerified не передан) считает слот проверенным', async () => {
  const pool = makeFakeMysqlPool([[{ insertId: 79 }], [{ affectedRows: 1 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.accept({
    reportId: 3, photoCode: 'FRONT', uploadedBy: 2, exifAt: null,
    content: Buffer.from('bytes'), mimeType: 'image/png', originalName: null
  });
  assert.deepEqual(pool.calls[0].params, [3, 'FRONT', 2, null, 1]);
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
  // Заведомо безопасный порог — см. PostgreSQL-версию этого теста и
  // блок про MIN_RECLAIM_STALE_MS выше по файлу.
  const n = await store.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS + 60_000 });
  assert.equal(n, 3);
  assert.match(pool.calls[0].sql, /publish_state = 'accepted'/);
});

test('MySQL: reclaimStale отклоняет порог размером в одну аренду и не делает запрос к БД', async () => {
  const pool = makeFakeMysqlPool([[{ affectedRows: 0 }]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await assert.rejects(
    store.reclaimStale({ staleMs: CLAIM_LEASE_MS }),
    RangeError,
    'staleMs в размер одной аренды — та же ошибка, что и в PostgreSQL-варианте'
  );
  assert.equal(pool.calls.length, 0);
});

test('MySQL: reclaimStale — граница: ровно MIN_RECLAIM_STALE_MS проходит, на 1мс меньше — нет', async () => {
  const okPool = makeFakeMysqlPool([[{ affectedRows: 0 }]]);
  const okStore = createPhotoQueueStore({ pool: okPool, dbType: 'mysql' });
  await assert.doesNotReject(okStore.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS }));

  const badPool = makeFakeMysqlPool([[{ affectedRows: 0 }]]);
  const badStore = createPhotoQueueStore({ pool: badPool, dbType: 'mysql' });
  await assert.rejects(badStore.reclaimStale({ staleMs: MIN_RECLAIM_STALE_MS - 1 }));
});

// ---------------------------------------------------------------------------
// C4 — MySQL: тот же контракт, три запроса (кандидаты -> UPDATE -> финальный
// SELECT), тот же приём, что и у MySQL-версии claimBatch.
// ---------------------------------------------------------------------------

test('MySQL: recoverFailed({reportId}) — кандидаты, UPDATE, финальный SELECT, в этом порядке', async () => {
  const pool = makeFakeMysqlPool([
    [[{ id: 5 }, { id: 6 }]],                 // кандидаты (failed, этот отчёт)
    [{ affectedRows: 2 }],                    // UPDATE
    [[{ id: 5, report_id: 501, photo_code: 'A' }, { id: 6, report_id: 501, photo_code: 'B' }]] // финальный SELECT
  ]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const rows = await store.recoverFailed({ reportId: 501 });
  assert.equal(rows.length, 2);

  assert.match(pool.calls[0].sql, /publish_state = 'failed'/);
  assert.match(pool.calls[0].sql, /report_id = \?/);

  assert.match(pool.calls[1].sql, /publish_state = 'accepted'/);
  assert.match(pool.calls[1].sql, /publish_attempts = 0/);
  assert.match(pool.calls[1].sql, /next_attempt_at = NULL/);
  assert.match(pool.calls[1].sql, /WHERE id IN \(\?, \?\)/);
  assert.match(pool.calls[1].sql, /AND publish_state = 'failed'/,
    'UPDATE обязан перепроверять publish_state=failed — защита от гонки с конкурентным изменением между SELECT и UPDATE');
  assert.deepEqual(pool.calls[1].params, [5, 6]);
});

test('MySQL: recoverFailed — пустая выборка кандидатов не порождает лишние UPDATE/SELECT', async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const rows = await store.recoverFailed({ reportId: 501 });
  assert.deepEqual(rows, []);
  assert.equal(pool.calls.length, 1);
});

test('MySQL: recoverFailed — и reportId, и ids одновременно, или ни одного — бросает, не делает запрос', async () => {
  const pool = makeFakeMysqlPool();
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await assert.rejects(store.recoverFailed({ reportId: 1, ids: [2] }), RangeError);
  await assert.rejects(store.recoverFailed({}), RangeError);
  assert.equal(pool.calls.length, 0);
});

test('MySQL: countByState группирует по состоянию', async () => {
  const pool = makeFakeMysqlPool([[[{ publish_state: 'failed', count: 2 }]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const counts = await store.countByState();
  assert.deepEqual(counts, { failed: 2 });
  assert.doesNotMatch(pool.calls[0].sql, /WHERE/, 'без reportId — глобальная сводка, без фильтра');
});

test('MySQL: countByState({reportId}) считает только фото этого отчёта', async () => {
  const pool = makeFakeMysqlPool([[[{ publish_state: 'published', count: 2 }]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const counts = await store.countByState({ reportId: 501 });
  assert.deepEqual(counts, { published: 2 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE report_id = \?/);
  assert.deepEqual(params, [501]);
});

test('MySQL: countPendingByState фильтрует publish_state <> \'published\'', async () => {
  const pool = makeFakeMysqlPool([[[
    { publish_state: 'accepted', count: 3 },
    { publish_state: 'failed', count: 1 }
  ]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const counts = await store.countPendingByState();
  assert.deepEqual(counts, { accepted: 3, failed: 1 });
  assert.match(pool.calls[0].sql, /publish_state <> 'published'/);
  assert.match(pool.calls[0].sql, /GROUP BY publish_state/);
});

test('MySQL: listPhotoStates({reportId}) отдаёт коды с их publish_state построчно', async () => {
  const pool = makeFakeMysqlPool([[[
    { photo_code: '1', publish_state: 'published' },
    { photo_code: '2', publish_state: 'accepted' }
  ]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  const states = await store.listPhotoStates({ reportId: 501 });
  assert.deepEqual(states, [
    { photoCode: '1', publishState: 'published' },
    { photoCode: '2', publishState: 'accepted' }
  ]);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE report_id = \?/);
  assert.deepEqual(params, [501]);
});

test('MySQL: listStuck использует LEFT JOIN — фото без байтов не теряется', async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.listStuck({ olderThanMs: 0, limit: 10 });
  assert.match(pool.calls[0].sql, /LEFT JOIN report_photo_blob/);
});

test("MySQL: listStuck показывает 'failed' сразу, не дожидаясь olderThanMs", async () => {
  const pool = makeFakeMysqlPool([[[]]]);
  const store = createPhotoQueueStore({ pool, dbType: 'mysql' });
  await store.listStuck({ olderThanMs: 999_999_999, limit: 10 });
  assert.match(
    pool.calls[0].sql,
    /b\.report_photo_id IS NULL OR rp\.publish_state = 'failed' OR rp\.uploaded_at <= /
  );
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
