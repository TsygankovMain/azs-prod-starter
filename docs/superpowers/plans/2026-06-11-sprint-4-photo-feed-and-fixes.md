# Спринт 4 «Фотолента + фикс-пакет» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить фичу заказчика «Фотолента с замечаниями» (по утверждённой спеке `docs/superpowers/specs/2026-06-11-photo-feed-design.md`) и закрыть накопленный фикс-пакет (BUG-001…007 + auth-контекст в БД) — одним релизом.

**Architecture:** Трек А (фотолента) строится на существующем: `report_photo`/`dispatch_log` + прокси превью + бот; новое — таблица `photo_remark`, 4 эндпоинта, страница рабочего стола. Трек B — точечные фиксы по бэклогу `2026-06-11-bug-backlog.md`. Все паттерны спринтов 1–2 обязательны (transient-retry, тосты/withPending, скелетоны, «ошибки без тупика»).

**Tech Stack:** Node.js 20 ESM (Express 5, node:test, фейковые пулы), Nuxt 3 + @bitrix24/b24ui-nuxt. Этот план заменяет черновой `2026-06-11-sprint-3-photo-feed.md` (расхождения: получатели = только управляющий/администратор АЗС; отправитель = бот, bot-upload — основной путь; добавлен журнал; поиск получателей S3-03 исключён).

---

## Параметры спринта

| Параметр | Значение |
|---|---|
| Committed | Трек А ≈ 11.5 чел.-дней, Трек B ≈ 4.5 чел.-дней; итого ~16 |
| Исполнение | Агентский конвейер (Sonnet) волнами, спек-ревью + ревью качества на задачу, полировка |
| Релиз | Коммиты в `feature/sprints-stability-ux`; merge в master = деплой (авто) — только по команде продакта |
| Гейты | Спека утверждена продактом 2026-06-11; смоук A7 — совместно с продактом |

## Волны (по непересечению файлов)

| Волна | Задачи | Примечание |
|---|---|---|
| W1 | A1 ∥ B1 ∥ B6 | A1 — новые модули reports/*; B1 — notifications/*; B6 — auth/* (+фабрика в server.js — ЕДИНСТВЕННЫЙ, кто правит server.js в волне) |
| W2 | A2 ∥ B2-бэк | A2 — photoRemark* (новые); B2-бэк — errorCodes в reportsRoutes (read-пути) |
| W3 | A3 ∥ A6 | A3 — новая страница/компоненты photos/*; A6 — settings.client.vue (+бэк-ключи настроек) |
| W4 | A4 ∥ B2-фронт ∥ B4 | A4 — photos/* (лайтбокс+панель); B2-фронт — словарь ошибок + admin/[reportId]; B4 — R1Summary |
| W5 | A5 ∥ B3+B5 | A5 — журнал (photos/* + страница); B3/B5 — reviewer.client.vue + .env.example (мелочь одним агентом) |
| W6 | A7 смоук + финальное интеграционное ревью + CHANGELOG | |

BUG-002 (выпадашки настроек) уже исправлен в ветке — едет в этот релиз; A6 работает в settings.client.vue ПОВЕРХ этого фикса (волна W3 после его коммита).

---

## Трек А — Фотолента (контракты и поведение — в спеке; здесь файлы и AC)

### A1 · Бэк: данные ленты — 2 д
**Files:** Create `backends/node/api/src/reports/photoRemarkStore.js` (таблица `photo_remark`, ensureSchema PG+MySQL, поля по спеке §5.1), `src/reports/photoFeedRoutes.js`; Modify `src/reports/reportsStore.js` (keyset-выборка фото с фильтрами), `server.js` (подключение роутера — координация с B6!), `tests/photoFeed.test.js`, `tests/photoRemarkStore.test.js`.
**Эндпоинты:** `GET /api/reports/photos/feed` (фильтры dateFrom/dateTo/azsId[]/photoCode[]/remarks/limit≤100/cursor; remark-данные join'ом — без N+1), `GET /api/reports/photos/categories` (CRM photoType, кэш 10 мин), `GET /api/reports/photos/recipients?azsId=` (manager из UF-поля по маппингу настроек `settings.azs.fields.manager`, admin из существующей привязки; null'ы честные).
**AC:** фильтры комбинируются; cursor стабилен; роли reviewer/admin (403 оператору); тесты с фейковыми пулами в стиле проекта; полный прогон зелёный.

### A2 · Бэк: отправка замечаний + журнал — 2 д
**Files:** Create `src/notifications/photoRemarkService.js`; Modify `src/dispatch/bitrixRestClient.js` (метод `uploadFileToDialogAsBot` → `imbot.v2.File.upload`, через `callWithTransientRetry`), `src/reports/photoFeedRoutes.js`; Tests `tests/photoRemarkService.test.js`.
**Эндпоинты:** `POST /api/photo-remarks` (azsId, recipientRole, message, photos[]; валидация ≤20 фото; резолв получателя; скачивание контента `downloadFileContent` → base64 → file-by-file бот-upload, текст «Замечание по АЗС {…} ({отправитель}): {текст}» на первом файле; запись журнала со статусом sent/failed+error), `POST /api/photo-remarks/:id/retry`, `GET /api/photo-remarks` (период/АЗС/cursor).
**AC:** частичный сбой → failed с описанием, retry шлёт заново; rate-limit не валит запрос; `PHOTO_FORWARD_MODE` (env, default `bot`) задокументирован в `.env.example`; тесты: успех, fallback-кейсы, валидация.

### A3 · Фронт: страница «Фотолента» — 2 д
**Files:** Create `frontend/app/pages/photos.client.vue`, `components/photos/PhotoFeedGrid.vue`, `components/photos/PhotoFilters.vue`; Modify `stores/api.ts` (getPhotoFeed/getPhotoCategories/getPhotoRecipients), навигация (вход с index-грида и вкладкой из reports — по фактическим паттернам).
**AC (спека §4.1):** дефолт «Сегодня·все·все», запоминание фильтров (localStorage/useState) + «Сбросить», чип «Замечания», тумблер «По АЗС» (секции), lazy-превью (IntersectionObserver, revoke), автоподгрузка по сентинелу, скелетоны, ошибки с «Повторить», пустые состояния; lint/build чистые.

### A4 · Фронт: лайтбокс + панель-черновик — 2 д
**Files:** Create `components/photos/PhotoLightbox.vue`, `components/photos/RemarkDraftPanel.vue`; Modify `pages/photos.client.vue`, `stores/api.ts` (sendPhotoRemark).
**AC (спека §3 С1–С3, С5, §4.2–4.3):** свайпы/стрелки/Esc/счётчик; «Отметить» синхронно сетка↔лайтбокс; панель копит в рамках ОДНОЙ АЗС; чужая АЗС → блокировка с двумя кнопками; получатель «Управляющему» дефолт, пустой управляющий → подсказка+переключение на администратора; шаблоны из настроек; withPending на отправке; тост+бейджи после успеха.

### A5 · Фронт: журнал + бейджи — 1.5 д
**Files:** Create `components/photos/RemarkJournal.vue`; Modify `pages/photos.client.vue` (вкладки Фотолента/Журнал — паттерн мокапа), `PhotoFeedGrid.vue`/`PhotoLightbox.vue` (бейдж «✓ замечание» + мини-карточка), `stores/api.ts` (getPhotoRemarks/retryPhotoRemark).
**AC (спека §4.4):** виды Лента/По АЗС; счётчик на вкладке; миниатюра → открытие фото; failed-запись с «Повторить»; фильтры периода/АЗС.

### A6 · Настройки: маппинг управляющего + шаблоны — 1 д
**Files:** Modify `frontend/app/pages/settings.client.vue` (блок «Фотолента»: поле кода UF «Управляющий» по образцу photoSet; редактируемый список шаблонов), `backends/node/api/src/settings/defaultSettings.js` (+валидация), тесты settings.
**AC:** дефолтные два шаблона из ТЗ; сохранение/чтение через существующий composite-стор; пустой маппинг — фича деградирует в «только администратору» с подсказкой (не падает).

### A7 · Смоук фичи на dev-портале — 1 д (совместно с продактом)
По критериям приёмки спеки §8 (включая получение сообщения управляющим: текст+фото). Зафиксировать результаты в CHANGELOG; открытые мелочи — в bug-backlog.

## Трек B — Фикс-пакет (детали в `2026-06-11-bug-backlog.md`)

### B1 · BUG-001: кнопки в сообщениях бота — 1 д
**Files:** `src/notifications/notificationService.js`, `src/dispatch/dispatchScheduler.js`/`timeoutWatcher.js` (тексты+keyboard), `src/notifications/reportLinks.js` (deep-link'и уже есть — проверить), тесты.
**AC:** задание → кнопка «Открыть приложение» (deep-link на отчёт); просрочка → кнопка «Указать причину» (deep-link на reason/[reportId]); проверка фактической доставки кнопок на dev-портале (imbot keyboard формат).

### B2 · BUG-007: человеческие ошибки — 1.5 д (бэк W2 + фронт W4)
**Бэк:** известные ошибки read/submit-путей отчёта получают `errorCode` (первый — `AZS_PHOTO_SET_EMPTY` с azsId; грепнуть остальные сырые message в ответах). **Фронт:** словарь `composables/useErrorText.ts` код→текст (RU), подключить в admin/[reportId] (плашка с фото — текущий кейс), общий fallback + «Подробности» (паттерн S2-03).
**AC:** кейс со скриншота продакта показывает оператору русский текст «Для вашей АЗС не настроен список фото…», техдеталь — под спойлером; ни один известный код не светит английским.

### B3 · BUG-003: resync только для done/expired — 0.25 д · `reviewer.client.vue`
### B4 · BUG-004: KPI-скелетоны в R1 — 0.5 д · `R1Summary.vue`
### B5 · BUG-005+006: объявления pendingActions выше использования; комментарий к `CRM_SYNC_STALE_RUNNING_MS` в `.env.example` — 0.25 д
### B6 · Auth-контекст в БД (этап 2 инфраструктуры) — 1 д
**Files:** Create `src/auth/databaseAuthContextStore.js`, `src/auth/compositeAuthContextStore.js` (по образцу `src/settings/*`); Modify `server.js` (фабрика по `AUTH_CONTEXT_STORE=composite|database|file`, default composite), `.env.example`; тесты.
**AC:** после redeploy планировщик работает БЕЗ входа админа (контекст читается из БД); file-store остаётся fallback'ом; миграция прозрачная (composite пишет в оба).

---

## Definition of Done спринта

- [ ] Полный прогон `node --test "tests/*.test.js"` зелёный (два прогона), `npm run lint` + build фронта чистые.
- [ ] Каждая задача: спек-ревью + ревью качества + полировка (конвейер как в спринтах 1–2).
- [ ] Смоук A7 пройден с продактом; критерии спеки §8 закрыты.
- [ ] CHANGELOG; bug-backlog обновлён (BUG-001…007 закрыты/перенесены осознанно).
- [ ] Merge в master и деплой — только по команде продакта (авто-деплой!).

## Риски

| Риск | Митигация |
|---|---|
| Формат keyboard/кнопок imbot и deep-link в мобильном Битриксе | B1 включает обязательную проверку на реальном телефоне (как на скриншоте продакта) |
| Скорость bot-upload пачки фото (base64 file-by-file) | Лимит 20 фото/замечание; замер в A7; запасной `PHOTO_FORWARD_MODE=commit` |
| settings.client.vue правится дважды (BUG-002 фикс + A6) | A6 строго после коммита фикса; волна W3 |
| server.js правят A1 и B6 | Разнесены: B6 в W1 единолично, A1 подключает роутер после |
