# CHANGELOG — Технический лог изменений

Технический лог. Пользовательские релизы — в [RELEASES.md](RELEASES.md).

Записи в обратном хронологическом порядке (новые сверху). Каждый спринт — краткий список изменений в коде и архитектуре.

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
