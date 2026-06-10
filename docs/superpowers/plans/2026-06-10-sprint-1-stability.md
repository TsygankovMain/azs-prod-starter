# Спринт 1 «Прод не падает и не молчит» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node-бэкенд переживает сбои БД, деградацию Битрикс24 и деплои без ручного вмешательства; любой отказ становится видимым (а не «зелёный healthcheck при мёртвом приложении»).

**Architecture:** Точечные правки в существующих модулях `backends/node/api` без изменения доменной логики: страховочный слой процесса в `server.js`, guard'ы перекрытия в cron-тиках, таймауты и retry-классификация в `bitrixRestClient`, честный healthcheck. Паттерны берём из самой кодовой базы (re-entrancy guard уже есть в `crmSyncWorker`, ветка `reclaimStale({runningTimeoutMs})` уже реализована в сторе).

**Tech Stack:** Node.js 20 (Express 5, ESM), node-cron, pg + mysql2, node:test; фронт — Nuxt 3 (одна задача S1-06).

---

## Параметры спринта

| Параметр | Значение |
|---|---|
| Длительность | 2 недели |
| Состав | 1 fullstack-разработчик |
| Capacity (фокус-дни) | ~8 дней |
| Committed объём | 8 дней (S1-01…S1-06) |
| Источник | Аудит стабильности от 2026-06-10 (4 агента, 240/240 тестов зелёные до начала работ) |

## Бэклог спринта

| ID | Задача | Оценка | Приоритет |
|---|---|---|---|
| S1-01 | Fail-fast валидация env + глобальные обработчики процесса + `pool.on('error')` | 1 д | Must |
| S1-02 | Graceful shutdown (SIGTERM/SIGINT) + `flush()` у authContextStore | 1.5 д | Must |
| S1-03 | Анти-спираль Bitrix: overlap-guard, таймауты fetch, 503/Retry-After, общий модуль transient-ошибок | 2 д | Must |
| S1-04 | Согласованность данных: `reclaimStale({runningTimeoutMs})` + «expired» только после успеха CRM | 1.5 д | Must |
| S1-05 | Честный healthcheck + HEALTHCHECK в Dockerfile + ротация логов | 1 д | Must |
| S1-06 | Фронт: единый путь refresh-токена + снятие visibilitychange-слушателя | 1 д | Should |
| S1-07 | (Stretch) fsync перед rename + hardening FileSettingsStore | 1 д | Could |
| S1-08 | (Stretch) `SYSTEM_ADMIN_USER_IDS` из конфигурации вместо хардкода | 0.5 д | Could |

**Вне скоупа спринта (зафиксировано осознанно):** вынос PostgreSQL из эфемерного контейнера Timeweb (пункт 1 аудита — отдельная инфраструктурная инициатива, риск потери данных при redeploy остаётся открытым); тестовая инфраструктура фронтенда; миграция legacy-режима рассылки.

**Правило запуска тестов (важно, Node ≥25 локально):** `node --test tests/` (каталогом) падает с MODULE_NOT_FOUND. Правильная команда:

```bash
cd backends/node/api && node --test "tests/*.test.js"
```

---

### Task S1-01: Fail-fast env + страховочный слой процесса

**Files:**
- Create: `backends/node/api/utils/validateEnv.js`
- Create: `backends/node/api/tests/validateEnv.test.js`
- Modify: `backends/node/api/server.js` (верх файла; создание пула — строки ~40–59)

**Проблема (аудит):** без `JWT_SECRET` процесс стартует «здоровым», но `/api/getToken` отдаёт 500 всем (`utils/verifyToken.js:7`, `server.js:542`). Нет `process.on('unhandledRejection'/'uncaughtException')` — фоновая ошибка роняет процесс. У pg-пула нет слушателя `'error'` (`server.js:53-59`) — обрыв простаивающего соединения при рестарте Postgres = `uncaughtException` = краш «сам по себе ночью».

- [ ] **Step 1: Написать падающий тест валидации env**

```js
// tests/validateEnv.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequiredEnv } from '../utils/validateEnv.js';

test('validateRequiredEnv: бросает понятную ошибку без JWT_SECRET', () => {
  assert.throws(
    () => validateRequiredEnv({ DB_TYPE: 'postgresql' }),
    /JWT_SECRET/
  );
});

test('validateRequiredEnv: пустая строка считается отсутствующей', () => {
  assert.throws(() => validateRequiredEnv({ JWT_SECRET: '   ' }), /JWT_SECRET/);
});

test('validateRequiredEnv: проходит при заданном JWT_SECRET', () => {
  assert.doesNotThrow(() => validateRequiredEnv({ JWT_SECRET: 'secret' }));
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает** — `node --test "tests/validateEnv.test.js"` → FAIL (модуль не существует).

- [ ] **Step 3: Реализовать `utils/validateEnv.js`**

```js
const REQUIRED_ALWAYS = ['JWT_SECRET'];

export function validateRequiredEnv(env = process.env) {
  const missing = REQUIRED_ALWAYS.filter(
    (name) => !env[name] || !String(env[name]).trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Refusing to start: auth would silently fail for all users.'
    );
  }
}
```

- [ ] **Step 4: Тест зелёный** — `node --test "tests/validateEnv.test.js"` → PASS.

- [ ] **Step 5: Подключить в `server.js`** — в самом верху, после импортов и `dotenv` (dotenv грузится через импорт `verifyToken.js`):

```js
import { validateRequiredEnv } from './utils/validateEnv.js';

try {
  validateRequiredEnv();
} catch (error) {
  console.error('[fatal]', error.message);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException:', error);
});
```

(Обработчики только логируют — под supervisord/Docker контролируемый выход не нужен: цель — пережить фоновую ошибку, а не упасть от неё.)

- [ ] **Step 6: Слушатель ошибок пула** — сразу после создания пула (pg-ветка обязательно; mysql2 promise-пул не EventEmitter, у него подписываемся на внутренний callback-пул):

```js
const onPoolError = (error) => {
  console.error('[db] idle connection error (recovered):', error.message);
};
if (typeof pool.on === 'function') {
  pool.on('error', onPoolError);
} else if (pool.pool && typeof pool.pool.on === 'function') {
  pool.pool.on('error', onPoolError);
}
```

- [ ] **Step 7: Ручная проверка fail-fast** — `cd backends/node/api && env -u JWT_SECRET node server.js`; ожидаемо: сообщение `[fatal] Missing required environment variables: JWT_SECRET…`, exit code 1, сервер не слушает порт.

- [ ] **Step 8: Полный прогон** — `node --test "tests/*.test.js"` → все зелёные.

- [ ] **Step 9: Commit** — `git commit -m "feat(stability): fail-fast env validation, process-level error handlers, db pool error listener"`

**Acceptance Criteria:**
- [ ] Старт без `JWT_SECRET` → exit 1 с понятным сообщением (до `app.listen`).
- [ ] `unhandledRejection` из фонового таймера логируется, процесс жив.
- [ ] `pool.on('error')` подписан в обеих ветках (pg/mysql2).

---

### Task S1-02: Graceful shutdown

**Files:**
- Modify: `backends/node/api/server.js` (захват `const server = app.listen(...)` ~:554; конец файла)
- Modify: `backends/node/api/src/auth/authContextStore.js` (~:102 — поле `writeChain`)
- Modify: `backends/node/api/src/dispatch/dispatchScheduler.js`, `src/dispatch/timeoutWatcher.js` — добавить/проверить экспорт `stop()` (cron-таски `:531`, `:543`)
- Test: `backends/node/api/tests/authContextStore.test.js` (дополнить)

**Проблема (аудит):** SIGTERM при деплое убивает процесс мгновенно: рвутся in-flight запросы, активная запись `auth-context.json` (между `writeFile(tmp)` и `rename`, `authContextStore.js:103-104`) — теряется свежевыписанный refresh-токен, после рестарта планировщик молчит («scheduler.skip: no admin context»).

- [ ] **Step 1: Падающий тест на `flush()`**

```js
// дополнение tests/authContextStore.test.js
test('flush: дожидается завершения всех отложенных записей', async (t) => {
  const store = createStoreForTest(t); // использовать существующий хелпер файла
  store.upsertContext({ memberId: 'm1', authData: { access_token: 'a' } }); // без await
  await store.flush();
  const onDisk = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.ok(onDisk.contexts || onDisk.m1, 'запись должна быть на диске после flush');
});
```

(Имена хелперов/структуру файла взять из существующих тестов этого же файла — там уже есть тест конкурентных upsert.)

- [ ] **Step 2: Тест падает** (нет метода `flush`).

- [ ] **Step 3: Реализовать `flush()` в `AuthContextStore`**

```js
async flush() {
  await this.writeChain; // цепочка сериализованных записей уже существует
}
```

- [ ] **Step 4: Тест зелёный.**

- [ ] **Step 5: Убедиться, что у планировщиков есть `stop()`** — в `dispatchScheduler.js`/`timeoutWatcher.js` cron-таски сохраняются в переменные (`dispatchTask = cron.schedule(...)`). Если экспорта `stop()` нет — добавить:

```js
export function stop() {
  dispatchTask?.stop();
  dispatchTask = null;
}
```

- [ ] **Step 6: Обработчик shutdown в `server.js`** (конец файла; `app.listen` присвоить в `const server`):

```js
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[process] ${signal}: graceful shutdown started`);
  const force = setTimeout(() => {
    console.error('[process] shutdown timeout, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await new Promise((resolve) => server.close(resolve)); // перестаём принимать новые запросы
    dispatchScheduler.stop?.();
    timeoutWatcher.stop?.();
    crmSyncWorker.stop?.();
    tokenRefreshScheduler.stop?.();
    await authContextStore.flush();
    await pool.end?.();
    console.log('[process] graceful shutdown complete');
  } catch (error) {
    console.error('[process] shutdown error:', error);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

(Импорты/имена переменных согласовать с фактическими в `server.js` — планировщики там уже инстанцируются, у `crmSyncWorker` `stop()` существует.)

- [ ] **Step 7: Ручная проверка** — запустить `node server.js`, послать `kill -TERM <pid>`; ожидаемо в логе: `graceful shutdown started` → `complete`, выход ≤10 с, в `data/` нет `*.tmp`-файлов.

- [ ] **Step 8: Полный прогон тестов → зелёный. Commit** — `git commit -m "feat(stability): graceful shutdown on SIGTERM/SIGINT, authContextStore.flush()"`

**Acceptance Criteria:**
- [ ] SIGTERM: сервер закрывается, планировщики остановлены, записи дописаны, пул закрыт, выход ≤10 с.
- [ ] Повторный SIGTERM во время shutdown игнорируется.
- [ ] `flush()` покрыт тестом.

---

### Task S1-03: Анти-спираль Bitrix (overlap-guard, таймауты, 503/Retry-After)

**Files:**
- Create: `backends/node/api/src/shared/transientErrors.js`
- Modify: `backends/node/api/src/dispatch/dispatchScheduler.js:531-553` (оба cron-колбэка)
- Modify: `backends/node/api/src/dispatch/bitrixRestClient.js` (`:47` паттерн; fetch `:182`, `:241`, `:339`, `:621`; обработка ответа `:249-251`)
- Modify: `backends/node/api/server.js:649`, `backends/node/api/src/reports/reportsRoutes.js:11` (заменить локальные копии паттерна импортом)
- Test: `backends/node/api/tests/dispatchScheduler.test.js`, `tests/bitrixRestClient.test.js` (дополнить)

**Проблема (аудит):** cron-тики рассылки/таймаут-вотчера не имеют guard'а от перекрытия (в отличие от `crmSyncWorker.js:79`); `fetch` без таймаутов виснет бесконечно; HTTP 503 от Битрикса не ретраится, `Retry-After` игнорируется; retry-паттерн скопирован в 3 местах и расползается.

- [ ] **Step 1: Общий модуль transient-ошибок + тест**

```js
// src/shared/transientErrors.js
export const RETRYABLE_TRANSIENT_ERROR_PATTERN =
  /QUERY_LIMIT_EXCEEDED|OPERATION_TIME_LIMIT|HTTP 429|HTTP 503|HTTP 504|Service Unavailable|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|TimeoutError|AbortError|operation was aborted/i;

export function isTransientError(error) {
  return RETRYABLE_TRANSIENT_ERROR_PATTERN.test(String(error?.message ?? error));
}
```

Перед заменой сверить состав с фактическим паттерном в `bitrixRestClient.js:47` — объединить множества, ничего не потеряв. Тест (`tests/transientErrors.test.js`): `isTransientError(new Error('HTTP 503 Service Unavailable')) === true`, `isTransientError(new Error('ACCESS_DENIED')) === false`, `isTransientError(new Error('The operation was aborted due to timeout')) === true`.

- [ ] **Step 2: Заменить 3 локальные копии** (`bitrixRestClient.js:47`, `server.js:649`, `reportsRoutes.js:11`) импортом из `src/shared/transientErrors.js`. Полный прогон тестов → зелёный.

- [ ] **Step 3: Падающий тест overlap-guard** — вынести тело cron-колбэка в тестируемую фабрику:

```js
// дополнение tests/dispatchScheduler.test.js
test('тик рассылки не перекрывается: повторный вызов во время работы пропускается', async () => {
  let resolveFirst;
  let calls = 0;
  const runOnce = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFirst = resolve; });
  };
  const tick = createGuardedTick({ runOnce, onSkip: () => {} });
  const first = tick();
  await tick(); // второй заход — должен выйти мгновенно
  assert.equal(calls, 1);
  resolveFirst({});
  await first;
});
```

- [ ] **Step 4: Реализовать guard** (паттерн из `crmSyncWorker.js:79-89`):

```js
export function createGuardedTick({ runOnce, onSkip = () => {} }) {
  let running = false;
  return async function tick() {
    if (running) {
      onSkip();
      return { skipped: true };
    }
    running = true;
    try {
      return await runOnce();
    } finally {
      running = false;
    }
  };
}
```

Обернуть оба `cron.schedule(...)` в `dispatchScheduler.js:531` и `:543`: внутри колбэка вызывать guarded-тик, `onSkip` → `console.warn('[dispatch] tick_skipped_overlap')` / `'[timeout-watcher] tick_skipped_overlap'`. Существующий try/catch вокруг сохранить.

- [ ] **Step 5: Таймаут на все fetch в `bitrixRestClient.js`**

```js
const HTTP_TIMEOUT_MS = Number(process.env.BITRIX_HTTP_TIMEOUT_MS || 30_000);

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}
```

Заменить `fetch(` на `fetchWithTimeout(` во всех 4 точках (`:182` OAuth-refresh, `:241` REST, `:339` batch, `:621` скачивание фото). `TimeoutError`/`AbortError` уже в общем паттерне (Step 1) → зависший вызов обрывается и ретраится как transient.

- [ ] **Step 6: 503 + Retry-After** — в обработке не-OK ответа (`:249-251`): включать статус в сообщение ошибки (`HTTP 503`), парсить заголовок:

```js
const retryAfterHeader = response.headers.get('retry-after');
const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
const error = new Error(`HTTP ${response.status} ${response.statusText}`);
if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
throw error;
```

В месте вычисления backoff-паузы перед ретраем: `const delay = error.retryAfterMs ?? BACKOFF_SCHEDULE[attempt];`

- [ ] **Step 7: Тесты на ретраи** — в `tests/bitrixRestClient.test.js` (там уже есть фейковый fetch): сценарий «503 c Retry-After: 1 → успех со второй попытки, пауза взята из заголовка»; сценарий «AbortError → классифицирован как transient».

- [ ] **Step 8: Полный прогон → зелёный. Commit** — `git commit -m "feat(stability): cron overlap guards, bitrix fetch timeouts, 503/Retry-After retries, shared transient-error module"`

**Acceptance Criteria:**
- [ ] Второй тик во время первого пропускается с warn-логом (покрыто тестом).
- [ ] Любой fetch к Битриксу обрывается за `BITRIX_HTTP_TIMEOUT_MS` (дефолт 30 с) и ретраится.
- [ ] 503 ретраится; `Retry-After` уважается (покрыто тестом).
- [ ] Retry-паттерн существует в одном модуле, 3 копии удалены.
- [ ] `BITRIX_HTTP_TIMEOUT_MS` добавлена в `.env.example` с комментарием.

---

### Task S1-04: Согласованность данных (reclaimStale + expired)

**Files:**
- Modify: `backends/node/api/src/reports/crmSyncWorker.js` (`recover()`, ~:98-105)
- Modify: `backends/node/api/src/dispatch/timeoutWatcher.js:82-93`
- Test: `backends/node/api/tests/crmSyncWorker.test.js`, `tests/timeoutWatcher.test.js` (дополнить)

**Проблема (аудит):** (а) `recover()` зовёт `reclaimStale()` без `runningTimeoutMs` → сбрасываются ВСЕ `running`-задачи; при rolling-deploy новый под отбирает задачу у живого старого → двойной синк. Безопасная ветка уже реализована в `crmSyncJobStore.js:77-84` и покрыта тестом — нужно её задействовать. (б) `timeoutWatcher` ставит `expired` в БД ДО CRM-апдейта; при сбое CRM отчёт навсегда выпадает из обработки (фильтр `status NOT IN ('done','expired')`, `reportsStore.js:201`), расхождение БД↔CRM не самовосстанавливается, уведомление не уходит.

- [ ] **Step 1: Падающий тест на recover** — в `tests/crmSyncWorker.test.js`: фейковый store фиксирует аргументы `reclaimStale`; `await worker.recover()`; assert: вызван с `{ runningTimeoutMs: <число> > 0 }`.

- [ ] **Step 2: Реализация**

```js
const STALE_RUNNING_TIMEOUT_MS = Number(process.env.CRM_SYNC_STALE_RUNNING_MS || 5 * 60 * 1000);
// в recover():
await store.reclaimStale({ runningTimeoutMs: STALE_RUNNING_TIMEOUT_MS });
```

- [ ] **Step 3: Тест зелёный.** Существующие тесты ветки (`reclaimStale with runningTimeoutMs`) остаются зелёными.

- [ ] **Step 4: Падающий тест порядка expired** — в `tests/timeoutWatcher.test.js`: фейковый CRM-клиент бросает на `updateReportCrmItem`; прогнать тик; assert: `setReportStatus('expired')` НЕ вызван, отчёт остаётся в выборке overdue. Второй сценарий: CRM «починился» → следующий тик ставит `expired` и шлёт уведомление.

- [ ] **Step 5: Реализация — поменять порядок в `timeoutWatcher.js:82-93`:** сначала успешный CRM-апдейт стадии, затем `setReportStatus('expired')`, затем уведомление. Ошибка CRM → лог + `continue` (отчёт вернётся в следующий 5-минутный тик — самовосстановление). Per-report try/catch уже существует (`:81-148`) — сохранить.

- [ ] **Step 6: Полный прогон → зелёный. Commit** — `git commit -m "fix(stability): scoped reclaimStale on recover, expire reports only after successful CRM update"`

**Acceptance Criteria:**
- [ ] `recover()` реклеймит только задачи старше `CRM_SYNC_STALE_RUNNING_MS` (дефолт 5 мин); переменная в `.env.example`.
- [ ] Сбой CRM при просрочке не «хоронит» отчёт: статус не меняется, обработка повторяется следующим тиком (покрыто тестом).
- [ ] Уведомление о просрочке уходит только после согласованного состояния БД+CRM.

---

### Task S1-05: Честный healthcheck + HEALTHCHECK + ротация логов

**Files:**
- Modify: `backends/node/api/server.js:279` (`/api/healthz`)
- Modify: `Dockerfile` (runtime-stage, `node:20-bookworm-slim`)
- Modify: `docker-compose.yml` (logging для api-сервисов)
- Docs: `docs/timeweb-app-platform-deploy.md` (абзац про лимит RAM)

**Проблема (аудит):** `/api/healthz` — статический 200 без проверки БД; `ensureSchema()` — fire-and-forget (`server.js:558-588`); в прод-образе нет `HEALTHCHECK` вообще → сервис с мёртвой БД выглядит здоровым и не перезапускается. Логи без ротации; лимитов памяти нет (multer memoryStorage + base64-фото).

- [ ] **Step 1: Разделить liveness/readiness в `server.js`**

```js
app.get('/api/livez', (req, res) => res.json({ ok: true }));

app.get('/api/healthz', async (req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db healthcheck timeout')), 2000)
      ),
    ]);
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ ok: false, error: 'db_unavailable' });
  }
});
```

(`pool.query('SELECT 1')` работает в обеих ветках pg/mysql2-promise.)

- [ ] **Step 2: HEALTHCHECK в `Dockerfile`** (runtime-stage; убедиться, что `curl` установлен — в bookworm-slim добавить в существующий `apt-get install`):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/healthz || exit 1
```

Порт взять из фактического `listen` в `infrastructure/timeweb/nginx.conf` / env `PORT` — проверять надо тот порт, на котором публикуется nginx внутри контейнера.

- [ ] **Step 3: Ротация логов в `docker-compose.yml`** — каждому долгоживущему сервису:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

- [ ] **Step 4: Лимит памяти** — в `docker-compose.yml` для api-сервиса `mem_limit: 1g`; в `docs/timeweb-app-platform-deploy.md` дописать: на Timeweb выставить план с ≥1 ГБ RAM (пиковая память ≈ сумма фото одного отчёта × 1.33 из-за base64 + базовый RSS).

- [ ] **Step 5: Ручная проверка** — `make dev-node`; `curl -i localhost:<port>/api/healthz` → 200; `docker stop <db-container>` → healthz отдаёт 503 ≤2 c; `docker start` → снова 200.

- [ ] **Step 6: Полный прогон тестов → зелёный. Commit** — `git commit -m "feat(ops): readiness healthcheck with db ping, Dockerfile HEALTHCHECK, log rotation, memory limits"`

**Acceptance Criteria:**
- [ ] При недоступной БД `/api/healthz` → 503 (контейнер помечается unhealthy и перезапускается платформой).
- [ ] `/api/livez` остаётся статическим (для liveness).
- [ ] Логи dev-окружения ограничены 30 МБ на сервис.

---

### Task S1-06: Фронт — единый путь refresh-токена

**Files:**
- Modify: `frontend/app/stores/api.ts` (`ensureFreshToken` ~:84-91; `init` ~:418)
- Modify: `frontend/app/plugins/auth-refresh.client.ts` (`:31` refresh; `:66-75` stop)
- Modify: `frontend/app/pages/index.client.vue:246`

**Проблема (аудит):** дедуплицирован только retry-путь 401; прямые `reinitToken()` из плагина (таймер 50 мин + `visibilitychange`) и `index.client.vue` конкурируют с интерсептором — «последний выиграл» по `tokenJWT.value` (`api.ts:453`) даёт «действие срабатывает со второго раза после простоя». `stop()` не снимает `visibilitychange`-слушатель.

- [ ] **Step 1:** В `api.ts` сделать `ensureFreshToken({ force = false } = {})` единственной точкой обновления: внутренний промис-дедуп уже есть — добавить параметр `force` (безусловное обновление для планового refresh) и использовать его всеми вызывающими. Прямые вызовы `reinitToken` вне `ensureFreshToken` устранить: `init` (:418), `index.client.vue:246`, `auth-refresh.client.ts:31` → `apiStore.ensureFreshToken({ force: true })`.

- [ ] **Step 2:** В `auth-refresh.client.ts` вынести обработчик в именованную функцию и снимать в `stop()`:

```ts
const onVisibility = () => { /* существующая логика refresh при возврате */ };
document.addEventListener('visibilitychange', onVisibility);
// в stop():
document.removeEventListener('visibilitychange', onVisibility);
```

- [ ] **Step 3: Ручная проверка (чек-лист, DevTools → Network, фильтр getToken):**
  - двойной `document.dispatchEvent(new Event('visibilitychange'))` подряд → один сетевой запрос `/api/getToken`;
  - симулировать 401 (подменить токен в сторе на мусор через консоль) + сразу триггернуть visibility → запрос токена один, действие со второй попытки НЕ требуется;
  - переход между страницами — без ошибок в консоли.

- [ ] **Step 4: Сборка и линт** — `cd frontend && pnpm lint && pnpm build` → без ошибок.

- [ ] **Step 5: Commit** — `git commit -m "fix(frontend): deduplicate token refresh through ensureFreshToken, detach visibility listener on stop"`

**Acceptance Criteria:**
- [ ] Все пути обновления токена идут через один дедуплицирующий промис.
- [ ] Конкурентные refresh дают ровно один сетевой запрос.
- [ ] `stop()` полностью снимает слушатели плагина.

---

### Task S1-07 (Stretch): Durability файловых сторов

**Files:** `backends/node/api/src/auth/authContextStore.js:99-106`, `src/settings/fileSettingsStore.js:31-40` + их тесты.

**Суть:** перед `rename` делать `fileHandle.sync()` (fsync) через `fs.open`/`writeFile(handle)`; в `FileSettingsStore` — уникальный tmp-путь (`${filePath}.${process.pid}.${random}.tmp` вместо фиксированного `:35`) и сериализация записей через цепочку, как в `AuthContextStore`. Тест: конкурентные `write()` не теряют обновления (аналог существующего теста authContextStore).

### Task S1-08 (Stretch): Админ-ID из конфигурации

**Files:** `backends/node/api/src/access/roleResolver.js:4,59-60`.

**Суть:** заменить хардкод `SYSTEM_ADMIN_USER_IDS = [498]` чтением `SYSTEM_ADMIN_USER_IDS` из env (CSV → массив чисел, дефолт — пустой). Добавить в `.env.example`. **Требует решения продакта:** какие ID считать системными админами на боевом портале и нужна ли эта эскалация вообще.

---

## Definition of Done спринта

- [ ] `node --test "tests/*.test.js"` — все тесты зелёные (≥240 старых + новые), два прогона подряд без флаков.
- [ ] `cd frontend && pnpm lint && pnpm build` — без ошибок.
- [ ] Код-ревью пройдено; новые env-переменные (`BITRIX_HTTP_TIMEOUT_MS`, `CRM_SYNC_STALE_RUNNING_MS`) задокументированы в `.env.example`.
- [ ] Smoke на dev-окружении (`make dev-node`): установка приложения, рассылка тестового плана, сдача отчёта, healthz-сценарий с остановкой БД.
- [ ] `docs/CHANGELOG.md` дополнен.
- [ ] Ручные сценарии S1-01 Step 7, S1-02 Step 7, S1-05 Step 5, S1-06 Step 3 выполнены и зафиксированы в PR.

## Риски спринта

| Риск | Митигация |
|---|---|
| `bitrixRestClient` — ядро интеграции, регрессия дорогая | Существующие тесты клиента + новые на 503/таймаут; изменения только в транспортном слое, не в семантике методов |
| Точные имена переменных/строк могли сместиться относительно аудита | Перед каждой задачей сверяться с фактическим кодом; номера строк в плане — ориентиры аудита от 2026-06-10 |
| Graceful shutdown сложно покрыть автотестом | Ручной сценарий с `kill -TERM` обязателен в DoD |
| Поведение mysql2-пула при подписке на ошибки отличается от pg | Защитная подписка через feature-detect (S1-01 Step 6) |

## Метрики успеха (смотреть 2 недели после релиза)

- 0 перезапусков контейнера из-за крашей процесса (логи supervisord/платформы).
- 0 инцидентов «зелёный healthcheck при неработающем приложении».
- В логах появляются и корректно разрешаются `tick_skipped_overlap` / transient-ретраи при деградации Битрикса (вместо лавины ошибок).
