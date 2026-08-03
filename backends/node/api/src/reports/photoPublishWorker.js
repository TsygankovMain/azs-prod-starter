// Воркер публикации фото: забирает принятые фото из очереди
// (photoQueueStore.js) и публикует их в Битрикс через уже готовый
// photoPublisher.publishOne, под общим ограничителем темпа портала
// (shared/rateLimiter.js). Последнее звено цепочки приём -> очередь ->
// публикация -> перевод отчёта в CRM (photoPublishCompletion.js).
//
// Чистая DI-функция без прямых обращений к Битриксу/БД помимо того, что дают
// инъецированные store/publishOne/pool/limiter — тот же приём, что и в
// crmSyncWorker.js (store/runSync инъецируются, а не создаются внутри).
//
// ---------------------------------------------------------------------------
// Advisory-лок Postgres — то, чего в проекте ещё не было.
//
// На Timeweb приложение может подняться в нескольких экземплярах. Без лока
// три воркера (workers=3 по умолчанию, см. ниже) на каждом экземпляре стали
// бы 3×M воркерами и M независимыми ограничителями темпа — ограничитель живёт
// в памяти ОДНОГО процесса и физически не видит расход соседнего экземпляра.
// pg_try_advisory_lock даёт ровно одного лидера на всю базу: не-лидер просто
// не публикует (accept фото на уровне HTTP этому не мешает — приём и
// публикация независимы по конструкции photoQueueStore.js). Лок снимается
// сам при обрыве соединения, поэтому смерть лидера не требует ручного
// вмешательства — соответственно, tick() тоже не пытается вручную снимать
// лок в stop().
//
// pg_try_advisory_lock — лок УРОВНЯ СЕССИИ (конкретного соединения), а не
// отдельного запроса. Этот модуль использует pool.query(...) как чёрный ящик,
// ровно так, как задано интерфейсом брифа — он не проверяет и не может
// проверить, что каждый вызов физически попадает на одно и то же соединение.
// Если под pool окажется обычный многосоединенческий pg.Pool, а не выделенный
// клиент, лидерство способно "мигать" между проверками. Это сознательно
// оставлено на совести вызывающего кода (server.js, "проводка" — отдельная
// задача от этой): какой именно pool сюда передать — решение уровня wiring,
// а не этого файла.
//
// Лидерство перепроверяется КАЖДЫЙ tick(), а не кэшируется после первого
// успеха — самовосстановление, если конкретно эта проверка вдруг вернёт
// false (в т.ч. из-за ошибки соединения, которую ниже ловим и трактуем как
// "не лидер", а не роняем весь tick()).
//
// ---------------------------------------------------------------------------
// Отложенная проверка слота (slot_verified=false) — обязанность именно этого
// файла (см. photoQueueStore.js: claimBatch отдаёт slot_verified). Task 5
// принимает фото с slot_verified=false, когда список требуемых фото не
// удалось узнать локально (Битрикс был недоступен) и оставляет проверку "до
// публикации". До ревью Task 6 эту обязанность не исполнял никто: колонка
// заводилась и проставлялась, но не читалась — обещание без исполнителя.
//
// Три исхода, ровно как в задании:
//   - код есть в дорезолвленном списке -> публикуем как обычно;
//   - кода в списке нет -> markFailed с внятной причиной
//     (PHOTO_CODE_NOT_REQUIRED) — байты не теряются, сторож (listStuck) и
//     сам отчёт видят явный отказ, а не молчаливую дыру;
//   - список по-прежнему не резолвится (Битрикс всё ещё недоступен, либо
//     resolveRequiredPhotoCodes не сконфигурирована вовсе) -> НЕ трогаем
//     задачу совсем: ни markFailed, ни reschedule, ни markPublished. Аренда,
//     которую claimBatch уже поставил при claim'е, истечёт сама (см.
//     CLAIM_LEASE_MS в photoQueueStore.js), и задача вернётся в оборот без
//     штрафа по publish_attempts (reschedule() — единственное, что этот
//     счётчик увеличивает). Отказ по неизвестности — ровно та тихая потеря
//     вместо видимого отказа, которую весь план запрещает.
//
// resolveRequiredPhotoCodes — ИНЪЕЦИРУЕМАЯ функция (task) => Promise<string[]>,
// не прямой импорт readRequiredPhotos из reportsRoutes.js. Причина та же, что
// и у publishOne в этом же факторе: readRequiredPhotos требует живой
// bitrixClient + settings + azsId + context, которых у чистого DI-воркера
// (см. тесты — ни одного реального Битрикса) нет и не должно быть. Конкретную
// привязку к Битриксу (bitrixClient/settingsStore/reportsStore.getById для
// azsId) собирает вызывающий код (server.js — отдельная задача от этой), а
// этот модуль остаётся проверяемым без реального Битрикса. Она получает ВЕСЬ
// task (как и publishOne) — этого достаточно, чтобы вызывающий код сам решил,
// что ему нужно (обычно task.report_id).
//
// Не сконфигурирована вовсе -> тот же безопасный исход, что и "не резолвится":
// НЕ публикуем непроверенный слот вслепую только потому, что никто не подал
// резолвер — тишина в конфигурации не должна превращаться в риск двойной
// публикации или дыры в комплекте.
//
// Как и publishOne (см. photoPublisher.js), resolveRequiredPhotoCodes сама
// отвечает за свой проход через ограничитель темпа, если внутри дёргается
// Битрикс — этот файл не оборачивает её лимитером повторно (иначе — двойной
// расход токена на один настоящий HTTP-вызов).
//
// НОВАЯ причина markFailed и инвариант POST /:id/submit: photoQueueStore.js
// (комментарий над markFailed) и reportsRoutes.js (комментарий над
// missingCodes в POST /:id/submit) прямо предупреждают, что расширение
// набора причин markFailed обязано быть сверено с missingCodes. Сверено:
// reportsStore.listPhotos() строит uploadedCodes по ФАКТУ строки report_photo
// и сознательно не выбирает publish_state вовсе (см. reportsStore.js,
// SELECT в listPhotos) — то есть отвечает только на вопрос "есть ли строка
// для этого кода", независимо от того, published она, failed или accepted.
// Код, помеченный здесь как "не обязателен", по определению НИКОГДА не входил
// и не войдёт в requiredCodes (тот самый список, что вернула
// resolveRequiredPhotoCodes) — ни на приёме, ни здесь, ни при пересчёте на
// submit. Его наличие или отсутствие в uploadedCodes не может ни скрыть, ни
// подменить реально недостающий требуемый код: missingCodes = requiredCodes
// minus uploadedCodes, а этого кода в requiredCodes нет ни у одной из трёх
// точек времени. Правки reportsRoutes.js это не требует — файл в этой задаче
// не трогаем.
//
// ---------------------------------------------------------------------------
// Почему обработка пачки построена как
// "Promise.allSettled(map(runTask)) -> затем цикл применения исхода", а не
// try/catch с ПОЛНОЙ обработкой ошибки внутри самой runTask:
//
// Если бы publishOne() перехватывался и сразу же полностью разруливался
// (reschedule/markFailed) ВНУТРИ функции, переданной в .map(), результирующий
// промис для задачи никогда бы не отклонялся — и замена Promise.allSettled на
// Promise.all не сломала бы ни одного теста (нечему отклоняться, значит и
// разница в семантике недостижима). Здесь иначе: publishOne() НЕ
// перехватывается внутри runTask, отклонение долетает до
// Promise.allSettled, и только ПОСЛЕ того как вся пачка "уляжется"
// (settled), цикл применяет исход к каждой задаче — сам цикл оборачивает
// КАЖДУЮ итерацию в собственный try/catch, чтобы падение store-вызова
// (markPublished/reschedule/markFailed) для одной задачи не остановило
// применение исхода для соседних.
import { classifyPublishError } from './photoPublisher.js';
import { PHOTO_CODE_NOT_REQUIRED } from './errorCodes.js';

// Пространство advisory-локов общее на всю базу, поэтому число обязано быть
// уникальным среди всего, что проект когда-либо залочит. Ничего не кодирует —
// просто константа "наш замок".
export const ADVISORY_LOCK_KEY = 776_100_301;

const DEFAULT_WORKERS = 3;
// Дольше клиентских [800, 1600, 3200] намеренно: тот график усиливал давление
// на портал ровно тогда, когда он просил его снизить. Здесь торопиться
// некуда — оператор уже свободен, дедлайн сверяется по operator_completed_at,
// а не по факту публикации.
const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const toErrorMessage = (error) => String(error?.message || error || '');

// slot_verified приходит из БД: Postgres отдаёт настоящий boolean, MySQL
// (TINYINT(1)) — число 0/1 (см. photoQueueStore.js, MySQL claimBatch). Both
// обязаны разбираться одинаково, иначе на MySQL воркер либо публиковал бы
// непроверенные слоты вслепую (0 не распознан как "непроверено"), либо гонял
// бы резолвер на каждую уже проверенную задачу (1 не распознан как
// "проверено"). undefined (форма фикстур из брифа, где slot_verified вообще
// не задаётся) обязан трактоваться как "уже проверено" — ни один тест брифа
// не настраивает резолвер.
const isSlotUnverified = (task) => task.slot_verified === false || task.slot_verified === 0;

const buildNotRequiredError = (task) =>
  `${PHOTO_CODE_NOT_REQUIRED}: код "${task.photo_code}" не входит в дорезолвленный список обязательных фото отчёта #${task.report_id}`;

/**
 * @param {object} deps
 * @param {object} deps.store — createPhotoQueueStore(...) из photoQueueStore.js
 * @param {Function} deps.publishOne — publishOne(task) из createPhotoPublisher(...) (photoPublisher.js); сама берёт токен лимитера на каждое обращение к Битриксу
 * @param {object} deps.limiter — createRateLimiter(...) из shared/rateLimiter.js; ОДИН общий экземпляр на процесс, разделяемый со всем, что ходит в Битрикс
 * @param {object} deps.pool — что угодно с query(sql, params); используется ТОЛЬКО для pg_try_advisory_lock (см. предупреждение про session-affinity выше)
 * @param {number} [deps.workers] — размер пачки claimBatch за один tick; по умолчанию 3
 * @param {number[]} [deps.backoffMs] — паузы reschedule по номеру попытки
 * @param {number} [deps.maxAttempts] — после этого числа попыток -> markFailed вместо reschedule
 * @param {number} [deps.pollIntervalMs] — интервал setInterval в start()
 * @param {Function} [deps.resolveRequiredPhotoCodes] — (task) => Promise<string[]>; нужна ТОЛЬКО для задач со slot_verified=false (см. блок комментариев выше)
 * @param {Function} [deps.syncCrmIfComplete] — (reportId, task) => Promise<any>; зовётся после КАЖДОГО успешного markPublished, best-effort (ошибка не отменяет уже состоявшуюся публикацию). task — второй, необязательный для реализации аргумент, на случай если вызывающему нужен более широкий контекст, чем голый id
 * @param {Function} [deps.now] — инжектируемые часы (мс), как в crmSyncWorker.js; по умолчанию Date.now
 * @param {object} [deps.logger] — по умолчанию console; используется только .error()
 */
export const createPhotoPublishWorker = ({
  store,
  publishOne,
  limiter,
  pool,
  workers = DEFAULT_WORKERS,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  resolveRequiredPhotoCodes = null,
  syncCrmIfComplete = null,
  now = () => Date.now(),
  logger = console
} = {}) => {
  if (!store) throw new Error('store is required');
  if (typeof publishOne !== 'function') throw new Error('publishOne must be a function');
  if (!limiter || typeof limiter.acquire !== 'function' || typeof limiter.penalize !== 'function') {
    throw new Error('limiter with acquire()/penalize() is required');
  }
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('pool with query() is required (advisory lock)');
  }
  if (!(Number(workers) >= 1)) throw new Error('workers must be at least 1');

  let leader = false;
  let timer = null;
  let ticking = false;

  // Перепроверяется каждый tick (см. комментарий про session-affinity выше) —
  // ошибка соединения трактуется как "не лидер", а не роняет весь tick():
  // неопределённость лучше разрешать в пользу "не публикуем", а не наоборот.
  const tryBecomeLeader = async () => {
    try {
      const result = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
      return Boolean(result?.rows?.[0]?.locked);
    } catch (error) {
      logger.error('photo_publish_advisory_lock_error', { message: toErrorMessage(error) });
      return false;
    }
  };

  // 'verified'     — слот уже проверен (обычный случай) ИЛИ только что успешно
  //                   дорезолвлен и код входит в список -> публикуем как обычно.
  // 'not_required'  — список дорезолвлен, кода в нём нет -> markFailed.
  // 'unresolved'    — резолвер не сконфигурирован ИЛИ бросил -> ничего не меняем.
  const resolveSlot = async (task) => {
    if (!isSlotUnverified(task)) return 'verified';
    if (typeof resolveRequiredPhotoCodes !== 'function') return 'unresolved';

    let requiredCodes;
    try {
      requiredCodes = await resolveRequiredPhotoCodes(task);
    } catch (error) {
      logger.error('photo_publish_slot_resolve_failed', {
        id: task.id,
        reportId: task.report_id,
        photoCode: task.photo_code,
        message: toErrorMessage(error)
      });
      return 'unresolved';
    }

    const codes = new Set((Array.isArray(requiredCodes) ? requiredCodes : []).map(String));
    return codes.has(String(task.photo_code)) ? 'verified' : 'not_required';
  };

  // Каждой задаче — свой независимый исход. publishOne() намеренно НЕ
  // перехватывается здесь (см. большой комментарий в шапке файла про
  // Promise.allSettled) — его отклонение обязано долететь до вызывающего
  // Promise.allSettled как отклонение промиса ЭТОЙ задачи.
  const runTask = async (task) => {
    const slotStatus = await resolveSlot(task);
    if (slotStatus === 'unresolved') return { type: 'skip' };
    if (slotStatus === 'not_required') return { type: 'not_required' };
    const result = await publishOne(task);
    return { type: 'published', result };
  };

  const finishPublished = async (task, result) => {
    await store.markPublished({
      id: task.id,
      fileId: result?.fileId,
      fileName: result?.fileName,
      diskFolderId: result?.diskFolderId,
      diskObjectId: result?.diskObjectId
    });
    if (typeof syncCrmIfComplete !== 'function') return;
    try {
      await syncCrmIfComplete(task.report_id, task);
    } catch (error) {
      // Best-effort: перевод в CRM — отдельный факт с отдельным моментом
      // (см. photoPublishCompletion.js). Публикация УЖЕ состоялась и уже
      // записана markPublished() выше — сбой здесь не имеет права откатывать
      // или маскировать это назад в "failed"/"rescheduled".
      logger.error('photo_publish_crm_sync_enqueue_failed', {
        id: task.id,
        reportId: task.report_id,
        message: toErrorMessage(error)
      });
    }
  };

  const handleError = async (task, error) => {
    // Retry-After от портала — это про ВСЕХ, кто делит общий лимитер, а не
    // только про эту задачу: если не сообщить лимитеру, остальные воркеры в
    // пачке (и в других тиках) продолжат долбить портал, который попросил
    // паузу.
    if (error && error.retryAfterMs != null) {
      limiter.penalize(error.retryAfterMs);
    }

    const attempts = Number(task.publish_attempts || 0);
    const permanent = classifyPublishError(error) === 'permanent';
    const errorMessage = toErrorMessage(error);

    if (permanent || attempts + 1 >= maxAttempts) {
      await store.markFailed({ id: task.id, error: errorMessage });
      return;
    }

    const wait = backoffMs[Math.min(attempts, backoffMs.length - 1)];
    await store.reschedule({ id: task.id, nextAttemptAt: new Date(now() + wait), error: errorMessage });
  };

  const applyOutcome = async (task, outcome) => {
    if (outcome.status === 'rejected') {
      await handleError(task, outcome.reason);
      return;
    }
    const { type, result } = outcome.value;
    if (type === 'skip') return; // Grabli 2: список не резолвится -> не трогаем ничего
    if (type === 'not_required') {
      await store.markFailed({ id: task.id, error: buildNotRequiredError(task) });
      return;
    }
    await finishPublished(task, result);
  };

  const tick = async () => {
    leader = await tryBecomeLeader();
    if (!leader) return { leader: false, claimed: 0 };

    const tasks = await store.claimBatch({ limit: workers, now: new Date(now()) });
    if (!tasks.length) return { leader: true, claimed: 0 };

    const settled = await Promise.allSettled(tasks.map(runTask));

    for (let i = 0; i < tasks.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await applyOutcome(tasks[i], settled[i]);
      } catch (error) {
        // Падение самого применения исхода (например, store.markPublished
        // бросил из-за обрыва БД) для одной задачи не должно останавливать
        // применение исхода для соседних — тот же принцип, что и у падения
        // publishOne().
        logger.error('photo_publish_apply_outcome_failed', {
          id: tasks[i]?.id,
          message: toErrorMessage(error)
        });
      }
    }

    return { leader: true, claimed: tasks.length };
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      // Гвард против пересекающихся тиков: если предыдущий tick() всё ещё
      // выполняется (например, ждёт на лимитере), setInterval не должен
      // запускать поверх него ещё один — та самая "бездумная выкачка без
      // пауз", которую этому воркеру явно запрещено воспроизводить
      // (crmSyncWorker.drain() крутит tick() вообще без паузы; здесь пауза
      // есть и по времени (pollIntervalMs), и структурно — тики не копятся).
      if (ticking) return;
      ticking = true;
      tick()
        .catch((error) => logger.error('photo_publish_tick_error', { message: toErrorMessage(error) }))
        .finally(() => { ticking = false; });
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    tick,
    start,
    stop,
    isLeader: () => leader
  };
};

export default createPhotoPublishWorker;
