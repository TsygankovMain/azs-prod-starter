// Кэш «какие фото требует эта АЗС» и «как называется этот тип фото».
//
// Зачем: readRequiredPhotos вызывается на КАЖДУЮ загрузку фото и делает залп
// через Promise.all — по одному crm.item.get на каждый требуемый тип. При 40
// слотах это 41 вызов из 44 на один снимок, при том что список требуемых фото
// — факт уровня АЗС, а не уровня снимка. Именно этот залп даёт QUERY_LIMIT_
// EXCEEDED: метод в ошибке инцидента 03.08 — crm.item.get.
//
// Почему два кэша с разным TTL, а не один:
//   - набор фото у АЗС может поменять администратор в Битриксе, и он должен
//     увидеть изменение в разумный срок -> короткий TTL;
//   - карточки типов фото общие для всего парка и почти неизменны -> длинный.
// При промахе по набору платим ОДИН вызов (карточка АЗС), а не сорок один:
// сами типы к этому моменту уже прогреты чужими загрузками.
//
// КРИТИЧНО: ключ включает идентичность портала. Без этого две инсталляции с
// одинаковыми id смарт-процессов получили бы ЧУЖОЙ набор требуемых фото.
// Пустой portalKey означает «не кэшируем» — не общий бакет для неопознанных.
// То же решение и по той же причине, что в disk/folderIdCache.js.

const KEY_SEP = '\x00';

const readEnvInt = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const DEFAULT_AZS_TTL_MS = readEnvInt('PHOTO_SET_CACHE_TTL_MS', 10 * 60 * 1000);
const DEFAULT_TYPE_TTL_MS = readEnvInt('PHOTO_TYPE_CACHE_TTL_MS', 12 * 60 * 60 * 1000);
const DEFAULT_MAX_ENTRIES = readEnvInt('PHOTO_SET_CACHE_MAX_ENTRIES', 2000);

export const createRequiredPhotosCache = ({
  azsTtlMs = DEFAULT_AZS_TTL_MS,
  typeTtlMs = DEFAULT_TYPE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now()
} = {}) => {
  // Одна Map на оба вида записей: LRU-вытеснение должно видеть общий объём
  // памяти, а не два независимых лимита, которые в сумме дадут вдвое больше.
  const entries = new Map();

  const buildKey = (kind, portalKey, id) => (
    `${kind}${KEY_SEP}${portalKey}${KEY_SEP}${String(id)}`
  );

  const readEntry = (key) => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() > entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    // Освежаем позицию в LRU: Map хранит порядок вставки, поэтому
    // delete+set перемещает запись в конец.
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

  const usable = (portalKey) => Boolean(String(portalKey || '').trim());

  return {
    getAzsSet(portalKey, azsId) {
      if (!usable(portalKey)) return null;
      return readEntry(buildKey('azs', portalKey, azsId));
    },
    setAzsSet(portalKey, azsId, value) {
      if (!usable(portalKey)) return;
      writeEntry(buildKey('azs', portalKey, azsId), value, azsTtlMs);
    },
    getPhotoType(portalKey, typeId) {
      if (!usable(portalKey)) return null;
      return readEntry(buildKey('type', portalKey, typeId));
    },
    setPhotoType(portalKey, typeId, value) {
      if (!usable(portalKey)) return;
      writeEntry(buildKey('type', portalKey, typeId), value, typeTtlMs);
    },
    evictAzs(portalKey, azsId) {
      entries.delete(buildKey('azs', portalKey, azsId));
    },
    size() {
      return entries.size;
    }
  };
};

export default createRequiredPhotosCache;
