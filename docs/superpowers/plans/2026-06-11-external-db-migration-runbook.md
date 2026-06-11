# Ранбук: Миграция данных на внешний Managed PostgreSQL (Timeweb)

**Дата:** 2026-06-11  
**Ветка:** feature/sprints-stability-ux  
**Результат:** контейнер работает с `EMBEDDED_POSTGRES=false`, данные прода сохранены.

---

## Предпосылки

- Кластер Managed PostgreSQL `BD_AZS` создан в Timeweb Cloud.
- Созданы БД `BD_AZS` и пользователь `<db_user>` (минимум: CONNECT + CREATE TABLE + SELECT/INSERT/UPDATE/DELETE на public.*).
- У вас есть доступ к текущему контейнеру через Timeweb App Platform (exec / logs).
- Установлен `pg_dump` локально или он доступен внутри контейнера (`which pg_dump`).

---

## Шаг 1 — Снять дамп из контейнера

```bash
# Зайти в shell контейнера через Timeweb App Platform → «Терминал»
# или через docker exec (если есть SSH к Timeweb):
#
#   docker exec -it <container_id> bash

# Внутри контейнера:
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=appdb
DB_USER=appuser

pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  --no-owner \
  --no-acl \
  -Fc \
  -f /tmp/azs-prod-dump-$(date +%Y%m%d-%H%M).dump

echo "Dump complete: $(ls -lh /tmp/azs-prod-dump-*.dump | tail -1)"
```

Скопировать дамп на локальную машину или в любое доступное хранилище:

```bash
# С локальной машины (если есть docker tunnel / scp):
docker cp <container_id>:/tmp/azs-prod-dump-XXXXXXXX.dump ./azs-prod-dump.dump
```

---

## Шаг 2 — Создать пользователя и права в кластере BD_AZS

Подключиться к внешнему кластеру (хост + порт из Timeweb-панели):

```sql
-- Выполнить от имени суперпользователя кластера:
CREATE ROLE <db_user> WITH LOGIN PASSWORD '<db_password>';
GRANT CONNECT ON DATABASE "BD_AZS" TO <db_user>;
\c BD_AZS
GRANT USAGE, CREATE ON SCHEMA public TO <db_user>;
```

---

## Шаг 3 — Восстановить дамп в BD_AZS

```bash
PGPASSWORD='<db_password>' pg_restore \
  -h <host>.timeweb.cloud \
  -p 5432 \
  -U <db_user> \
  -d BD_AZS \
  --no-owner \
  --no-acl \
  --single-transaction \
  -v \
  ./azs-prod-dump.dump
```

Проверить, что таблицы на месте:

```bash
PGPASSWORD='<db_password>' psql \
  -h <host>.timeweb.cloud -p 5432 -U <db_user> -d BD_AZS \
  -c "\dt public.*"
```

Ожидаемые таблицы: `app_settings`, `dispatch_log`, `report_photo`, `crm_sync_jobs`,
`report_reason`, `dispatch_plan` — и все остальные, которые были созданы ensureSchema().

---

## Шаг 4 — Переключить переменные окружения в Timeweb App Platform

В разделе «Переменные окружения» приложения:

```
EMBEDDED_POSTGRES=false
DB_HOST=<host>.timeweb.cloud
DB_PORT=5432
DB_NAME=BD_AZS
DB_USER=<db_user>
DB_PASSWORD=<db_password>      # вводится в поле «Секрет» в панели
DB_SSL=require
```

Убедитесь, что `DB_PASSWORD` введён через защищённое поле (не через `.env`-файл в репо).

---

## Шаг 5 — Redeploy

Запустить деплой текущего тега/коммита в Timeweb App Platform.

При старте контейнера:
- `start-postgres.sh` и `init-db.sh` завершатся немедленно с кодом 0.
- `start-backend.sh` выполнит pg_isready к `<host>.timeweb.cloud:5432` с повтором до 60 с.
- Node.js запустится и выполнит `ensureSchema()` — создаст недостающие таблицы/индексы.

---

## Шаг 6 — Smoke-тест после переключения

Чек-лист:

- [ ] `GET https://<domain>/api/healthz` → `200 {"ok":true}`
- [ ] Открыть приложение в Bitrix24 iframe — авторизация проходит.
- [ ] Отчёты на месте: список отчётов загружается.
- [ ] Настройки на месте: страница настроек не пуста.
- [ ] Ручной запуск отчёта — диспатч создаётся без ошибок.
- [ ] Планировщик работает: `SCHEDULER_ENABLED=true` + проверить логи через 1–2 мин.

---

## Откат

Если после переключения healthz или smoke не проходят — вернуться к embedded-режиму:

1. В панели App Platform изменить переменные:
   ```
   EMBEDDED_POSTGRES=true
   DB_HOST=127.0.0.1
   DB_PORT=5432
   DB_NAME=appdb
   DB_USER=appuser
   DB_PASSWORD=apppass
   # DB_SSL — убрать или оставить пустым
   ```
2. Запустить redeploy.
3. После успешного запуска healthz вернётся в норму — встроенный PG запустится
   и выполнит init-db.sh (если данные были в volume, они сохранятся; если нет —
   приложение создаст схему с нуля).

---

## Этап 2 (после переезда): auth-контекст в БД

**Цель:** сохранять auth-контекст (Bitrix OAuth-токены) в managed-БД вместо файла
`data/auth-context.json`, который теряется при redeploy контейнера.

**Что есть сейчас:** `AuthContextStore` (файл `src/auth/authContextStore.js`) реализован
как файловый store; методы: `upsertContext`, `getContext`, `getContextByKey`,
`getLastAdminContext`, `listContexts`, `flush`.

**Что понадобится:**
- Таблица `auth_context` (ключ `member_id:domain:user_id`, JSON-поле контекста,
  `updated_at`, `last_admin_key`).
- `DatabaseAuthContextStore` — реализует тот же интерфейс, но хранит записи в БД
  (по образцу `databaseSettingsStore.js`).
- Опциональный `CompositeAuthContextStore` — читает из обоих, пишет в оба во время
  переходного периода (по образцу `compositeSettingsStore.js`); позволяет мигрировать
  без потери токенов на работающем проде.
- Фабрика в `server.js`: выбирает реализацию по env `AUTH_CONTEXT_STORE=database|file|composite`.

**Оценка:** ~1 рабочий день (написание стора + тесты + интеграция + smoke).

Паттерн file/database/composite уже отработан в `src/settings/` — следовать ему буквально.
Реализацию начинать после успешного smoke-теста на внешней БД (этап 1).
