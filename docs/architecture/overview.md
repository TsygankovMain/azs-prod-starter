# Архитектура — Обзор

Краткий обзор системы «Фото-отчёт АЗС». Детали — в [spec-kit/04-architecture.md](../spec-kit/04-architecture.md) и [spec-kit/00-overview.md](../spec-kit/00-overview.md).

---

## Стек

| Слой | Технология |
|---|---|
| Фронтенд | Nuxt 3, Vue 3, `@bitrix24/b24ui-nuxt` (B24 UI Kit) |
| Бэкенд | Node.js, Express |
| База данных | PostgreSQL |
| Хранилище настроек/контекстов | JSON-файлы на диске сервера |
| Публичный тоннель (dev) | Cloudpub |
| Контейнеризация | Docker Compose (dev), Docker single-container (Timeweb prod) |

---

## Компоненты

```
Пользователь в Bitrix24 iframe
        │
        ▼
  Nuxt 3 frontend
        │ JWT (Authorization: Bearer)
        ▼
  Node Express API
     │        │
     ▼        ▼
PostgreSQL  JSON settings/auth
     │
     ▼
Bitrix24 REST API
  ├── CRM (smart processes: АЗС, Типы фото, Отчёты)
  ├── Disk (папки и файлы фото)
  └── Bot/IM («Порядок на АЗС»)
```

---

## Фронтенд

Nuxt 3 — единое SPA-приложение, встроенное в Bitrix24 через placement `REST_APP_URI`.

Основные маршруты:
- `/` — главная, ролевая навигация
- `/settings` — настройки и маппинг смарт-процессов
- `/reviewer` — дашборд проверяющего
- `/admin/[reportId]` — экран сдачи фото администратором АЗС

---

## Бэкенд

Node.js/Express API отвечает за:
- JWT и Bitrix24 OAuth-контекст (per-user, keyed `member_id:domain:user_id`)
- настройки и роли (RBAC: `admin`, `reviewer`, `azs_admin`)
- создание отчётов и dispatch по расписанию
- загрузку фото, проверку EXIF, загрузку на Bitrix24 Disk
- **durable CRM-sync**: таблица `crm_sync_jobs`, воркер с backoff, восстановление после краша
- timeout-watcher (просроченные → `expired`)
- уведомления бота и IM

---

## База данных (PostgreSQL)

Служебные таблицы (не бизнес-данные Bitrix24):

| Таблица | Назначение |
|---|---|
| `dispatch_log` | Идемпотентность запуска отчётов по слотам |
| `report_photo` | Загруженные фото по отчётам |
| `crm_sync_jobs` | Durable-очередь синхронизации с CRM (survives restart) |
| `app_settings` | Зарезервировано; сейчас настройки в JSON-файле |

Бизнес-данные (АЗС, Типы фото, карточки отчётов, файлы фото) хранятся в Bitrix24 CRM и Disk.

---

## Синхронизация с Bitrix24

**OAuth per-user context:** при каждом открытии Bitrix24 iframe передаёт `AUTH_ID`/`REFRESH_TOKEN`/`DOMAIN`/`member_id`/`user_id` в `/api/getToken`. Бэкенд проверяет токен через `profile` и `app.info`, сохраняет контекст по ключу, возвращает JWT.

**Scheduler:** для cron-dispatch используется последний валидный admin-контекст. Если его нет — тик пропускается с диагностическим логом.

**CRM-sync:** после загрузки каждого фото job записывается в `crm_sync_jobs` и обрабатывается воркером. При ошибке — backoff `[800, 1600, 3200]`+jitter, до 4 попыток. При краше сервера pending-джобы возобновляются при старте (`recover()`).

**Disk:** папки создаются по шаблону из настроек (`disk.folderNameTemplate`). Файлы именуются по схеме `{azs}_{slotDate}_{slotHHmm}_{category}.{ext}`.

**Bot:** уведомления отправляются от бота «Порядок на АЗС» через `imbot.v2.Chat.Message.send`, fallback на `im.notify.personal.add`. Бот регистрируется автоматически при install.

---

## Деплой

- **Dev:** Docker Compose, 4 сервиса (`frontend`, `api-node`, `cloudpub`, `db-postgres`), Cloudpub для публичного HTTPS.
- **Prod (Timeweb):** single-container Docker, `supervisord` управляет PostgreSQL + Node API + Nginx. Детали: [timeweb-app-platform-deploy.md](../timeweb-app-platform-deploy.md).
- **VM (self-hosted):** требования: [deployment-server-requirements.md](../deployment-server-requirements.md).

---

## Карта фич → файлы

Подробная таблица «фича → frontend-файл → backend-файл» — в [architecture/feature-map.md](feature-map.md).
