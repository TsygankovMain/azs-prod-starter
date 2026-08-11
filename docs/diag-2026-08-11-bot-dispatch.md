# Диагностика: 33249 не получает запрос; 548 и 3108 получают по 2–5 раз

Дата: 11.08.2026. Проект: `2_Клиенты/ОРТК/Проекты/АЗС прод/azs-prod-starter`, ветка `feat/diag-bundle-stage1`.

Всё ниже только читает. Выполнять по порядку: сначала блок A (SQL, Adminer), потом блок B (консоль браузера) — блоку B нужен `entityTypeId` из A0.

**Итоги первого раунда — в конце файла, раздел «Раунд 1: что показали данные». Там же второй раунд запросов (A7–A12).**

---

## Блок A. SQL в Adminer (БД `BD_AZS`)

### A0. Настройки: тип смарт-процесса АЗС, поля, расписание

```sql
SELECT scope_key AS "скоуп",
       (settings_json::jsonb)->'azs'->>'entityTypeId'      AS "entityTypeId АЗС",
       (settings_json::jsonb)->'azs'->'fields'             AS "поля АЗС",
       (settings_json::jsonb)->'report'->'dispatchTimes'   AS "глобальные слоты",
       (settings_json::jsonb)->'report'->>'dispatchJitterMinutes' AS "джиттер мин",
       (settings_json::jsonb)->'report'->'workWindow'      AS "рабочее окно",
       (settings_json::jsonb)->>'timezone'                 AS "таймзона",
       jsonb_array_length(coalesce((settings_json::jsonb)->'dispatchProfiles','[]'::jsonb)) AS "профилей",
       updated_at AT TIME ZONE 'Europe/Moscow'             AS "обновлены мск"
FROM app_settings;
```

### A1. Профили рассылки: кто в каком режиме и с каким числом окон

Режим B = «первичная точка + напоминания по окнам». Число окон и есть верхняя граница «сколько раз в день».

```sql
SELECT p->>'id'   AS "профиль",
       p->>'name' AS "название",
       p->>'mode' AS "режим",
       jsonb_array_length(coalesce(p->'azsIds','[]'::jsonb))          AS "азс в профиле",
       coalesce(p->'config'->'slots', p->'config'->'windows')         AS "слоты/окна",
       jsonb_array_length(coalesce(p->'config'->'windows','[]'::jsonb)) AS "окон (режим B)",
       p->'config'->>'escalateUntilDone'                              AS "эскалация до сдачи",
       p->'azsIds'                                                    AS "список азс"
FROM app_settings,
     LATERAL jsonb_array_elements(coalesce((settings_json::jsonb)->'dispatchProfiles','[]'::jsonb)) p;
```

### A2. Главный запрос: кому сколько раз слали и был ли отчёт сдан

Это прямой ответ на «548 и 3108 — по 2–5 раз за день». Строки, где `напоминаний > 0` **и** `отчёт_сдан = 1`, — это дефект: напоминания продолжали идти после сдачи.

```sql
SELECT substring(slot_key from 1 for 10) AS "день",
       azs_id AS "азс",
       count(*) FILTER (WHERE slot_key NOT LIKE '%:reminder:%') AS "первичных",
       count(*) FILTER (WHERE slot_key LIKE '%:reminder:%')     AS "напоминаний",
       max(CASE WHEN slot_key NOT LIKE '%:reminder:%' AND status = 'done' THEN 1 ELSE 0 END) AS "отчёт_сдан",
       string_agg(DISTINCT status, ', ')                        AS "статусы",
       min(created_at) AT TIME ZONE 'Europe/Moscow'             AS "первое",
       max(created_at) AT TIME ZONE 'Europe/Moscow'             AS "последнее"
FROM dispatch_log
WHERE created_at > now() - interval '7 days'
  AND slot_key ~ '^\d{4}-\d{2}-\d{2}'
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY count(*) DESC, 1 DESC
LIMIT 60;
```

### A3. План на последние 3 дня: сколько точек и каких сгенерировано

Показывает, заложены ли 2–5 отправок ещё на этапе планирования (то есть это профиль), или они появились сверх плана (то есть это дефект исполнения).

```sql
SELECT plan_date AS "дата",
       azs_id    AS "азс",
       count(*) FILTER (WHERE entry_type = 'primary')  AS "первичных точек",
       count(*) FILTER (WHERE entry_type = 'reminder') AS "напоминаний",
       string_agg(base_time || '/' || entry_type || coalesce('#' || window_index::text, '') || '=' || status, ', ' ORDER BY base_time) AS "точки",
       count(*) FILTER (WHERE error_text IS NOT NULL)  AS "с ошибкой"
FROM dispatch_plan
WHERE plan_date >= to_char((now() AT TIME ZONE 'Europe/Moscow') - interval '3 days', 'YYYY-MM-DD')
GROUP BY 1, 2
ORDER BY 1 DESC, count(*) DESC
LIMIT 80;
```

### A4. Полный список АЗС в плане на сегодня

По нему проверяем «33249 не приходит запрос»: если её ID здесь нет — АЗС отсеялась ещё при сборке кандидатов (нет ответственного или снят флаг «включена» в карточке CRM), и до отправки дело не доходило.

```sql
SELECT plan_date AS "дата",
       count(DISTINCT azs_id) AS "азс в плане",
       count(*) AS "точек всего",
       string_agg(DISTINCT azs_id, ', ' ORDER BY azs_id) AS "id азс"
FROM dispatch_plan
WHERE plan_date >= to_char((now() AT TIME ZONE 'Europe/Moscow') - interval '2 days', 'YYYY-MM-DD')
GROUP BY 1
ORDER BY 1 DESC;
```

### A5. Ошибки планировщика и отправки за 3 суток

```sql
SELECT источник, произошло_мск, ключ, азс, ошибка FROM (
  SELECT 'планировщик' AS источник, updated_at AT TIME ZONE 'Europe/Moscow' AS произошло_мск,
         'plan#' || id AS ключ, azs_id AS азс, left(error_text, 300) AS ошибка, updated_at AS ts
  FROM dispatch_plan WHERE error_text IS NOT NULL AND updated_at > now() - interval '3 days'
  UNION ALL
  SELECT 'отчёт', updated_at AT TIME ZONE 'Europe/Moscow',
         'report#' || id, azs_id, left(error_text, 300), updated_at
  FROM dispatch_log WHERE error_text IS NOT NULL AND updated_at > now() - interval '3 days'
) t
ORDER BY ts DESC
LIMIT 100;
```

### A6. Общая сводка «где рвётся»

```sql
SELECT metric AS "метрика", value AS "значение" FROM (
  SELECT 1 ord,'ALERT: админский OAuth-контекст (0 = проблема)' metric, count(*) FILTER (WHERE is_admin) value FROM auth_context
  UNION ALL SELECT 2,'ALERT: план просрочен >10 мин', count(*) FROM dispatch_plan WHERE status='planned' AND execute_at < now()-interval '10 minutes'
  UNION ALL SELECT 3,'ALERT: отчёты зависли в reserved >1 ч', count(*) FROM dispatch_log WHERE status='reserved' AND created_at < now()-interval '1 hour'
  UNION ALL SELECT 4,'ALERT: дедлайн прошёл, отчёт не закрыт', count(*) FROM dispatch_log WHERE deadline_at IS NOT NULL AND deadline_at < now() AND status NOT IN ('done','expired','failed')
  UNION ALL SELECT 20,'info: отчётов done за сутки', count(*) FROM dispatch_log WHERE status='done' AND updated_at > now()-interval '24 hours'
  UNION ALL SELECT 23,'info: запланировано на сегодня', count(*) FROM dispatch_plan WHERE plan_date = to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD')
) s ORDER BY ord;
```

---

## Блок B. Консоль браузера — сопоставить номера АЗС с ID карточек

Номера 33249, 548, 3108 — внешние. В базе приложения АЗС хранится по **ID элемента смарт-процесса**, поэтому сначала находим ID.

Открыть **портал ОРТК** (обычную страницу Битрикс24, не приложение), F12 → Console, подставить `ETID` из запроса A0 и вставить целиком:

```js
(async () => {
  const ETID = 0;                       // <-- entityTypeId АЗС из запроса A0
  const NUMS = ['33249', '548', '3108'];

  const call = (method, params) => new Promise((res, rej) =>
    BX.rest.callMethod(method, params, (r) => r.error() ? rej(r.error()) : res(r.data())));

  let start = 0, all = [];
  for (;;) {
    const r = await call('crm.item.list', { entityTypeId: ETID, start });
    const items = r.items || [];
    all = all.concat(items);
    if (items.length < 50) break;
    start += 50;
    if (start > 5000) break;
  }
  console.log('Всего карточек АЗС:', all.length);

  for (const num of NUMS) {
    const hits = all.filter((it) => JSON.stringify(it).includes(num));
    console.log('--- номер ' + num + ': совпадений ' + hits.length + ' ---');
    hits.forEach((it) => console.log(it.id, it.title, it));
  }
  window.__azsAll = all;   // остаётся в консоли для ручного разбора
})();
```

Из вывода нужны для каждой из трёх АЗС: **id**, **title**, значение поля-ответственного и поля «включена» (коды полей — из `поля АЗС` в запросе A0).

### B1. Проверка «почему 33249 выпала» — после того, как известен её id

```js
(async () => {
  const ETID = 0;        // entityTypeId АЗС
  const ID = 0;          // id карточки 33249
  const r = await new Promise((res, rej) =>
    BX.rest.callMethod('crm.item.get', { entityTypeId: ETID, id: ID }, (x) => x.error() ? rej(x.error()) : res(x.data())));
  console.log(r.item);
})();
```

Смотрим два поля из A0 (`fields.admin` и `fields.enabled`):
- поле-ответственный пустое → АЗС молча выбрасывается из рассылки (в логе приложения это строка `dispatch_skipped_no_admin`);
- поле «включена» = `N` / `0` / `нет` → АЗС исключена намеренно.

---

## Что покажут эти данные

| Наблюдение | Вывод |
|---|---|
| A4: id 33249 нет в плане | АЗС отсеялась при сборке кандидатов → причина в карточке CRM (B1), не в боте |
| A4: id есть, A3 показывает точки со `status='failed'` | Планировщик пытался, но отправка падала → текст в A5 |
| A2: `напоминаний > 0` и `отчёт_сдан = 1` | Дефект: напоминания не гасятся после сдачи отчёта |
| A2: `напоминаний > 0`, `отчёт_сдан = 0`, число ≈ числу окон из A1 | Штатное поведение профиля режима B; вопрос к настройке, не к коду |
| A3: точек в плане меньше, чем фактических отправок в A2 | Дубли рождаются при исполнении, а не при планировании |

---

# Раунд 1: что показали данные

Выгрузка от 11.08.2026, вечер.

## Конфигурация (A0, A1)

- Смарт-процесс АЗС — `entityTypeId = 1054`. Поле ответственного `ufCrm10_1779984739`, флаг «включена» `ufCrm10_1780490626`.
- Таймзона Europe/Moscow. Глобальное расписание `dispatchTimes` **пустое** — вся рассылка идёт через профиль.
- Профиль один: «Основные АЗС», режим B, 75 АЗС, `escalateUntilDone = true`.
  Окна на прод-портале `ortk.bitrix24.ru`: **06:00–09:00** (первичный запрос) и **17:00–18:00** (напоминание).
  Дедлайн отчёта = конец последнего окна, то есть 18:00.
- В `app_settings` два скоупа: `ortk.bitrix24.ru` (боевой, 2 окна) и `b24-xc36ra.bitrix24.ru` (второй портал, 1 окно). Настройки боевого обновлены 11.08 в 13:39.

**Отсюда штатная норма — 2 сообщения в день на АЗС:** запрос утром и напоминание вечером, причём напоминание гасится, если отчёт сдан.

## 33249 не получает запрос — причина найдена, она вне бота

В плане на 09, 10 и 11 августа стабильно **71 АЗС**, а в профиле их **75**. Разница:

| | ID АЗС |
|---|---|
| Есть в профиле, но **никогда не попадают в план** | **10, 146, 148, 150, 152** |
| Есть в плане, но нет в профиле | 174 |

Пять АЗС отсеиваются на этапе сборки кандидатов — `dispatchScheduler.js:284` выбрасывает карточку, если у неё пустое поле ответственного или снят флаг «включена». Ошибок при этом не пишется никуда, АЗС просто исчезает из рассылки. Почти наверняка одна из этих пяти и есть АЗС № 33249 — подтверждается блоком B.

Аномалия на будущее: АЗС 174 получает по одной точке в день, хотя её нет в профиле, а глобальное расписание пустое — по коду у неё не должно генерироваться ни одной точки. Проверяется запросом A12.

## 548 и 3108 получают 2–5 раз — дублей рассылки нет

- A3: на каждую АЗС ровно одна первичная точка и одно напоминание. Ни одной лишней.
- A2: в журнале за 10.08 — по одной первичной и одной reminder-записи на АЗС.
- A5: ошибок отправки за трое суток нет вообще.

Значит рассылка не двоится. «2–5 раз» набирается из **разных типов сообщений**, которые шлёт бот одному и тому же человеку за день:

1. запрос отчёта (06:00–09:00);
2. напоминание (17:00–18:00), если отчёт не сдан;
3. уведомление о просрочке после 18:00 + кнопка «Указать причину» (`timeoutWatcher.js:136`);
4. ответ бота на причину;
5. замечания по фото от проверяющего (`photoRemarkService`).

Проверить это до конца по базе нельзя — журнала отправленных сообщений в ней нет. Нужен либо скриншот переписки бота с админом одной из этих АЗС за день, либо рантайм-лог приложения.

## Два дефекта, найденных попутно (A6)

**1. Записи напоминаний навсегда зависают в `reserved` — 271 штука.**
Исполнитель напоминаний сначала резервирует строку в `dispatch_log` (`dispatchScheduler.js:441`), а потом, независимо от того, отправлено напоминание или пропущено, статус этой строки не меняет — закрывается только точка плана. Строка остаётся `reserved` навсегда. Из-за этого метрика «отчёты зависли в reserved >1 ч» врёт и как алерт бесполезна.

**2. 270 записей с прошедшим дедлайном не закрыты, при этом ошибок нет.**
Watcher просрочек берёт по 200 самых старых записей за тик (`reportsStore.js:239`, `LIMIT 200`, сортировка по возрастанию дедлайна). Если эти 200 по какой-то причине не переводятся в `expired`, он на каждом тике перемалывает один и тот же старый хвост и до свежих просрочек не доходит. Разбирается запросами A7–A8.

---

# Раунд 2: запросы

## A7. Разрез зависших `reserved`: это напоминания или первичные

```sql
SELECT CASE WHEN slot_key LIKE '%:reminder:%' THEN 'напоминание' ELSE 'первичный' END AS "тип",
       status AS "статус",
       count(*) AS "записей",
       count(*) FILTER (WHERE deadline_at IS NOT NULL) AS "с дедлайном",
       count(*) FILTER (WHERE report_item_id IS NULL)  AS "без карточки СП",
       min(created_at) AT TIME ZONE 'Europe/Moscow' AS "самая старая",
       max(created_at) AT TIME ZONE 'Europe/Moscow' AS "самая свежая"
FROM dispatch_log
WHERE status = 'reserved'
GROUP BY 1, 2
ORDER BY count(*) DESC;
```

## A8. Что именно висит с прошедшим дедлайном

Если самые старые записи здесь — за прошлые недели, значит watcher просрочек упёрся в хвост и свежие просрочки не обрабатывает.

```sql
SELECT substring(slot_key from 1 for 10) AS "день слота",
       status AS "статус",
       count(*) AS "записей",
       count(*) FILTER (WHERE slot_key LIKE '%:reminder:%') AS "из них напоминаний",
       min(deadline_at) AT TIME ZONE 'Europe/Moscow' AS "самый старый дедлайн",
       count(DISTINCT azs_id) AS "азс"
FROM dispatch_log
WHERE deadline_at IS NOT NULL
  AND deadline_at < now()
  AND status NOT IN ('done', 'expired', 'failed')
GROUP BY 1, 2
ORDER BY 1 DESC
LIMIT 40;
```

## A9. Сколько раз бот просил причину — второй канал сообщений

```sql
SELECT * FROM report_reason ORDER BY id DESC LIMIT 20;
```

## A10. Замечания по фото за неделю — третий канал сообщений

```sql
SELECT date_trunc('day', created_at AT TIME ZONE 'Europe/Moscow')::date AS "день",
       azs_id AS "азс",
       count(*) AS "замечаний"
FROM photo_remark
WHERE created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY "замечаний" DESC
LIMIT 30;
```

## A11. Вся картина по одной АЗС за двое суток

Подставить в обоих местах ID карточки, полученный из блока B (для 548 и 3108).

```sql
SELECT 'план' AS "источник", plan_date AS "дата", base_time AS "время", entry_type AS "тип",
       window_index::text AS "окно", status AS "статус",
       execute_at AT TIME ZONE 'Europe/Moscow' AS "момент мск", left(error_text, 200) AS "ошибка"
FROM dispatch_plan
WHERE azs_id = '000' AND plan_date >= to_char((now() AT TIME ZONE 'Europe/Moscow') - interval '2 days', 'YYYY-MM-DD')
UNION ALL
SELECT 'журнал', substring(slot_key from 1 for 10), slot_key,
       CASE WHEN slot_key LIKE '%:reminder:%' THEN 'reminder' ELSE 'primary' END,
       coalesce(report_item_id::text, '—'), status,
       created_at AT TIME ZONE 'Europe/Moscow', left(error_text, 200)
FROM dispatch_log
WHERE azs_id = '000' AND created_at > now() - interval '2 days'
ORDER BY 2 DESC, 3;
```

## A12. Аномалия: откуда точки у АЗС 174

```sql
SELECT plan_date AS "дата", base_time AS "время", entry_type AS "тип", window_index AS "окно",
       status AS "статус", execute_at AT TIME ZONE 'Europe/Moscow' AS "момент мск",
       created_at AT TIME ZONE 'Europe/Moscow' AS "создана мск"
FROM dispatch_plan
WHERE azs_id = '174'
ORDER BY plan_date DESC
LIMIT 15;
```

---

# Раунд 2: разгадка

Получен реестр карточек АЗС (ID → номер → ответственный → «включена»). Он снял оба вопроса.

## Тексты, которые шлёт бот

Всё, что может прийти сотруднику за день. Источники — `notificationService.js`, `dispatchScheduler.js:503`, `timeoutWatcher.js:138`, `photoRemarkService.js:36`.

**1. Запрос отчёта** — утром, в окне 06:00–09:00 (`buildDispatchMessage`, notificationService.js:37):

```
Время сделать фото-отчёт по АЗС 548.
Сдать до 18:00.

Откройте приложение «Порядок на АЗС» в Битрикс24, чтобы загрузить фото.
```

Кнопка под сообщением: **«Не успеваю — указать причину»**.

**2. Напоминание** — вечером, в окне 17:00–18:00, если отчёт не сдан (dispatchScheduler.js:503):

```
Напоминание: не сдан фото-отчёт за 2026-08-11. Пожалуйста, отправьте отчёт.
```

**Номера АЗС в этом тексте нет.** Это ключ ко второй жалобе — см. ниже.

**3. Просрочка + запрос причины** — после 18:00 (timeoutWatcher.js:138):

```
Отчёт по АЗС 548 просрочен. Пожалуйста, укажите причину.
```

Кнопка: **«Указать причину»**. Если бот-канал недоступен и сообщение уходит обычным уведомлением, кнопка теряется и вместо неё дописывается строка `Не успеваете? Ответьте этому боту: /reason <номер>`.

**4. Отчёт не сдан вовремя** (`notifyReportExpired`):

```
Отчёт по АЗС 548 не сдан вовремя.
Срок сдачи был до 18:00.
```

**5. Отчёт принят** (`buildDoneMessage`):

```
Отчёт по АЗС 548 сдан и готов к проверке.
```

**6. Замечание по фото** — от проверяющего, по одному сообщению на каждое фото (photoRemarkService.js:36):

```
Замечание по АЗС 548 (Иван Петров): переделайте выкладку промо-товара
```

## Кто за что отвечает — вот причина обеих жалоб

Карточек 75, включённых 70 — ровно столько же АЗС в плане. **Ни одна включённая станция из рассылки не выпадает.**

Пять выключенных (`включена = Нет`) — и это правильно, рассылать по ним нечего:

| ID | Что это | Ответственный |
|---|---|---|
| 10 | дубль карточки АЗС 33231 (рабочая — ID 134) | Сергей Бессонов |
| 146 | Офис | Юлия Белова |
| 148 | Нефтебаза | Андрей Лукин |
| 150 | Стройбаза | Алексей Сапегин |
| 152 | АГЗС (Одинцово) | Сергей Прахов |

**Один человек отвечает за несколько АЗС — и получает по комплекту сообщений на каждую:**

| Ответственный | АЗС | Сообщений в день при несданных отчётах |
|---|---|---|
| Сергей Бессонов | 8 | до 16 |
| Федор Засадный | 7 | до 14 |
| Борис Усиков / Роман Османов / Дмитрий Пенкин | по 6 | до 12 |
| Дмитрий Зеленько | 5 | до 10 |
| **Галина Васёнина** | 4 — 3107, 3109, 487, **33249** | до 8 |
| **Наталья Смирнова** | 3 — 3105, **3108**, **548** | до 6 |

### 548 и 3108 «по 2–5 раз за день»

Это **одна и та же сотрудница — Наталья Смирнова**, и у неё три станции. За день ей приходит до трёх запросов и до трёх напоминаний. Запросы различимы — в них есть номер АЗС. Напоминания — нет: три подряд идентичных сообщения «Напоминание: не сдан фото-отчёт за 2026-08-11». Со стороны это выглядит как «бот прислал одно и то же 2–5 раз».

Проверка по журналу за 10.08: 3105 — просрочен, 3108 — сдан, 548 — сдан. То есть она работает по потоку сообщений, часть которых неразличима.

### 33249 «не приходит запрос»

Прежний вывод (АЗС выпала из плана) к ней **не относится** — это ID 162, она включена, ответственный назначен, и она есть в плане все три дня: 11.08 в 07:34 запрос отправлен, на 17:12 стоит напоминание.

Смотрим по её ответственному — Галина Васёнина, 4 станции. Журнал за 10.08:

| АЗС | ID | Итог дня |
|---|---|---|
| 3107 | 58 | сдан |
| 3109 | 62 | сдан |
| 487 | 106 | сдан |
| **33249** | **162** | **просрочен** |

Три отчёта из четырёх сданы, четвёртый — нет. Похоже не на сбой доставки, а на потерю одного запроса в потоке однотипных сообщений. Подтверждается это одним взглядом в чат Галины Васёниной с ботом за любой день.

## Что чинить

1. **Добавить номер АЗС в текст напоминания** (dispatchScheduler.js:503) — сейчас человек с несколькими станциями не может понять, о какой из них речь. Это главная причина жалоб.
2. **Свести дневные сообщения одного получателя в одно** — вместо N отдельных напоминаний присылать одно со списком несданных станций.
3. Развести окно напоминания и дедлайн: сейчас напоминание может прийти в 17:55, а в 18:00 уже просрочка — два сообщения подряд, реагировать некогда.
4. Дефекты из раунда 1 (зависшие `reserved`, 270 незакрытых просрочек) — отдельно, к жалобам отношения не имеют.

## Поправка к разгадке

ФИО в реестре — это **управляющие** (поле `manager` / `assignedById`), а не получатели сообщений. Бот пишет учётной записи из поля `admin` = `ufCrm10_1779984739`, и такие учётки названы по станции: «АЗС 548», «АЗС 3108». Значит таблица нагрузки выше построена не на том столбце и к жалобам отношения не имеет — привязка «Смирнова = 3 АЗС» снята.

При схеме «одна учётка на одну станцию» обе жалобы объясняются одним дефектом данных: **если в карточке 33249 в поле `admin` указана не своя учётка, а чужая** (например, «АЗС 548»), то оператор 33249 не получает ничего, а получатель чужой учётки получает двойной комплект сообщений — свой и за 33249. Ровно то, на что жалуются.

Проверяется двумя запросами.

### A13. Есть ли учётка, на которую висит больше одной АЗС

Строки с «азс» > 1 — прямое попадание в гипотезу.

```sql
SELECT admin_user_id AS "получатель (id юзера)",
       count(DISTINCT azs_id) AS "азс",
       string_agg(DISTINCT azs_id, ', ') AS "id азс",
       count(*) AS "точек за день"
FROM dispatch_plan
WHERE plan_date = to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
GROUP BY 1
ORDER BY 2 DESC, 4 DESC;
```

### A14. Кому именно шлём по 33249, 548, 3108 и 3105

ID карточек: 162 → АЗС 33249, 116 → АЗС 548, 60 → АЗС 3108, 56 → АЗС 3105.

```sql
SELECT azs_id AS "id азс", admin_user_id AS "получатель (id юзера)",
       plan_date AS "дата", base_time AS "время", entry_type AS "тип", status AS "статус"
FROM dispatch_plan
WHERE azs_id IN ('162', '116', '60', '56')
  AND plan_date >= to_char((now() AT TIME ZONE 'Europe/Moscow') - interval '2 days', 'YYYY-MM-DD')
ORDER BY azs_id, plan_date DESC, base_time;
```

### B2. Кто эти получатели — консоль портала

Подставить ID получателей из A13/A14 и сверить: имя учётки должно совпадать с номером своей станции, а сама учётка — быть активной (`ACTIVE: true`).

```js
(async () => {
  const IDS = [0, 0, 0];   // <-- admin_user_id из A14
  const r = await new Promise((res, rej) =>
    BX.rest.callMethod('user.get', { ID: IDS }, (x) => x.error() ? rej(x.error()) : res(x.data())));
  console.table(r.map((u) => ({ id: u.ID, имя: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim(), активен: u.ACTIVE })));
})();
```

Если учётка неактивна — бот пишет в пустоту, и жалоба «не приходит» объясняется этим.

## Блок B (сопоставление номеров) — уже не нужен

Без него нельзя связать жалобы с данными: в базе АЗС живут под ID карточек (4…174, чётные), а 33249, 548 и 3108 — внешние номера станций. Блок B даёт две вещи сразу: соответствие «номер → ID» и содержимое полей `ufCrm10_1779984739` (ответственный) и `ufCrm10_1780490626` (включена) — то есть прямую причину, по которой АЗС может выпадать из рассылки.

`ETID` для скриптов блока B — **1054**.
