# Дизайн: рандомизированный план рассылки (plan-then-execute)

- Дата: 2026-06-01
- Ветка: `feature/randomized-dispatch`
- Критичность: **ВЫСШАЯ** — затрагивает основной прод-путь авто-рассылки. Внедрение за фиче-флагом с мгновенным откатом.
- Источники: требования клиента (этот чат) + полный разбор `dispatchScheduler.js`, `dispatchService.js`, `dispatchLogStore.js`.

## 1. Проблема

Сейчас (`dispatchScheduler.runOnce`): cron тикает каждую минуту, но рассылка срабатывает **только в минуту base-времени** (напр. 12:00) — и тогда **все АЗС получают пуш одновременно**. Джиттер (`dispatchService.dispatchCandidate:138`) меняет только `scheduledAt`/`deadlineAt` в записи, НЕ момент пуша. → АЗС знают, когда придёт проверка → могут подготовиться. Это противоречит цели «внезапная проверка».

## 2. Целевое поведение

- В **00:01** приложение генерирует план на **текущий день**: для каждой включённой АЗS × каждого base-времени — своё случайное смещение `jitter ∈ [−N, +N]` (N = `dispatchJitterMinutes`), `execute_at = base + jitter`, **поджатое к рабочему окну** [work_start, work_end].
- В назначенную случайную минуту (НЕ в base-время) cron создаёт элемент Б24 + пуш + запрос отчёта **поштучно** для каждой АЗС.
- Момент проверки знает только БД. Каждый день — новый рандом. У каждой АЗС — своё смещение.
- Проверяющий видит **справочный план на сегодня** (только чтение): АЗС | время запроса | ответственный | статус.

## 3. Архитектура (plan-then-execute)

### 3.1 Новая таблица `dispatch_plan` (durable, PG + MySQL; паттерн `crmSyncJobStore`)
```
id            BIGSERIAL / BIGINT PK
plan_date     TEXT/VARCHAR     -- 'YYYY-MM-DD' (в таймзоне настроек)
azs_id        TEXT/VARCHAR
admin_user_id BIGINT
base_time     TEXT/VARCHAR     -- 'HHMM' базовый слот
execute_at    TIMESTAMPTZ/DATETIME -- момент реальной рассылки (UTC)
jitter_minutes INT
status        TEXT             -- planned | dispatched | failed | skipped
report_item_id BIGINT NULL     -- заполняется после рассылки
error_text    TEXT NULL
created_at, updated_at
UNIQUE(plan_date, azs_id, base_time)   -- идемпотентность генерации
INDEX(status, execute_at)              -- быстрый выбор «созревших»
```

### 3.2 Генерация плана
- Cron `1 0 * * *` (00:01 в таймзоне сервера; план считается в таймзоне настроек).
- На boot: если на сегодня плана нет И ещё не прошли все base-времена → сгенерировать (bootstrap для первого дня после включения флага / рестарта).
- Логика: загрузить включённые АЗС (`loadCandidatesFromAzs` — переиспользуем), для каждой × base-время посчитать jitter, `execute_at`, clamp к [work_start, work_end], `INSERT ... ON CONFLICT DO NOTHING` (идемпотентно).
- Ручная регенерация на сегодня: `deletePlannedForDate(today)` (только status=planned, dispatched не трогаем) + повторная генерация.

### 3.3 Исполнение
- Существующий тик `* * * * *`.
- `SELECT * FROM dispatch_plan WHERE status='planned' AND execute_at <= NOW() ORDER BY execute_at`.
- Для каждой созревшей: `dispatchService.dispatchBatch({ candidates:[{azsId, adminUserId, slotDate, slotHHmm, scheduledAt, jitterMinutes }], trigger:'auto' })` — с **предрасчитанным** scheduledAt (см. 3.4) → `markDispatched(id, reportItemId)` или `markFailed`.
- Past-due (execute_at в прошлом, сервер лежал) подхватываются автоматически.

### 3.4 Критический seam: джиттер не должен примениться дважды
`dispatchService.dispatchCandidate` сейчас сам зовёт `pickJitterMinutes` (line 138) и считает `scheduledAt = plannedAt + jitter`. В новом пути джиттер **уже применён** на этапе генерации.
- Решение: `dispatchCandidate` принимает опциональные `candidate.scheduledAt` (Date/ISO) и `candidate.jitterMinutes`. Если переданы — использует их, НЕ зовёт `pickJitterMinutes`. Если не переданы — текущее поведение (manual-путь, обратная совместимость).
- `deadlineAt = scheduledAt + timeoutMinutes` (как сейчас).

### 3.5 Замена старого пути (за флагом)
- `DISPATCH_PLAN_MODE_ENABLED` (default `false`).
- Флаг ON: `runOnce` НЕ делает старую «рассылку в минуту слота»; вместо этого исполняет созревшие планы. Генерация — отдельным cron/boot.
- Флаг OFF: текущее поведение без изменений (нулевой риск при деплое).
- Идемпотентность `UNIQUE(slot_key, azs_id)` в `dispatch_log` остаётся вторым рубежом от дублей.

### 3.6 Рабочее окно (clamp), настраивается в UI
- Настройки: `report.workWindow = { start: 'HH:MM', end: 'HH:MM' }` (напр. 07:00–22:00).
- `execute_at` поджимается: если < start → start; если > end → end (в пределах plan_date).
- Валидатор: start < end, формат HH:MM.

### 3.7 Экран проверяющего — «План на сегодня» (read-only)
- Новый endpoint `GET /api/reports/plan?date=YYYY-MM-DD` (reviewer-guarded) → `dispatchPlanStore.listByDate`.
- Таблица: АЗС (название) | Время запроса (execute_at в TZ) | Ответственный | Статус (запланирован/отправлен/ошибка).
- Только чтение (по решению клиента).

## 4. Что переиспользуем (не дублируем)
- Дуальный стор PG/MySQL — паттерн `crmSyncJobStore.js`.
- `loadCandidatesFromAzs`, `getTimeParts`, `parseScheduleTimes`, `getFieldValue` (с camelCase-фиксом) — вынести в общий util, чтобы генерация и старый путь не разошлись.
- `pickJitterMinutes` (±N) — как есть.
- `dispatchService.dispatchBatch` — точечно по 1 АЗС.
- Существующий cron-тик и `node-cron`.

## 5. Обработка ошибок
- Генерация падает → лог + не блокирует тик; boot-bootstrap и ручная регенерация как страховка.
- Исполнение элемента падает → `markFailed(error_text)`, видно проверяющему; остальные планы не затронуты.
- Дубль (рестарт во время рассылки) → `dispatch_log` UNIQUE отбивает повторный INSERT.
- Past-due массой (сервер долго лежал) → исполняются по порядку, по 1/мин (или батч с лимитом — см. план).

## 6. Тестирование
- `dispatchPlanStore`: schema, generate/upsert идемпотентность, listDue по времени, markDispatched/markFailed, listByDate, deletePlannedForDate. Fake-pool, без живой БД.
- Генерация: jitter в диапазоне, clamp к окну, у каждой АЗС своё значение (детерминированный rng в тесте), идемпотентность повторного запуска.
- dispatchService: precomputed scheduledAt НЕ ре-джиттерится (новый тест) + старый путь без precomputed работает как раньше (регресс).
- Исполнение: только созревшие, markDispatched, past-due подхват.
- Флаг OFF → старое поведение (регресс-тест существующих 3 тестов scheduler).
- Backend `node --test tests/*.test.js` зелёным.

## 7. Безопасность внедрения
- Всё за `DISPATCH_PLAN_MODE_ENABLED=false` по умолчанию → деплой не меняет прод.
- Включение: выставить флаг → рестарт → boot сгенерит план на остаток дня → смоук на стейдже/проде → наблюдать логи.
- Откат: флаг в `false` → мгновенно старое поведение.

## 8. Подтверждённые решения
- План на **сегодня**, генерация 00:01 + boot-bootstrap.
- Рабочее окно: **настраивается в UI** (start/end).
- Экран проверяющего: **список АЗС + время, read-only**.
- Каждая АЗС — своё случайное смещение, каждый день новое.
- Внедрение за фиче-флагом.

## 9. Открытый момент (не блокирует старт)
- Лимит исполнений за один тик при массовом past-due (чтобы не словить QUERY_LIMIT_EXCEEDED) — заложить `EXECUTE_BATCH_LIMIT` (напр. 20/мин). Уточнить значение на нагрузке.
