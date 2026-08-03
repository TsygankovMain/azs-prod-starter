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
// публикация независимы по конструкции photoQueueStore.js).
//
// ВЫДЕЛЕННЫЙ КЛИЕНТ, А НЕ pool.query() (раунд правок 1, Critical — ревью
// нашло на живой базе). pg_try_advisory_lock — лок УРОВНЯ СЕССИИ конкретного
// соединения, а не отдельного запроса. pool.query() у обычного
// многосоединенческого pg.Pool (в проде — 10 соединений по умолчанию,
// server.js:107, размер там не переопределён) на КАЖДЫЙ вызов может отдать
// ДРУГОЕ физическое соединение — ревьюер поднял настоящий Postgres 17 и
// сконструировал pool ровно как server.js, без искусственных допущений:
//   - пул простаивает без посторонней нагрузки -> все проверки случайно
//     попадают на одно и то же соединение, лок держится (ложное ощущение,
//     что всё работает);
//   - тот же пул плюс четыре параллельных чужих запроса (обычный прод, где
//     пул общий на всё приложение) -> 5 тиков из 8 отдали locked=false, хотя
//     лок физически держало СОБСТВЕННОЕ простаивающее соединение того же
//     процесса — просто проверка ушла на другое соединение пула. Воркер сам
//     себя разжаловал, публикация встала бы молча;
//   - простаивающее соединение, которое pool успел переработать -> лок
//     снялся сам, никто не уведомлён, и второй, полностью независимый pool
//     взял тот же лок немедленно. Два лидера.
// Двойной публикации это, скорее всего, не даёт (SKIP LOCKED + аренда в
// photoQueueStore поделят бэклог), но лок в этом задании существует РАДИ
// ДРУГОЙ гарантии — не дать двум экземплярам поднять по своему ограничителю
// темпа в памяти и удвоить нагрузку на портал, который и так дважды ронял
// смены из-за перегруза. Гарантия "ровно один ведущий" держится, только если
// "я держу лок" и "моё физическое соединение живо" — один и тот же факт, а
// не два разных, которые pool.query() умеет незаметно развести.
//
// Поэтому: pool.connect() вызывается ОДИН раз (лениво, на первом tick()),
// клиент удерживается в замыкании и переиспользуется на КАЖДОЙ последующей
// проверке — pool.query() в этом файле для лока больше не используется
// вовсе. На событии 'error' у клиента (обрыв соединения) ссылка обнуляется,
// клиент возвращается пулу С ошибкой (pg: .release(err) просит пул уничтожить
// это соединение, а не отдать его следующему запросу сомнительным), и
// следующий tick() переподключается заново — лок при обрыве соединения и так
// снимается сам на стороне Postgres, вручную его снимать при обрыве не нужно.
// stop() — единственное место, где лок снимается ЯВНО (см. releaseClient
// ниже): если к моменту остановки этот процесс был лидером, stop() зовёт
// pg_advisory_unlock и только потом отдаёт клиента обратно в pool.
//
// ОБЯЗАННОСТЬ ВЫЗЫВАЮЩЕГО КОДА (раунд правок 2 — ревью попросило
// задокументировать здесь, а не только в проводке server.js): выделенный
// клиент чек-аутнут из pool на ВСЮ жизнь процесса воркера (см. ensureClient
// ниже) и возвращается пулу ТОЛЬКО через releaseClient(), которую вызывает
// stop(). pg.Pool.end() дожидается возврата ВСЕХ чек-аутнутых клиентов,
// прежде чем завершиться — вызов pool.end() БЕЗ ПРЕДВАРИТЕЛЬНОГО
// await worker.stop() подвесит pool.end() НАВСЕГДА, потому что клиент этого
// воркера никогда не будет возвращён сам по себе. Порядок при остановке
// процесса ОБЯЗАН быть: await worker.stop() (снимает лок, отдаёт клиента) ->
// и только потом pool.end() (или закрытие всего pool, если оно общее на всё
// приложение).
//
// ПЕРЕЗАХВАТ ЛОКА НА КАЖДОМ tick() — то, чего здесь БОЛЬШЕ НЕТ (раунд правок
// 2, Blocker, доказано ревью на живом Postgres 17): pg_try_advisory_lock —
// СЧЁТЧИК держаний сессии, а не флаг; сессия, уже держащая лок, при повторном
// pg_try_advisory_lock того же ключа получает locked=true немедленно и
// увеличивает свой счётчик, а снять лок для других сессий требует РОВНО
// СТОЛЬКО ЖЕ pg_advisory_unlock. Прежняя версия перепроверяла лидерство
// заново на каждом tick() тем же клиентом ("самовосстановление" — но
// самовосстанавливаться там было не от чего, кроме обрыва соединения, а он и
// так детектится событием 'error'), из-за чего воркер, проживший N тиков
// лидером, копил N держаний, а releaseClient() снимал только одно — лок
// оставался висеть после stop() у ЛЮБОГО воркера, прожившего больше одного
// тика лидером (то есть у любого реального воркера в проде). Сейчас
// tryBecomeLeader() ниже перезахватывает лок ТОЛЬКО если ещё не лидер —
// пока сессия жива, лок при ней и без повторных запросов; releaseClient()
// дополнительно снимает в цикле (защита в глубину, см. там же), а не одним
// вызовом.
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
//   - код есть в дорезолвленном списке -> публикуем как обычно (сам столбец
//     slot_verified при этом НЕ обновляется отдельным запросом — метода на
//     это store не даёт, а после публикации строка покидает 'accepted' и
//     больше никем не читается по slot_verified; если публикация временно
//     не удастся и задача вернётся в reschedule, следующая попытка резолвит
//     слот заново — дёшево, кэш почти всегда тёплый, и то же самое верно
//     для уже ОПУБЛИКОВАННЫХ строк: их slot_verified тоже навсегда
//     останется FALSE в БД. Безвредно — эта колонка больше не читается
//     никем, кроме claimBatch, а published-строки claimBatch не выбирает —
//     но при ручном осмотре таблицы может сбить с толку, отсюда эта заметка);
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
// расход токена на один настоящий HTTP-вызов). Этот файл, впрочем, НЕ отдаёт
// её вызывать по разу на каждое фото пачки вслепую — см. resolveRequiredPhotoCodesShared
// ниже (минорная заметка ревью, раунд правок 1): несколько фото ОДНОГО отчёта
// со slot_verified=false в одной пачке иначе независимо резолвили бы список
// параллельно, до трёх одновременных походов в Битрикс на холодный кэш одной
// АЗС — тот же класс "стада", что createSettingsCache в photoPublisher.js уже
// решает для настроек.
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
// и не войдёт в requiredCodes В МОМЕНТ ЭТОГО ЖЕ резолва. Правки reportsRoutes.js
// это не требует — файл в этой задаче не трогаем.
//
// ДРЕЙФ МЕЖДУ ИСТОЧНИКАМИ (раунд правок 1, Important — ревью). Предыдущий
// абзац верен только про ОДИН и тот же резолв. Но воркер и POST /:id/submit
// читают список требуемых кодов из РАЗНЫХ источников с разным моментом
// актуальности: воркер — живой (resolveRequiredPhotoCodes: кэш с TTL или
// прямо Битрикс), submit — зафиксированный снепшот в
// report_local_state.required_photo_codes, который обновляется только при
// открытии карточки отчёта (см. reportsRoutes.js, resolveRequiredPhotoSlotLocally).
// Если состав обязательных фото у АЗС сменится МЕЖДУ "воркер дорезолвил
// список" и "оператор переоткрыл карточку" (или даже без изменений в
// Битриксе — просто из-за повтора: slot_verified в БД после успешной
// проверки не обновляется отдельным запросом, следующая попытка резолвит
// слот заново, см. заметку выше), код, которого не было в списке воркера,
// может оказаться в списке submit — и тогда помеченная здесь строка
// (markFailed/not_required) тихо засчитается как загруженная у submit,
// маскируя реально недостающий слот. persistResolvedCodes ниже закрывает
// дрейф ПО КОНСТРУКЦИИ, а не по вероятности: после каждого успешного резолва
// актуальный список пишется обратно в report_local_state тем же приёмом,
// что и открытие карточки (reportsStore.setRequiredPhotoCodes) — так оба
// потребителя (воркер и следующий submit) сходятся на одном и том же
// свежем снепшоте. Best-effort и опционально (reportsStore может быть не
// передан): ошибка здесь не имеет права остановить публикацию — тот же
// принцип, что и у backfill в самой resolveRequiredPhotoSlotLocally
// (.catch(() => {})).
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
 * @param {object} deps.pool — что угодно с connect(): Promise<client>, где client — { query(sql, params), on('error', fn), release([err]) }. ИМЕННО connect(), не query() — см. заголовочный комментарий про session-affinity advisory-лока (раунд правок 1, Critical)
 * @param {number} [deps.workers] — размер пачки claimBatch за один tick; по умолчанию 3
 * @param {number[]} [deps.backoffMs] — паузы reschedule по номеру попытки
 * @param {number} [deps.maxAttempts] — после этого числа попыток -> markFailed вместо reschedule
 * @param {number} [deps.pollIntervalMs] — интервал setInterval в start()
 * @param {Function} [deps.resolveRequiredPhotoCodes] — (task) => Promise<string[]>; нужна ТОЛЬКО для задач со slot_verified=false (см. блок комментариев выше)
 * @param {object} [deps.reportsStore] — { setRequiredPhotoCodes({ reportId, codes }) }; локальная БД (не Битрикс). После каждого успешного resolveRequiredPhotoCodes актуальный список пишется сюда же, чтобы POST /:id/submit не сверялся с устаревшим снепшотом (раунд правок 1, Important). Опционален — без него backfill просто не происходит, поведение публикации не меняется
 * @param {Function} [deps.syncCrmIfComplete] — (reportId, task) => Promise<any>; зовётся после КАЖДОГО успешного markPublished, best-effort (ошибка не отменяет уже состоявшуюся публикацию). task — второй, необязательный для реализации аргумент, на случай если вызывающему нужен более широкий контекст, чем голый id
 * @param {Function} [deps.now] — инжектируемые часы (мс), как в crmSyncWorker.js; по умолчанию Date.now
 * @param {object} [deps.logger] — по умолчанию console; используется только .error()
 * @param {Function} [deps.setIntervalFn] — инъекция таймера для start(), как now/sleep в shared/rateLimiter.js; по умолчанию глобальный setInterval. Тестам это даёт детерминированный, управляемый вручную "таймер" вместо гонки с реальными миллисекундами (см. tests/photoPublishWorker.test.js — тесты на start/stop не спят по-настоящему)
 * @param {Function} [deps.clearIntervalFn] — парная инъекция для stop(); по умолчанию глобальный clearInterval
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
  reportsStore = null,
  syncCrmIfComplete = null,
  now = () => Date.now(),
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) => {
  if (!store) throw new Error('store is required');
  if (typeof publishOne !== 'function') throw new Error('publishOne must be a function');
  if (!limiter || typeof limiter.acquire !== 'function' || typeof limiter.penalize !== 'function') {
    throw new Error('limiter with acquire()/penalize() is required');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('pool with connect() is required (advisory lock needs one dedicated, session-pinned client — see header comment)');
  }
  if (!(Number(workers) >= 1)) throw new Error('workers must be at least 1');

  let leader = false;
  let timer = null;
  let ticking = false;

  // -------------------------------------------------------------------------
  // Advisory-лок: один выделенный клиент на весь процесс воркера (см.
  // заголовочный комментарий файла — Critical, раунд правок 1).
  // -------------------------------------------------------------------------
  let client = null;
  let connecting = null;
  const releasedClients = new WeakSet();

  const safeRelease = (target, err) => {
    if (!target || releasedClients.has(target)) return;
    releasedClients.add(target);
    if (typeof target.release !== 'function') return;
    try {
      target.release(err);
    } catch (releaseError) {
      // Настоящий pg.PoolClient.release() не бросает — защита на случай
      // самодельного клиента (тесты/будущая обёртка).
      logger.error('photo_publish_advisory_lock_release_error', { message: toErrorMessage(releaseError) });
    }
  };

  // Роняем СВОЮ ссылку и возвращаем клиента пулу С ошибкой: pg трактует
  // .release(err) как "уничтожь это соединение, не отдавай его следующему
  // запросу" — клиент, на котором что-то пошло не так, не должен молча
  // вернуться в пул под видом здорового (это и есть Опыт D ревьюера —
  // переработанное соединение с молча снятым локом).
  //
  // ВАЖНО: client === broken — проверка идентичности, а не формальность
  // (раунд правок 2, гэп покрытия, найденный ревью). Один и тот же реальный
  // обрыв соединения иногда порождает событие 'error' ДВАЖДЫ — если бы эта
  // функция безусловно обнуляла client/leader, запоздавшее ВТОРОЕ событие от
  // УЖЕ отброшенного клиента затёрло бы ссылку на клиента, который к этому
  // моменту успел смениться на новый, здоровый (переподключение уже
  // произошло) — воркер ошибочно "потерял" бы лидерство, которое реально
  // держит. leader сбрасывается ТОЛЬКО вместе с client и ТОЛЬКО когда
  // broken — это именно текущий активный клиент, а не устаревшая ссылка.
  const dropClient = (broken, error) => {
    if (client === broken) {
      client = null;
      leader = false;
    }
    safeRelease(broken, error || new Error('photo_publish_advisory_lock_client_dropped'));
  };

  // pool.connect() — один раз (лениво, на первом tick(), см. JSDoc pool
  // выше), с дедупликацией конкурентных вызовов через connecting: без неё
  // два одновременных tick() (в теории — прямой вызов worker.tick() дважды
  // без ожидания) породили бы два клиента, и один навсегда "утёк" бы из
  // пула, оставшись висеть checked-out.
  const ensureClient = async () => {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const newClient = await pool.connect();
      newClient.on('error', (error) => {
        // Обрыв сессии = обрыв соединения = лок снимается сам на стороне
        // Postgres (см. заголовочный комментарий). Обнуляем ссылку и
        // отдаём клиента пулу с ошибкой, чтобы СЛЕДУЮЩИЙ tick()
        // переподключился на новом соединении, а не бился в мёртвый сокет.
        logger.error('photo_publish_advisory_lock_client_error', { message: toErrorMessage(error) });
        dropClient(newClient, error);
      });
      client = newClient;
      return newClient;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  // РАУНД ПРАВОК 2 (Blocker, доказано ревью на живом Postgres 17):
  // pg_try_advisory_lock — СЧЁТЧИК держаний на сессию, а не флаг. Одна и та
  // же сессия (наш выделенный клиент) может успешно вызвать
  // pg_try_advisory_lock один и тот же ключ сколько угодно раз подряд —
  // каждый такой вызов на сессии, УЖЕ держащей лок, немедленно успешен и
  // увеличивает внутренний счётчик держаний этой сессии. Чтобы лок стал
  // доступен ДРУГИМ сессиям, требуется РОВНО СТОЛЬКО ЖЕ pg_advisory_unlock.
  // Раньше эта функция безусловно перезахватывала лок на КАЖДОМ tick() —
  // ровно то, что предыдущий заголовочный комментарий называл "перепроверять
  // каждый tick, не кэшировать" — и воркер, проживший N тиков лидером,
  // копил N держаний на своей сессии; releaseClient() снимал только одно.
  // Прожил 5 тиков, снял 1 — лок фактически остаётся висеть на уже
  // отданной пулу сессии до её физического закрытия. Воспроизведено
  // ревьюером на настоящей базе (5 тиков -> лок удержан после stop()).
  //
  // Фикс — НЕ перезахватывать лок повторно, если УЖЕ лидер: Postgres хранит
  // advisory-лок как атрибут СЕССИИ (не отдельного запроса) — если сессия
  // жива, лок при ней и без повторных вызовов. Единственный способ
  // ПОТЕРЯТЬ session-level advisory-лок без явного pg_advisory_unlock —
  // гибель самой сессии/соединения (обрыв, pg_terminate_backend, рестарт
  // Postgres), а это ровно тот случай, который уже детектит событие 'error'
  // на клиенте (см. ensureClient/dropClient выше) — leader сбрасывается
  // именно там, синхронно с обнулением client, а не только на следующем
  // tick(). Другого пути потерять лок БЕЗ потери соединения в Postgres нет:
  // снять чужой session-level лок нельзя ничем, кроме обрыва самой сессии
  // (что наш клиент узнал бы через 'error') или явного pg_advisory_unlock С
  // ЭТОЙ ЖЕ сессии — а таких вызовов мы нигде не делаем, кроме releaseClient
  // при остановке.
  //
  // becomingLeaderPromise дедуплицирует КОНКУРЕНТНЫЕ попытки стать лидером
  // (например, два прямых worker.tick() без ожидания — гвард ticking в
  // start() защищает только вызовы из планировщика между собой, не прямые):
  // без этой дедупликации два конкурентных tick(), заставших leader===false
  // ОБА до того, как первый успеет присвоить результат, отправили бы ДВА
  // pg_try_advisory_lock с одной и той же сессии — оба успешны (сессия
  // реентерабельна сама к себе), и счётчик снова стал бы больше 1 даже с
  // этим фиксом.
  let becomingLeaderPromise = null;

  const tryBecomeLeader = async () => {
    if (leader) return true;
    if (becomingLeaderPromise) return becomingLeaderPromise;

    becomingLeaderPromise = (async () => {
      let activeClient;
      try {
        activeClient = await ensureClient();
      } catch (error) {
        logger.error('photo_publish_advisory_lock_connect_error', { message: toErrorMessage(error) });
        return false;
      }
      try {
        const result = await activeClient.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
        return Boolean(result?.rows?.[0]?.locked);
      } catch (error) {
        logger.error('photo_publish_advisory_lock_query_error', { message: toErrorMessage(error) });
        dropClient(activeClient, error);
        return false;
      }
    })();

    try {
      return await becomingLeaderPromise;
    } finally {
      becomingLeaderPromise = null;
    }
  };

  // stop() — единственное место, где лок снимается ЯВНО. Снимаем ТОЛЬКО
  // если на момент остановки реально были лидером (иначе pg_advisory_unlock
  // на чужом локе — бессмысленный вызов и вводящий в заблуждение лог).
  // Клиент возвращается пулу без ошибки — это штатное завершение работы,
  // а не обрыв.
  //
  // Снятие — ЦИКЛОМ, пока pg_advisory_unlock не ответит "нечего снимать"
  // (false), а не одним вызовом (раунд правок 2, защита в глубину поверх
  // основного фикса выше). Основной фикс (не перезахватывать, если уже
  // лидер) держит счётчик этой сессии не выше 1 в любой нормальный момент,
  // поэтому цикл в норме отработает 0 или 1 раз — это НЕ замена основному
  // фиксу, а недорогая страховка на случай будущего бага, который снова
  // раздует счётчик: тогда releaseClient всё равно снимет лок ПОЛНОСТЬЮ, а
  // не оставит его частично висеть. Верхняя граница — защита от
  // бесконечного цикла при по-настоящему сломанном сервере, а не ожидаемый
  // рабочий путь.
  const MAX_UNLOCK_ATTEMPTS = 1000;

  const releaseClient = async () => {
    const toRelease = client;
    client = null;
    if (!toRelease) return;
    try {
      if (leader) {
        for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const result = await toRelease.query('SELECT pg_advisory_unlock($1) AS released', [ADVISORY_LOCK_KEY]);
          if (!result?.rows?.[0]?.released) break;
        }
      }
    } catch (error) {
      logger.error('photo_publish_advisory_unlock_error', { message: toErrorMessage(error) });
    } finally {
      leader = false;
      safeRelease(toRelease);
    }
  };

  // -------------------------------------------------------------------------
  // Отложенная проверка слота (см. заголовочный комментарий файла).
  // -------------------------------------------------------------------------

  // Раунд правок 1 (Important): дорезолвленный список пишется обратно в
  // report_local_state тем же приёмом, что и открытие карточки отчёта —
  // закрывает дрейф между "живым" списком воркера и "снепшотом" submit'а
  // по конструкции (полное обоснование — заголовочный комментарий файла).
  // Best-effort и опционально: reportsStore может быть не передан, ошибка
  // здесь никогда не должна отменять уже состоявшийся резолв.
  const persistResolvedCodes = async (task, requiredCodes) => {
    if (!reportsStore || typeof reportsStore.setRequiredPhotoCodes !== 'function') return;
    try {
      await reportsStore.setRequiredPhotoCodes({
        reportId: task.report_id,
        codes: Array.isArray(requiredCodes) ? requiredCodes : []
      });
    } catch (error) {
      logger.error('photo_publish_slot_codes_backfill_failed', {
        id: task.id,
        reportId: task.report_id,
        message: toErrorMessage(error)
      });
    }
  };

  // Минорная заметка ревью (раунд правок 1): дедупликация КОНКУРЕНТНЫХ
  // резолвов одного report_id внутри уже идущей пачки — тот же приём
  // (Map + finally-очистка), что createSettingsCache в photoPublisher.js
  // использует для settingsStore.read(), но БЕЗ TTL-половины: результат
  // не кэшируется здесь на будущее, только конкурентные вызовы, заставшие
  // уже идущий резолв ЭТОГО report_id, делят один и тот же промис вместо
  // каждый-своего похода в Битрикс. Долгоживущее кэширование — забота
  // инъецированной resolveRequiredPhotoCodes (или того, что она оборачивает).
  const inFlightResolves = new Map();
  const resolveRequiredPhotoCodesShared = async (task) => {
    const key = task.report_id;
    const existing = inFlightResolves.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await resolveRequiredPhotoCodes(task);
      } finally {
        if (inFlightResolves.get(key) === promise) inFlightResolves.delete(key);
      }
    })();
    inFlightResolves.set(key, promise);
    return promise;
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
      requiredCodes = await resolveRequiredPhotoCodesShared(task);
    } catch (error) {
      logger.error('photo_publish_slot_resolve_failed', {
        id: task.id,
        reportId: task.report_id,
        photoCode: task.photo_code,
        message: toErrorMessage(error)
      });
      return 'unresolved';
    }

    await persistResolvedCodes(task, requiredCodes);

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
      // или маскировать это назад в "failed"/"rescheduled". Лог —
      // photo_publish_crm_sync_enqueue_failed — специфичен намеренно (раунд
      // правок 1, M8): внешний try/catch в цикле tick() тоже поймал бы это
      // падение, но под общим ключом photo_publish_apply_outcome_failed —
      // менее полезным для диагностики именно CRM-шага.
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

  // inFlightTicks — раунд правок 2, второй механизм той же поломки: гвард
  // ticking в start() защищает только срабатывания ПЛАНИРОВЩИКА друг от
  // друга, но никак не координируется со stop(), вызванным СНАРУЖИ. Сигнал
  // остановки ровно в момент, когда tick() уже взял лидерство (или ещё
  // только берёт), раньше приводил к тому, что releaseClient() срабатывал
  // ДО завершения tick() — клиент мог быть отдан пулу (или лок снят не тем
  // состоянием leader), пока сам tick() ещё работает с ним же. Теперь
  // каждый tick() регистрирует свой промис здесь, а stop() ниже дожидается
  // ВСЕХ зарегистрированных тиков, прежде чем звать releaseClient().
  const inFlightTicks = new Set();

  const tick = async () => {
    const run = (async () => {
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
    })();

    inFlightTicks.add(run);
    try {
      return await run;
    } finally {
      inFlightTicks.delete(run);
    }
  };

  const start = () => {
    if (timer) return;
    timer = setIntervalFn(() => {
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
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  // async: обязана дождаться и летящего tick() (inFlightTicks — раунд
  // правок 2, см. выше), и releaseClient() (снятие лока при лидерстве +
  // возврат клиента пулу) ПРЕЖДЕ чем считаться завершённой. Порядок важен:
  // сначала снимаем таймер (чтобы не стартовал ещё один tick, пока мы
  // ждём), потом дожидаемся уже летящих, и только затем освобождаем
  // клиента — иначе при graceful shutdown ровно в момент тика клиент мог
  // быть отдан пулу (или лок снят при не финальном leader) раньше, чем
  // tick() успевал с ним доработать.
  const stop = async () => {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (inFlightTicks.size > 0) {
      // allSettled, не all: свой собственный сбой tick() (например,
      // store.claimBatch бросил) не имеет права помешать stop() дождаться
      // остальных летящих тиков и всё равно освободить клиента.
      await Promise.allSettled([...inFlightTicks]);
    }
    await releaseClient();
  };

  return {
    tick,
    start,
    stop,
    isLeader: () => leader
  };
};

export default createPhotoPublishWorker;
