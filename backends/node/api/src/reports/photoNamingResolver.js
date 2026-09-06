// Резолвер человекочитаемых имён для файлов и папок фотоотчёта:
// «как называется эта АЗС» и «как называется этот тип фото».
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ ВООБЩЕ ПОЯВИЛСЯ (BUG-8733). diskService.buildPhotoFileName
// с самого начала умеет строить имя вида «486_2026-09-06_0750_Доска
// визуального управления.jpg» — но только если ему передали azsName и
// requiredTitle. photoPublisher.publishOne читает их из task
// (task.azsName / task.requiredTitle), а в task их не кладёт НИКТО: очередь
// публикации (photoQueueStore.claimBatch) отдаёт только id/report_id/
// photo_code/exif_at/slot_verified/байты, и оба поля всегда приходили
// пустыми. Срабатывали запасные варианты: id элемента смарт-процесса вместо
// номера станции (104 вместо 486) и «Фото_70» вместо названия категории.
// Клиент читает эти имена глазами, для него 104 и «Фото_70» — шум.
//
// ПОЧЕМУ КЭШ ОБЯЗАТЕЛЕН, А НЕ ЖЕЛАТЕЛЕН. Публикация идёт пофотно: один
// publishOne на каждый снимок. Парк — 75 станций, справочник типов фото — 40
// карточек, отчёт — до 40 фото в смену. Без кэша это два crm.item.get на
// КАЖДОЕ фото, то есть тысячи лишних вызовов в день на портал, который уже
// дважды ронял смены по QUERY_LIMIT_EXCEEDED (инциденты 31.07 и 03.08).
// При этом оба факта — «как называется станция» и «как называется тип фото»
// — уровня справочника, а не уровня снимка: они меняются, когда админ правит
// карточку, то есть в лучшем случае раз в недели.
//
// Приём и разделение TTL — тот же, что уже принят в проекте
// (reports/requiredPhotosCache.js, disk/folderIdCache.js, shared/settingsCache.js):
//   - карточка АЗС может быть переименована администратором, и он должен
//     увидеть это в разумный срок -> TTL покороче (6 часов);
//   - карточки типов фото общие для всего парка и почти неизменны -> TTL
//     подлиннее (12 часов, как PHOTO_TYPE_CACHE_TTL_MS в requiredPhotosCache);
//   - НЕУДАЧА (портал не ответил, карточки нет, заголовок пуст) кэшируется
//     отдельным, коротким TTL (минута). Без этого падение портала означало бы
//     не «одно лишнее обращение», а «лишнее обращение на каждое фото» —
//     ровно в тот момент, когда порталу и так плохо; а с длинным TTL мы бы,
//     наоборот, помнили пустое имя ещё полсуток после того, как портал
//     починился.
//
// КРИТИЧНО: ключ кэша включает идентичность портала (buildPortalKey). Без
// этого две инсталляции с одинаковыми id смарт-процессов получили бы ЧУЖИЕ
// названия. Пустой portalKey (контекст без memberId/domain) означает «портал
// не опознан» -> НЕ кэшируем вовсе, а не кладём в общий безымянный бакет.
// То же решение и по той же причине, что в disk/folderIdCache.js.
//
// ОТКАЗ СПРАВОЧНИКА НЕ ИМЕЕТ ПРАВА РОНЯТЬ ПУБЛИКАЦИЮ. Любая ошибка здесь —
// это пустая строка наружу, а неброшенное исключение: вызывающий код
// (buildPhotoFileName / buildFolderPath) на пустом значении вернётся к
// прежнему запасному варианту (id и «Фото_N»), фото опубликуется, отчёт
// сдастся. Красивое имя дешевле сданной смены — это тот же несимметричный
// выбор, что и во всей цепочке публикации (см. photoPublisher.js).

import { buildPortalKey } from '../disk/folderIdCache.js';
import { createThrottledLog } from '../shared/throttledLogger.js';

const KEY_SEP = '\x00';

const readEnvInt = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const DEFAULT_AZS_TTL_MS = readEnvInt('PHOTO_NAMING_AZS_TTL_MS', 6 * 60 * 60 * 1000);
const DEFAULT_TYPE_TTL_MS = readEnvInt('PHOTO_NAMING_TYPE_TTL_MS', 12 * 60 * 60 * 1000);
const DEFAULT_NEGATIVE_TTL_MS = readEnvInt('PHOTO_NAMING_NEGATIVE_TTL_MS', 60 * 1000);
const DEFAULT_MAX_ENTRIES = readEnvInt('PHOTO_NAMING_MAX_ENTRIES', 2000);

// Реплика parseCrmItemId из reportsRoutes.js/dispatchService.js (там она тоже
// продублирована в двух файлах) — id элемента может прийти и числом, и
// строкой вида «azs-104».
const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

// Заголовок карточки АЗС в реестре ОРТК — это и есть номер станции: «486»,
// «1102», «33231». У части записей номер записан с приставкой — «АЗС 33249».
// Клиент просил в имени файла «[Код_АЗС]», поэтому приставку срезаем: она не
// несёт информации (все 75 карточек этого реестра — АЗС) и только удлиняет
// имя. Остальные нечисловые заголовки («Офис», «Нефтебаза», «АГЗС
// (Одинцово)») остаются как есть — regexp заякорен на начало строки и на
// точную последовательность «АЗС», поэтому «АГЗС» под него не попадает.
//
// \b здесь НЕ используется намеренно: в JS границы слова не видят кириллицу
// (\w — только латиница), и «\bАЗС\b» вело бы себя не так, как выглядит.
// Если после среза не осталось ничего (заголовок был ровно «АЗС») — отдаём
// исходный заголовок, пустое имя хуже некрасивого.
const AZS_TITLE_PREFIX_RE = /^АЗС\s*№?\s*/i;

export const normalizeAzsCode = (title) => {
  const raw = String(title ?? '').trim();
  if (!raw) {
    return '';
  }
  const stripped = raw.replace(AZS_TITLE_PREFIX_RE, '').trim();
  return stripped || raw;
};

/**
 * @param {object} deps
 * @param {object} deps.bitrixClient — должен предоставлять getCrmItem({entityTypeId, id, context})
 * @param {object} [deps.limiter] — общий ограничитель темпа портала (shared/rateLimiter.js);
 *   КАЖДЫЙ реальный поход в Битрикс берёт токен сам, тем же приёмом, что
 *   publishOne и buildReportPhotoFieldValue. Не передан -> без пейсинга
 *   (так вызывают тесты).
 * @param {number} [deps.azsTtlMs]
 * @param {number} [deps.typeTtlMs]
 * @param {number} [deps.negativeTtlMs]
 * @param {number} [deps.maxEntries]
 * @param {Function} [deps.now] — инжектируемые часы (тесты TTL)
 * @param {object} [deps.logger]
 * @param {number} [deps.logIntervalMs] — окно дедупликации лога отказов
 */
export const createPhotoNamingResolver = ({
  bitrixClient,
  limiter = null,
  azsTtlMs = DEFAULT_AZS_TTL_MS,
  typeTtlMs = DEFAULT_TYPE_TTL_MS,
  negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
  logger = console,
  logIntervalMs = undefined
} = {}) => {
  // Одна Map на оба вида записей — LRU-вытеснение должно видеть общий объём
  // памяти, а не два независимых лимита, которые в сумме дадут вдвое больше
  // (то же решение, что в requiredPhotosCache.js).
  const entries = new Map();
  // Дедупликация КОНКУРЕНТНЫХ промахов: PHOTO_PUBLISH_WORKERS по умолчанию 3,
  // и все три обычно разгребают фото одного и того же отчёта одной и той же
  // АЗС. Без этого холодный кэш означал бы три одинаковых crm.item.get вместо
  // одного — ровно в момент всплеска, ради которого кэш и заведён (тот же
  // приём и та же причина, что inFlight в shared/settingsCache.js).
  const inFlight = new Map();
  const logOnce = createThrottledLog({ logger, intervalMs: logIntervalMs });

  const buildKey = (kind, portalKey, id) => `${kind}${KEY_SEP}${portalKey}${KEY_SEP}${id}`;

  const readEntry = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() > entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    // Освежаем позицию в LRU: Map хранит порядок вставки.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const writeEntry = (key, value, ttlMs) => {
    if (entries.has(key)) entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const fetchTitle = async ({ entityTypeId, id, context }) => {
    if (limiter) await limiter.acquire();
    try {
      const item = await bitrixClient.getCrmItem({ entityTypeId, id, context });
      return String(item?.title ?? item?.TITLE ?? '').trim();
    } catch (error) {
      // Тот же контракт, что у wrapDiskApiWithLimiter в photoPublisher.js:
      // просьбу портала подождать передаём ограничителю, ошибку не глотаем
      // здесь — её глотает resolve() ниже, уже осознанно и с логом.
      if (limiter && error && error.retryAfterMs != null) {
        limiter.penalize(error.retryAfterMs);
      }
      throw error;
    }
  };

  const resolve = async ({ kind, entityTypeId, rawId, context, ttlMs, transform, event }) => {
    const typeId = Number(entityTypeId || 0);
    const itemId = parseCrmItemId(rawId);
    // Справочник не настроен / клиент не умеет crm.item.get / id не разобрать
    // -> молча отдаём пустое имя. Это не ошибка: буквально так же ведут себя
    // resolveAzsTitle (dispatchService.js) и createAzsTitleResolver
    // (reportsRoutes.js) — конфигурация без справочника это законное
    // состояние, а не отказ.
    if (!typeId || !itemId || typeof bitrixClient?.getCrmItem !== 'function') {
      return '';
    }

    const portalKey = buildPortalKey(context);
    const key = portalKey ? buildKey(kind, portalKey, itemId) : '';

    if (key) {
      const cached = readEntry(key);
      // Пустая строка — валидное закэшированное значение («узнать не вышло,
      // не долби портал ещё минуту»), поэтому проверка именно на undefined.
      if (cached !== undefined) return cached;
      const pending = inFlight.get(key);
      if (pending) return pending;
    }

    const promise = (async () => {
      try {
        const title = await fetchTitle({ entityTypeId: typeId, id: itemId, context });
        const value = transform(title);
        if (key) writeEntry(key, value, value ? ttlMs : negativeTtlMs);
        return value;
      } catch (error) {
        // Отказ справочника НЕ отменяет публикацию: отдаём пустое имя,
        // вызывающий вернётся к прежнему запасному варианту. Лог —
        // дедуплицированный (createThrottledLog), иначе недоступный портал
        // дал бы по строке на каждое из тысяч фото.
        logOnce(
          `${event}${KEY_SEP}${itemId}`,
          'warn',
          `${event}: не удалось получить название (entityTypeId=${typeId}, id=${itemId}) — имя файла останется запасным`,
          { event, entityTypeId: typeId, itemId, error: String(error?.message || error) }
        );
        if (key) writeEntry(key, '', negativeTtlMs);
        return '';
      } finally {
        if (key) inFlight.delete(key);
      }
    })();

    if (key) inFlight.set(key, promise);
    return promise;
  };

  return {
    /**
     * Номер станции для имени файла и сегмента {azs_name} папки.
     * Возвращает '' — и только '' — если узнать не удалось.
     */
    resolveAzsName({ settings, azsId, context = {} } = {}) {
      return resolve({
        kind: 'azs',
        entityTypeId: settings?.azs?.entityTypeId,
        rawId: azsId,
        context,
        ttlMs: azsTtlMs,
        transform: normalizeAzsCode,
        event: 'photo_naming_azs_lookup_failed'
      });
    },

    /**
     * Название категории фото. Числовую приставку («35. Доска…») срезает уже
     * buildPhotoCategory в diskService.js — здесь заголовок отдаётся как есть.
     */
    resolvePhotoTypeTitle({ settings, photoCode, context = {} } = {}) {
      return resolve({
        kind: 'type',
        entityTypeId: settings?.photoType?.entityTypeId,
        rawId: photoCode,
        context,
        ttlMs: typeTtlMs,
        transform: (title) => title,
        event: 'photo_naming_type_lookup_failed'
      });
    },

    get size() {
      return entries.size;
    }
  };
};

export default createPhotoNamingResolver;
