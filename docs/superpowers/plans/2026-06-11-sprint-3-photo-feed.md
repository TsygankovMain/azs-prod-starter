# Спринт 3 «Фотолента» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Офис быстро находит нужные фото по фильтрам (АЗС / диапазон дат / категория), просматривает их лентой со свайпами, выделяет и пересылает — массово или по одному — в групповой чат или конкретным получателям Битрикс24 с прикреплённым текстом. (Обязательная фича из ТЗ, п.4 «Фильтрация и поиск для последующего анализа», переслано Дмитрием Гуськовым.)

**Architecture:** Бэкенд — три новых эндпоинта поверх существующих данных (`report_photo` + `dispatch_log` уже содержат всё нужное: `disk_object_id`, `photo_code`, EXIF-даты; миграции НЕ нужны). Пересылка — `im.disk.file.commit` (фото уже лежат на Диске Битрикс24, прикрепляем существующие FILE_ID к диалогу с текстом; scope `im` уже используется приложением) с fallback на `imbot.v2.File.upload` (бот, base64) при отказе в доступе. Фронтенд — новая страница «Фотолента» по паттернам R5Wall (сетка+blob-превью) и reviewer (фильтры, мультиселект) + самописный лайтбокс со свайпами.

**Tech Stack:** Node.js 20 ESM (Express 5, существующий `bitrixRestClient` с retry/таймаутами из спринта 1), Nuxt 3 + @bitrix24/b24ui-nuxt (B24Modal/B24Skeleton/useAppToast/useConfirm из спринта 2), node:test.

---

## Параметры спринта

| Параметр | Значение |
|---|---|
| Длительность | 2 недели (при агентском исполнении волнами — как спринты 1–2) |
| Committed объём | ~11.5 человеко-дней (S3-01…S3-07); для ручной разработки одним человеком — 2.5–3 недели, вдвоём (бэк ∥ фронт) — 2 недели |
| База | Ветка после спринтов 1–2 (276 тестов зелёные, toast/confirm/skeleton-инфраструктура готова) |
| Разведка | Отчёт скаута от 2026-06-11 + проверка API по официальной документации Битрикс24 (MCP) |

## Ключевые факты разведки (повторно не проверять)

- **Модель фото:** `report_photo` (`reportsStore.js:41-62`): `report_id`, `photo_code` (= String(id) записи CRM-смарт-процесса `photoType.entityTypeId`), `file_id`, `disk_folder_id`, `disk_object_id`, `exif_at`, `uploaded_at`. Заголовки категорий — `title` CRM-айтемов `photoType` (паттерн чтения — `readRequiredPhotos`, `reportsRoutes.js:321-393`).
- **Выдача картинок:** прокси `GET /api/reports/photos/:reportId/:photoCode/preview` (`analyticsRoutes.js:81-117`) — скачивание с Диска через `fetchWithDownloadTimeout`, `Cache-Control: private, max-age=3600`. Фронт: `apiStore.getPhotoPreviewObjectUrl()` + blob URL (паттерн R5Wall).
- **Фильтры-источники:** `GET /api/reports` поддерживает `dateFrom/dateTo/azsId[]/status/limit` (`reportsRoutes.js:745-780`); `day-photos` — только одна дата; фильтра по категории нет нигде; пагинации нет (limit max 500).
- **Пересылка (проверено по докам):** `im.disk.file.commit` — `CHAT_ID|DIALOG_ID` + `FILE_ID[]` (ID файла на Диске) + `MESSAGE`; batch запрещён (`ERROR_BATCH_METHOD_NOT_ALLOWED`) — слать последовательно; возможен `ACCESS_ERROR` (нет доступа к диалогу/файлу). `imbot.v2.File.upload` — `botId` + `dialogId` + `fields.FILE {name, content(base64, ≤100МБ), message}` — fallback. Бот уже зарегистрирован (`botRegistryService`), личные диалоги ботом уже используются (`notificationService`).
- **Выбор получателей (методы существуют):** `im.recent.get` (последние чаты токен-пользователя), `im.search.chat.list` (поиск чатов по названию/участникам, доступных текущему пользователю), `user.search`. Все вызовы — под admin-контекстом (`getLastAdminContext`, как CRM-синк).
- **Мультиселект-паттерн UI:** чекбокс-список с поиском уже есть (`reviewer.client.vue:481-496, 1181-1242`).
- **Лайтбокса/свайпов в кодовой базе нет** — пишем свой (зависимость не тянем: нужны кастомные пометки и blob-источники).

## Принятые трактовки ТЗ (подтвердить у продакта, см. «Открытые вопросы»)

1. «Пометки (выделение)» = выбор фотографий для пересылки (чекбоксы в сетке и в лайтбоксе), НЕ постоянные метки на фото.
2. «Конкретным получателям» = личные диалоги сотрудников (поиск по имени) и групповые чаты (поиск по названию).

## Бэклог спринта

| ID | Задача | Оценка | Приоритет | Зависимости |
|---|---|---|---|---|
| S3-01 | Бэк: эндпоинт фотоленты с фильтрами и курсорной пагинацией + справочник категорий | 1.5 д | Must | — |
| S3-02 | Бэк: эндпоинт пересылки фото (commit + fallback upload) | 2 д | Must | — |
| S3-03 | Бэк: поиск получателей (чаты + сотрудники) | 1 д | Must | — |
| S3-04 | Фронт: страница «Фотолента» — фильтры, сетка, подгрузка, скелетоны | 2 д | Must | S3-01 |
| S3-05 | Фронт: лайтбокс со свайпами и выделением | 2 д | Must | S3-04 |
| S3-06 | Фронт: мультиселект + drawer пересылки с получателями и текстом | 2 д | Must | S3-02, S3-03, S3-04 |
| S3-07 | Смоук фичи на dev-портале + выбор primary/fallback пересылки по факту | 1 д | Must | все |
| S3-08 | (Stretch) Серверные thumbnails (sharp или PREVIEW-URL Диска) | 1.5 д | Could | S3-01 |
| S3-09 | (Stretch) Сохранение фильтров в query-параметрах | 0.5 д | Could | S3-04 |

**Вне скоупа:** постоянные метки/теги на фото; права доступа к ленте тоньше существующих ролей (лента доступна ролям reviewer/admin); изменение скоупов приложения (im/imbot/disk уже используются); push.

**Волны для агентского исполнения:** W1: S3-01 ∥ S3-02 ∥ S3-03 (бэк, файлы не пересекаются — новые модули + точечные роуты) → W2: S3-04 → W3: S3-05 ∥ S3-06… S3-05 и S3-06 оба правят страницу ленты → последовательно: W3: S3-05, W4: S3-06, W5: S3-07.

---

### Task S3-01: Бэк — фотолента с фильтрами + справочник категорий

**Files:**
- Create: `backends/node/api/src/reports/photoFeedRoutes.js` (или расширение `analyticsRoutes.js` — решить по фактической структуре, предпочтительно отдельный модуль)
- Modify: `backends/node/api/server.js` (подключение роутера), `src/reports/reportsStore.js` (новый метод выборки)
- Test: `backends/node/api/tests/photoFeed.test.js`

**API-контракт:**

```
GET /api/reports/photos/feed?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&azsId[]=12&photoCode[]=1106:55&limit=40&cursor=<opaque>
→ 200 { items: [{ reportId, azsId, azsTitle, photoCode, exifAt, uploadedAt, doneAt }], nextCursor: string|null }

GET /api/reports/photos/categories
→ 200 { items: [{ code, title }] }
```

- [ ] **Step 1: Тест выборки (TDD, фейковый пул в стиле существующих тестов):** фильтры по диапазону дат (по `dispatch_log` дате отчёта), по `azs_id` (массив), по `photo_code` (массив); сортировка новые-сверху; `limit+1`-паттерн курсора (`nextCursor` = последний id связки при наличии следующей страницы; cursor — `${reportId}:${photoCode}` или составной id строки, простая keyset-пагинация по (uploaded_at, id)).
- [ ] **Step 2: Метод стора** — SQL JOIN `report_photo` × `dispatch_log` (обе ветки pg/mysql, по образцу соседних методов `reportsStore`), параметризованные запросы, keyset WHERE для курсора.
- [ ] **Step 3: Роут** — `verifyToken` + `attachAccessContext`, доступ только ролям reviewer/admin (как у `analyticsRoutes` — скопируй фактическую проверку); валидация параметров (limit ≤ 100, даты, массивы); ответ по контракту.
- [ ] **Step 4: Категории** — чтение списка айтемов `photoType.entityTypeId` через `listCrmItems` (паттерн `readRequiredPhotos`), кэш в памяти на 10 мин (категорий мало, меняются редко); ответ `{code: String(id), title}`.
- [ ] **Step 5: Полный прогон** `node --test "tests/*.test.js"` → зелёный. **Commit** `feat(photos): photo feed endpoint with filters/cursor + categories catalog`.

**AC:** фильтры комбинируются; пустые фильтры = вся лента постранично; курсор стабилен при вставках новых фото; категории отдают человеческие названия; неавторизованный/оператор АЗС получает 403.

---

### Task S3-02: Бэк — пересылка фото в диалоги

**Files:**
- Create: `backends/node/api/src/notifications/photoForwardService.js`
- Modify: `backends/node/api/src/dispatch/bitrixRestClient.js` (новые методы-обёртки), `src/reports/photoFeedRoutes.js` (роут), `.env.example`
- Test: `backends/node/api/tests/photoForwardService.test.js`

**API-контракт:**

```
POST /api/reports/photos/forward
{ photos: [{ reportId, photoCode }], recipients: [{ dialogId }], message: string }
→ 200 { results: [{ dialogId, ok, error? }] }
```

- [ ] **Step 1: Методы клиента** в `bitrixRestClient.js`: `commitFilesToDialog({ dialogId, fileIds, message, context })` → `im.disk.file.commit` (`DIALOG_ID`, `FILE_ID: fileIds`, `MESSAGE`); `uploadFileToDialogAsBot({ dialogId, name, contentBase64, message })` → `imbot.v2.File.upload` (botId из `botRegistryService`). Оба — через существующий `callWithTransientRetry` (503/429/таймауты уже обработаны спринтом 1). ВАЖНО: `im.disk.file.commit` нельзя батчить — последовательные вызовы.
- [ ] **Step 2: Сервис (TDD):** по списку `{reportId, photoCode}` достать `disk_object_id`/`file_id`/`file_name` из `report_photo`; для каждого получателя: primary — commit с массивом FILE_ID (один вызов на диалог, admin-контекст через `getLastAdminContext`); при `ACCESS_ERROR` — fallback: для каждого фото `downloadFileContent` → base64 → `uploadFileToDialogAsBot` (текст сообщения — к первому файлу). Частичные сбои не прерывают остальных получателей; результат per-dialog.
- [ ] **Step 3: Тесты:** primary-успех (один commit на диалог, FILE_ID массивом); fallback по ACCESS_ERROR; częściowy сбой одного диалога не ломает другие; пустые photos/recipients → 400; лимит: ≤ 20 фото и ≤ 10 получателей за вызов (валидация, защита от рейт-лимита).
- [ ] **Step 4: Роут** — роли reviewer/admin; лог отправки (`console`/logger в стиле модулей: кто, сколько фото, кому).
- [ ] **Step 5: Полный прогон → зелёный. Commit** `feat(photos): forward photos to Bitrix24 dialogs (disk commit + bot upload fallback)`.

**AC:** один отчётный вызов на диалог в primary-пути; текст прикреплён; fallback задействуется только при отказе доступа; per-dialog статусы честные; rate-limit Битрикса не валит весь запрос (transient-retry).

**Риск (закрывается в S3-07):** доступ admin-токена к файлам папки приложения и к целевым диалогам — проверить на dev-портале; если commit недоступен системно, primary становится bot-upload (решение фиксируется в коде одним флагом `PHOTO_FORWARD_MODE=commit|bot`, в `.env.example`).

---

### Task S3-03: Бэк — поиск получателей

**Files:**
- Create: `backends/node/api/src/notifications/recipientSearchService.js` + роут в `photoFeedRoutes.js`
- Test: `backends/node/api/tests/recipientSearch.test.js`

**API-контракт:**

```
GET /api/im/recipients?q=строка  (q пустой → последние чаты)
→ 200 { items: [{ type: 'chat'|'user', dialogId, title, subtitle? }] }
```

- [ ] **Step 1 (TDD):** при пустом `q` — `im.recent.get` (admin-контекст), маппинг в `{type, dialogId: 'chatXXX'|'NNN', title}`; при `q` — параллельно `im.search.chat.list` (чаты) + `user.search` (`NAME/LAST_NAME`, активные) и слить (чаты первыми), максимум 20.
- [ ] **Step 2:** Дедупликация, фильтрация ботов/системных, понятный subtitle (для user — должность/отдел, если есть в ответе).
- [ ] **Step 3: Роут** — роли reviewer/admin; кэш на 60 сек по `q` (защита от дребезга поиска).
- [ ] **Step 4: Полный прогон → зелёный. Commit** `feat(photos): recipient search (chats + users) under admin context`.

**AC:** пустой запрос отдаёт осмысленный список «недавних»; поиск работает по части названия чата и имени сотрудника; ответ ≤ 20 элементов; формат dialogId совместим с S3-02.

---

### Task S3-04: Фронт — страница «Фотолента»

**Files:**
- Create: `frontend/app/pages/photos.client.vue`, `frontend/app/components/photos/PhotoFeedGrid.vue`, `PhotoFilters.vue`
- Modify: `frontend/app/stores/api.ts` (методы `getPhotoFeed`, `getPhotoCategories`), навигация (как подключены текущие страницы — пункт в меню/index-грид; посмотреть `index.client.vue` экраны и `reports.client.vue` табы — добавить вход с обоих мест по ролям reviewer/admin)
- Test: ручной чек-лист (фронт без тест-инфры)

- [ ] **Step 1: Фильтры** (`PhotoFilters.vue`): пресеты периода (Сегодня/Вчера/Неделя/Диапазон — паттерн reviewer), мультиселект АЗС (переиспользовать чекбокс-список с поиском из reviewer — вынести в общий компонент, если правка reviewer не требуется, то скопировать разметку), чипы категорий из `getPhotoCategories`. Кнопка «Сбросить».
- [ ] **Step 2: Сетка** (`PhotoFeedGrid.vue`): тайлы `aspect-[4/3]` `grid-cols-2 lg:grid-cols-5` (паттерн R5Wall), blob-превью через существующий `getPhotoPreviewObjectUrl` с ЛЕНИВОЙ загрузкой (IntersectionObserver: грузить превью только видимых тайлов — в отличие от R5Wall, где грузится всё сразу), revoke blob при unmount; подпись тайла: АЗС + дата + категория.
- [ ] **Step 3: Пагинация:** «Показать ещё» по `nextCursor` (+автоподгрузка через IntersectionObserver на сентинеле). Скелетоны `SkeletonBlock` по сетке тайлов (паттерн S2-05). Ошибки — `B24Alert` + «Повторить» (паттерн S2-03).
- [ ] **Step 4: Доступ:** страница только reviewer/admin (паттерн проверки из reports.client.vue); оператору — экран «нет доступа».
- [ ] **Step 5:** `npm run lint` + build чистые. **Commit** `feat(photos): photo feed page — filters, lazy grid, cursor pagination`.

**AC:** фильтры применяются без перезагрузки страницы; лента листается до конца без падения памяти (blob-кэш ограничен видимым + revoked); пустые состояния и ошибки с действием; вход в ленту виден реальным ролям.

---

### Task S3-05: Фронт — лайтбокс со свайпами и выделением

**Files:**
- Create: `frontend/app/components/photos/PhotoLightbox.vue`
- Modify: `frontend/app/pages/photos.client.vue` (открытие по тапу на тайл)

- [ ] **Step 1: Просмотр:** полноэкранный оверлей (Teleport в body, z-выше модалки), текущее фото по центру (`object-contain`), подпись: АЗС, дата/время (EXIF при наличии), категория; крестик и Esc — закрыть; счётчик «3 / 47».
- [ ] **Step 2: Свайпы:** pointer events (`pointerdown/move/up`) с порогом ~50px по X → prev/next в ПРЕДЕЛАХ ТЕКУЩЕЙ ОТФИЛЬТРОВАННОЙ ленты; стрелки ←/→ с клавиатуры; кнопки-стрелки для десктопа; на границах — мягкий стоп. Предзагрузка соседних фото (n±1) через тот же blob-механизм.
- [ ] **Step 3: Выделение из лайтбокса:** чекбокс «Выбрать» на оверлее — синхронизирован с мультиселектом сетки (общий `Set` выбранных в сторе/реактивном состоянии страницы); индикатор «Выбрано: N».
- [ ] **Step 4: Подгрузка:** при достижении конца загруженной части ленты внутри лайтбокса — догрузить следующую страницу (тот же `nextCursor`).
- [ ] **Step 5:** lint+build чистые; жесты — «отложено до smoke» (S3-07). **Commit** `feat(photos): swipe lightbox with selection`.

**AC:** свайп/стрелки/Esc работают; выделение из лайтбокса видно в сетке и наоборот; нет утечки blob (revoke вышедших из окна n±3); скролл фона заблокирован при открытом лайтбоксе.

---

### Task S3-06: Фронт — мультиселект и пересылка

**Files:**
- Create: `frontend/app/components/photos/ForwardDrawer.vue`
- Modify: `frontend/app/pages/photos.client.vue`, `frontend/app/components/photos/PhotoFeedGrid.vue` (чекбоксы тайлов), `frontend/app/stores/api.ts` (`forwardPhotos`, `searchRecipients`)

- [ ] **Step 1: Мультиселект сетки:** чекбокс в углу тайла (зона тапа ≥40px, не конфликтует с открытием лайтбокса — чекбокс stopPropagation); «Выбрать все на странице» / «Снять»; нижняя sticky-панель при N>0: «Выбрано N · Переслать · Отмена» (паттерн sticky из S2-06).
- [ ] **Step 2: ForwardDrawer** (B24Modal или нижний drawer): поиск получателей с дебаунсом 300мс (`searchRecipients`), выбранные — чипсы с крестиком (можно и чаты, и людей вместе); textarea текста с 2–3 быстрыми шаблонами-кнопками («Переделайте выкладку промо-товара», «Перегрузите правый монитор — старая реклама») — шаблоны константой, легко править; счётчик «N фото → M получателей».
- [ ] **Step 3: Отправка:** confirm через `useConfirm` («Отправить N фото M получателям?»), процесс с блокировкой кнопки (withPending-паттерн), результат per-получатель: всё ок → success-тост; частично → перечень неудачных в drawer с кнопкой «Повторить неудачные»; после полного успеха — очистить выделение и закрыть drawer.
- [ ] **Step 4: Одиночная пересылка из лайтбокса:** кнопка «Переслать» в лайтбоксе = тот же drawer с одним фото.
- [ ] **Step 5:** lint+build чистые. **Commit** `feat(photos): multi-select and forward drawer with recipients search and message templates`.

**AC:** массовая и одиночная пересылка из обоих мест; двойной клик не дублирует отправку; частичный сбой виден и повторяем; шаблоны текста подставляются в поле (редактируемы перед отправкой).

---

### Task S3-07: Смоук фичи на dev-портале + фиксация режима пересылки

- [ ] Прогнать на dev-портале (`make dev-node` + туннель): фильтры (все три типа + комбинации), лента ≥ 2 страниц, свайпы на телефоне (390px), выделение сетка↔лайтбокс.
- [ ] КЛЮЧЕВОЕ: пересылка в (а) групповой чат, где админ состоит; (б) групповой чат, где НЕ состоит; (в) личный диалог сотрудника. Зафиксировать, где primary (`im.disk.file.commit`) проходит, где `ACCESS_ERROR` → выставить `PHOTO_FORWARD_MODE` по результату, дописать вывод в план/CHANGELOG.
- [ ] Проверить получение: фото в чате открываются получателем, текст на месте, имя отправителя приемлемо (админ vs бот — показать продакту оба варианта, зафиксировать выбор).
- [ ] Лимиты: переслать 20 фото 5 получателям — без QUERY_LIMIT_EXCEEDED (ретраи отрабатывают), время приемлемое.
- [ ] Полный прогон тестов + lint + build; CHANGELOG-запись спринта 3.

---

## Definition of Done спринта

- [ ] `node --test "tests/*.test.js"` — все зелёные (276 + новые), два прогона.
- [ ] `npm run lint` (frontend) — 0 новых; build чистый.
- [ ] Смоук S3-07 пройден, режим пересылки зафиксирован.
- [ ] Демо продакту: сценарий «найти фото выкладки за неделю по АЗС №X и отправить в чат с текстом» проходит end-to-end.
- [ ] CHANGELOG дополнен; новые env (`PHOTO_FORWARD_MODE`) в `.env.example`.

## Риски

| Риск | Митигация |
|---|---|
| `ACCESS_ERROR` у `im.disk.file.commit` (доступ к файлам папки приложения / к диалогам) | Fallback `imbot.v2.File.upload` реализуется сразу (S3-02); финальный режим фиксируется по фактам S3-07 |
| Полноразмерные превью тяжёлые на ленте (нет thumbnails) | Ленивая загрузка только видимых + limit 40 + кэш 1h; S3-08 (sharp/PREVIEW) как stretch |
| Свайпы конфликтуют с жестами iframe/браузера | Порог 50px + только горизонталь; проверка на реальном телефоне в S3-07 |
| Категории = CRM-айтемы: где-то photo_code исторически другой | В ленте показывать code, если title не нашёлся; не падать |
| Двойная отправка при сетевых ретраях (фото в чате дважды) | Primary-путь идемпотентен слабо — лимит ретраев transient уже стоит; в drawer повтор только вручную по неудачным |

## Открытые вопросы продакту (не блокируют старт бэка)

1. «Пометки» = выделение для пересылки (наша трактовка) — или нужны постоянные метки на фото (это +хранение, отдельная задача)?
2. Где вход в ленту: отдельная кнопка на главной + вкладка в «Отчётах» (предлагаем обе)?
3. Отправитель в чате: админ (фото «как вложение от руководителя») или бот (как остальные уведомления)? Покажем оба на демо S3-07.
4. Тексты быстрых шаблонов пересылки — финальные формулировки.
