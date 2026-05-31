# Карта фич → файлы

Таблица «фича → frontend → backend → заметки». Источники: `docs/code-review-log.md` (аудит функциональности 15/15), sprint logs, spec-kit.

Все пути относительно корня репозитория.

---

## Фронтенд

| Фича | Frontend | Заметки |
|---|---|---|
| Главная / ролевая навигация | `frontend/app/pages/index.client.vue` | Определяет роль через `/api/me/role`, показывает нужные разделы |
| Настройки и маппинг СП | `frontend/app/pages/settings.client.vue:589-636` | Дропдауны из `crm.type.list`/`crm.item.fields`; создание поля через `userfieldconfig.add` |
| Дашборд проверяющего | `frontend/app/pages/reviewer.client.vue` | Лента событий, сводка дня, фильтры, расписание, внеплановый запрос |
| Экран сдачи фото (администратор АЗС) | `frontend/app/pages/admin/[reportId].client.vue` | Camera-only, предпросмотр, пересъёмка, фоновая очередь x2/x1 |
| API-стор | `frontend/app/stores/api.ts` | Все вызовы бэкенда из фронта |

---

## Бэкенд — основные модули

| Фича | Backend | Заметки |
|---|---|---|
| **Settings** | `backends/node/api/src/settings/settingsStore.js` | JSON-хранилище на диске |
| **Disk-сервис** | `backends/node/api/src/disk/diskService.js:1-100` | `ensureRootFolder`, `ensureFolderPath`, `uploadPhoto`; шаблон папок из настроек |
| **Dispatch scheduler** | `backends/node/api/src/dispatch/dispatchScheduler.js:190-282` | Читает `report.dispatchTimes`+`timezone`, cron-tick каждую минуту |
| **Идемпотентность dispatch** | `backends/node/api/src/dispatch/dispatchLogStore.js:24-103` | `dispatch_log`, уникальный ключ `(slot_key, azs_id)` |
| **Dispatch-сервис** | `backends/node/api/src/dispatch/dispatchService.js` | `createReport` + `notifyDispatch`; ручной ключ `manual:${slotKey}` |
| **Timeout watcher** | `backends/node/api/src/dispatch/timeoutWatcher.js` | Просроченные → `expired`, уведомление проверяющему |
| **Reports routes** | `backends/node/api/src/reports/reportsRoutes.js` | GET/POST /api/reports, /photo, /submit, /resync, /manual, /my-active |
| **Reports store** | `backends/node/api/src/reports/reportsStore.js` | CRUD по таблице `report_photo` и логика статусов |
| **CRM-sync (helper)** | `backends/node/api/src/reports/reportCrmSync.js` | `syncReportCrmStrict`: обновление стадии/папки/фото в Bitrix24 |
| **Durable CRM-sync store** | `backends/node/api/src/reports/crmSyncJobStore.js` | Таблица `crm_sync_jobs`, dual PG/MySQL, enqueue/claim/markDone/markFailed/reschedule/reclaimStale |
| **Durable CRM-sync worker** | `backends/node/api/src/reports/crmSyncWorker.js` | Polling worker, backoff `[800,1600,3200]`+jitter, `recover()` на старте |
| **buildCrmSyncRunner** | `backends/node/api/src/reports/reportsRoutes.js` (export) | Выполняет синк под admin-контекстом; fallback на contextKey загрузчика |
| **Bitrix REST client** | `backends/node/api/src/dispatch/bitrixRestClient.js` | `crm.item.*`, `disk.*`, `imbot.*`, `im.*`; per-request context |
| **Auth context store** | `backends/node/api/src/auth/authContextStore.js:21-28` | Per-user OAuth context, keyed `member_id:domain:user_id`; `getLastAdminContext()` |
| **JWT middleware** | `backends/node/api/utils/verifyToken.js` | Проверка JWT, привязка `req.bitrixContext` |
| **RBAC role resolver** | `backends/node/api/src/access/roleResolver.js` | `admin > reviewer > azs_admin`; ACL на все API |
| **Bot registry** | `backends/node/api/src/notifications/botRegistryService.js` | `imbot.v2.Bot.register` при install |
| **NotificationService** | `backends/node/api/src/notifications/notificationService.js:51-134` | Бот-first + fallback на `im.notify.personal.add` |
| **Token refresh scheduler** | `backends/node/api/src/auth/tokenRefreshScheduler.js` | Превентивный refresh (warning на 23-й день, force на 29-й) |
| **REST_APP_URI placement** | `backends/node/api/server.js:74-148` | `placement.bind` при install, идемпотентная проверка |
| **Мой активный отчёт** | `backends/node/api/src/reports/reportsRoutes.js:293-333` | `GET /api/reports/my-active`; приоритет: in_progress → ближайший дедлайн |

---

## Детальная карта фич (ключевые файлы:строки)

| Фича | Frontend | Backend | Заметки |
|---|---|---|---|
| Фото-отчёт администратора АЗС | `admin/[reportId].client.vue:114-275` (camera), `:69-322` (upload queue) | `reportsRoutes.js:POST /photo`, `diskService.js`, `reportCrmSync.js` | Очередь x2/x1, sticky «Сдать отчёт» |
| Экран проверяющего | `reviewer.client.vue` (лента событий, сводка, фильтры) | `reportsRoutes.js:GET /api/reports`, `GET /api/reports/summary` | KPI-карточки, chip-фильтры |
| Расписание + jitter + dispatch | `reviewer.client.vue:878-959` (chip-теги времён) | `dispatchScheduler.js:190-282`, `dispatchLogStore.js:24-103` | Глобальное расписание, единожды |
| Ручной / внеплановый запрос | `reviewer.client.vue` (правая панель, кнопка «Запросить») | `reportsRoutes.js:POST /manual`, `dispatchService.js:20-25` | Backend уже принимает `candidates[]`/`azsIds[]` |
| Загрузка фото + EXIF | `admin/[reportId].client.vue` | `reportsRoutes.js:176-198` | `multer` 10 МБ, `exifr`, проверка свежести фото |
| **Durable CRM-sync** | `reviewer.client.vue` (бейдж `не синхронизировано`, кнопка «Пересинхронизировать») | `crmSyncJobStore.js`, `crmSyncWorker.js`, `buildCrmSyncRunner` (export из `reportsRoutes.js`) | Таблица `crm_sync_jobs`, recover() на старте, resync-эндпоинт `POST /:id/resync` |
| Уведомления бота | — | `notificationService.js:51-134`, `dispatchService.js` | Bot-first + IM-fallback; `botRegistryService.js` при install |
| Регистрация бота при install | — | `server.js:380-400`, `botRegistryService.js` | `imbot.v2.Bot.register`, idempotent |
| Диск (папки / файлы) | — | `diskService.js`, `reportsRoutes.js:986` | Шаблон из `settings.disk.folderNameTemplate`; имя файла `{azs}_{slotDate}_{slotHHmm}_{category}.ext` |
| RBAC | `index.client.vue` (ролевые секции) | `roleResolver.js`, ACL на всех API | Приоритет `admin > reviewer > azs_admin` |
| Настройки / маппинг СП | `settings.client.vue:589-636` | `settingsStore.js`, `GET/PUT /api/settings` | Дропдауны CRM-полей, создание поля |
| Токены (JWT + OAuth refresh) | `stores/api.ts:52-54, 233-263` (401-interceptor) | `verifyToken.js`, `authContextStore.js:21-28`, `tokenRefreshScheduler.js` | Per-user context, превентивный refresh, merge без затирания `isAdmin` |
| Timeweb-деплой | — | `Dockerfile` (multi-stage), `infrastructure/timeweb/supervisord.conf`, `GET /api/healthz` | Single-container: PG + Node + Nginx |

---

## Env-переменные (ключевые)

| Переменная | Где используется |
|---|---|
| `SCHEDULER_ENABLED` | `dispatchScheduler.js` |
| `CRM_SYNC_WORKER_ENABLED` | `server.js` (durable worker) |
| `CRM_SYNC_POLL_MS` | `crmSyncWorker.js` |
| `TOKEN_REFRESH_SCHEDULER_ENABLED` | `tokenRefreshScheduler.js` |
| `BITRIX_BOT_MODE` / `BITRIX_BOT_ID` | `notificationService.js`, `botRegistryService.js` |
| `APP_PUBLIC_BASE_URL` / `BITRIX_APP_CODE` | `reportLinks.js`, уведомления |
| `ENABLE_REPORT_DEEP_LINK` | `dispatchService.js` (за флагом, default `false`) |
