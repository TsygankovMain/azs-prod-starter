// Проводка server.js (Task 11) — чистые, DI-функции, решающие "включать ли
// очередь публикации фото при старте процесса" и "как валидировать её
// окружение". Вынесены из server.js в отдельный, импортируемый модуль
// намеренно: server.js нигде не импортируется тестами (весь его верхний
// уровень — живые side-effects: подключение к БД, express.listen()), а
// мутационная проверка обязана бить по НАСТОЯЩЕМУ коду, который реально
// исполняется в проде, а не по его копии, переписанной в теле теста — иначе
// проверка декоративна (в этом проекте это уже случалось восемь раз).
//
// ---------------------------------------------------------------------------
// Защита загрузки (server.js использует эти функции ДО монтирования
// /api/reports и ДО старта воркеров):
//
//   1. isEmbeddedPostgresEnabled — EMBEDDED_POSTGRES читается СТРОГО, а не по
//      truthy-строке. process.env.* всегда строка или undefined; строка
//      'false' истинна в булевом контексте JS — наивная `if (process.env.X)`
//      включила бы предохранитель ровно наоборот и выключила бы очередь в
//      проде, где EMBEDDED_POSTGRES=false — постоянное боевое значение
//      (внешняя Timeweb Managed PostgreSQL, миграция 2026-06-11).
//
//   2. readPhotoPublishNumberEnv — числовые значения окружения
//      (PHOTO_PUBLISH_RATE_PER_SEC/BURST/WORKERS) валидируются ДО передачи в
//      конструктор, который на плохом значении БРОСАЕТ (createRateLimiter:
//      ratePerSec<=0 || burst<1; createPhotoPublishWorker: workers<1). Кривая
//      или нечисловая переменная окружения не имеет права уронить старт
//      всего процесса — оператор не должен платить за опечатку в конфиге
//      невозможностью сдать фото.
//
//   3. buildPhotoQueueRuntime — единая точка решения "включать ли очередь",
//      закрывающая сразу два разных предохранителя:
//        - эфемерная БД (EMBEDDED_POSTGRES=true): очередь НЕ включается
//          ВООБЩЕ, ни приём, ни публикация. На встроенной в контейнер базе
//          редеплой стирает её целиком — если бы приём продолжал класть
//          байты в такую очередь, а воркер (которого тоже нет) их не успевал
//          публиковать, редеплой тихо уничтожил бы уже принятые, но не
//          опубликованные фото. Очередь, задуманная как защита от потери,
//          сама стала бы механизмом потери, и молча — поэтому отказ здесь
//          громкий (лог) и полный (никакого приёма мимо синхронного пути,
//          которого дальше и так нет).
//        - отказ создания стора (createStore бросил, например от недоступного
//          pool) — приложение обязано подняться целиком, не только эта
//          функция: возвращается работающая заглушка вместо throw наружу.
//      В обоих случаях createReportsRouter всё равно получает ВАЛИДНЫЙ,
//      truthy объект с работающим .accept() (пусть и бросающим понятную
//      ошибку) — это и держит обязательную проверку конструктора роутера
//      (createReportsRouter требует photoQueueStore, см. reportsRoutes.js)
//      от того, чтобы погасить целиком /api/reports (отчёты, диспетчеризацию,
//      submit — всё, что НЕ имеет отношения к фото) ради проблемы, которая
//      касается только публикации снимков.
//
// ВАЖНО, раунд правок 1 (ревью владельца нашло противоречие в собственном
// задании и попросило проговорить решение явно, а не только в коде):
// когда очередь выключена (оба случая выше), ПРИЁМ ФОТО ВОЗВРАЩАЕТ ЯВНУЮ
// ОШИБКУ ОПЕРАТОРУ — и это ОСОЗНАННЫЙ ВЫБОР, а не забытая деградация.
// Причины две, и обе достаточны сами по себе:
//   1. "Прежнего синхронного пути" приёма (в обход очереди, напрямую в
//      Битрикс в рамках HTTP-запроса) в коде БОЛЬШЕ НЕТ. Его убрала задача
//      переноса приёма фото на очередь (см. reportsRoutes.js, POST
//      /:id/photo: единственная реализация — photoQueueStore.accept()).
//      Вернуться "прежним путём" ЗДЕСЬ буквально некуда — такой код не
//      существует, и придумывать его заново специально под отказ очереди
//      значило бы разводить два независимых способа принять фото.
//   2. Даже если бы такой путь существовал: на эфемерной БД (EMBEDDED_POSTGRES
//      =true) принять фото в очередь — значит принять его в то, что редеплой
//      сотрёт без следа. Явный отказ прямо сейчас честнее, чем тихая потеря
//      прямо перед следующим редеплоем — тот же главный принцип, что стоит
//      за всей этой задачей ("Приём фото не имеет права упасть" — но
//      конкретно ЗДЕСЬ цена ложного "успеха" выше цены честного отказа).
// ---------------------------------------------------------------------------

export const isEmbeddedPostgresEnabled = (rawValue) =>
  String(rawValue ?? '').trim().toLowerCase() === 'true';

export const readPhotoPublishNumberEnv = ({ rawValue, fallback, isValid, name, logger = console }) => {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !isValid(parsed)) {
    logger.error(JSON.stringify({
      event: 'photo_publish_env_invalid',
      name,
      value: String(rawValue),
      fallback
    }));
    return fallback;
  }
  return parsed;
};

// Заглушка, которую видит createReportsRouter, когда очередь не включена
// (эфемерная БД) или её создание бросило (защита загрузки). Единственная
// задача — сделать photoQueueStore ВСЕГДА truthy-объектом с работающим
// .accept(), который откажет громко и по делу на конкретной загрузке фото, а
// не молча — и не даёт обязательной проверке конструктора роутера погасить
// весь /api/reports целиком.
//
// Этот отказ — ОСОЗНАННЫЙ, а не деградация "пока не доделали": альтернативы
// у него нет. У приёма фото больше нет прежнего синхронного пути в обход
// очереди (см. reportsRoutes.js — единственная реализация POST /:id/photo
// это photoQueueStore.accept()), а на эфемерной БД (см. вызывающую сторону —
// buildPhotoQueueRuntime) молча принять фото значило бы молча подготовить
// его к потере на следующем редеплое. Явная ошибка здесь — честнее тихого
// "успеха", который позже окажется потерей.
export const createPhotoQueueUnavailableStore = (reason) => ({
  async accept() {
    const error = new Error(`photo intake queue is unavailable: ${reason}`);
    error.code = 'photo_queue_unavailable';
    throw error;
  }
});

/**
 * @param {object} deps
 * @param {boolean} deps.isEmbeddedPostgres — результат isEmbeddedPostgresEnabled(process.env.EMBEDDED_POSTGRES)
 * @param {Function} deps.createStore — () => photoQueueStore; вызывается ТОЛЬКО если isEmbeddedPostgres===false. Инъецируется (а не createPhotoQueueStore напрямую), чтобы функция была тестируема без реального pool
 * @param {object} [deps.logger] — по умолчанию console; используется только .error()
 * @returns {{ store: object, enabled: boolean, reason: string|null }}
 */
// createPhotoPublishWorker (photoPublishWorker.js) требует pool.connect() —
// это НЕ формальность, а прямое следствие того, как там реализован
// advisory-лок: pg_try_advisory_lock/pg_advisory_unlock — лок УРОВНЯ СЕССИИ
// одного физического соединения, специфичный для Postgres SQL-синтаксис, и
// у него нет реализованного эквивалента для MySQL в этом файле (в отличие
// от photoQueueStore.js, где у КАЖДОГО метода есть вариант для обеих СУБД —
// см. заголовочный комментарий photoPublishWorker.js: там везде "Postgres",
// ни разу "MySQL"). mysql2/promise.Pool не предоставляет .connect() вовсе
// (у него .getConnection() — другой метод, другая форма клиента).
//
// Без этой проверки ДО конструктора: на DB_TYPE=mysql с
// EMBEDDED_POSTGRES=false очередь была бы включена (photoQueueStore.accept/
// claimBatch полностью поддерживают MySQL), но createPhotoPublishWorker({
// pool, ... }) бросил бы синхронно ('pool with connect() is required') — и
// уронил бы ВЕСЬ процесс, а не только публикацию. Это строго хуже, чем
// просто "не работает публикация": приём фото (не завязанный на
// advisory-лок вообще) тоже перестал бы работать, хотя мог бы.
export const isPhotoPublishWorkerSupported = ({ pool }) =>
  Boolean(pool) && typeof pool.connect === 'function';

export const buildPhotoQueueRuntime = ({ isEmbeddedPostgres, createStore, logger = console }) => {
  if (isEmbeddedPostgres) {
    const reason = 'EMBEDDED_POSTGRES=true: embedded DB is wiped on redeploy — the queue would silently lose accepted-but-unpublished photos';
    logger.error(JSON.stringify({ event: 'photo_publish_queue_disabled', reason }));
    return { store: createPhotoQueueUnavailableStore(reason), enabled: false, reason };
  }
  try {
    const store = createStore();
    return { store, enabled: true, reason: null };
  } catch (error) {
    logger.error(JSON.stringify({ event: 'photo_publish_queue_disabled', reason: error.message }));
    return { store: createPhotoQueueUnavailableStore(error.message), enabled: false, reason: error.message };
  }
};

export default buildPhotoQueueRuntime;
