# CHANGELOG — Технический лог изменений

Технический лог. Пользовательские релизы — в [RELEASES.md](RELEASES.md).

Записи в обратном хронологическом порядке (новые сверху). Каждый спринт — краткий список изменений в коде и архитектуре.

---

## «Перевыпустить задания на сегодня» — 2026-06-26 (фича)

Кнопка для админа на дашборде проверяющего: снимает несданные сегодняшние задания по всем АЗС (новый статус `dispatch_log.status='cancelled'`), предупреждает затронутых сотрудников сообщением бота и пересоздаёт план на сегодня по текущему расписанию из настроек (уже сдавшие АЗС пропускаются). Сданные отчёты и фото не трогаются.

- **Бэкенд:** `reportsStore` — `listNotSubmittedForDate`/`cancelNotSubmittedForDate`/`listSubmittedAzsForDate` (PG+MySQL); `cancelled` инертен в `getSummary`/`listOverdueReports`/`getActiveReportForAzsOnDate`. Новый `reissueTodayService` (снять → уведомить best-effort с дедупом по пользователю → `generateDailyPlan(regenerate)`). Эндпоинт `POST /api/reports/today/reissue` (только `capabilities.settings`, dry-run + выполнение). Тесты: +9 (863 всего, 0 падений).
- **Фронт:** `apiStore.reissueTodayTasks`; кнопка «Перевыпустить задания на сегодня» на карточке плана (`reviewer.client.vue`) — предпросмотр в подтверждении (снято/сданные/пропущено) + тост-результат; гейт `hasSettingsAccess`.
- **Доки:** `docs/superpowers/specs/2026-06-26-reissue-today-photo-tasks-design.md`, `docs/superpowers/plans/2026-06-26-reissue-today-photo-tasks.md`.

## Sprint 7 «Логика и доступ» — 2026-06-15 (ветка feature/sprints-stability-ux)

Закрыто 20 пунктов бэклога волнами 1–5: доступ (BUG-A1/A2/A3 — getToken/admin_user_ids/retry настроек), логика отправки (BUG-024/LOGIC-D2 — дедлайн/таймзона ручной рассылки), безопасность (BUG-S1/S2 — /api/install верификация + JOB_SECRET fail-closed), фотолента (BUG-P1/P2/P3/P4/P6 — логирование потерь/превью 503/diskFolderId/commit-режим/CRM-синк по portal), фронтенд (BUG-F1/LOGIC-F2/F3/F4/F6 — черновик замечаний v-show/загрузка с причиной/ошибка отправки/гейт capabilities/кнопка роли). Бэкенд: 643 теста, 0 падений.

- **BUG-A1:** getToken — явное сброс `admin_flag` при выходе из admin-плейсмента; не остаётся в памяти на след. вход пользователя.
- **BUG-A2:** Доступ — верификация через `SYSTEM_ADMIN_USER_IDS` из env/config вместо hardcoded `498`.
- **BUG-A3:** Настройки — save() с ретраем на 3 попытки при ошибке Bitrix API.
- **BUG-024:** Дедлайн отчёта = `max(scheduled_at + timeout, now + timeout)` вместо `scheduled_at + timeout`; теперь не рождается просроченным при большом джиттере/ручной отправке.
- **LOGIC-D2:** Ручная рассылка (запрос сейчас) выполняется в таймзоне `settings.timezone` вместо UTC.
- **LOGIC-D3:** Авто-complete (3/3 замечаний → done) откатан; by-design — /submit остаётся каноничным путём.
- **BUG-S1:** /api/install верифицирует через `bitrix.profile` + `application_token` + валидация `member_id`.
- **BUG-S2:** /api/bot/event fail-closed при пустом JOB_SECRET (401 вместо молча-игнорить).
- **BUG-P1:** Потеря фото при CRM-done логируется явно (диагностика).
- **BUG-P2:** Превью 503 `preview_auth_broken` вместо 502 при сломанной auth.
- **BUG-P3:** /resync восстанавливает `diskFolderId` из `listPhotos` при потере.
- **BUG-P4:** Commit-режим: флаг `sent` выставляется только для успешно доставленных в Б24; честный тост.
- **BUG-P6:** CRM-синк строго по `domain + member_id` своего портала, не с других.
- **BUG-F1:** Черновик замечаний переживает вкладки (v-show вместо v-if).
- **LOGIC-F2:** Неудачная загрузка фото — текст причины + кнопка повтора; не обходит сдачу.
- **LOGIC-F3:** Ошибка отправки замечания видна в лайтбоксе; блокирует закрытие до fix/retry.
- **LOGIC-F4:** Гейт сохранения расписания по `capabilities.settings`.
- **LOGIC-F6:** Кнопка «Обновить роль» на экране ожидания azs_admin доступа.

## Sprint 6 «Фотолента CJM + баги» — 2026-06-12 (ветка feature/sprints-stability-ux)

- **Пофотные замечания (UX-2 backend, `e952a2d`):** свой комментарий к каждому фото, пачка отдельных сообщений в чат вместо кучи; schema `photo_remark`, отправка через `imbot.v2.File.upload`.
- **Пофотные замечания (UX-2 frontend, `db91efd`):** коммент к каждому фото в лайтбоксе, отправка пачкой (переход с batch-отправки на per-photo); UI стабильна на Slow 3G.
- **Фотолента в окне проверяющего (UX-1, `82f837e`):** отдельной вкладкой вместо отдельного экрана; старый вход убран; keyset-пагинация, фильтры, свайпы in-place.
- **COMMAND-кнопки бота вместо диплинков (BUG-019, `2aef6b4`):** кнопки теперь COMMAND-типа с `ONIMBOTV2COMMANDADD` вместо LINK; reason-capture в чате работает без диплинка в браузер; поведенческий сдвиг позитивный (no empty browser tab).
- **Ускорение отчётов × 30-50× (BUG-021, `d7fa7bb`):** `batchResolveAzsTitles` — один `crm.item.list` вместо N+1 в R2/R4/feed/витрина; N АЗС × 200мс → один запрос 200мс; регрессионные тесты.

---

## Фикс-спринт 5 «Канал бота + добивание смоука» — 2026-06-11 (ветка feature/sprints-stability-ux)

Спека: `docs/superpowers/specs/2026-06-11-fix-sprint-5-design.md`, план: `…/2026-06-11-fix-sprint-5-execution.md`, бэклог: BUG-009…018 — все закрыты (`…/2026-06-11-bug-backlog.md`). Конвейер Sonnet/Opus/Haiku; верификация: 508/508 бэк-тестов ×2, lint 0 новых, build чистый, финальное интеграционное Opus-ревью — READY_FOR_RELEASE.

- **Канал бота восстановлен (BUG-018/009):** плоский формат keyboard по доке (`{BOT_ID, BUTTONS, {TYPE:'NEWLINE'}}` — корень PARAM_KEYBOARD_ERROR устранён); fallback в пуш стал видимым (warn `bot_channel_degraded`, пометка `delivered via notify fallback:` в dispatch_log.error_text, синий бейдж «Пуш» в тех-таблице); self-heal BOT_NOT_FOUND→ensureBot→retry; ручка `POST /api/admin/bot/reregister` + кнопка в настройках (обновляет живой процесс: setBotId + env).
- **Зависшие слоты:** reserve() пишет zone-correct scheduled_at (buildZonedDatetime, таймзона портала); просроченные «Запланирован» исполняются или честно закрываются `skipped: no auth context…`; будущие manual-слоты защищены от досрочной отправки; ручная рассылка без auth-контекста → 503 `BOT_UNAVAILABLE` без создания слота.
- **Превью (BUG-013):** скачивание с Диска переведено на admin-контекст; `downloadFileContent` получил 401→refresh→retry (once, не для webhook); тайлы со сбоем превью показывают «Не удалось / Нажмите для повтора» (грид/лайтбокс/журнал).
- **Карточка АЗС (BUG-014):** list() фильтрует по `updated_at` вместо `created_at` (+регресс-тесты). ⚠️ Поведенческий сдвиг: тех-таблица проверяющего теперь датируется по последнему изменению статуса — строки, разосланные до окна, но завершённые внутри окна, стали видимы (это осознанно). Прод-корень 0/0 подтверждается смоуком (Network-развилка в бэклоге).
- **Человеческие ошибки рассылки (BUG-011):** `dispatchErrorReasons.classifyDispatchError` (7 кодов) + errorReason/deliveredViaFallback в GET /api/reports + тексты/«Подробности» в тех-таблице и ленте событий.
- **Гигиена логов (BUG-017):** maskSecret/maskAuthFields на install/getToken (токены — префикс 6 симв.); throttledLogger — повторяющиеся фоновые ошибки логируются 1 раз/5 мин со счётчиком (шторм wrong_client 2108 строк больше невозможен).
- **Скорость выборок (BUG-010):** listCrmItems в режиме huge-data (`start=-1`, ORDER BY ID, курсор `>id`), legacy-фоллбек при кастомном order; сигнатура неизменна — crmSync/справочники/кандидаты прозрачно ускорены.
- **Мелочи:** названия категорий и АЗС в подписях ленты/журнала (BUG-012, admin-контекст для azsTitle в /feed); кнопка «Назад» в отчётах и на странице причины (BUG-016); удалены отладочные чипы «источник:» (BUG-015).
- **Вне кода (продакт):** перевбить CLIENT_ID/CLIENT_SECRET в панели Timeweb (лечит шторм `wrong_client`; критерий — час простоя без него в логах).

## Спринт «Фотолента + фикс-пакет» — 2026-06-11 (ветка feature/sprints-stability-ux)

План: `docs/superpowers/plans/2026-06-11-sprint-4-photo-feed-and-fixes.md`, спека фичи: `docs/superpowers/specs/2026-06-11-photo-feed-design.md`. Выполнен агентским конвейером (Sonnet/Opus/Haiku) волнами; два Opus-ревью поймали блокеры до релиза (структура fields imbot.v2.File.upload; контракт ответа POST → дубли). Итог верификации: 400/400 бэк-тестов, сборка фронта чистая, финальное интеграционное ревью — READY_FOR_SMOKE. Гейты: смоук-чеклист (15 сценариев) с продактом → команда на релиз (merge в master = автодеплой).

- Фотолента (фича заказчика, ТЗ п.4): рабочий стол проверяющего/админа — лента фото с фильтрами (период/АЗС/категории/замечания), ленивые превью, keyset-пагинация; полноэкранный просмотр со свайпами; панель-черновик замечания (правило одной АЗС, получатель Управляющий/Администратор из карточки АЗС, быстрые шаблоны из настроек); отправка фото+текста личным сообщением от бота (`imbot.v2.File.upload`, запасной режим `PHOTO_FORWARD_MODE=commit`); журнал замечаний в БД (`photo_remark` + связка фото) с бейджами на фото.
- BUG-001: кнопки в сообщениях бота («Открыть приложение», «Указать причину» / «Не успеваю — указать причину») — причиной был невыставленный флаг ENABLE_REPORT_DEEP_LINK; флаг удалён, гейт теперь BITRIX_APP_CODE.
- BUG-007: типизированные коды ошибок бэка (`src/reports/errorCodes.js`) + русский словарь на фронте (`useErrorText`) на экранах оператора; кейс «AZS item … has empty required photo set field» теперь показывается по-человечески, техдетали — под спойлером.
- BUG-002: выпадашки настроек — устранены пункты с пустыми значениями (запрет reka-ui), дочинен незавершённый фикс.
- BUG-003/004/005/006: ресинк только для сданных/просроченных; скелетоны KPI в R1; порядок объявлений в reviewer; комментарий к CRM_SYNC_STALE_RUNNING_MS.
- Инфраструктура: auth-контекст в БД (database/composite-сторы, `AUTH_CONTEXT_STORE=composite` по умолчанию) — рассылка переживает redeploy без входа админа; починена гонка конкурентных upsert (сериализация записей) и устойчивость composite-записи при сбое БД.
- Настройки: маппинг поля «Управляющий» карточки АЗС + редактируемые шаблоны быстрых сообщений (блок «Фотолента»).

---

## Спринт «UX-доверие» — 2026-06-11 (ветка feature/sprints-stability-ux)

План: `docs/superpowers/plans/2026-06-10-sprint-2-ux-trust.md`. Выполнен агентами (Sonnet) с двухступенчатым ревью каждой задачи. Только фронтенд.

- Toast-слой: обёртка `useAppToast` (success/error/info + actions) над встроенной системой b24ui (`B24Toaster`), один инстанс в `app.vue`; modal поднят над тостами через `app.config.ts`.
- Действия проверяющего: `withPending` (защита от дабл-клика) + видимый результат (тост успеха/ошибки) для «Запросить повторно», ресинка, массовой рассылки и прогона просрочек; стабильная ширина кнопок.
- Подтверждение массовых действий: `useConfirm` (promise-API, без зависших промисов) + `ConfirmDialog` на `B24Modal` — рассылка на N АЗС, генерация плана, ручной таймаут больше не выполняются одним кликом; в тексте — число затрагиваемых АЗС.
- Ошибки без тупика: `error.vue` — человеческий текст + кнопка «Обновить» + технические детали под спойлером, `console.log` удалён; кнопки «Повторить» у ошибок загрузки (reviewer, reports, R5); видимая деградация фильтра АЗС с retry (R1, R4).
- Скелетоны загрузки вместо «Загрузка…»: `SkeletonBlock` на базе `B24Skeleton`, структурно повторяют финальные сетки (R1–R5, лента reviewer) — устранён сдвиг контента на медленной сети.
- Мобильная страница причины: пресеты 2 колонки с тап-таргетами ≥48px и aria-pressed, автофокус «Другое» со скроллом к полю, sticky-кнопка «Сохранить».
- Главная: открытие отчёта с обработкой ошибки и гарантированным сбросом спиннера; авто-проверка появления отчёта раз в минуту (без тост-спама в фоне).
- Сборка и линт чистые; интеграционное ревью всей ветки: READY (25 коммитов, +1651/−169 в 43 файлах).
- Отложено до smoke на dev-портале: 10 сценариев (чек-лист в отчёте интеграционного ревью; ключевые — confirm-диалог рассылки, скелетоны на Slow 3G, error.vue с восстановлением, мобильная форма причины).

---

## Спринт «Стабильность» — 2026-06-11 (ветка feature/sprints-stability-ux)

План: `docs/superpowers/plans/2026-06-10-sprint-1-stability.md`. Выполнен агентами (Sonnet) с двухступенчатым ревью каждой задачи.

- Fail-fast валидация окружения: без `JWT_SECRET` процесс не стартует (exit 1) вместо тихой поломки auth; глобальные обработчики `unhandledRejection`/`uncaughtException` (log-only); слушатель ошибок pg-пула — рестарт Postgres ночью больше не роняет процесс.
- Graceful shutdown по SIGTERM/SIGINT: `server.close` + `closeIdleConnections()` (без 5с keep-alive задержки на деплой), остановка всех планировщиков, `authContextStore.flush()` (новый метод — дописывает токен на диск), `pool.end()` с 3с таймаутом, force-exit 10с.
- Анти-спираль Bitrix: overlap-guard на всех трёх cron-тиках (`src/shared/guardedTick.js`), таймауты на все fetch (`BITRIX_HTTP_TIMEOUT_MS`=30с, для скачивания фото отдельный `BITRIX_HTTP_DOWNLOAD_TIMEOUT_MS`=120с), ретраи HTTP 503 с уважением `Retry-After`, общий модуль `src/shared/transientErrors.js` вместо 3 копий паттерна (сужен от ложных срабатываний на БД lock/statement timeout).
- Согласованность данных: `recover()` реклеймит только осиротевшие задачи (`CRM_SYNC_STALE_RUNNING_MS`, дефолт 5 мин, NaN-guard) — безопасно для rolling-deploy; статус `expired` ставится только ПОСЛЕ успешного CRM-апдейта (сбой CRM больше не «хоронит» отчёт, повтор следующим тиком).
- Честный healthcheck: `/api/healthz` = SELECT 1 с per-query таймаутом (слот пула не зависает) → 503 при мёртвой БД; `/api/livez` — статический; `HEALTHCHECK` в Dockerfile (start-period 120с, curl --max-time 3); ротация логов 10m×3 всем сервисам compose; `mem_limit: 1g` + `memswap_limit` + `NODE_OPTIONS=--max-old-space-size=768` (compose и supervisord) против OOM-kill; `connectionTimeoutMillis: 3000` у pg-пула.
- Фронтенд: единый дедуплицированный путь обновления JWT через `ensureFreshToken({force})` (устранена гонка таймер/visibility/401-интерсептор — «срабатывает со второго раза»); `stop()` плагина снимает visibilitychange-слушатель.
- Тесты: 240 → 276 зелёных; сборка фронтенда и линт чистые.
- Отложено до smoke на dev-портале: ручные DevTools-проверки refresh-гонки, сценарий healthz с остановкой БД в docker.

---

## Sprint 1 v2.0 — 2026-05-31 (ветка feature/v2.0)

- Добавлена durable CRM-sync очередь: таблица `crm_sync_jobs` (PG+MySQL), `crmSyncJobStore` (enqueue/claim/markDone/markFailed/reschedule), воркер `crmSyncWorker` с backoff `[800,1600,3200]`+jitter.
- Исправлен критический баг: зависшие `running`-джобы теперь сбрасываются методом `reclaimStale()` при старте воркера (`recover()`); без этого краш mid-sync блокировал синк навсегда.
- `buildCrmSyncRunner` выполняет синк под admin-контекстом (`getLastAdminContext()`), а не под токеном загрузчика; fix I2: убрана 502-блокировка upload/submit от наличия admin-токена.
- Эндпоинт `POST /:id/resync` (для проверяющего) + поля `synced`/`lastSyncError` в ответах `GET /:id`.
- Исправлен баг `authContextStore.upsertContext`: partial-upsert теперь мержит поверх предыдущего значения, не затирает `refreshToken`/`isAdmin`.
- Тесты: 126/126 зелёных (первый полностью чистый прогон).

---

## Sprint 10 — 2026-05-31 (master, commit 2e60861)

- Экран администратора: sticky-панель с прогрессом + кнопка «Сдать отчёт» вверху; убран нижний дубль кнопки; кнопка «Перейти к проблемам» (скролл).
- Фоновая очередь загрузок: параллельность x2, переключение на x1 при retryable-ошибках Bitrix (429/504/OPERATION_TIME_LIMIT), автовозврат x2 после 10 успехов.
- Backend: `POST /photo` отвечает после Disk+DB, CRM-синк вынесен в сериализованную фоновую очередь по `reportId` с backoff `[800,1600,3200]+jitter`; `syncQueued:true` в ответе.

---

## Sprint 9 (reviewer redesign) — 2026-04-29

- Полная переработка экрана проверяющего: переключатель периода, сводка «N из M АЗС сдали», лента событий, inline-кнопки «Запросить повторно» / «Открыть фото», фильтр «Только проблемы».
- Правая панель: редактирование расписания (chip-теги) + внеплановый запрос на одном экране.
- Технический блок со старой таблицей убран в раздел «Показать техническую информацию» (коллапс).
- Все пользовательские статусы переведены на русский язык; `done/expired/failed/new` в шаблоне не появляются.

---

## Sprint 9 (manual trigger) — 2026-04-29

- Раздельный ключ идемпотентности для ручного запуска: `manual:${slotKey}` не блокирует авто-слот с тем же ключом.
- Фидбек проверяющему при повторном ручном запуске с одинаковыми параметрами.

---

## Sprint 8 — 2026-04-29

- Эндпоинт `GET /api/reports/summary` с агрегированными счётчиками (`total`, `open`, `done`, `expired`, `failed`, `overdue`, `byStatus`).
- KPI-карточки на экране проверяющего; быстрые фильтры по статусу; параллельная загрузка списка и сводки.

---

## Sprint 7 — 2026-04-28/29

- Timeout-watcher: `POST /api/jobs/timeout`, автоматический перевод просроченных отчётов в `expired`, уведомление проверяющему.
- Синхронизация стадии `EXPIRED` в CRM через `crm.item.update`.
- Кнопка «Проверить просрочки» на экране проверяющего.

---

## Sprint 6 — 2026-04-28/29

- Endpoint `POST /api/reports/:id/photo`: загрузка через `multer` (лимит 10 МБ), проверка EXIF-даты, загрузка на Bitrix24 Disk.
- Таблица `report_photo`, upsert по `(report_id, photo_code)`.
- Статусная прогрессия: `in_progress` → `done` (когда все обязательные фото загружены).
- Фронт: реальная отправка файла, статусы слотов, сообщение при переходе в DONE.
- Камера-only поток: убран `input[type=file]`, добавлен `getUserMedia` с предпросмотром и возможностью пересъёмки; исправлена ошибка `play is not a function` в mobile WebView.
- Строгий режим: удалён Bitrix REST mock, убраны демо-страницы стартера.

---

## Sprint 5 — 2026-04-28

- Заменён стартерный UI на продуктовые экраны: главная страница-хаб, `/reviewer`, `/admin/[reportId]`.
- Backend: `GET /api/reports`, `GET /api/reports/:id`, `POST /api/reports/manual`.

---

## Sprint 4 — 2026-04-28/30

- `POST /api/jobs/dispatch` с JWT-защитой.
- Таблица `dispatch_log` с уникальным ключом `(slot_key, azs_id)` для идемпотентности.
- Джиттер в диапазоне `[-dispatchJitterMinutes, +dispatchJitterMinutes]`.
- Scheduler на `node-cron` (включается через `SCHEDULER_ENABLED=true`).
- Загрузка кандидатов АЗС из `crm.item.list` + пагинация.
- Авто-dispatch по временным слотам из настроек (`report.dispatchTimes`).
- Исправлена регрессия: `dispatch_log.report_item_id` сохраняется сразу после `crm.item.add`, отказ уведомления не блокирует запись.

---

## Sprint 3 — 2026-04-28

- Disk-сервис: `ensureRootFolder`, `ensureFolderPath`, `uploadPhoto`.
- Детерминированный путь папки и имя файла (`{slotHHmm}_{photoCode}_{isoTimestamp}.{ext}`).
- Safe-сегментная нормализация имён.

---

## Sprint 2 — 2026-04-28

- `GET /api/settings` / `PUT /api/settings` (JWT-защита, JSON-хранилище в dev).
- Settings-контракт: АЗС, Отчёт, этапы, Disk, таймаут, джиттер, часовой пояс.
- `/settings` — UI настройщика с дропдаунами из `crm.type.list` / `crm.item.fields`, автозагрузка стадий, создание поля через `userfieldconfig.add`.

---

## Sprint 1 (bootstrap) — 2026-04-28

- Node.js + Nuxt stack запущен в Docker Compose с именами `azs-prod-*`.
- Cloudpub URL для публичного доступа.
- Bitrix24 app credentials вынесены в `.env` (не коммитятся).

---

## Sprint 0 (control plane) — 2026-04-28

- Репозиторий настроен: `origin` → пользовательский GitHub, `upstream` с отключённым push.
- Bitrix24 task 6475 создан в проекте 371.
- Основной project-log создан.

---

## 2026-05-01 — Аудит токенов и auth

- Исправлены 7 проблем токен-lifecycle: 401-интерсептор на фронте, расширенный список retryable OAuth-ошибок, merge-контекста без затирания `isAdmin`, `getLastAdminContext` возвращает null при отсутствии admin-контекста, `tokenRefreshScheduler.js` (превентивный refresh на 29-й день), fix `/api/getToken` (merge `isAdmin`, не overwrite).
- Per-user JWT + per-user Bitrix OAuth-контекст, keyed `member_id:domain:user_id`.
- Роль-резолвер RBAC: `admin > reviewer > azs_admin`, ACL на все API.
- `REST_APP_URI` placement registrations при install; исправлен URL бота (`.../marketplace/view/...`).
- Исправлена ошибка: `nodemon` не перезапускается на запись `auth-context.json`.

---

## 2026-05-05 — Документация MVP

- Создан docs/README.md, spec-kit (00–08), docs/bitrix24-portal-setup.md (alias → spec-kit/03).

---

## 2026-05-11 — Деплой и ТЗ

- `docs/deployment-server-requirements.md`: требования к VM для client IT.
- `docs/contract-technical-assignment.md`: краткое ТЗ к договору.

---

## 2026-05-13 — Timeweb deploy

- Root `Dockerfile` (multi-stage: Nuxt static + Node API), `supervisord` для PG + Node + Nginx в одном контейнере.
- `GET /api/healthz` (публичный health-check для платформы).
- `docs/timeweb-app-platform-deploy.md`.
