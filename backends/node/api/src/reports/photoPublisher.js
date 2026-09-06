// Публикация одного принятого фото в Битрикс + таксономия ошибок публикации.
//
// classifyPublishError решает, стоит ли повторить попытку или считать отказ
// окончательным. Список окончательных ошибок снят с живого портала, а не из
// документации — в этом проекте догадки по документации уже дважды приводили
// к неверным допущениям. Пополнять список можно только по наблюдённой в
// проде ошибке.
//
// Дефолт — 'retryable', и это умышленное, несимметричное решение: неверная
// догадка «повторить» стоит одного лишнего запроса; неверная догадка «отказ
// навсегда» стоит потерянного фото и несданной смены у живого человека.
// Невидимая потеря вместо видимого отказа — главный анти-гол всей задачи.
//
// Раунд правок 1 (ревью нашло Critical): bitrixRestClient.js прокидывает код
// ошибки Bitrix ТОЛЬКО в message брошенного Error — см. callInternalOnce/
// callRawOnce: `Bitrix REST ${method} error: ${responsePayload.error} ...`.
// Свойство `.bitrixError`, на которое изначально смотрел этот классификатор
// (ровно так заданы фикстуры в брифе), нигде в src/ не присваивается — для
// настоящих ошибок Битрикса весь список ниже был математически недостижим, и
// КАЖДАЯ реальная ошибка (включая DISK_QUOTA_EXCEEDED) уходила retryable по
// дефолту. Приём чинки — тот же, что уже установлен в проекте: сопоставление
// по тексту ошибки (см. diskService.js: isFolderMissingError,
// isDuplicateFileNameError; bitrixRestClient.js: isRefreshableAuthError,
// isRetryableTransientError) — единственный работающий в проекте способ
// узнать код Bitrix из брошенной ошибки.
//
// buildErrorHaystack КОНКАТЕНИРУЕТ источники, а не берёт первый truthy через
// `||`: `.bitrixError`/`.error` остаются ДОПОЛНИТЕЛЬНЫМ источником на случай,
// если когда-нибудь появится код, кладущий такое структурированное поле — и
// при этом синтетические фикстуры брифа (Object.assign(new Error('x'),
// {bitrixError: ...})) продолжают работать: `.message` у них непустой ('x'),
// но `||`-каскад с message первым отбросил бы `.bitrixError` целиком.
const buildErrorHaystack = (error) => [
  error?.message,
  error?.bitrixError,
  error?.error,
  typeof error === 'string' ? error : ''
].filter(Boolean).join(' ');

// Проверяется ПЕРВОЙ и безусловно, до списка окончательных: QUERY_LIMIT_EXCEEDED
// — это просьба портала подождать, а не отказ. Порядок имеет значение — если
// бы список окончательных проверялся раньше, сообщение, где оба сигнала
// встретились одновременно, ушло бы в permanent (см. тест на этот случай).
const NEVER_PERMANENT_PATTERN = /\bQUERY_LIMIT_EXCEEDED\b/i;

// Список снят с живого портала, а не из документации: в этом проекте догадки
// по документации уже дважды приводили к неверным допущениям. Пополнять его
// можно только по наблюдённой в проде ошибке. \b-границы (а не голый substring)
// — минимальная защита от случайного попадания как части более длинного слова;
// более строгий (позиционный/JSON-aware) парсинг был бы избыточен и расходится
// с установленной в проекте конвенцией простого сопоставления по тексту.
const PERMANENT_BITRIX_ERROR_PATTERN = /\b(DISK_QUOTA_EXCEEDED|ERROR_NOT_FOUND_FOLDER|ACCESS_DENIED)\b/i;

// ИНВАРИАНТ, ЗАЩИЩАЮЩИЙ ПОВЕДЕНИЕ POST /:id/submit (раунд правок 1,
// Important 4 — ревью Task 8; см. полный комментарий над markFailed в
// photoQueueStore.js, куда результат 'permanent' в итоге приводит). Все три
// причины 'permanent' сегодня — коды Bitrix, то есть отказы, за которые
// отвечает инфраструктура/портал, а не оператор. Это тот же класс отказов,
// на который submit опирается, чтобы НЕ фильтровать report_photo по
// publish_state. Если этот список расширится кодом, который означает НЕ
// "Битрикс отказал", а "код в принципе не должен считаться загруженным"
// (например, будущая проверка slot_verified при публикации) — реши в
// markFailed/reportsRoutes.js, обязан ли /submit это различать, ПРЕЖДЕ чем
// расширять паттерн, а не после.
export const classifyPublishError = (error) => {
  const haystack = buildErrorHaystack(error);
  if (NEVER_PERMANENT_PATTERN.test(haystack)) return 'retryable';
  if (PERMANENT_BITRIX_ERROR_PATTERN.test(haystack)) return 'permanent';
  return 'retryable';
};

// ---------------------------------------------------------------------------
// publishOne
//
// Переносит цепочку публикации, которая раньше жила прямо в обработчике
// POST /:id/photo (reportsRoutes.js, роут не трогаем — его переписывает
// другая задача): резолвинг корневой папки (с учётом папки бренда) →
// uploadPhoto с folderIdCache. Сам обработчик логики не меняет — меняется
// только то, что каждое обращение к Битриксу теперь проходит под общим
// ограничителем темпа (см. shared/rateLimiter.js).
// ---------------------------------------------------------------------------

import { ensureRootFolder, uploadPhoto } from '../disk/diskService.js';
import { createSettingsCache } from '../shared/settingsCache.js';
import { createPhotoNamingResolver } from './photoNamingResolver.js';

class ReportSlotKeyError extends Error {
  constructor(slotKey) {
    super(`Report slotKey "${String(slotKey || '')}" is invalid; expected YYYY-MM-DD:HHmm or manual:YYYY-MM-DD:HHmm`);
    this.name = 'ReportSlotKeyError';
    this.code = 'report_slot_key_invalid';
    this.statusCode = 422;
  }
}

// Реплика normalizeSlotHHmm/parseReportSlotKey из reportsRoutes.js. Не импорт:
// тот модуль сейчас переписывает другая задача, и связывать свежий,
// изолированный модуль с файлом, который прямо сейчас меняется параллельно —
// значит рисковать конфликтом с чужой веткой работы ради двух строк логики.
const normalizeSlotHHmm = (value) => {
  const raw = String(value || '').replace(/[^0-9]/g, '').slice(0, 4);
  if (raw.length !== 4) return '';
  const hours = Number(raw.slice(0, 2));
  const minutes = Number(raw.slice(2, 4));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return '';
  }
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
};

const parseSlotKey = (slotKey) => {
  const parts = String(slotKey || '').split(':').map((part) => String(part || '').trim());
  const isManual = String(parts[0] || '').toLowerCase() === 'manual';
  const slotDate = isManual ? String(parts[1] || '').trim() : String(parts[0] || '').trim();
  const rawSlotHHmm = isManual ? String(parts[2] || '').trim() : String(parts[1] || '').trim();
  const slotHHmm = normalizeSlotHHmm(rawSlotHHmm);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !slotHHmm) {
    throw new ReportSlotKeyError(slotKey);
  }

  return { slotDate, slotHHmm };
};

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

// Оборачивает diskApi так, что КАЖДЫЙ его метод сначала берёт токен у общего
// ограничителя темпа, а при ошибке с полем retryAfterMs (портал попросил
// подождать через заголовок Retry-After — см. bitrixRestClient.js, разбор
// около строк 277 и 385) — сообщает об этом ограничителю через penalize(),
// прежде чем пробросить ошибку дальше без изменений.
//
// Оборачиваем ВСЕ методы diskApi обобщённо (Object.keys), а не только те,
// что нужны сегодняшней цепочке (findChildFolder/createFolder/findChildFile/
// markFileDeleted/uploadFile): ensureRootFolder и uploadPhoto — чужой код
// (diskService.js, трогать нельзя), и его набор внутренних вызовов может
// измениться. Жёстко перечисленный список методов здесь означал бы дыру мимо
// лимитера, которую легко не заметить при следующей правке diskService.js.
//
// original.apply(diskApi, args), а не отвязанный original(...args): методы
// diskApi живут в объектном литерале и сегодня не читают this, но полагаться
// на это — случайность реализации, а не контракт; apply сохраняет корректное
// поведение независимо от того, начнёт ли какой-то метод использовать this.
const wrapDiskApiWithLimiter = (diskApi, limiter) => {
  const wrapped = {};
  for (const name of Object.keys(diskApi || {})) {
    const original = diskApi[name];
    if (typeof original !== 'function') {
      wrapped[name] = original;
      continue;
    }
    wrapped[name] = async (...args) => {
      await limiter.acquire();
      try {
        return await original.apply(diskApi, args);
      } catch (error) {
        if (error && error.retryAfterMs != null) {
          limiter.penalize(error.retryAfterMs);
        }
        throw error;
      }
    };
  }
  return wrapped;
};

// Раунд правок 1 (ревью нашло Critical): settingsStore, собранный в проде
// (server.js — createCompositeSettingsStore), на read() реально ходит в
// Bitrix ПЕРВЫМ (app.option.get), а локальная БД — только фоллбек на отказ
// портала (settings/compositeSettingsStore.js: «Source of truth: Bitrix app
// storage. Local DB is a warm fallback cache»; settings/bitrixAppSettingsStore.js
// вызывает bitrixClient.callMethod('app.option.get', ...) — настоящий REST).
// Без кэша это необнаруживаемый REST-вызов на КАЖДУЮ публикацию, мимо
// ограничителя целиком — и худшее время для этого расхода: после сбоя, когда
// очередь большая и несколько воркеров разом её разгребают.
//
// Обернуть сам вызов лимитером было бы неверным лечением: расход бюджета
// портала остался бы, лимитер лишь равномернее размазал бы его во времени.
// Настройки — административная конфигурация уровня приложения (меняет
// администратор, не каждое фото), поэтому TTL-кэш не просто удобен, а
// безопасен по своей природе. Приём — тот же, что requiredPhotosCache.js
// (первая задача этого плана): Map/значение с TTL, вытесняемое по возрасту.
//
// inFlight отдельно от cached: несколько publishOne(), стартовавших почти
// одновременно на холодный кэш (типично для нескольких воркеров, разом
// поднявшихся после простоя), обязаны дождаться ОДНОГО read() и разделить его
// результат, а не каждый сделать свой — иначе кэш не спасает именно в момент
// всплеска нагрузки, ради которого он и нужен.
//
// createSettingsCache — раунд правок 2 (финальное ревью ветки, I1): вынесена
// в src/shared/settingsCache.js — тот же приём понадобился ВТОРОМУ
// потребителю (buildCrmSyncRunner, reportsRoutes.js) по той же причине; сам
// код теперь общий, инстанс (см. ниже) — по-прежнему свой, приватный, только
// для этого publisher'а.
const DEFAULT_SETTINGS_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.PHOTO_PUBLISHER_SETTINGS_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

/**
 * @param {object} deps
 * @param {object} deps.bitrixClient   — должен предоставлять diskApi (см. bitrixRestClient.js)
 * @param {object} deps.settingsStore  — { read(): Promise<settings> }, локальные настройки приложения
 * @param {object} deps.reportsStore   — { getById(reportId) }, локальная БД (не Битрикс)
 * @param {object} [deps.brandStore]   — { getBrandByAzsId(azsId) }, локальная БД; необязателен
 * @param {object} [deps.folderIdCache] — createFolderIdCache(...) из folderIdCache.js; передаётся в uploadPhoto как есть
 * @param {object} deps.limiter        — createRateLimiter(...) из shared/rateLimiter.js; ОДИН общий экземпляр на процесс
 * @param {Function} [deps.resolveContext] — (task) => Promise<bitrixContext> | bitrixContext; по умолчанию {}
 * @param {number} [deps.settingsCacheTtlMs] — TTL кэша settingsStore.read(); см. createSettingsCache выше
 * @param {Function} [deps.now] — инжектируемые часы для теста TTL кэша настроек; по умолчанию Date.now
 * @param {object} [deps.namingResolver] — createPhotoNamingResolver(...) из photoNamingResolver.js;
 *   не передан -> собирается здесь же, ОДИН на publisher (то есть один на процесс, см. server.js)
 * @param {object} [deps.logger] — куда пишутся дедуплицированные отказы справочника имён
 */
export const createPhotoPublisher = ({
  bitrixClient,
  settingsStore,
  reportsStore,
  brandStore = null,
  folderIdCache = null,
  limiter,
  resolveContext = () => ({}),
  settingsCacheTtlMs = DEFAULT_SETTINGS_CACHE_TTL_MS,
  now = () => Date.now(),
  namingResolver = null,
  logger = console
} = {}) => {
  if (!bitrixClient || !bitrixClient.diskApi) {
    throw new Error('bitrixClient with diskApi is required');
  }
  if (!settingsStore || typeof settingsStore.read !== 'function') {
    throw new Error('settingsStore.read() is required');
  }
  if (!limiter || typeof limiter.acquire !== 'function' || typeof limiter.penalize !== 'function') {
    throw new Error('limiter with acquire()/penalize() is required');
  }

  // Один и тот же обёрнутый diskApi используется на все обращения этого
  // publisher — обёртка ставится один раз здесь, а не при каждом publishOne(),
  // но это не имеет значения для контракта «acquire() перед каждым вызовом»:
  // сама обёртка stateless относительно limiter (тот передан снаружи и разделяется
  // между всеми воркерами уже на уровне лимитера, см. rateLimiter.js).
  const rateLimitedDiskApi = wrapDiskApiWithLimiter(bitrixClient.diskApi, limiter);
  const settingsCache = createSettingsCache({ settingsStore, ttlMs: settingsCacheTtlMs, now });

  // BUG-8733. Резолвер человекочитаемых имён (номер АЗС и название категории
  // фото) — ОДИН инстанс на publisher, а значит один на процесс: publisher
  // собирается ровно один раз в server.js, а PHOTO_PUBLISH_WORKERS воркеров
  // пользуются одним и тем же publishOne. Пересоздание резолвера на каждый
  // publishOne сделало бы его кэш всегда пустым и бессмысленным — та же
  // ошибка, от которой отдельно предостерегает проводка folderIdCache в
  // server.js. Свой limiter резолвер берёт тот же общий (каждый его поход в
  // Битрикс оплачивается токеном), а часы (now) — те же инжектируемые, что и
  // у кэша настроек, чтобы TTL обоих кэшей был проверяем одним фейковым
  // временем.
  const naming = namingResolver || createPhotoNamingResolver({
    bitrixClient,
    limiter,
    now,
    logger
  });

  const publishOne = async (task = {}) => {
    const reportId = firstDefined(task.reportId, task.report_id);
    const photoCode = firstDefined(task.photoCode, task.photo_code);
    const content = task.content;
    const mimeType = firstDefined(task.mimeType, task.mime_type);
    const originalName = firstDefined(task.originalName, task.original_name);
    const capturedAt = firstDefined(task.capturedAt, task.exifAt, task.exif_at) || new Date();

    if (!content) {
      throw new Error('task.content is required');
    }

    let azsId = firstDefined(task.azsId, task.azs_id);
    let slotDate = hasValue(task.slotDate) ? task.slotDate : undefined;
    let slotHHmm = hasValue(task.slotHHmm) ? task.slotHHmm : undefined;

    // reportsStore — локальная БД (dispatch_log), не Битрикс: обращение сюда
    // НЕ проходит через limiter, он существует только для порталового REST.
    if (!hasValue(azsId) || !slotDate || !slotHHmm) {
      const report = await reportsStore.getById(reportId);
      if (!report) {
        throw new Error(`report ${reportId} not found`);
      }
      if (!hasValue(azsId)) {
        azsId = report.azsId;
      }
      if (!slotDate || !slotHHmm) {
        const parsed = parseSlotKey(report.slotKey);
        slotDate = slotDate || parsed.slotDate;
        slotHHmm = slotHHmm || parsed.slotHHmm;
      }
    }

    const context = (await resolveContext(task)) || {};
    // Раунд правок 1: settingsStore.read() кэшируется с TTL — прод-стор ходит
    // в Bitrix (см. createSettingsCache выше). Не вызывать settingsStore.read()
    // напрямую здесь.
    const settings = await settingsCache.read();

    // BUG-8733. Имя АЗС и название категории фото. Задача из очереди их не
    // несёт (claimBatch отдаёт только id/report_id/photo_code/exif_at/
    // slot_verified/байты) — поля task.azsName/task.requiredTitle остаются
    // ради вызывающих, которые могут передать готовые значения (и ради
    // тестов), но в проде оба всегда пусты, и настоящий источник — реестр
    // АЗС и справочник типов фото в Битриксе через кэширующий резолвер.
    //
    // ПУСТАЯ СТРОКА — ШТАТНЫЙ ИСХОД, а не ошибка: справочник не настроен,
    // портал не ответил, карточку удалили. Тогда buildPhotoFileName и
    // buildFolderPath (diskService.js) сами вернутся к прежним запасным
    // вариантам — id элемента и «Фото_N». Публикация от этого не страдает:
    // сдача отчёта важнее красивого имени.
    //
    // Оба резолва параллельно: они независимы, а общий ограничитель темпа
    // всё равно сериализует реальные обращения к порталу между собой.
    const [resolvedAzsName, resolvedRequiredTitle] = await Promise.all([
      hasValue(firstDefined(task.azsName, task.azs_name))
        ? String(firstDefined(task.azsName, task.azs_name)).trim()
        : naming.resolveAzsName({ settings, azsId, context }),
      hasValue(firstDefined(task.requiredTitle, task.required_title))
        ? String(firstDefined(task.requiredTitle, task.required_title)).trim()
        : naming.resolvePhotoTypeTitle({ settings, photoCode, context })
    ]);

    const azsName = resolvedAzsName || '';
    const requiredTitle = resolvedRequiredTitle || '';

    // Учёт папки бренда — та же логика, что была в обработчике: если АЗС
    // принадлежит бренду с настроенной папкой на Диске, она становится корнем
    // вместо общего AZS-Photo-Reports. brandStore — локальная БД, не Битрикс.
    let brandRootFolderId = null;
    if (brandStore && typeof brandStore.getBrandByAzsId === 'function') {
      const brand = await brandStore.getBrandByAzsId(azsId).catch(() => null);
      if (brand && brand.disk_folder_id) {
        brandRootFolderId = Number(brand.disk_folder_id);
      }
    }

    const rootFolderId = brandRootFolderId
      ? brandRootFolderId
      : await ensureRootFolder(rateLimitedDiskApi, {
          configuredRootFolderId: Number(settings.disk?.rootFolderId || 0),
          storageRootId: Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1),
          appFolderName: process.env.BITRIX_DISK_APP_FOLDER || 'AZS-Photo-Reports'
        }, context);

    const uploaded = await uploadPhoto(rateLimitedDiskApi, {
      rootFolderId,
      azsId,
      azsName,
      slotDate,
      slotHHmm,
      photoCode,
      requiredTitle,
      originalName,
      mimeType,
      capturedAt,
      content,
      folderNameTemplate: settings.disk?.folderNameTemplate || '{yyyy-mm}/{dd}/{azs}_{azs_name}',
      folderIdCache
    }, context);

    return {
      fileId: uploaded.fileId,
      fileName: uploaded.fileName,
      diskFolderId: uploaded.folderId,
      diskObjectId: uploaded.diskObjectId
    };
  };

  return { publishOne };
};

export default createPhotoPublisher;
