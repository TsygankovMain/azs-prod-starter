# Сбор логов через Adminer: пакет SQL-запросов

Чистый SQL под Adminer — без `psql`-мета-команд, шелла и доступа к контейнеру.
Каждый запрос самодостаточен: выделить, вставить в поле «SQL-запрос», выполнить.
Всё только читает.

**Где здесь «логи приложения».** Рантайм-лог процесса через SQL недоступен, но
приложение само пишет в базу почти всё, что нужно для разбора:

| Источник | Что внутри |
|---|---|
| `dispatch_plan.error_text` | сбои планировщика при отправке |
| `dispatch_log.error_text` | сбои конкретного отчёта |
| `crm_sync_jobs.last_error` | сбои синхронизации с CRM |
| `photo_remark(_photo).delivery_error` | недоставленные замечания |
| `diag_report.bundle` | **клиентский лог**: JS-ошибки, журнал загрузок фото, HTTP-вызовы, вызовы Bitrix REST, состояние сети и устройства |
| `diag_report.server_slice` | серверные пробы на момент жалобы: OAuth, Диск, БД, флаги окружения |

Бандлы диагностики уже очищены от секретов на клиенте и на сервере — токены туда
не попадают, выгрузку можно пересылать как есть.

---

## 1. Сводка: где рвётся

Первый запрос при любом разборе. Строки `ALERT` должны быть нулевыми, кроме первой —
там ноль означает проблему.

```sql
SELECT metric AS "метрика", value AS "значение" FROM (
  SELECT 1 ord,'ALERT: админский OAuth-контекст (0 = проблема)' metric, count(*) FILTER (WHERE is_admin) value FROM auth_context
  UNION ALL SELECT 2,'ALERT: план просрочен >10 мин', count(*) FROM dispatch_plan WHERE status='planned' AND execute_at < now()-interval '10 minutes'
  UNION ALL SELECT 3,'ALERT: отчёты зависли в reserved >1 ч', count(*) FROM dispatch_log WHERE status='reserved' AND slot_key NOT LIKE '%:reminder:%' AND created_at < now()-interval '1 hour'
  UNION ALL SELECT 4,'ALERT: дедлайн прошёл, отчёт не закрыт', count(*) FROM dispatch_log WHERE deadline_at IS NOT NULL AND deadline_at < now() AND status NOT IN ('done','expired','failed','cancelled')
  UNION ALL SELECT 5,'ALERT: фото без disk_object_id >30 мин', count(*) FROM report_photo WHERE disk_object_id IS NULL AND uploaded_at < now()-interval '30 minutes'
  UNION ALL SELECT 6,'ALERT: CRM-очередь просрочена >15 мин', count(*) FROM crm_sync_jobs WHERE status='pending' AND next_attempt_at < now()-interval '15 minutes'
  UNION ALL SELECT 7,'ALERT: CRM залипли в running >10 мин', count(*) FROM crm_sync_jobs WHERE status='running' AND updated_at < now()-interval '10 minutes'
  UNION ALL SELECT 8,'ALERT: CRM провалены окончательно', count(*) FROM crm_sync_jobs WHERE status='failed' OR attempts >= max_attempts
  UNION ALL SELECT 9,'ALERT: замечания не доставлены (7 дн)', count(*) FROM photo_remark_photo p JOIN photo_remark r ON r.id=p.remark_id WHERE p.delivery_status<>'sent' AND r.created_at > now()-interval '7 days'
  UNION ALL SELECT 10,'ALERT: done без единого фото (7 дн)', count(*) FROM (SELECT d.id FROM dispatch_log d LEFT JOIN report_photo rp ON rp.report_id=d.id WHERE d.status='done' AND d.created_at > now()-interval '7 days' GROUP BY d.id HAVING count(rp.id)=0) t
  UNION ALL SELECT 20,'info: отчётов done за сутки', count(*) FROM dispatch_log WHERE status='done' AND updated_at > now()-interval '24 hours'
  UNION ALL SELECT 21,'info: отчётов expired за сутки', count(*) FROM dispatch_log WHERE status='expired' AND updated_at > now()-interval '24 hours'
  UNION ALL SELECT 22,'info: фото загружено за сутки', count(*) FROM report_photo WHERE uploaded_at > now()-interval '24 hours'
  UNION ALL SELECT 23,'info: запланировано на сегодня', count(*) FROM dispatch_plan WHERE plan_date = to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD')
  UNION ALL SELECT 24,'info: жалоб через диагностику за сутки', count(*) FROM diag_report WHERE created_at > now()-interval '24 hours'
) s ORDER BY ord;
```

---

**Почему в двух строках сводки есть оговорки** (уточнено 11.08.2026 по факту разбора):

- В «зависли в reserved» не считаются строки напоминаний (`slot_key` вида `%:reminder:%`). Исполнитель напоминаний резервирует такую строку перед отправкой и статус ей потом не меняет, поэтому она навсегда остаётся `reserved`. Это не зависший отчёт, а служебная запись: без оговорки метрика показывала 271 при одном реальном случае.
- В «дедлайн прошёл, отчёт не закрыт» добавлен `cancelled`. Отменённый отчёт закрыт по сути, но раньше в терминальные статусы не входил и давал 266 ложных срабатываний из 270.

## 2. Единая лента ошибок бэкенда за 3 суток

Все серверные ошибки из четырёх таблиц в одном хронологическом потоке.
Это ближайший аналог `tail -f` по логу приложения, доступный через SQL.

```sql
SELECT источник, произошло_мск, ключ, азс, ошибка FROM (
  SELECT 'планировщик' AS источник,
         updated_at AT TIME ZONE 'Europe/Moscow' AS произошло_мск,
         'plan#'||id AS ключ, azs_id AS азс,
         left(error_text, 300) AS ошибка, updated_at AS ts
  FROM dispatch_plan
  WHERE error_text IS NOT NULL AND updated_at > now()-interval '3 days'

  UNION ALL
  SELECT 'отчёт', updated_at AT TIME ZONE 'Europe/Moscow',
         'report#'||id, azs_id, left(error_text, 300), updated_at
  FROM dispatch_log
  WHERE error_text IS NOT NULL AND updated_at > now()-interval '3 days'

  UNION ALL
  SELECT 'CRM-синк', j.updated_at AT TIME ZONE 'Europe/Moscow',
         'job#'||j.id||' report#'||j.report_id, d.azs_id, left(j.last_error, 300), j.updated_at
  FROM crm_sync_jobs j
  LEFT JOIN dispatch_log d ON d.id = j.report_id
  WHERE j.last_error IS NOT NULL AND j.updated_at > now()-interval '3 days'

  UNION ALL
  SELECT 'замечание', r.created_at AT TIME ZONE 'Europe/Moscow',
         'remark#'||r.id, r.azs_id,
         left(coalesce(r.delivery_error, p.delivery_error), 300), r.created_at
  FROM photo_remark r
  LEFT JOIN photo_remark_photo p ON p.remark_id = r.id
  WHERE coalesce(r.delivery_error, p.delivery_error) IS NOT NULL
    AND r.created_at > now()-interval '3 days'
) t
ORDER BY ts DESC
LIMIT 200;
```

Частотный срез по тому же материалу — что именно ломается чаще всего:

```sql
SELECT источник, left(ошибка, 90) AS образец, count(*) AS раз FROM (
  SELECT 'планировщик' AS источник, error_text AS ошибка FROM dispatch_plan
    WHERE error_text IS NOT NULL AND updated_at > now()-interval '7 days'
  UNION ALL SELECT 'отчёт', error_text FROM dispatch_log
    WHERE error_text IS NOT NULL AND updated_at > now()-interval '7 days'
  UNION ALL SELECT 'CRM-синк', last_error FROM crm_sync_jobs
    WHERE last_error IS NOT NULL AND updated_at > now()-interval '7 days'
) t
GROUP BY источник, left(ошибка, 90)
ORDER BY раз DESC
LIMIT 30;
```

---

## 3. Клиентский лог: JS-ошибки из диагностики

`CASE WHEN jsonb_typeof(...)` нужен, чтобы старые или пустые бандлы не роняли запрос.

```sql
SELECT d.code AS "код жалобы",
       d.created_at AT TIME ZONE 'Europe/Moscow' AS "жалоба мск",
       d.azs_id AS "азс", d.user_id AS "пользователь", d.report_id AS "отчёт",
       e->>'kind' AS "тип",
       left(e->>'message', 200) AS "сообщение",
       (e->>'source')||':'||(e->>'line') AS "место",
       e->>'at' AS "время события"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'errors')='array' THEN d.bundle->'errors' ELSE '[]'::jsonb END
) AS e
WHERE d.created_at > now()-interval '7 days'
ORDER BY d.created_at DESC
LIMIT 200;
```

Топ клиентских ошибок — где регрессия:

```sql
SELECT left(e->>'message', 100) AS "сообщение",
       count(*) AS "раз",
       count(DISTINCT d.azs_id) AS "азс",
       count(DISTINCT d.user_id) AS "пользователей",
       max(d.created_at) AT TIME ZONE 'Europe/Moscow' AS "последний раз мск"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'errors')='array' THEN d.bundle->'errors' ELSE '[]'::jsonb END
) AS e
WHERE d.created_at > now()-interval '14 days'
GROUP BY left(e->>'message', 100)
ORDER BY "раз" DESC
LIMIT 30;
```

---

## 4. Журнал загрузок фото: почему фото не доехало

Самое ценное для «фото не грузятся». Видны код ошибки, HTTP-статус, размер файла,
длительность и номер попытки.

```sql
SELECT d.code AS "код жалобы",
       d.created_at AT TIME ZONE 'Europe/Moscow' AS "жалоба мск",
       d.azs_id AS "азс", d.report_id AS "отчёт",
       u->>'photoCode' AS "тип фото",
       u->>'outcome' AS "итог",
       u->>'errorCode' AS "код ошибки",
       u->>'httpStatus' AS "http",
       u->>'retryable' AS "повторяемо",
       u->>'attempt' AS "попытка",
       round((u->>'fileSize')::numeric/1048576, 2) AS "размер мб",
       round((u->>'durationMs')::numeric/1000, 1) AS "длительность с",
       left(u->>'message', 160) AS "сообщение"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'uploads')='array' THEN d.bundle->'uploads' ELSE '[]'::jsonb END
) AS u
WHERE d.created_at > now()-interval '7 days'
  AND u->>'outcome' = 'error'
ORDER BY d.created_at DESC
LIMIT 200;
```

Сводка по кодам ошибок загрузки:

```sql
SELECT coalesce(u->>'errorCode','(нет кода)') AS "код ошибки",
       coalesce(u->>'httpStatus','—') AS "http",
       count(*) AS "раз",
       round(avg((u->>'durationMs')::numeric)/1000, 1) AS "средняя длительность с",
       round(avg((u->>'fileSize')::numeric)/1048576, 2) AS "средний размер мб"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'uploads')='array' THEN d.bundle->'uploads' ELSE '[]'::jsonb END
) AS u
WHERE d.created_at > now()-interval '14 days' AND u->>'outcome'='error'
GROUP BY 1, 2
ORDER BY "раз" DESC;
```

---

## 5. Сетевые вызовы и Bitrix REST

Провальные HTTP-запросы клиента (`status = 0` — обрыв связи):

```sql
SELECT d.code AS "код жалобы",
       d.azs_id AS "азс",
       n->>'method' AS "метод",
       left(n->>'url', 80) AS "url",
       n->>'status' AS "статус",
       round((n->>'durationMs')::numeric/1000, 1) AS "с",
       n->>'startedAt' AS "начало"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'net')='array' THEN d.bundle->'net' ELSE '[]'::jsonb END
) AS n
WHERE d.created_at > now()-interval '7 days'
  AND ((n->>'status')::int >= 400 OR (n->>'status')::int = 0)
ORDER BY d.created_at DESC
LIMIT 200;
```

Ошибки вызовов Bitrix24 REST — здесь всплывают `expired_token` и `insufficient_scope`:

```sql
SELECT b->>'method' AS "метод b24",
       b->>'errorCode' AS "код ошибки",
       count(*) AS "раз",
       round(avg((b->>'durationMs')::numeric)/1000, 1) AS "средняя с",
       max(d.created_at) AT TIME ZONE 'Europe/Moscow' AS "последний раз мск"
FROM diag_report d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.bundle->'b24')='array' THEN d.bundle->'b24' ELSE '[]'::jsonb END
) AS b
WHERE d.created_at > now()-interval '14 days'
  AND (b->>'ok') = 'false'
GROUP BY 1, 2
ORDER BY "раз" DESC;
```

---

## 6. Серверные пробы на момент жалобы

`server_slice` снимается бэкендом в момент отправки бандла: живость OAuth, реальный
вызов Диска с таймингом, пинг БД и флаги окружения. Быстро отделяет «сломался клиент»
от «сломался сервер».

```sql
SELECT code AS "код жалобы",
       created_at AT TIME ZONE 'Europe/Moscow' AS "жалоба мск",
       azs_id AS "азс",
       server_slice->'app'->>'schedulerEnabled' AS "планировщик вкл",
       server_slice->'app'->>'botMode' AS "режим бота",
       server_slice->'oauth'->>'hasContext' AS "oauth есть",
       server_slice->'oauth'->>'ageSec' AS "возраст токена с",
       server_slice->'oauth'->>'domain' AS "домен",
       server_slice->'disk'->>'ok' AS "диск ок",
       server_slice->'disk'->>'ms' AS "диск мс",
       server_slice->'disk'->>'errorCode' AS "диск ошибка",
       server_slice->'db'->>'ok' AS "бд ок",
       server_slice->'db'->>'ms' AS "бд мс"
FROM diag_report
WHERE created_at > now()-interval '7 days'
  AND server_slice IS NOT NULL
ORDER BY created_at DESC
LIMIT 100;
```

Только проблемные срезы:

```sql
SELECT code AS "код жалобы",
       created_at AT TIME ZONE 'Europe/Moscow' AS "жалоба мск",
       azs_id AS "азс",
       server_slice->'oauth'->>'hasContext' AS "oauth есть",
       server_slice->'disk'->>'errorCode' AS "диск ошибка",
       left(server_slice->'disk'->>'errorMessage', 120) AS "диск текст",
       left(server_slice->'db'->>'errorMessage', 120) AS "бд текст"
FROM diag_report
WHERE created_at > now()-interval '14 days'
  AND server_slice IS NOT NULL
  AND (server_slice->'disk'->>'ok' = 'false'
       OR server_slice->'db'->>'ok' = 'false'
       OR server_slice->'oauth'->>'hasContext' = 'false'
       OR server_slice->'app'->>'schedulerEnabled' = 'false')
ORDER BY created_at DESC
LIMIT 100;
```

---

## 7. Условия на местах: сеть и устройства

Для жалоб «долго грузится» — часто причина не в коде, а в 3G на АЗС.

```sql
SELECT d.azs_id AS "азс",
       count(*) AS "жалоб",
       round(avg((d.bundle->'network'->>'rtt')::numeric)) AS "средний rtt мс",
       round(avg((d.bundle->'network'->>'downlink')::numeric), 1) AS "средний канал мбит",
       round(avg((d.bundle->'probe'->>'echoKbps')::numeric)) AS "реальная отдача кбит",
       round(avg((d.bundle->'startup'->>'ttfbMs')::numeric)) AS "средний ttfb мс",
       string_agg(DISTINCT d.bundle->'network'->>'effectiveType', ', ') AS "тип сети",
       string_agg(DISTINCT d.bundle->'device'->>'platform', ', ') AS "платформы"
FROM diag_report d
WHERE d.created_at > now()-interval '30 days'
  AND jsonb_typeof(d.bundle->'network') = 'object'
GROUP BY d.azs_id
ORDER BY "жалоб" DESC
LIMIT 30;
```

---

## 8. Разбор одного случая

Когда известен код жалобы (пользователь видит его на экране) — вся картина по нему.
Подставьте свой код вместо `A1B2C3`.

```sql
SELECT code AS "код", created_at AT TIME ZONE 'Europe/Moscow' AS "жалоба мск",
       trigger AS "триггер", azs_id AS "азс", user_id AS "пользователь",
       report_id AS "отчёт", size_bytes AS "размер бандла",
       bundle->'app'->>'build' AS "сборка",
       bundle->'app'->>'route' AS "экран",
       bundle->'device'->>'platform' AS "платформа",
       left(bundle->'device'->>'userAgent', 80) AS "устройство",
       bundle->'queue'->>'activeCount' AS "активных загрузок",
       bundle->'dropped'->>'errors' AS "потеряно ошибок"
FROM diag_report
WHERE code = 'A1B2C3';
```

Сырой бандл целиком — если нужно прислать мне на разбор:

```sql
SELECT jsonb_pretty(bundle) AS "бандл", jsonb_pretty(server_slice) AS "серверный срез"
FROM diag_report
WHERE code = 'A1B2C3';
```

---

## 9. Батч разбора: провалы CRM-синка и зависшие отчёты

Прицельный набор под инцидент от 10.08.2026: массовые `failed` в `crm_sync_jobs`
с текстом `reportItemId is missing or invalid` плюс накопление `reserved`.
Вставляется одним куском — Adminer нарисует десять таблиц подряд.

> **Важно про метрику «CRM провалены окончательно».** В сводке она считается как
> `status='failed' OR attempts >= max_attempts`. Второе условие ловит и *успешные*
> джобы, которым потребовались все попытки (`status='done'`, `attempts=4`). Поэтому
> число из сводки — верхняя оценка; истинное значение даёт запрос Q1 ниже.

```sql
-- Q1. Очередь по статусам: отделяем настоящие провалы от done-с-ретраями
SELECT status AS "статус", count(*) AS "джобов", count(DISTINCT report_id) AS "уник отчётов",
       min(attempts) AS "мин попыток", max(attempts) AS "макс попыток",
       min(created_at) AT TIME ZONE 'Europe/Moscow' AS "первый",
       max(updated_at) AT TIME ZONE 'Europe/Moscow' AS "последний"
FROM crm_sync_jobs GROUP BY status ORDER BY count(*) DESC;

-- Q2. Какие вообще тексты ошибок среди failed
SELECT left(last_error,110) AS "ошибка", count(*) AS "джобов", count(DISTINCT report_id) AS "отчётов",
       min(updated_at) AT TIME ZONE 'Europe/Moscow' AS "первый раз",
       max(updated_at) AT TIME ZONE 'Europe/Moscow' AS "последний раз"
FROM crm_sync_jobs WHERE status='failed'
GROUP BY left(last_error,110) ORDER BY count(*) DESC LIMIT 20;

-- Q3. Когда началось: динамика по дням
SELECT date_trunc('day', updated_at AT TIME ZONE 'Europe/Moscow')::date AS "день",
       count(*) FILTER (WHERE status='failed') AS "провалено",
       count(*) FILTER (WHERE status='done') AS "успешно",
       count(*) AS "всего"
FROM crm_sync_jobs WHERE updated_at > now()-interval '30 days'
GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

-- Q4. Прямая проверка причины: у провальных джобов пуст report_item_id?
SELECT CASE WHEN d.id IS NULL THEN 'отчёта нет в dispatch_log'
            WHEN d.report_item_id IS NULL THEN 'report_item_id ПУСТ'
            ELSE 'report_item_id есть' END AS "состояние отчёта",
       count(*) AS "провальных джобов", count(DISTINCT j.report_id) AS "отчётов"
FROM crm_sync_jobs j LEFT JOIN dispatch_log d ON d.id = j.report_id
WHERE j.status='failed' GROUP BY 1 ORDER BY 2 DESC;

-- Q5. Дубли: сколько провальных джобов приходится на один отчёт
SELECT jobs_per_report AS "джобов на отчёт", count(*) AS "отчётов" FROM (
  SELECT report_id, count(*) AS jobs_per_report FROM crm_sync_jobs WHERE status='failed' GROUP BY report_id
) t GROUP BY 1 ORDER BY 1 DESC LIMIT 15;

-- Q6. Масштаб отчётов без карточки смарт-процесса
SELECT status AS "статус отчёта", count(*) AS "отчётов",
       min(created_at) AT TIME ZONE 'Europe/Moscow' AS "первый",
       max(created_at) AT TIME ZONE 'Europe/Moscow' AS "последний"
FROM dispatch_log WHERE report_item_id IS NULL GROUP BY status ORDER BY count(*) DESC;

-- Q7. Зависшие reserved: основные слоты или напоминания
SELECT CASE WHEN slot_key LIKE '%:reminder:%' THEN 'напоминание' ELSE 'основной' END AS "тип слота",
       count(*) AS "зависших",
       count(*) FILTER (WHERE error_text IS NOT NULL) AS "с текстом ошибки",
       count(*) FILTER (WHERE report_item_id IS NULL) AS "без карточки СП",
       min(created_at) AT TIME ZONE 'Europe/Moscow' AS "самый старый"
FROM dispatch_log WHERE status='reserved' AND created_at < now()-interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;

-- Q8. Зависшие reserved по дням
SELECT date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow')::date AS "день",
       count(*) AS "зависших", count(DISTINCT azs_id) AS "азс"
FROM dispatch_log WHERE status='reserved' AND created_at < now()-interval '1 hour'
GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

-- Q9. Просроченный дедлайн: в каких статусах висят
SELECT status AS "статус", count(*) AS "отчётов",
       min(deadline_at) AT TIME ZONE 'Europe/Moscow' AS "самый старый дедлайн",
       max(deadline_at) AT TIME ZONE 'Europe/Moscow' AS "самый свежий"
FROM dispatch_log
WHERE deadline_at IS NOT NULL AND deadline_at < now() AND status NOT IN ('done','expired','failed')
GROUP BY status ORDER BY count(*) DESC;

-- Q10. Админские контексты и домены портала
SELECT key AS "ключ", is_admin AS "админ",
       updated_at AT TIME ZONE 'Europe/Moscow' AS "обновлён мск",
       now()-updated_at AS "возраст",
       payload::jsonb->>'domain' AS "домен",
       payload::jsonb->>'memberId' AS "member_id"
FROM auth_context ORDER BY is_admin DESC, updated_at DESC LIMIT 20;
```

Если Q10 упадёт на приведении типа — значит `payload` хранит не-JSON; тогда убрать
две последние колонки.

---

## Что присылать в первую очередь

1. Запрос 1 — сводка.
2. Запрос 2 — единая лента ошибок бэкенда.
3. Запрос 6 — серверные пробы.

Этих трёх обычно хватает, чтобы назвать причину. Запросы 3–5 и 7 — уже прицельно,
по тому, что покажут первые три.

Подробный разбор по подсистемам и «что делать по срабатыванию» — [db-healthcheck.md](db-healthcheck.md).
