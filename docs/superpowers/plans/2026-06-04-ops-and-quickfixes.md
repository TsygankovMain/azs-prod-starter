# OPS-кластер + быстрые фиксы — Implementation Plan

> **Для исполнителя:** часть пунктов — ОПЕРАЦИОННЫЕ (действия на проде/в портале Bitrix), их нельзя покрыть TDD; они оформлены как runbook с проверками. Кодовый пункт (UI-errorText) идёт по обычному формату. Прод заморожен: выполнять только по команде владельца.

**Goal:** Восстановить работу прода (авто-рассылка, открытие приложения), убрать корень стирания данных при редеплое, плюс два мелких фикса (переименование категории фото, показ текста ошибки в ленте).

**Architecture:** Прод Timeweb = ОДИН контейнер (Dockerfile `runtime`): nginx + Node API + **Postgres внутри образа** (supervisord `[program:postgres]`, данные в `/var/lib/postgresql/<ver>/main`). App Platform пересоздаёт ФС контейнера при каждом деплое → БД и `data/auth-context.json` эфемерны. Это общий корень нескольких симптомов.

**Tech Stack:** Timeweb App Platform, Docker (single-container, supervisord), PostgreSQL, Bitrix24 REST (OAuth/webhook), Nuxt/Vue фронт.

---

## Корневой узел (почему всё связано)

Приложение в портале **пересоздавали/переустанавливали**, и контейнер **эфемерный**. Отсюда:
- **BUG-A** — адрес приложения в портале указывает на мёртвый/сменившийся хост → `ERR_NAME_NOT_RESOLVED` при открытии.
- **BUG-G** — `CLIENT_ID/SECRET` разъехались с сохранённым `refresh_token` → `wrong_client` → авто-рассылка падает (22/22 `failed`).
- **Стирание БД** — Postgres внутри контейнера, том не персистится на App Platform.
- **Потеря admin-контекста** — `data/auth-context.json` исчезает при редеплое (отдельно от БД).

Фиксы ниже закрывают узел: webhook снимает зависимость фона от OAuth/контекста, вынос БД — стирание данных, правка портала — адрес.

---

## OPS-1 — Восстановить прод (P0)

**Цель:** авто-рассылка снова работает, приложение открывается. Все шаги — read-only диагностика + действия владельца на проде; кода не меняем.

### Шаг 1 (диагностика, read-only) — задеплоен ли DR-код
В консоли прод-контейнера:
```sh
find / -xdev -name webhookContext.js -not -path '*/node_modules/*' 2>/dev/null
find / -xdev -path '*dispatch/dispatchScheduler.js' -not -path '*/node_modules/*' 2>/dev/null -exec grep -c resolveBackgroundContext {} +
```
- Пусто / `0` → DR НЕ в проде (автодеплой не подхватил) → переходим к Шагу 2 (деплой).
- Путь + число ≥1 → DR в проде → переходим к Шагу 3 (проверка вебхука).

### Шаг 2 — починить деплой и выкатить актуальный код
- В панели Timeweb App Platform запустить **ручной redeploy** последнего коммита (раз автодеплой не срабатывает).
- Параллельно проверить настройку автодеплоя (привязка ветки/репозитория, вебхук гита) — почему пуши не триггерят сборку. Зафиксировать причину.
- **Verify:** повторить Шаг 1 → `webhookContext.js` найден, `resolveBackgroundContext` ≥1.

### Шаг 3 (read-only) — корректность вебхука
```sh
echo "$BITRIX_WEBHOOK_URL" | sed -E 's#(/rest/[0-9]+/)[^/]+#\1***#'
```
- Норма: `https://<портал>.bitrix24.ru/rest/<цифры>/***/`.
- Нет `/rest/<цифры>/...` → URL кривой → создать новый ВХОДЯЩИЙ вебхук в портале (scopes: crm, im, imbot, disk, user), прописать в `BITRIX_WEBHOOK_URL`, рестарт.

### Шаг 4 — проверить, что рассылка перестала падать
```sh
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -P pager=off \
  -c "SELECT count(*) FROM dispatch_log WHERE status='failed' AND created_at > now() - interval '1 hour';"
```
- **Verify:** после фикса новые `failed` с `wrong_client` не появляются. Логи без `Bitrix OAuth refresh failed`.

### Шаг 5 — BUG-A (адрес приложения)
- В портале: Разработчикам → приложение «Фото-отчёт АЗС» → проверить **адрес обработчика/путь приложения**; привести к актуальному домену Timeweb, где реально крутится фронт (тот, что отдаёт HTTP 200).
- **Verify:** открыть приложение из меню Bitrix24 на устройстве, где была ошибка → грузится без `ERR_NAME_NOT_RESOLVED`. Если хост резолвится curl/nslookup, но не на устройстве — проверить DNS устройства/сети (отдельно).

### Времянка (пока OPS-1 не закрыт)
Под залогиненным проверяющим «Сформировать график»/«Запросить вне расписания» работают (живой токен сессии, без refresh) — дослать задания операторам.

---

## OPS-2 — Персистентность БД (убрать корень стирания)

**Проблема:** Postgres в контейнере (`[program:postgres]` supervisord, `DATA_DIR=/var/lib/postgresql/<ver>/main`); App Platform не сохраняет ФС между деплоями → `dispatch_log`, `report_photo`, `dispatch_plan`, будущий `report_reason` стираются.

### Вариант 1 (рекомендуется) — внешняя managed-Postgres
1. Завести managed PostgreSQL в Timeweb (или иной внешний PG). Получить host/port/db/user/password.
2. Прод-env: `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` → на managed-БД. `DB_TYPE=postgresql`.
3. Из `infrastructure/timeweb/supervisord.conf` убрать программы `[program:postgres]` и `[program:db-init]` (контейнер становится stateless: только API + nginx). Из Dockerfile можно убрать установку `postgresql`/`postgresql-contrib` (опционально, для размера образа).
4. Схема: приложение само создаёт таблицы (`ensureSchema`/`CREATE TABLE IF NOT EXISTS` во всех сторах) — отдельный init не обязателен; при необходимости один раз прогнать `infrastructure/database/init.sql` на managed-БД.
- **Verify:** редеплой контейнера → данные на месте (та же managed-БД). `SELECT count(*) FROM dispatch_log;` не обнуляется после деплоя.
- **Бонус:** снимает и эфемерность; вместе с webhook (DR) делает редеплой безопасным.

### Вариант 2 — персистентный том
Если App Platform поддерживает подключение persistent volume — смонтировать на `/var/lib/postgresql`. (App-платформы часто НЕ дают томов — вероятная причина текущей эфемерности; проверить возможность в Timeweb. Если нет → Вариант 1.)

### Вариант 3 (митигейшн, не полный фикс) — зеркалить в Bitrix
Паттерн DR: критичное состояние → app.option (снимки) / CRM (записи). План уже зеркалится; FEAT-C пишет причины в CRM. Историю `dispatch_log`/фото не спасает; держать как дополнительный слой, а не вместо Варианта 1.

### Сопутствующее — admin-контекст
`data/auth-context.json` тоже эфемерен. Закрывается **webhook'ом** (DR, OPS-1), не БД. После OPS-1 фон не зависит от файла.

---

## FEAT-F — переименовать категорию фото «оранжевый ящик» (портал, без кода)

**Не код.** «Оранжевый ящик» = `title` элемента смарт-процесса «Тип фото» (`settings.photoType.entityTypeId`), подтягивается через `readRequiredPhotos` (`reportsRoutes.js:318-377`, `title = item.title`).
1. В портале открыть смарт-процесс «Тип фото» → элемент с заголовком «оранжевый ящик».
2. Переименовать `title` в согласованный текст, напр. «Уличный экспозитор / уличный бункер (оранжевый ящик)».
- **Verify:** в задании/мини-вью причина и название фото показывают новый текст; история не ломается (`report_photo.photo_code` = ID элемента, не текст).
- **Нюанс:** `title` идёт и в имена папок Диска — слэши «/» санитизируются (на отображение не влияет).

---

## UI-1 — показать текст ошибки в ленте (frontend, малый код)

**Проблема:** событие `failed` показывает только «Ошибка обработки отчёта для {id}», а реальная причина (`errorText`) есть в данных, но в ленту не выводится (`reviewer.client.vue` `deriveEvents` не кладёт её в `subtitle`).

**Files:**
- Modify: `frontend/app/pages/reviewer.client.vue` (функция `deriveEvents`, ветка `report.status === 'failed'`)

- [ ] **Step 1: Проверить наличие фронт-тест-раннера**
Run: `grep -nE '"test"|vitest|jest|@vue/test-utils' frontend/package.json`
Если раннера нет — шаги проверки ниже ручные (ожидаемо для этого проекта).

- [ ] **Step 2: Добавить `subtitle` с текстом ошибки в событие `failed`**
В `deriveEvents`, в `events.push({...})` ветки `failed` добавить поле:
```js
} else if (report.status === 'failed' && report.updatedAt) {
  events.push({
    id: `failed-${report.id}`,
    type: 'failed',
    timestamp: report.updatedAt,
    azsId: report.azsId,
    azsTitle,
    reportRow: report,
    subtitle: report.errorText ? `Причина: ${report.errorText}` : undefined
  })
}
```
(Шаблон уже рендерит `event.subtitle` — `reviewer.client.vue:1027`.)

- [ ] **Step 3: Ручная проверка**
Открыть экран проверяющего → фильтр «Только проблемы» → у события «Ошибка обработки отчёта…» под заголовком видна строка «Причина: …» (напр. `Bitrix OAuth refresh failed: wrong_client`).

- [ ] **Step 4: Commit (при разморозке)**
```bash
git add frontend/app/pages/reviewer.client.vue
git commit -m "feat(reviewer): показывать текст ошибки failed-события в ленте"
```

---

## Последовательность и зависимости

1. **OPS-1** (P0) — первым; внутри: автодеплой/ручной деплой → DR → BUG-G; затем портал → BUG-A.
2. **OPS-2** — следом или параллельно (инфра): вынос БД; делает редеплой безопасным, разблокирует durable-фичи (C/E историю не теряют).
3. **FEAT-F** — в любой момент (портал, независимо).
4. **UI-1** — в любой момент (мелкий фронт), удобно выкатить вместе с другими фронт-фиксами (B/D).

> Все фиче-планы (B, C, D, E) опираются на здоровый прод после OPS-1/OPS-2. До этого — разрабатываются в ветках, выкатываются по готовности инфры.
