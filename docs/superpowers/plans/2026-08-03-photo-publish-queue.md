# Серверная очередь публикации фото — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Принимать фото в нашу базу за один быстрый запрос и публиковать их в Битрикс фоновым воркером с общим ограничителем темпа, чтобы поломка портала перестала выглядеть как вина оператора.

**Architecture:** Очередью служит сама таблица `report_photo`: новая колонка `publish_state` (`accepted → published | failed`), выборка через `FOR UPDATE SKIP LOCKED`. Байты лежат в отдельной таблице `report_photo_blob` и удаляются через N дней после успеха. Пул из трёх воркеров работает под одним общим токен-бакетом (1,4 запроса в секунду) и под advisory-локом Postgres, чтобы второй экземпляр приложения не удвоил темп.

**Tech Stack:** Node 25 (нативный ESM), Express, PostgreSQL (`pg`) + MySQL-вариант стора, `node:test` + `node:assert/strict`, Nuxt 4 / Vue 3 на фронте.

**Спека:** [`docs/superpowers/specs/2026-07-31-async-photo-publish-design.md`](../specs/2026-07-31-async-photo-publish-design.md)

## Global Constraints

- **Приоритет владельца: стабильность, не скорость.** Сначала все отчёты должны без сбоев доезжать **до нашего сервера**, потом — в Битрикс. Время слива парка (~1 ч 13 м) вынесено в отдельную задачу и **не является целью этого плана**. Практическое следствие: при выборе между «быстрее» и «надёжнее» всегда выбирается надёжнее, а любое ускорение, ухудшающее приём фото, отклоняется.
- **Приём фото не имеет права упасть из-за Битрикса. Ни при каких условиях.** Это главный критерий приёмки всего плана. Если обработчик приёма может вернуть ошибку, когда портал недоступен, — задача не сделана.
- **База данных — внешняя (Timeweb Managed PostgreSQL), `EMBEDDED_POSTGRES=false`**, миграция выполнена 2026-06-11 ([ранбук](2026-06-11-external-db-migration-runbook.md), «данные прода сохранены»). От этого зависит вся затея: на встроенной в контейнер БД редеплой уничтожил бы все неопубликованные фото. Комментарии в `dispatchPlanMirror.js:7` и `reportsRoutes.js:1116` про «DB is wiped on redeploy» **устарели** — они написаны до миграции. Не принимать их за актуальное описание прода и не чинить по ним поведение.
- **Плановые величины:** 71 АЗС, 40 слотов в отчёте, предел портала **2 запроса в секунду**, очереди отдаётся **70%** — `PHOTO_PUBLISH_RATE_PER_SEC = 1.4`.
- **Воркеров ровно три** (`PHOTO_PUBLISH_WORKERS = 3`). Не «столько же, сколько АЗС». Режет общий ограничитель, а не число воркеров.
- **`git add` только явными путями.** `git add -A`, `git add .`, `git commit -a` **запрещены** — у владельца незакоммиченный WIP в `docs/code-review-log.md`, `frontend/nuxt.config.ts`, `frontend/app/pages/reason/[reportId].client.vue`, `docs/superpowers/plans/2026-06-04-backlog-master.md`, `docs/superpowers/plans/2026-06-11-bug-backlog.md`.
- **`frontend/nuxt.config.ts` не трогать вообще** — там WIP владельца по демо-режиму.
- Тесты — только `node:test` + `node:assert/strict`. Никаких библиотек моков: подделываем пул объектом с методом `query`, как в существующих тестах.
- `ensureSchema()` идемпотентен: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`.
- В `server.js` нет top-level `await` — только `.then()/.catch()`.
- Каждый стор имеет вариант для PostgreSQL и для MySQL — образец: [`crmSyncJobStore.js`](../../../backends/node/api/src/reports/crmSyncJobStore.js).
- Ключ любого кэша **обязан включать идентичность портала**; пустой `portalKey` означает «не кэшируем», а не общий бакет. Образец и обоснование: [`folderIdCache.js`](../../../backends/node/api/src/disk/folderIdCache.js).
- В логи не попадают байты фото и координаты EXIF.
- Запуск тестов: `cd backends/node/api && npm test`. Если `node_modules` пуст — `npm ci --cache "$SCRATCHPAD/npm-cache"`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/reports/requiredPhotosCache.js` | **создать** — два кэша: набор фото у АЗС (TTL 10 мин) и записи типов фото (TTL 12 ч) |
| `src/shared/rateLimiter.js` | **создать** — токен-бакет, чистый, с внедряемыми часами |
| `src/reports/photoQueueStore.js` | **создать** — очередь поверх `report_photo` + `report_photo_blob` |
| `src/reports/photoPublisher.js` | **создать** — публикация одного фото в Битрикс, таксономия отказов |
| `src/reports/photoPublishWorker.js` | **создать** — пул воркеров, advisory-лок, ограничитель |
| `src/reports/photoPublishWatchdog.js` | **создать** — сторож застрявших фото в чат |
| `src/reports/reportsStore.js` | изменить — схема: `publish_state`, `published_at`, `operator_completed_at`, `report_photo_blob` |
| `src/reports/reportsRoutes.js` | изменить — приём фото без вызовов Битрикса; кэш в `readRequiredPhotos`; `operator_completed_at` в `/submit` |
| `src/reports/photoFeedRoutes.js` | изменить — отдавать `publishState` проверяющему |
| `server.js` | изменить — проводка стора, воркеров, сторожа, очистки |
| `frontend/app/components/...` | изменить — статус «публикуется» в фотоленте |

Порядок задач — из §11 спеки. Кэш идёт до очереди: без него воркеру достаётся 125 000 вызовов вместо 8 700.

---

### Task 1: Кэш набора фото и типов фото

Самый ценный шаг плана: 44 вызова Битрикса на одно фото превращаются в 2. Делается независимо от очереди и ценен сам по себе.

Два разных кэша, а не один, потому что у них разная природа: набор фото у конкретной АЗС может поменять администратор (короткий TTL), а карточки типов фото общие для всего парка и почти неизменны (длинный TTL). При промахе по первому платим один вызов, а не сорок один.

**Files:**
- Create: `backends/node/api/src/reports/requiredPhotosCache.js`
- Create: `backends/node/api/tests/requiredPhotosCache.test.js`
- Modify: `backends/node/api/src/reports/reportsRoutes.js` (`readRequiredPhotos`, ~строка 416)

**Interfaces:**
- Consumes: `buildPortalKey(context)` из `../disk/folderIdCache.js` — уже существует, реэкспортировать не нужно, импортировать напрямую.
- Produces:
  - `createRequiredPhotosCache({ azsTtlMs, typeTtlMs, maxEntries, now }) -> { getAzsSet, setAzsSet, getPhotoType, setPhotoType, evictAzs, size }`
  - `getAzsSet(portalKey, azsId) -> { photoTypeIds: number[], azsTitle: string } | null`
  - `setAzsSet(portalKey, azsId, { photoTypeIds, azsTitle }) -> void`
  - `getPhotoType(portalKey, typeId) -> { code: string, title: string, sort: number } | null`
  - `setPhotoType(portalKey, typeId, record) -> void`

- [ ] **Шаг 1: Написать падающий тест**

Создать `backends/node/api/tests/requiredPhotosCache.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequiredPhotosCache } from '../src/reports/requiredPhotosCache.js';

test('пустой portalKey не кэшируется — ни на запись, ни на чтение', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('', 12, { photoTypeIds: [1, 2], azsTitle: 'АЗС 12' });
  assert.equal(cache.getAzsSet('', 12), null);
  assert.equal(cache.size(), 0);
});

test('набор фото АЗС не течёт между порталами', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('m1 a.bitrix24.ru', 12, { photoTypeIds: [1], azsTitle: 'Наша' });
  assert.equal(cache.getAzsSet('m2 b.bitrix24.ru', 12), null);
});

test('запись набора протухает по azsTtlMs', () => {
  let clock = 1000;
  const cache = createRequiredPhotosCache({ azsTtlMs: 500, now: () => clock });
  cache.setAzsSet('p', 12, { photoTypeIds: [1], azsTitle: 'АЗС' });
  clock = 1400;
  assert.deepEqual(cache.getAzsSet('p', 12).photoTypeIds, [1]);
  clock = 1501;
  assert.equal(cache.getAzsSet('p', 12), null);
});

test('типы фото живут дольше набора — у них свой TTL', () => {
  let clock = 0;
  const cache = createRequiredPhotosCache({ azsTtlMs: 100, typeTtlMs: 10_000, now: () => clock });
  cache.setAzsSet('p', 12, { photoTypeIds: [7], azsTitle: 'АЗС' });
  cache.setPhotoType('p', 7, { code: '7', title: 'Колонка', sort: 7 });
  clock = 500;
  assert.equal(cache.getAzsSet('p', 12), null, 'набор протух');
  assert.equal(cache.getPhotoType('p', 7).title, 'Колонка', 'тип ещё жив');
});

test('evictAzs убирает только свою запись', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('p', 12, { photoTypeIds: [1], azsTitle: 'A' });
  cache.setAzsSet('p', 13, { photoTypeIds: [2], azsTitle: 'B' });
  cache.evictAzs('p', 12);
  assert.equal(cache.getAzsSet('p', 12), null);
  assert.equal(cache.getAzsSet('p', 13).azsTitle, 'B');
});

test('LRU вытесняет самую давнюю запись при переполнении', () => {
  const cache = createRequiredPhotosCache({ maxEntries: 2 });
  cache.setPhotoType('p', 1, { code: '1', title: 'A', sort: 1 });
  cache.setPhotoType('p', 2, { code: '2', title: 'B', sort: 2 });
  cache.getPhotoType('p', 1);                                   // 1 становится свежее 2
  cache.setPhotoType('p', 3, { code: '3', title: 'C', sort: 3 });
  assert.equal(cache.getPhotoType('p', 2), null, 'вытеснена 2, а не 1');
  assert.ok(cache.getPhotoType('p', 1));
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
cd backends/node/api && node --test tests/requiredPhotosCache.test.js
```

Ожидается: `ERR_MODULE_NOT_FOUND` — файла `src/reports/requiredPhotosCache.js` ещё нет.

- [ ] **Шаг 3: Реализовать кэш**

Создать `backends/node/api/src/reports/requiredPhotosCache.js`:

```js
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
```

- [ ] **Шаг 4: Запустить тест — должен пройти**

```bash
cd backends/node/api && node --test tests/requiredPhotosCache.test.js
```

Ожидается: 6 passing.

- [ ] **Шаг 5: Мутационная проверка — тесты должны быть несущими, а не декоративными**

Внести временно каждую мутацию, убедиться, что тест краснеет, откатить:

| Мутация | Какой тест обязан упасть |
|---|---|
| В `usable` вернуть всегда `true` | «пустой portalKey не кэшируется» |
| Убрать `portalKey` из `buildKey` | «не течёт между порталами» |
| В `readEntry` убрать проверку `now() > entry.expiresAt` | «протухает по azsTtlMs» |
| В `setPhotoType` подставить `azsTtlMs` вместо `typeTtlMs` | «типы живут дольше набора» |
| В `readEntry` убрать `delete`+`set` | «LRU вытесняет самую давнюю» |

Если какая-то мутация проходит зелёной — тест не проверяет то, что должен. Чинить тест, не код.

- [ ] **Шаг 6: Подключить кэш в `readRequiredPhotos`**

В `backends/node/api/src/reports/reportsRoutes.js` добавить импорты рядом с существующими:

```js
import { createRequiredPhotosCache } from './requiredPhotosCache.js';
import { buildPortalKey } from '../disk/folderIdCache.js';
```

Рядом с существующим `photoFolderIdCache` (модульный синглтон) завести:

```js
// Живёт на весь процесс: набор требуемых фото — факт уровня АЗС, а не запроса.
// Прежний createAzsTitleResolver создавал свою Map ВНУТРИ обработчика, поэтому
// между двумя загрузками не помогал вообще.
const requiredPhotosCache = createRequiredPhotosCache();
```

Заменить тело `readRequiredPhotos` (начиная со строки с `const azsItem = await bitrixClient.getCrmItem({`) на:

```js
  const portalKey = buildPortalKey(context);

  const cachedSet = requiredPhotosCache.getAzsSet(portalKey, azsItemId);
  let photoTypeIds = cachedSet?.photoTypeIds ?? null;

  if (!photoTypeIds) {
    const azsItem = await bitrixClient.getCrmItem({
      entityTypeId: azsEntityTypeId,
      id: azsItemId,
      context
    });
    if (!azsItem) {
      const err = new ReportConfigError(
        `AZS item ${azsItemId} was not found in entityTypeId=${azsEntityTypeId}`,
        'azs_item_not_found'
      );
      err.errorCode = AZS_CARD_NOT_FOUND;
      err.meta = { azsId: String(azsId) };
      throw err;
    }

    photoTypeIds = [...new Set(extractMultipleIds(getFieldValue(azsItem, photoSetField)))];
    if (!photoTypeIds.length) {
      const err = new ReportConfigError(
        `AZS item ${azsItemId} has empty required photo set field "${photoSetField}"`,
        'azs_photo_set_empty'
      );
      err.errorCode = AZS_PHOTO_SET_EMPTY;
      err.meta = { azsId: String(azsId) };
      throw err;
    }

    requiredPhotosCache.setAzsSet(portalKey, azsItemId, {
      photoTypeIds,
      azsTitle: String(azsItem.title ?? azsItem.TITLE ?? '').trim()
    });
  }

  // Здесь и был залп: Promise.all по вызову на каждый тип, на каждое фото.
  // Теперь в Битрикс уходят только промахи — типы фото общие для всего парка
  // и после первой загрузки дня прогреты для всех АЗС сразу.
  const missingIds = photoTypeIds.filter((id) => !requiredPhotosCache.getPhotoType(portalKey, id));
  if (missingIds.length) {
    const fetched = await Promise.all(missingIds.map((id) => bitrixClient.getCrmItem({
      entityTypeId: photoTypeEntityTypeId,
      id,
      context
    })));
    for (const item of fetched) {
      if (!item) continue;
      const id = Number(item.id ?? item.ID ?? 0);
      if (!id) continue;
      const standardTitle = String(item.title ?? item.TITLE ?? '').trim();
      requiredPhotosCache.setPhotoType(portalKey, id, {
        code: String(id),
        title: standardTitle || `Фото #${id}`,
        sort: id
      });
    }
  }

  const requiredPhotos = photoTypeIds
    .map((id) => requiredPhotosCache.getPhotoType(portalKey, id))
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort)
    .map(({ code, title, sort }) => ({ code, title, sort }));

  if (!requiredPhotos.length) {
    const err = new ReportConfigError(
      'Failed to load photo type records',
      'photo_types_not_found'
    );
    err.errorCode = PHOTO_TYPE_NOT_FOUND;
    err.meta = { azsId: String(azsId) };
    throw err;
  }

  return requiredPhotos;
};
```

**Осторожно:** при пустом `portalKey` оба кэша возвращают `null`, и код честно вырождается в прежнее поведение — тот же залп, та же корректность. Это и есть требуемый фоллбек, а не дефект.

- [ ] **Шаг 7: Тест на то, что кэш реально срезает вызовы**

Дописать в `backends/node/api/tests/requiredPhotosCache.test.js`:

```js
import { readRequiredPhotos } from '../src/reports/reportsRoutes.js';

const makeClient = (counter) => ({
  async getCrmItem({ entityTypeId, id }) {
    counter.calls += 1;
    if (entityTypeId === 100) return { id, TITLE: 'АЗС 12', UF_PHOTO_SET: [7, 8, 9] };
    return { id, TITLE: `Тип ${id}` };
  }
});

const SETTINGS = {
  azs: { entityTypeId: 100, fields: { photoSet: 'UF_PHOTO_SET' } },
  photoType: { entityTypeId: 200 }
};
const CONTEXT = { memberId: 'm-cache-test', domain: 'cache.bitrix24.ru' };

test('вторая загрузка того же отчёта не ходит в Битрикс вовсе', async () => {
  const counter = { calls: 0 };
  const client = makeClient(counter);

  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '12', context: CONTEXT });
  const firstCalls = counter.calls;
  assert.equal(firstCalls, 4, '1 карточка АЗС + 3 типа фото');

  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '12', context: CONTEXT });
  assert.equal(counter.calls, firstCalls, 'второй вызов не добавил ни одного обращения');
});

test('без идентичности портала кэш не применяется — поведение прежнее', async () => {
  const counter = { calls: 0 };
  const client = makeClient(counter);
  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '77', context: {} });
  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '77', context: {} });
  assert.equal(counter.calls, 8, 'оба раза по 4 вызова, кэш не сработал');
});
```

- [ ] **Шаг 8: Прогнать весь набор тестов**

```bash
cd backends/node/api && npm test
```

Ожидается: все прежние тесты зелёные плюс новые. Если покраснел какой-то существующий тест `readRequiredPhotos` — разбираться в нём, **не переписывать тест под новое поведение**: контракт функции меняться не должен.

- [ ] **Шаг 9: Коммит**

```bash
git add backends/node/api/src/reports/requiredPhotosCache.js backends/node/api/tests/requiredPhotosCache.test.js backends/node/api/src/reports/reportsRoutes.js
git commit -m "perf(PHOTO): кэш набора и типов фото — 2 вызова Битрикса на снимок вместо 44"
```

---

### Task 2: Схема — состояние публикации, два времени, таблица байтов

**Files:**
- Modify: `backends/node/api/src/reports/reportsStore.js` (`ensurePhotoSchema`, ~строка 75, и MySQL-вариант ~строка 526)
- Test: `backends/node/api/tests/photoPublishSchema.test.js`

**Interfaces:**
- Produces: колонки `report_photo.publish_state TEXT NOT NULL DEFAULT 'published'`, `report_photo.published_at TIMESTAMPTZ NULL`, `report_photo.publish_attempts INT NOT NULL DEFAULT 0`, `report_photo.next_attempt_at TIMESTAMPTZ NULL`, `report_photo.last_publish_error TEXT NULL`; колонка `report.operator_completed_at TIMESTAMPTZ NULL`; таблица `report_photo_blob`.

**Почему `DEFAULT 'published'`, а не `'accepted'`:** в таблице уже лежат строки, которые попали туда ПОСЛЕ успешной загрузки в Битрикс — они опубликованы по факту. Дефолт `'accepted'` поставил бы весь исторический архив в очередь на повторную публикацию и устроил бы ровно тот шторм, который мы лечим. Новые строки проставляют `'accepted'` явно.

- [ ] **Шаг 1: Написать падающий тест**

Создать `backends/node/api/tests/photoPublishSchema.test.js`:

```js
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
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoPublishSchema.test.js
```

Ожидается: провал на первом же `assert.match` — таблицы и колонок нет.

- [ ] **Шаг 3: Расширить `ensurePhotoSchema` (PostgreSQL)**

В `backends/node/api/src/reports/reportsStore.js` дописать в конец `ensurePhotoSchema` (после существующего `ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS disk_object_id`):

```js
    // Очередь публикации живёт прямо в report_photo, отдельной таблицы задач
    // нет: состояние фото и состояние его публикации — один и тот же факт, и
    // разносить их значит заводить второй источник правды и рассинхрон.
    //
    // DEFAULT 'published' намеренно: строки, уже лежащие в таблице, попали
    // сюда ПОСЛЕ успешной загрузки в Битрикс. Дефолт 'accepted' поставил бы
    // весь исторический архив в очередь на повторную публикацию — то есть
    // устроил бы ровно тот шторм запросов, который эта задача и лечит.
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS publish_state TEXT NOT NULL DEFAULT 'published'
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS publish_attempts INT NOT NULL DEFAULT 0
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL
    `);
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS last_publish_error TEXT NULL
    `);
    // Частичный индекс: в очереди всегда меньшинство строк, а сканировать
    // весь архив опубликованных на каждый тик воркера незачем.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_report_photo_publish_due
        ON report_photo (next_attempt_at)
        WHERE publish_state = 'accepted'
    `);
    // Байты отдельной таблицей: обычные выборки по фото не должны тянуть
    // мегабайты, а удаление байтов после публикации не должно трогать
    // метаданные, на которые ссылается фотолента.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_photo_blob (
        report_photo_id BIGINT PRIMARY KEY REFERENCES report_photo(id) ON DELETE CASCADE,
        content         BYTEA NOT NULL,
        mime_type       TEXT  NOT NULL,
        byte_size       INT   NOT NULL,
        original_name   TEXT  NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Локальное состояние отчёта.
    //
    // ОТДЕЛЬНОЙ ТАБЛИЦЕЙ, а не колонками в таблице отчётов, потому что
    // локальной таблицы отчётов НЕ СУЩЕСТВУЕТ: сами отчёты живут элементами
    // смарт-процесса в Битриксе, а у нас локальны только report_photo,
    // dispatch_plan, auth_context, app_settings и report_reason. Ключ —
    // report_id, то есть id элемента CRM.
    //
    // Не в dispatch_plan, хотя там есть report_item_id: отчёт можно создать
    // вручную через POST /manual, и тогда строки плана у него нет вовсе.
    //
    // required_photo_codes — JSON-массив кодов. Нужен затем, что приём фото
    // не имеет права зависеть от Битрикса ВООБЩЕ. Кэш в памяти этого не даёт:
    // после рестарта процесса он пуст, и первый же снимок пошёл бы в портал
    // за списком — то есть приём падал бы ровно тогда, когда портал лежит.
    // Заполняется при открытии карточки отчёта, когда список уже получен и
    // оплачен, и дальше читается из нашей БД.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_local_state (
        report_id             BIGINT PRIMARY KEY,
        operator_completed_at TIMESTAMPTZ NULL,
        required_photo_codes  TEXT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Слот не проверен против Битрикса: список не был известен в момент
    // приёма. Фото всё равно принято — проверка отложена до публикации.
    await pool.query(`
      ALTER TABLE report_photo ADD COLUMN IF NOT EXISTS slot_verified BOOLEAN NOT NULL DEFAULT TRUE
    `);
```

- [ ] **Шаг 4: Тот же набор для MySQL-варианта**

В MySQL-варианте (`ensurePhotoSchema` около строки 526) `ADD COLUMN IF NOT EXISTS` не поддерживается — там уже используется проверка через `INFORMATION_SCHEMA` (см. существующий код для `disk_object_id`). Повторить этот же приём для каждой новой колонки, а таблицу байтов создать как:

```js
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_photo_blob (
        report_photo_id BIGINT PRIMARY KEY,
        content         LONGBLOB NOT NULL,
        mime_type       VARCHAR(128) NOT NULL,
        byte_size       INT NOT NULL,
        original_name   VARCHAR(512) NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_report_photo_blob FOREIGN KEY (report_photo_id)
          REFERENCES report_photo(id) ON DELETE CASCADE
      )
    `);
```

- [ ] **Шаг 5: Прогнать тесты**

```bash
cd backends/node/api && npm test
```

Ожидается: новый файл зелёный, прежние не сломаны.

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/reports/reportsStore.js backends/node/api/tests/photoPublishSchema.test.js
git commit -m "feat(PHOTO): схема очереди публикации — состояние, два времени, таблица байтов"
```

---

### Task 3: Ограничитель темпа

Чистый токен-бакет: без него очередь опустошается на максимальной скорости — ровно так, как это делает `crmSyncWorker.drain()` сегодня.

**Files:**
- Create: `backends/node/api/src/shared/rateLimiter.js`
- Create: `backends/node/api/tests/rateLimiter.test.js`

**Interfaces:**
- Produces: `createRateLimiter({ ratePerSec, burst, now, sleep }) -> { acquire(): Promise<void>, penalize(ms): void, available(): number }`

- [ ] **Шаг 1: Написать падающий тест**

Создать `backends/node/api/tests/rateLimiter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/shared/rateLimiter.js';

const makeHarness = () => {
  let clock = 0;
  const sleeps = [];
  return {
    now: () => clock,
    advance: (ms) => { clock += ms; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    sleeps
  };
};

test('первые burst обращений проходят без ожидания', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 1.4, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(h.sleeps, [], 'запаса хватило на три');
});

test('четвёртое обращение ждёт пополнения', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.sleeps[0], 500, 'при 2/с один токен копится 500 мс');
});

test('токены копятся со временем, но не выше burst', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  h.advance(60_000);
  assert.equal(limiter.available(), 3, 'за минуту накопилось бы 120, но потолок — burst');
});

test('penalize замораживает выдачу на указанный срок', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 5, now: h.now, sleep: h.sleep });
  limiter.penalize(3000);
  await limiter.acquire();
  assert.equal(h.sleeps[0], 3000, 'Retry-After от портала важнее накопленных токенов');
});

test('penalize не сокращает уже назначенную паузу', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 5, now: h.now, sleep: h.sleep });
  limiter.penalize(5000);
  limiter.penalize(1000);
  await limiter.acquire();
  assert.equal(h.sleeps[0], 5000, 'вторая, более мягкая пауза не отменяет первую');
});

test('ограничитель общий: два потребителя делят один бюджет', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 2, now: h.now, sleep: h.sleep });
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.equal(h.sleeps.length, 1, 'третий подождал, хотя пришёл из другого воркера');
});
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/rateLimiter.test.js
```

Ожидается: `ERR_MODULE_NOT_FOUND`.

- [ ] **Шаг 3: Реализовать**

Создать `backends/node/api/src/shared/rateLimiter.js`:

```js
// Токен-бакет для общего темпа обращений к порталу.
//
// Зачем отдельным модулем и почему общий: сегодня темпом не управляет никто —
// каждый телефон и каждый воркер гонят свои цепочки, не зная друг о друге, а
// лимит портала (2 запроса в секунду) общий. Существующий crmSyncWorker.drain()
// вообще крутит tick() без пауз. Этот объект — единственное место, где виден
// суммарный расход, поэтому экземпляр обязан быть ОДИН на процесс и делиться
// между всеми воркерами.
//
// acquire() последовательно сериализует ожидающих через цепочку промисов:
// без этого два одновременных вызова оба увидели бы «токен есть» и выпустили
// бы два запроса на один токен.

export const createRateLimiter = ({
  ratePerSec = 1.4,
  burst = 3,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) => {
  if (!(ratePerSec > 0)) throw new Error('ratePerSec must be positive');
  if (!(burst > 0)) throw new Error('burst must be positive');

  let tokens = burst;
  let lastRefillAt = now();
  let frozenUntil = 0;
  let queue = Promise.resolve();

  const refill = () => {
    const at = now();
    const elapsedMs = at - lastRefillAt;
    if (elapsedMs > 0) {
      tokens = Math.min(burst, tokens + (elapsedMs / 1000) * ratePerSec);
      lastRefillAt = at;
    }
  };

  const takeOne = async () => {
    refill();

    // Штраф от портала (Retry-After) важнее накопленных токенов: продолжать
    // слать в этот момент — усиливать давление ровно тогда, когда портал
    // просит его снизить.
    const freezeMs = frozenUntil - now();
    if (freezeMs > 0) {
      await sleep(freezeMs);
      refill();
    }

    if (tokens < 1) {
      const waitMs = Math.ceil(((1 - tokens) / ratePerSec) * 1000);
      await sleep(waitMs);
      refill();
    }
    tokens -= 1;
  };

  return {
    // Сериализация обязательна: параллельные acquire() без неё оба увидели бы
    // один и тот же запас и выпустили бы два запроса на один токен.
    acquire() {
      const next = queue.then(takeOne, takeOne);
      queue = next.catch(() => {});
      return next;
    },
    // Только продлевает заморозку, никогда не сокращает: более мягкий ответ
    // от другого запроса не должен отменять более строгий.
    penalize(ms) {
      const until = now() + Math.max(0, Number(ms) || 0);
      if (until > frozenUntil) frozenUntil = until;
    },
    available() {
      refill();
      return tokens;
    }
  };
};

export default createRateLimiter;
```

- [ ] **Шаг 4: Запустить тесты**

```bash
cd backends/node/api && node --test tests/rateLimiter.test.js
```

Ожидается: 6 passing.

- [ ] **Шаг 5: Мутационная проверка**

| Мутация | Какой тест обязан упасть |
|---|---|
| Убрать `Math.min(burst, ...)` в `refill` | «не выше burst» |
| В `penalize` заменить условие на безусловное `frozenUntil = until` | «не сокращает уже назначенную паузу» |
| В `acquire` вызывать `takeOne()` напрямую, без `queue` | «два потребителя делят один бюджет» |
| Убрать блок `if (freezeMs > 0)` | «penalize замораживает выдачу» |

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/shared/rateLimiter.js backends/node/api/tests/rateLimiter.test.js
git commit -m "feat(PHOTO): общий токен-бакет темпа обращений к порталу"
```

---

### Task 4: Стор очереди

**Files:**
- Create: `backends/node/api/src/reports/photoQueueStore.js`
- Create: `backends/node/api/tests/photoQueueStore.test.js`

**Interfaces:**
- Produces: `createPhotoQueueStore({ pool, dbType }) -> { accept, claimBatch, markPublished, reschedule, markFailed, reclaimStale, countByState, listStuck, purgePublishedBlobs }`
  - `accept({ reportId, photoCode, uploadedBy, exifAt, content, mimeType, originalName }) -> { id }`
  - `claimBatch({ limit, now }) -> Array<{ id, report_id, photo_code, publish_attempts, content, mime_type, original_name, exif_at }>`
  - `markPublished({ id, fileId, fileName, diskFolderId, diskObjectId }) -> void`
  - `reschedule({ id, nextAttemptAt, error }) -> void`
  - `markFailed({ id, error }) -> void`
  - `reclaimStale({ staleMs }) -> number`
  - `listStuck({ olderThanMs, limit }) -> Array<{ id, report_id, photo_code, publish_attempts, last_publish_error, uploaded_at }>`
  - `purgePublishedBlobs({ olderThanMs }) -> number`

- [ ] **Шаг 1: Написать падающий тест**

Создать `backends/node/api/tests/photoQueueStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoQueueStore } from '../src/reports/photoQueueStore.js';

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
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoQueueStore.test.js
```

- [ ] **Шаг 3: Реализовать PostgreSQL-вариант**

Создать `backends/node/api/src/reports/photoQueueStore.js`. Ключевой метод:

```js
// Очередь публикации поверх report_photo.
//
// FOR UPDATE SKIP LOCKED, а не SELECT-затем-UPDATE как в crmSyncJobStore:
// у нас три воркера в процессе и потенциально несколько экземпляров
// приложения на Timeweb. Гонка «оба увидели строку и оба взяли» дала бы
// двойную публикацию одного файла и двойной расход бюджета портала.
//
// Байты приезжают тем же запросом (JOIN report_photo_blob): отдельный поход
// за содержимым удвоил бы число обращений к БД на каждую задачу.

  async claimBatch({ limit = 3, now = new Date() } = {}) {
    const result = await pool.query(
      `WITH due AS (
         SELECT rp.id
           FROM report_photo rp
          WHERE rp.publish_state = 'accepted'
            AND (rp.next_attempt_at IS NULL OR rp.next_attempt_at <= $1)
          ORDER BY rp.uploaded_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE report_photo rp
          SET next_attempt_at = $1 + INTERVAL '5 minutes',
              updated_at = NOW()
         FROM due
         JOIN report_photo_blob b ON b.report_photo_id = due.id
        WHERE rp.id = due.id
       RETURNING rp.id, rp.report_id, rp.photo_code, rp.publish_attempts, rp.exif_at,
                 rp.slot_verified, b.content, b.mime_type, b.original_name`,
      [now, limit]
    );
    // Сдвиг next_attempt_at на 5 минут в момент взятия — аренда задачи:
    // если процесс умрёт с задачей в руках, она сама вернётся в оборот через
    // пять минут, без отдельного статуса 'running' и без reclaimStale на
    // старте (который в crmSyncWorker существует ровно потому, что там
    // статус 'running' некому снять после падения).
    //
    // JOIN, а не LEFT JOIN, намеренно: фото без байтов опубликовать нечем.
    // Такая строка — уже дефект (байты удалены раньше срока или приём
    // прервался между вставками), и её место у сторожа, а не в очереди, где
    // она вечно бралась бы и вечно падала.
    return result.rows;
  },
```

Остальные методы — по образцу `crmSyncJobStore.js`, включая MySQL-вариант. В MySQL `FOR UPDATE SKIP LOCKED` поддерживается с 8.0; для более старых версий вернуть прежний приём SELECT-затем-UPDATE с проверкой `affectedRows`.

**Дополнительный тест к шагу 1** — про строки без байтов, раз JOIN их отбрасывает молча:

```js
test('фото без байтов не попадает в очередь, но и не теряется', async () => {
  // claimBatch не возвращает такую строку (JOIN её отбрасывает),
  // а listStuck — возвращает, чтобы сторож о ней сообщил
  const pool = makeFakePool([{ rows: [] }]);
  const store = createPhotoQueueStore({ pool, dbType: 'postgres' });
  await store.listStuck({ olderThanMs: 0, limit: 10 });
  assert.match(pool.calls[0].sql, /LEFT JOIN report_photo_blob/,
    'сторож обязан видеть фото, у которого пропали байты');
});
```

- [ ] **Шаг 4: Прогнать тесты, добиться зелёного**

```bash
cd backends/node/api && npm test
```

- [ ] **Шаг 5: Мутационная проверка**

| Мутация | Какой тест обязан упасть |
|---|---|
| Убрать `SKIP LOCKED` | «два экземпляра не возьмут одну» |
| Убрать условие `next_attempt_at <= $1` | «не берёт задачи, чей срок не наступил» |
| В `markPublished` дописать `DELETE FROM report_photo_blob` | «не трогает байты» |
| В `purgePublishedBlobs` убрать `publish_state = 'published'` | «чистит только опубликованные» |

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/reports/photoQueueStore.js backends/node/api/tests/photoQueueStore.test.js
git commit -m "feat(PHOTO): стор очереди публикации с арендой задач через SKIP LOCKED"
```

---

### Task 5: Приём фото в базу без единого вызова Битрикса

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js:1598-1799` (обработчик `POST /:id/photo`)
- Test: `backends/node/api/tests/photoAcceptRoute.test.js`

**Interfaces:**
- Consumes: `photoQueueStore.accept(...)` из Task 4, `report.required_photo_codes` из Task 2.
- Produces: ответ `{ item: { reportId, photoCode, publishState: 'accepted', accepted: true, uploadedCount, requiredCount, requiredPhotos } }`. Поля `fileId`, `diskObjectId`, `folderId` в ответе становятся `null` — фронт обязан перестать на них рассчитывать.

**Приём обязан пережить полную недоступность Битрикса.** Это критерий приёмки задачи, а не пожелание. Поэтому список требуемых фото берётся **из нашей БД** (`report.required_photo_codes`, заполняется при открытии карточки отчёта), а не из портала и даже не из кэша в памяти: кэш пуст после каждого рестарта процесса, и первый снимок снова пошёл бы в портал.

Три уровня, строго в этом порядке:

| Источник списка | Когда | Что делаем |
|---|---|---|
| `report.required_photo_codes` | обычный случай | проверяем слот локально, `slot_verified = TRUE` |
| Кэш в памяти (Task 1) | колонка пуста, кэш прогрет | проверяем, заодно заполняем колонку |
| — | колонка пуста, кэш пуст | **принимаем фото**, `slot_verified = FALSE`, проверка при публикации |

В третьем случае мы сознательно принимаем фото на непроверенный слот. Цена ошибки несимметрична: непроверенный слот всплывёт при публикации и попадёт к сторожу, а отказ в приёме — это несданная смена у живого человека из-за чужой поломки.

- [ ] **Шаг 1: Написать падающий тест**

Создать `backends/node/api/tests/photoAcceptRoute.test.js` с проверками:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// Собираем роутер с поддельными зависимостями; образец сборки — существующий
// tests/reasonRoutes.test.js.

test('приём фото не делает НИ ОДНОГО вызова Битрикса при прогретом кэше', async () => {
  // прогреть кэш первой загрузкой, затем обнулить счётчик и загрузить второе
  // фото; assert.equal(bitrixCalls, 0)
});

test('байты попадают в report_photo_blob до ответа телефону', async () => {
  // assert: accept() вызван с content, и вызван ДО res.json
});

test('ответ приходит со статусом accepted, а не published', async () => {
  // assert.equal(body.item.publishState, 'accepted')
});

test('валидация EXIF по-прежнему синхронная и отвергает старое фото', async () => {
  // assert.equal(status, 400); assert.equal(body.errorCode, 'photo_exif_too_old')
  // и accept() НЕ вызван
});

test('недоступность Битрикса больше не мешает принять фото', async () => {
  // bitrixClient бросает на любом методе -> всё равно 200 и accept() вызван
});

test('после рестарта процесса приём работает при лежащем Битриксе', async () => {
  // кэш в памяти ПУСТ, report.required_photo_codes заполнена, bitrixClient бросает
  // -> 200, accept() вызван, slotVerified=true
  // Это и есть причина, по которой список дублируется в БД, а не только в кэше.
});

test('список неизвестен и Битрикс лежит — фото всё равно принимается', async () => {
  // кэш пуст, required_photo_codes NULL, bitrixClient бросает
  // -> 200, accept() вызван со slotVerified=false
  assert.equal(status, 200, 'отказ здесь = несданная смена у человека из-за чужой поломки');
});

test('открытие карточки отчёта заполняет required_photo_codes', async () => {
  // GET /:id при живом Битриксе -> setRequiredPhotoCodes вызван
});
```

Реализующий обязан дописать тела тестов реальным кодом сборки роутера — **заглушки-комментарии в коммит не идут**.

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoAcceptRoute.test.js
```

- [ ] **Шаг 3: Переписать обработчик**

Из тела `router.post('/:id/photo', ...)` **удаляются**: `ensureRootFolder`, `uploadPhoto`, `brandStore.getBrandByAzsId`, `reportsStore.upsertPhoto` с данными Диска и `crmSyncJobStore.enqueue`. **Остаются** и выполняются синхронно: проверка прав, `normalizePhotoCode`, `isSupportedPhotoUpload`, `getById`, `ensureCurrentUserOwnsReport`, `readRequiredPhotos` (теперь из кэша), проверка `requiredCodes.includes(photoCode)`, разбор и валидация EXIF.

Вместо удалённого:

```js
      // Байты — в нашу БД, и на этом синхронная часть кончается. Ни одного
      // вызова Битрикса: именно ожидание этих вызовов телефон и не переживал,
      // упираясь в UPLOAD_TIMEOUT_MS = 55_000.
      await photoQueueStore.accept({
        reportId,
        photoCode,
        uploadedBy: currentUserId,
        exifAt: exifValidation.exifAt,
        content: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname
      });

      const currentPhotos = await reportsStore.listPhotos(reportId);
      const uploadedCodes = new Set(currentPhotos.map((photo) => normalizePhotoCode(photo.photoCode)));
      await reportsStore.setReportStatus({ reportId, status: 'in_progress' });

      return res.json({
        item: {
          reportId,
          photoCode,
          publishState: 'accepted',
          accepted: true,
          status: 'in_progress',
          completed: false,
          allUploaded: requiredCodes.every((code) => uploadedCodes.has(code)),
          uploadedCount: uploadedCodes.size,
          requiredCount: requiredCodes.length,
          requiredPhotos
        }
      });
```

- [ ] **Шаг 4: Прогнать тесты**

```bash
cd backends/node/api && npm test
```

Существующие тесты загрузки, ожидающие `fileId` в ответе, покраснеют. Это ожидаемо: контракт изменился намеренно. **Каждый такой тест правится осознанно и перечисляется в отчёте** — молчаливое «поправил тесты» неприемлемо.

- [ ] **Шаг 5: Коммит**

```bash
git add backends/node/api/src/reports/reportsRoutes.js backends/node/api/tests/photoAcceptRoute.test.js
git commit -m "feat(PHOTO): приём фото в БД без вызовов Битрикса"
```

---

### Task 6: Публикация одного фото и таксономия отказов

**Files:**
- Create: `backends/node/api/src/reports/photoPublisher.js`
- Create: `backends/node/api/tests/photoPublisher.test.js`

**Interfaces:**
- Produces:
  - `classifyPublishError(error) -> 'retryable' | 'permanent'`
  - `createPhotoPublisher({ bitrixClient, settingsStore, reportsStore, brandStore, folderIdCache, limiter, resolveContext }) -> { publishOne(task): Promise<{ fileId, fileName, diskFolderId, diskObjectId }> }`

**Правило по умолчанию — повторять.** Неизвестная ошибка считается временной. Неверная догадка в сторону «повторять» стоит лишних попыток; в сторону «отказ навсегда» — стоит потерянного фото, а это главный анти-гол спеки. В `permanent` попадает только явный список, снятый с живого портала.

- [ ] **Шаг 1: Написать падающий тест**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPublishError } from '../src/reports/photoPublisher.js';

test('неизвестная ошибка считается временной — потерять фото хуже, чем повторить', () => {
  assert.equal(classifyPublishError(new Error('нечто невиданное')), 'retryable');
});

test('сетевые и 5xx — временные', () => {
  for (const err of [
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('gateway'), { statusCode: 502 }),
    Object.assign(new Error('limit'), { statusCode: 503, bitrixError: 'QUERY_LIMIT_EXCEEDED' })
  ]) {
    assert.equal(classifyPublishError(err), 'retryable', err.message);
  }
});

test('протухший токен — временный: он обновится сам', () => {
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'expired_token' })), 'retryable');
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'wrong_client' })), 'retryable');
});

test('исчерпанная квота Диска — окончательный отказ, нужен человек', () => {
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'DISK_QUOTA_EXCEEDED' })), 'permanent');
});

test('QUERY_LIMIT_EXCEEDED никогда не окончательный — это просьба подождать', () => {
  const err = Object.assign(new Error('x'), { statusCode: 503, bitrixError: 'QUERY_LIMIT_EXCEEDED' });
  assert.equal(classifyPublishError(err), 'retryable');
});

test('publishOne берёт токен у ограничителя перед КАЖДЫМ вызовом Битрикса', async () => {
  // поддельный limiter считает acquire(); поддельный diskApi считает вызовы;
  // assert.equal(limiter.acquired, diskApi.calls)
});
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoPublisher.test.js
```

- [ ] **Шаг 3: Реализовать**

`classifyPublishError` — явный список окончательных, всё прочее временное:

```js
// Список снят с живого портала, а не из документации: в этом проекте догадки
// по документации уже дважды приводили к неверным допущениям. Пополнять его
// можно только по наблюдённой в проде ошибке.
const PERMANENT_BITRIX_ERRORS = new Set([
  'DISK_QUOTA_EXCEEDED',
  'ERROR_NOT_FOUND_FOLDER',
  'ACCESS_DENIED'
]);

export const classifyPublishError = (error) => {
  const bitrixError = String(error?.bitrixError || error?.error || '').trim();
  if (bitrixError && PERMANENT_BITRIX_ERRORS.has(bitrixError)) return 'permanent';
  // Умышленный дефолт. Неверная догадка «повторить» стоит лишних попыток;
  // неверная догадка «отказ навсегда» стоит потерянного фото — а невидимая
  // потеря вместо видимого отказа и есть главный анти-гол этой затеи.
  return 'retryable';
};
```

`publishOne` — та же цепочка, что была в обработчике (корневая папка → `uploadPhoto` с `folderIdCache`), но перед каждым обращением к Битриксу вызывается `await limiter.acquire()`, а при ошибке с `retryAfterMs` — `limiter.penalize(error.retryAfterMs)`.

- [ ] **Шаг 4: Тесты зелёные**

```bash
cd backends/node/api && npm test
```

- [ ] **Шаг 5: Мутационная проверка**

| Мутация | Какой тест обязан упасть |
|---|---|
| Дефолт `classifyPublishError` заменить на `'permanent'` | «неизвестная ошибка временная» |
| Добавить `QUERY_LIMIT_EXCEEDED` в `PERMANENT_BITRIX_ERRORS` | «никогда не окончательный» |
| Убрать `await limiter.acquire()` перед вызовом | «берёт токен перед каждым вызовом» |

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/reports/photoPublisher.js backends/node/api/tests/photoPublisher.test.js
git commit -m "feat(PHOTO): публикация фото под ограничителем темпа, неизвестная ошибка — временная"
```

---

### Task 7: Пул воркеров под advisory-локом

**Files:**
- Create: `backends/node/api/src/reports/photoPublishWorker.js`
- Create: `backends/node/api/tests/photoPublishWorker.test.js`

**Interfaces:**
- Produces: `createPhotoPublishWorker({ store, publishOne, limiter, pool, workers, backoffMs, maxAttempts, pollIntervalMs, now, logger }) -> { tick, start, stop, isLeader }`

**Advisory-лок — то, чего в проекте ещё нет.** На Timeweb приложение может подняться в нескольких экземплярах, и тогда три воркера превратятся в 3×M, а общий ограничитель темпа — в M независимых ограничителей. Ограничитель живёт в памяти процесса и физически не может видеть чужой. `pg_try_advisory_lock` даёт ровно одного лидера на всю базу: остальные экземпляры принимают фото (это дёшево и параллелится), но не публикуют. Лок снимается сам при обрыве соединения, поэтому смерть лидера не требует ручного вмешательства.

- [ ] **Шаг 1: Написать падающий тест**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoPublishWorker } from '../src/reports/photoPublishWorker.js';

const makeStore = (batches) => ({
  claimed: [], published: [], rescheduled: [], failed: [],
  async claimBatch() { return batches.shift() ?? []; },
  async markPublished(args) { this.published.push(args); },
  async reschedule(args) { this.rescheduled.push(args); },
  async markFailed(args) { this.failed.push(args); }
});

const okPool = { async query() { return { rows: [{ locked: true }] }; } };
const busyPool = { async query() { return { rows: [{ locked: false }] }; } };

test('без advisory-лока воркер не публикует ничего', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: busyPool, publishOne: async () => ({ fileId: 1 }),
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.published.length, 0, 'второй экземпляр обязан молчать');
  assert.equal(worker.isLeader(), false);
});

test('успех переводит фото в published', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => ({ fileId: 7, fileName: 'a.jpg', diskFolderId: 2, diskObjectId: 3 }),
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.published[0].id, 1);
  assert.equal(store.published[0].fileId, 7);
});

test('временная ошибка переносит попытку с растущей паузой', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 1 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, backoffMs: [1000, 5000, 20000], now: () => 0,
    publishOne: async () => { throw new Error('temporary'); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed.length, 0);
  assert.equal(store.rescheduled[0].nextAttemptAt.getTime(), 5000, 'вторая попытка — вторая пауза');
});

test('исчерпание попыток переводит в failed', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 9 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, maxAttempts: 10,
    publishOne: async () => { throw new Error('still failing'); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed[0].id, 1);
});

test('окончательная ошибка не тратит оставшиеся попытки', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool, maxAttempts: 10,
    publishOne: async () => { throw Object.assign(new Error('quota'), { bitrixError: 'DISK_QUOTA_EXCEEDED' }); },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.failed.length, 1, 'сразу failed, без девяти бесполезных повторов');
  assert.equal(store.rescheduled.length, 0);
});

test('Retry-After от портала уходит в ограничитель, а не только в паузу задачи', async () => {
  const penalties = [];
  const store = makeStore([[{ id: 1, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async () => { throw Object.assign(new Error('limit'), { statusCode: 503, retryAfterMs: 4000 }); },
    limiter: { acquire: async () => {}, penalize: (ms) => penalties.push(ms) }
  });
  await worker.tick();
  assert.deepEqual(penalties, [4000],
    'иначе остальные два воркера продолжат долбить портал, который попросил паузу');
});

test('падение одной задачи не отменяет остальные в пачке', async () => {
  const store = makeStore([[{ id: 1, publish_attempts: 0 }, { id: 2, publish_attempts: 0 }]]);
  const worker = createPhotoPublishWorker({
    store, pool: okPool,
    publishOne: async (task) => {
      if (task.id === 1) throw new Error('boom');
      return { fileId: 22 };
    },
    limiter: { acquire: async () => {}, penalize() {} }
  });
  await worker.tick();
  assert.equal(store.rescheduled.length, 1);
  assert.equal(store.published.length, 1, 'вторая задача опубликована несмотря на первую');
});
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoPublishWorker.test.js
```

- [ ] **Шаг 3: Реализовать**

Ключевые куски:

```js
// Один лидер на всю базу. Число — произвольная, но постоянная константа:
// пространство advisory-локов общее на всю базу, поэтому оно должно быть
// уникальным среди всего, что мы когда-либо залочим.
const ADVISORY_LOCK_KEY = 776_100_301;

const tryBecomeLeader = async () => {
  const result = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
  return Boolean(result?.rows?.[0]?.locked);
};
```

`tick()`: взять лидерство → `claimBatch({ limit: workers })` → обработать задачи через `Promise.allSettled` (падение одной не отменяет остальные) → по каждой: успех `markPublished`; ошибка с `retryAfterMs` → `limiter.penalize`; `classifyPublishError === 'permanent'` или `attempts + 1 >= maxAttempts` → `markFailed`; иначе `reschedule` с `backoffMs[min(attempts, len-1)]`.

Дефолты: `workers = 3`, `backoffMs = [5_000, 30_000, 120_000, 600_000]`, `maxAttempts = 8`, `pollIntervalMs = 2_000`.

**Паузы длиннее клиентских `[800, 1600, 3200]` намеренно.** Тот график усиливал давление ровно тогда, когда портал просил его снизить. Здесь торопиться некуда: оператор уже свободен, дедлайн считается по `operator_completed_at`.

- [ ] **Шаг 4: Тесты зелёные**

```bash
cd backends/node/api && npm test
```

- [ ] **Шаг 5: Мутационная проверка**

| Мутация | Какой тест обязан упасть |
|---|---|
| Игнорировать результат `pg_try_advisory_lock` | «без advisory-лока не публикует» |
| Убрать `limiter.penalize` при `retryAfterMs` | «Retry-After уходит в ограничитель» |
| Заменить `Promise.allSettled` на `Promise.all` | «падение одной не отменяет остальные» |
| Убрать ветку `permanent` | «не тратит оставшиеся попытки» |

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/reports/photoPublishWorker.js backends/node/api/tests/photoPublishWorker.test.js
git commit -m "feat(PHOTO): пул воркеров публикации под advisory-локом Postgres"
```

---

### Task 8: `operator_completed_at` и перевод отчёта в «сдан»

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js:1801` (`POST /:id/submit`)
- Modify: `backends/node/api/src/reports/photoPublishWorker.js` (после успеха проверить, все ли обязательные опубликованы)
- Test: `backends/node/api/tests/photoPublishCompletion.test.js`

**Interfaces:**
- Consumes: `reportsStore.setOperatorCompletedAt({ reportId, at })`, `photoQueueStore.countByState({ reportId })`.
- Produces: отчёт уходит в CRM через существующий `crmSyncJobStore.enqueue` — **не напрямую**, чтобы у перевода статуса остались повторы и переживание рестарта.

- [ ] **Шаг 1: Написать падающий тест**

```js
test('submit проставляет operator_completed_at даже когда фото ещё не опубликованы', async () => {
  // все фото в accepted -> setOperatorCompletedAt вызван, ответ 200
});

test('дедлайн считается по operator_completed_at, а не по published_at', async () => {
  // оператор закончил в 09:59, публикация в 10:05 -> отчёт сдан вовремя
});

test('отчёт уходит в CRM только когда опубликованы ВСЕ обязательные', async () => {
  // 39 из 40 published -> enqueue не вызван; 40 из 40 -> вызван ровно один раз
});

test('повторная публикация последнего фото не ставит вторую задачу в CRM', async () => {
  // идемпотентность: второй проход при полном комплекте -> enqueue не вызван
});
```

- [ ] **Шаг 2: Запустить, убедиться в падении**

```bash
cd backends/node/api && node --test tests/photoPublishCompletion.test.js
```

- [ ] **Шаг 3: Реализовать**

В `POST /:id/submit` снять требование «все фото загружены в Битрикс» и заменить на «все обязательные приняты» (`publish_state IN ('accepted','published')`), проставив `operator_completed_at = NOW()`.

В воркере после `markPublished` — проверка комплекта и постановка задачи в CRM.

- [ ] **Шаг 4–5: Тесты и мутационная проверка**

```bash
cd backends/node/api && npm test
```

| Мутация | Какой тест обязан упасть |
|---|---|
| Считать комплект по `published` в `/submit` | «проставляет даже когда не опубликованы» |
| Ставить задачу в CRM при неполном комплекте | «только когда опубликованы ВСЕ» |

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/src/reports/reportsRoutes.js backends/node/api/src/reports/photoPublishWorker.js backends/node/api/tests/photoPublishCompletion.test.js
git commit -m "feat(PHOTO): дедлайн по времени оператора, отчёт в CRM по полному комплекту"
```

---

### Task 9: Статус «публикуется» для проверяющего

**Обязателен до выката воркера.** Иначе проверяющий откроет отчёт, увидит пустоту и решит, что оператор не сдал — та же несправедливость, ради устранения которой всё затевалось, только с другой стороны.

**Files:**
- Modify: `backends/node/api/src/reports/photoFeedRoutes.js`
- Modify: фотолента во фронте (найти потребителя `photoFeed` — `rg "photoFeed" frontend/app`)
- Test: `backends/node/api/tests/photoFeedPublishState.test.js`

**Interfaces:**
- Produces: каждый элемент фотоленты получает `publishState: 'accepted' | 'published' | 'failed'`.

- [ ] **Шаг 1: Тест**

```js
test('фотолента отдаёт publishState для каждого фото', async () => {
  // assert: у элемента есть publishState
});

test('принятое, но не опубликованное фото не выглядит отсутствующим', async () => {
  // элемент присутствует в ленте с publishState='accepted', а не пропущен
});
```

- [ ] **Шаг 2–4: Реализовать, прогнать**

Добавить `publish_state` в `SELECT` фотоленты, пробросить в ответ, отрисовать во фронте плашкой «Публикуется». **`frontend/nuxt.config.ts` не трогать.**

```bash
cd backends/node/api && npm test
cd ../../../frontend && npm run build
```

Сборка фронта обязательна: в прошлый раз ненайденный автоимпорт вложенной директории `composables/diag/` пережил двенадцать раундов ревью именно потому, что сборку никто не запускал.

- [ ] **Шаг 5: Коммит**

```bash
git add backends/node/api/src/reports/photoFeedRoutes.js backends/node/api/tests/photoFeedPublishState.test.js frontend/app/components
git commit -m "feat(PHOTO): статус «публикуется» в фотоленте проверяющего"
```

---

### Task 10: Сторож застрявших фото

**Обязателен до выката в прод.** Без него мы меняем видимый отказ на невидимую потерю — это главный риск всей затеи. Отсутствие сигнала не есть признак здоровья.

**Files:**
- Create: `backends/node/api/src/reports/photoPublishWatchdog.js`
- Create: `backends/node/api/tests/photoPublishWatchdog.test.js`

**Interfaces:**
- Consumes: `photoQueueStore.listStuck`, `notificationService` / `diagChatNotifier` (образец постановки сообщения в чат — [`diagChatNotifier.js`](../../../backends/node/api/src/diag/diagChatNotifier.js), там же приём резолва id бота в рантайме вместо `BITRIX_BOT_ID`).
- Produces: `createPhotoPublishWatchdog({ store, notify, stuckAfterMs, intervalMs, now, logger }) -> { tick, start, stop }`

Порог: `PHOTO_STUCK_AFTER_MS`, по умолчанию **2 часа** — покрывает полный слив парка (1 ч 13 м при 2/с) с запасом, поэтому нормальная работа сторожа не будит. Чат: `PHOTO_WATCHDOG_CHAT_ID`, по умолчанию тот же `DIAG_CHAT_ID`.

- [ ] **Шаг 1: Тест**

```js
test('молчит, когда застрявших нет', async () => { /* notify не вызван */ });
test('сигналит при фото старше порога', async () => { /* notify вызван с числом и списком АЗС */ });
test('не спамит одним и тем же каждую минуту', async () => {
  // два тика подряд с тем же набором -> ровно один вызов notify
});
test('failed попадает в сигнал сразу, не дожидаясь порога', async () => { /* notify вызван */ });
test('падение отправки в чат не роняет тик', async () => {
  // notify бросает -> tick() резолвится, ошибка залогирована
});
```

- [ ] **Шаг 2–4: Реализовать, прогнать, мутационная проверка**

| Мутация | Какой тест обязан упасть |
|---|---|
| Убрать защиту от повторов | «не спамит одним и тем же» |
| Убрать `try/catch` вокруг `notify` | «падение отправки не роняет тик» |
| Не включать `failed` в выборку | «failed попадает сразу» |

- [ ] **Шаг 5: Коммит**

```bash
git add backends/node/api/src/reports/photoPublishWatchdog.js backends/node/api/tests/photoPublishWatchdog.test.js
git commit -m "feat(PHOTO): сторож застрявших фото — сигнал живому человеку в чат"
```

---

### Task 11: Проводка в `server.js` и защита загрузки

**Files:**
- Modify: `backends/node/api/server.js`
- Test: `backends/node/api/tests/photoQueueBootGuard.test.js`

**Interfaces:**
- Consumes: всё из задач 3, 4, 7, 10.

**Защита загрузки — не формальность.** В прошлый раз `createDiagStore`, бросавший на не-PostgreSQL, едва не сделал приложение незагружаемым целиком. Здесь то же правило: если стор очереди создать не удалось, приложение обязано подняться и продолжать принимать фото прежним синхронным путём, а не упасть.

**Отдельный предохранитель: эфемерная база.** Вся затея держится на том, что БД внешняя и переживает редеплой (`EMBEDDED_POSTGRES=false`, миграция 2026-06-11). На встроенной в контейнер базе редеплой уничтожил бы все принятые, но не опубликованные фото — то есть очередь, задуманная как защита от потери, сама стала бы механизмом потери, и молча. Поэтому при `EMBEDDED_POSTGRES` в истинном значении воркеры и приём байтов **не включаются**, а в лог уходит явный отказ. Громкий отказ вместо тихой катастрофы.

- [ ] **Шаг 1: Тест**

```js
test('приложение поднимается, когда очередь недоступна', async () => {
  // dbType='mysql' на старой версии -> сервер стартует, роуты отвечают
});
test('воркеры не стартуют без стора очереди', async () => { /* start не вызван */ });
test('ограничитель темпа — ОДИН на процесс, общий для всех воркеров', async () => {
  // одна и та же ссылка передана в каждый воркер
});
test('на эфемерной БД очередь не включается вовсе', async () => {
  // EMBEDDED_POSTGRES='true' -> worker.start НЕ вызван, в логе явная причина,
  // приём фото работает прежним синхронным путём
});
test('признак эфемерности читается строго, а не по truthy-строке', async () => {
  // EMBEDDED_POSTGRES='false' -> очередь ВКЛЮЧАЕТСЯ.
  // Строка 'false' истинна в JS — наивная проверка выключила бы очередь в проде
});
```

- [ ] **Шаг 2–3: Реализовать**

Рядом с существующей проводкой `crmSyncWorker` (строки ~1184-1200), тем же приёмом `.then()/.catch()` без top-level `await`:

```js
// ОДИН ограничитель на процесс. Отдельный экземпляр на воркера означал бы
// три независимых бюджета вместо одного общего — то есть втрое превышенный
// предел портала и ровно тот инцидент, который эта задача лечит.
const photoRateLimiter = createRateLimiter({
  ratePerSec: Number(process.env.PHOTO_PUBLISH_RATE_PER_SEC || 1.4),
  burst: Number(process.env.PHOTO_PUBLISH_BURST || 3)
});
```

Далее `photoQueueStore.ensureSchema().then(() => { photoPublishWorker.start(); photoPublishWatchdog.start(); }).catch(...)`, очистка байтов — по существующему приёму крона ретенции диагностики, и `stop()` в блоке завершения рядом с `crmSyncWorker.stop?.()`.

- [ ] **Шаг 4: Прогнать всё**

```bash
cd backends/node/api && npm test
```

- [ ] **Шаг 5: Поднять приложение в Docker и проверить живьём**

Не пропускать. В прошлый раз отсутствие живого запуска пропустило дефект, переживший двенадцать раундов ревью.

- [ ] **Шаг 6: Коммит**

```bash
git add backends/node/api/server.js backends/node/api/tests/photoQueueBootGuard.test.js
git commit -m "feat(PHOTO): проводка очереди, воркеров и сторожа с защитой загрузки"
```

---

### Task 12: Очистка байтов и проверка на реальном объёме

**Files:**
- Modify: `backends/node/api/server.js` (крон очистки)
- Create: `backends/node/api/tests/photoBlobRetention.test.js`

Срок: `PHOTO_BLOB_RETENTION_DAYS`, по умолчанию **7**. Байты удаляются **через N дней после успеха**, не сразу: пока файл свежий, возможность переслать его без участия оператора стоит дороже места.

- [ ] **Шаг 1: Тест**

```js
test('чистит опубликованные старше N дней', async () => { /* ... */ });
test('НИКОГДА не трогает accepted и failed', async () => {
  // это единственная копия ещё не доехавшего файла
});
```

- [ ] **Шаг 2–3: Реализовать и прогнать**

```bash
cd backends/node/api && npm test
```

- [ ] **Шаг 4: Нагрузочная проверка на плановом объёме**

Скриптом залить **2 840 фото** (71 АЗС × 40 слотов) по 101 КБ и замерить:

| Что меряем | Ожидание |
|---|---|
| Время приёма одного фото | без вызовов Битрикса, единицы миллисекунд |
| Обращений к порталу на весь парк | **~8 700**, не 125 000 |
| Фактический темп | **не выше 1,4/с** — главная проверка всей затеи |
| Размер `report_photo_blob` | ~280 МБ |
| Время полного слива | ~1 ч 13 м при 2/с |

Если фактический темп выше 1,4/с — ограничитель не работает, и выкатывать нельзя.

- [ ] **Шаг 5: Коммит**

```bash
git add backends/node/api/server.js backends/node/api/tests/photoBlobRetention.test.js
git commit -m "feat(PHOTO): очистка байтов через N дней после публикации"
```

---

## Порядок выката в прод

Задачи 1–2 выкатываются самостоятельно и сразу дают эффект: кэш снимает четырнадцатикратную нагрузку с портала, схема ничего не меняет в поведении. Задачи 3–8 выкатываются вместе. **Задачи 9 и 10 обязаны быть в проде до того, как воркер начнёт публиковать асинхронно** — иначе проверяющий видит пустой отчёт, а застрявшие фото не видит никто.

## Что осталось открытым

1. `MAX_FILE_BYTES` — 10 МБ при фактических 101 КБ (§5 спеки). На очередь не влияет.
2. Точные строки окончательных ошибок Битрикса — список в Task 6 заведомо неполон и пополняется по наблюдённому в проде. Дефолт «повторять» делает неполноту безопасной.
3. **`batch` — считается ли за один запрос против лимита.** В клиенте не реализован. Если да, слив парка уходит с ~1 ч 13 м к получасу. Снять с заголовков остатка лимита на живом портале до того, как кто-то решит «доработать» ограничитель.
