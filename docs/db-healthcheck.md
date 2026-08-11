# Проверка стабильности: SQL-ранбук

Набор read-only запросов для проверки, что «Фото-отчёт АЗС» работает штатно.
Все запросы — `SELECT`, ничего не меняют. СУБД — **PostgreSQL** (`DB_TYPE=postgresql`
и локально, и на Timeweb; база `BD_AZS`).

Порядок при разборе инцидента — сверху вниз: сначала связность, потом планировщик,
потом фото, потом очереди. Первый раздел, который «красный», обычно и есть причина.

---

## 0. Подключение

Пароль не хранится в файлах — берётся из панели Timeweb App Platform.

```bash
# Внешняя managed-БД (прод)
export PGHOST='<host>.timeweb.cloud'
export PGPORT=5432
export PGDATABASE='BD_AZS'
export PGUSER='<db_user>'
export PGPASSWORD='<db_password>'   # не коммитить, не вставлять в docs
export PGSSLMODE=verify-full

psql -c 'SELECT version(), now() AT TIME ZONE '"'"'Europe/Moscow'"'"' AS msk;'
```

```bash
# Встроенный PostgreSQL внутри контейнера (EMBEDDED_POSTGRES=true)
docker exec -it azs-prod-api-node psql -U "$DB_USER" -d BD_AZS
```

```bash
# Локальная разработка (docker-compose)
docker compose exec database-postgres psql -U "$DB_USER" -d "$DB_NAME"
```

Быстрая проба без psql — HTTP-эндпоинт, который дергает БД с таймаутом 2 с:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://<app-host>/api/healthz   # ждём 200
```

---

## 1. Связность и базовое состояние

```sql
-- Живость, версия, время сервера БД в МСК
SELECT version() AS pg_version,
       now() AT TIME ZONE 'Europe/Moscow' AS db_time_msk,
       current_setting('TimeZone') AS db_tz;
```

```sql
-- Размер базы и запас по соединениям
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size,
       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS conns,
       current_setting('max_connections')::int AS max_conns;
```

```sql
-- Все таблицы приложения на месте? Ожидаем 12 строк.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('auth_context','app_settings','brand','brand_azs',
                     'dispatch_plan','dispatch_log','report_photo','report_reason',
                     'crm_sync_jobs','photo_remark','photo_remark_photo','diag_report')
ORDER BY table_name;
```

Нет какой-то таблицы — значит `ensureSchema()` не отработал при старте: смотреть логи
бэкенда на предмет ошибки прав или недоступности БД в момент boot.

---

## 2. OAuth-контекст — первое, что ломается

Планировщик без валидного admin-контекста молча пропускает тик. Это самая частая
причина «отчёты не приходят».

```sql
-- Есть ли живой админский контекст и насколько он свежий
SELECT key,
       is_admin,
       last_admin_at AT TIME ZONE 'Europe/Moscow' AS last_admin_msk,
       updated_at    AT TIME ZONE 'Europe/Moscow' AS updated_msk,
       now() - updated_at AS age
FROM auth_context
ORDER BY is_admin DESC, updated_at DESC;
```

Норма: есть хотя бы одна строка `is_admin = true`, и её `age` меньше срока жизни
access token (Bitrix24 — 1 час; фоновый refresh должен обновлять `updated_at`).

```sql
-- Тревога: админского контекста нет вообще
SELECT count(*) FILTER (WHERE is_admin) AS admin_contexts,
       count(*)                          AS total_contexts
FROM auth_context;
```

`admin_contexts = 0` → открыть приложение администратором портала, затем перепроверить.

---

## 3. Планировщик: план на день

```sql
-- Срез плана за сегодня по статусам
SELECT plan_date, status, entry_type, count(*)
FROM dispatch_plan
WHERE plan_date = to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
GROUP BY plan_date, status, entry_type
ORDER BY status, entry_type;
```

```sql
-- ПРОСРОЧКА: запись должна была уйти, но всё ещё planned.
-- Пустой результат — планировщик успевает.
SELECT id, plan_date, azs_id, base_time, entry_type, window_index,
       execute_at AT TIME ZONE 'Europe/Moscow' AS execute_msk,
       now() - execute_at AS overdue
FROM dispatch_plan
WHERE status = 'planned'
  AND execute_at < now() - interval '10 minutes'
ORDER BY execute_at ASC
LIMIT 50;
```

```sql
-- Провалившиеся отправки за 3 суток, с текстом ошибки
SELECT id, plan_date, azs_id, base_time,
       execute_at AT TIME ZONE 'Europe/Moscow' AS execute_msk,
       left(error_text, 200) AS error
FROM dispatch_plan
WHERE status = 'failed'
  AND created_at > now() - interval '3 days'
ORDER BY id DESC
LIMIT 50;
```

```sql
-- Частотный разбор ошибок планировщика за неделю
SELECT left(error_text, 80) AS error_head, count(*)
FROM dispatch_plan
WHERE status = 'failed' AND created_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

```sql
-- План на завтра сгенерирован? Пусто накануне вечером — планировщик не отработал.
SELECT plan_date, count(*) AS entries, count(DISTINCT azs_id) AS azs
FROM dispatch_plan
WHERE plan_date >= to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
GROUP BY plan_date ORDER BY plan_date;
```

---

## 4. Отчёты: воронка исполнения

`dispatch_log` — фактические отчёты. Статусы: `reserved` → `new`/`in_progress` → `done`,
либо `expired` по дедлайну, либо `failed`.

```sql
-- Воронка за 7 суток
SELECT status, count(*),
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM dispatch_log
WHERE created_at > now() - interval '7 days'
GROUP BY status ORDER BY count(*) DESC;
```

```sql
-- Динамика по дням: сколько дошло до done, сколько сгорело
SELECT date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow')::date AS day,
       count(*)                                  AS total,
       count(*) FILTER (WHERE status = 'done')    AS done,
       count(*) FILTER (WHERE status = 'expired') AS expired,
       count(*) FILTER (WHERE status = 'failed')  AS failed
FROM dispatch_log
WHERE created_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1 DESC;
```

```sql
-- ЗАВИСШИЕ: reserved больше часа. Их должен подбирать stale-finisher;
-- если копятся — планировщик не тикает.
SELECT id, slot_key, azs_id, admin_user_id,
       created_at   AT TIME ZONE 'Europe/Moscow' AS created_msk,
       scheduled_at AT TIME ZONE 'Europe/Moscow' AS scheduled_msk,
       now() - created_at AS stuck_for
FROM dispatch_log
WHERE status = 'reserved'
  AND created_at < now() - interval '1 hour'
ORDER BY created_at ASC
LIMIT 50;
```

```sql
-- Просрочен дедлайн, а отчёт всё ещё в работе — timeoutWatcher не закрыл
SELECT id, azs_id, status,
       deadline_at AT TIME ZONE 'Europe/Moscow' AS deadline_msk,
       now() - deadline_at AS past_deadline
FROM dispatch_log
WHERE deadline_at IS NOT NULL
  AND deadline_at < now()
  AND status NOT IN ('done','expired','failed')
ORDER BY deadline_at ASC
LIMIT 50;
```

```sql
-- Отчёт создан, но не привязан к карточке СП — «reportItemId is missing»
SELECT count(*) AS orphan_reports
FROM dispatch_log
WHERE report_item_id IS NULL
  AND status <> 'reserved'
  AND created_at > now() - interval '7 days';
```

---

## 5. Фото и Диск

Ключевой признак здоровья загрузки: у фото проставлен `disk_object_id`.
`NULL` = файл не доехал на Bitrix24 Диск.

```sql
-- Сводка за сутки: сколько фото, сколько без объекта на Диске
SELECT count(*)                                        AS photos,
       count(*) FILTER (WHERE disk_object_id IS NULL)  AS no_disk_object,
       count(*) FILTER (WHERE file_id IS NULL)         AS no_file_id,
       count(DISTINCT report_id)                       AS reports
FROM report_photo
WHERE uploaded_at > now() - interval '24 hours';
```

```sql
-- Список «залипших» фото — загружены давно, на Диске так и нет
SELECT rp.id, rp.report_id, d.azs_id, rp.photo_code, rp.file_name,
       rp.uploaded_at AT TIME ZONE 'Europe/Moscow' AS uploaded_msk,
       now() - rp.uploaded_at AS age
FROM report_photo rp
LEFT JOIN dispatch_log d ON d.id = rp.report_id
WHERE rp.disk_object_id IS NULL
  AND rp.uploaded_at < now() - interval '30 minutes'
ORDER BY rp.uploaded_at ASC
LIMIT 50;
```

```sql
-- Отчёты, закрытые как done, но без единого фото — так быть не должно
SELECT d.id, d.azs_id, d.status,
       d.updated_at AT TIME ZONE 'Europe/Moscow' AS updated_msk
FROM dispatch_log d
LEFT JOIN report_photo rp ON rp.report_id = d.id
WHERE d.status = 'done'
  AND d.created_at > now() - interval '7 days'
GROUP BY d.id, d.azs_id, d.status, d.updated_at
HAVING count(rp.id) = 0
ORDER BY d.id DESC
LIMIT 50;
```

```sql
-- Комплектность: сколько фото на отчёт (ищем недобор относительно нормы)
SELECT photo_count, count(*) AS reports
FROM (
  SELECT d.id, count(rp.id) AS photo_count
  FROM dispatch_log d
  LEFT JOIN report_photo rp ON rp.report_id = d.id
  WHERE d.status = 'done' AND d.created_at > now() - interval '7 days'
  GROUP BY d.id
) t
GROUP BY photo_count ORDER BY photo_count;
```

```sql
-- Расхождение EXIF и времени загрузки > 6 часов: старые фото из галереи
SELECT rp.id, rp.report_id, d.azs_id, rp.photo_code,
       rp.exif_at     AT TIME ZONE 'Europe/Moscow' AS exif_msk,
       rp.uploaded_at AT TIME ZONE 'Europe/Moscow' AS uploaded_msk,
       rp.uploaded_at - rp.exif_at AS lag
FROM report_photo rp
LEFT JOIN dispatch_log d ON d.id = rp.report_id
WHERE rp.exif_at IS NOT NULL
  AND rp.uploaded_at - rp.exif_at > interval '6 hours'
  AND rp.uploaded_at > now() - interval '7 days'
ORDER BY lag DESC
LIMIT 50;
```

---

## 6. Очередь синхронизации с CRM

```sql
-- Состояние очереди
SELECT status, count(*),
       min(created_at) AT TIME ZONE 'Europe/Moscow' AS oldest_msk
FROM crm_sync_jobs
GROUP BY status ORDER BY status;
```

```sql
-- ПРОСРОЧЕННЫЕ: пора выполнять, но всё ещё pending. Воркер стоит.
SELECT id, report_id, attempts, max_attempts,
       next_attempt_at AT TIME ZONE 'Europe/Moscow' AS next_msk,
       now() - next_attempt_at AS overdue,
       left(last_error, 160) AS last_error
FROM crm_sync_jobs
WHERE status = 'pending'
  AND next_attempt_at < now() - interval '15 minutes'
ORDER BY next_attempt_at ASC
LIMIT 50;
```

```sql
-- ОСИРОТЕВШИЕ running: процесс упал в середине. Должны подбираться reclaimStale
-- при старте воркера; если висят при живом процессе — воркер завис.
SELECT id, report_id, attempts,
       updated_at AT TIME ZONE 'Europe/Moscow' AS updated_msk,
       now() - updated_at AS running_for
FROM crm_sync_jobs
WHERE status = 'running'
  AND updated_at < now() - interval '10 minutes'
ORDER BY updated_at ASC;
```

```sql
-- Исчерпавшие попытки — это уже потерянные данные в CRM
SELECT id, report_id, attempts, max_attempts,
       left(last_error, 200) AS last_error,
       updated_at AT TIME ZONE 'Europe/Moscow' AS updated_msk
FROM crm_sync_jobs
WHERE status = 'failed' OR attempts >= max_attempts
ORDER BY id DESC
LIMIT 50;
```

```sql
-- Частотный разбор ошибок синка за неделю
SELECT left(last_error, 80) AS error_head, count(*)
FROM crm_sync_jobs
WHERE last_error IS NOT NULL AND updated_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

---

## 7. Замечания по фото (доставка в чат)

```sql
-- Доставка замечаний за неделю
SELECT delivery_status, count(*)
FROM photo_remark
WHERE created_at > now() - interval '7 days'
GROUP BY delivery_status;
```

```sql
-- Недоставленные позиции внутри замечаний
SELECT prp.remark_id, prp.report_id, prp.photo_code, prp.delivery_status,
       left(prp.delivery_error, 160) AS error,
       pr.azs_id, pr.recipient_role,
       pr.created_at AT TIME ZONE 'Europe/Moscow' AS created_msk
FROM photo_remark_photo prp
JOIN photo_remark pr ON pr.id = prp.remark_id
WHERE prp.delivery_status <> 'sent'
  AND pr.created_at > now() - interval '7 days'
ORDER BY pr.created_at DESC
LIMIT 50;
```

---

## 8. Причины срыва отчётов и жалобы пользователей

```sql
-- Топ причин, почему отчёт не сдан (за 30 суток)
SELECT reason_code, count(*),
       count(DISTINCT azs_id) AS azs_affected
FROM report_reason
WHERE created_at > now() - interval '30 days'
GROUP BY reason_code ORDER BY count(*) DESC;
```

```sql
-- АЗС-рекордсмены по срывам
SELECT azs_id, count(*) AS reasons, array_agg(DISTINCT reason_code) AS codes
FROM report_reason
WHERE created_at > now() - interval '30 days'
GROUP BY azs_id ORDER BY count(*) DESC LIMIT 20;
```

```sql
-- Поток жалоб через кнопку «Что-то не работает» — рост = регрессия
SELECT date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow')::date AS day,
       trigger, count(*)
FROM diag_report
WHERE created_at > now() - interval '14 days'
GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;
```

```sql
-- Последние диаг-бандлы с кодом для поиска в интерфейсе
SELECT code, trigger, azs_id, user_id, report_id, size_bytes,
       created_at AT TIME ZONE 'Europe/Moscow' AS created_msk
FROM diag_report
ORDER BY created_at DESC
LIMIT 20;
```

---

## 9. Здоровье самой БД

```sql
-- Размеры таблиц
SELECT relname AS table_name,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       n_live_tup AS live_rows,
       n_dead_tup AS dead_rows,
       last_autovacuum AT TIME ZONE 'Europe/Moscow' AS last_autovacuum_msk
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

```sql
-- Долгие запросы (> 30 с) — кандидаты на разбор
SELECT pid, state, now() - query_start AS duration,
       left(query, 120) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND state <> 'idle'
  AND now() - query_start > interval '30 seconds'
ORDER BY duration DESC;
```

```sql
-- Блокировки
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
       left(blocked.query, 80)  AS blocked_query,
       left(blocking.query, 80) AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

```sql
-- Индексы фото-пайплайна используются?
SELECT relname, indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE relname IN ('dispatch_plan','dispatch_log','report_photo','crm_sync_jobs')
ORDER BY relname, idx_scan DESC;
```

---

## 10. Сводка одним запросом

Ежедневная проверка «всё ли в порядке». Каждая строка — метрика; ненулевое значение
в строках с пометкой `ALERT` требует разбора.

```sql
SELECT 'ALERT: админский OAuth-контекст' AS metric,
       count(*) FILTER (WHERE is_admin) AS value FROM auth_context
UNION ALL
SELECT 'ALERT: план просрочен >10 мин',
       count(*) FROM dispatch_plan
       WHERE status='planned' AND execute_at < now() - interval '10 minutes'
UNION ALL
SELECT 'ALERT: отчёты зависли в reserved >1 ч',
       count(*) FROM dispatch_log
       WHERE status='reserved'
         AND slot_key NOT LIKE '%:reminder:%'  -- служебные строки напоминаний, а не отчёты
         AND created_at < now() - interval '1 hour'
UNION ALL
SELECT 'ALERT: фото без disk_object_id >30 мин',
       count(*) FROM report_photo
       WHERE disk_object_id IS NULL AND uploaded_at < now() - interval '30 minutes'
UNION ALL
SELECT 'ALERT: CRM-очередь просрочена >15 мин',
       count(*) FROM crm_sync_jobs
       WHERE status='pending' AND next_attempt_at < now() - interval '15 minutes'
UNION ALL
SELECT 'ALERT: CRM-задания залипли в running',
       count(*) FROM crm_sync_jobs
       WHERE status='running' AND updated_at < now() - interval '10 minutes'
UNION ALL
SELECT 'ALERT: CRM-задания провалены',
       count(*) FROM crm_sync_jobs WHERE status='failed'
UNION ALL
SELECT 'ALERT: замечания не доставлены (7 дн)',
       count(*) FROM photo_remark_photo prp
       JOIN photo_remark pr ON pr.id=prp.remark_id
       WHERE prp.delivery_status <> 'sent' AND pr.created_at > now() - interval '7 days'
UNION ALL
SELECT 'info: отчётов done за сутки',
       count(*) FROM dispatch_log
       WHERE status='done' AND updated_at > now() - interval '24 hours'
UNION ALL
SELECT 'info: фото загружено за сутки',
       count(*) FROM report_photo WHERE uploaded_at > now() - interval '24 hours'
UNION ALL
SELECT 'info: жалоб через диагностику за сутки',
       count(*) FROM diag_report WHERE created_at > now() - interval '24 hours';
```

Первая строка — исключение: там **ноль** означает проблему, остальные `ALERT` должны
быть нулевыми.

Эта же сводка лежит готовым файлом — запуск одной командой:

```bash
psql -f scripts/healthcheck.sql
```

---

## Что делать по срабатыванию

| Сигнал | Первое действие |
|---|---|
| Нет админского контекста | Открыть приложение администратором портала, проверить `/api/healthz` |
| План просрочен | Проверить `SCHEDULER_ENABLED`, живость процесса, логи планировщика |
| `reserved` копятся | Планировщик не тикает — рестарт бэкенда, затем проверить повторно |
| Фото без `disk_object_id` | Проверить scope Диска и `disk.folderNameTemplate` в настройках |
| CRM-очередь стоит | Воркер не запущен либо истёк токен — смотреть `last_error` |
| Замечания не доставлены | Проверить регистрацию бота (`BITRIX_BOT_ID`, `BITRIX_BOT_MODE`) |

Связанные документы: [08-operations.md](spec-kit/08-operations.md),
[runbook внешней БД](superpowers/plans/2026-06-11-external-db-migration-runbook.md).
