# Диаг-бандл, этап 1 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По нажатию кнопки «Что-то не работает» или автоматически при сбое загрузки фото собрать с устройства оператора диагностический бандл (ошибки, исходы загрузок, состояние очереди, устройство, сеть, замер канала) и сохранить его на нашем бэкенде под коротким кодом.

**Architecture:** Клиент собирает данные в кольцевые буферы с момента бута (Nuxt-плагин оборачивает `globalThis.fetch`, подписывается на `window.onerror`/`unhandledrejection`, добавляет заголовок `X-Diag-Session`). По триггеру прогоняются активные пробы (`ping`, `echo`), бандл собирается чистой функцией, редактируется от секретов, обрезается по размеру и уходит `POST /api/diag/report`. Бэкенд валидирует, **повторно** редактирует (клиенту в вопросах приватности не доверяем) и пишет в таблицу `diag_report`.

**Tech Stack:** Nuxt 4 / Vue 3 / Pinia (frontend) · Node 20+/Express 5 (backend) · PostgreSQL · тесты — `node:test` + `node:assert/strict`.

**Спека:** [2026-07-30-diag-bundle-design.md](../specs/2026-07-30-diag-bundle-design.md). Этот план покрывает только **этап 1** (§3 спеки). Этап 2 получит отдельный план после выката.

## Global Constraints

- **Ничто из добавленного не имеет права ломать сдачу отчёта.** Весь диаг-код — в `try/catch`, fire-and-forget. Ошибка сбора или отправки не всплывает в UI и не блокирует очередь загрузок.
- **Erasable-only TypeScript** во всех файлах `frontend/app/utils/diag/**`. Node запускает `.ts` в strip-only режиме: `enum`, `namespace` и parameter properties **падают с ошибкой**. Использовать `type`, `interface`, `as const`.
- **Тесты фронтенда** — `node --test "app/utils/diag/**/*.test.ts"` из каталога `frontend/`. Скан каталога не работает (Node ищет `*.test.js`) — только glob или явный путь. Новых зависимостей не добавлять.
- **Тесты бэкенда** — `node --test tests/<name>.test.js` из `backends/node/api/`, фейковые пулы вместо реальной БД, по образцу `tests/databaseAuthContextStore.test.js`.
- **БД — только PostgreSQL.** `DB_TYPE=postgresql` в `.env` и `.env.timeweb`. Для `mysql` диаг-стор бросает явную ошибку, а не молча ломается.
- **Приватность:** байтов фото нет, GPS/EXIF-координат нет. Скрываются `authorization`, `cookie`, `set-cookie`, `x-api-key`; query-параметры `token`, `access_token`, `auth`, `sessid`. Значение маски — ровно `'***'`.
- **Потолки:** `net` 150 записей · `errors` 50 · `uploads` 60 · `b24` 100 · сериализованный бандл 256 КБ · лимит тела на роуте 512 КБ · `echo` 1 МБ.
- **Троттлинг отправки:** не чаще 1 раза в 60 000 мс на устройство.
- **Ретеншен:** 30 дней.
- **Русский язык** во всех строках UI и в сообщениях, видимых оператору.
- **Стейджить только свои файлы, явными путями.** `git add -A`, `git add .`, `git commit -a` запрещены: в рабочем дереве есть незакоммиченные правки владельца (`docs/code-review-log.md`, `frontend/nuxt.config.ts`, `frontend/app/pages/reason/[reportId].client.vue`, `docs/superpowers/plans/2026-06-04-backlog-master.md`, `docs/superpowers/plans/2026-06-11-bug-backlog.md`). Массовый стейджинг подметёт их в чужой коммит.
- **`frontend/nuxt.config.ts` не изменять ни в одной задаче** — он в работе у владельца. Поэтому `app.build` = `'unknown'`, `app.isDemo` = `false` (см. врезку в Task 7).

---

### Task 1: Чистые утилиты — кольцевой буфер и редакция секретов

**Files:**
- Create: `frontend/app/utils/diag/ringBuffer.ts`
- Create: `frontend/app/utils/diag/ringBuffer.test.ts`
- Create: `frontend/app/utils/diag/redact.ts`
- Create: `frontend/app/utils/diag/redact.test.ts`
- Modify: `frontend/package.json` (добавить скрипт `test:unit`)

**Interfaces:**
- Consumes: ничего.
- Produces: `createRingBuffer<T>(capacity: number): RingBuffer<T>` с `push(item): void`, `toArray(): T[]`, геттерами `size: number` и `dropped: number`; тип `RingBuffer<T>`. `redactHeaders(headers: Record<string,string>): Record<string,string>`, `redactUrl(rawUrl: string): string`, константа `REDACTED = '***'`.

- [ ] **Step 1: Написать падающие тесты**

`frontend/app/utils/diag/ringBuffer.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRingBuffer } from './ringBuffer.ts'

test('держит вместимость и вытесняет самое старое', () => {
  const b = createRingBuffer<number>(3)
  for (const n of [1, 2, 3, 4, 5]) b.push(n)
  assert.deepEqual(b.toArray(), [3, 4, 5])
  assert.equal(b.size, 3)
})

test('считает вытесненные записи', () => {
  const b = createRingBuffer<number>(2)
  assert.equal(b.dropped, 0)
  b.push(1); b.push(2); b.push(3)
  assert.equal(b.dropped, 1)
})

test('toArray возвращает копию, а не внутренний массив', () => {
  const b = createRingBuffer<number>(2)
  b.push(1)
  b.toArray().push(99)
  assert.deepEqual(b.toArray(), [1])
})

test('некорректная вместимость бросает RangeError', () => {
  assert.throws(() => createRingBuffer<number>(0), RangeError)
  assert.throws(() => createRingBuffer<number>(-1), RangeError)
  assert.throws(() => createRingBuffer<number>(1.5), RangeError)
})
```

`frontend/app/utils/diag/redact.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactHeaders, redactUrl, REDACTED } from './redact.ts'

test('redactHeaders: секретные заголовки скрыты независимо от регистра', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', COOKIE: 'a=1', 'X-Ok': 'keep' })
  assert.equal(out.Authorization, REDACTED)
  assert.equal(out.COOKIE, REDACTED)
  assert.equal(out['X-Ok'], 'keep')
})

test('redactHeaders: пустой вход не падает', () => {
  assert.deepEqual(redactHeaders({}), {})
})

test('redactUrl: секретный query скрыт, остальное сохранено', () => {
  assert.equal(redactUrl('/api/reports?token=abc&azsId=548'), '/api/reports?token=***&azsId=548')
})

test('redactUrl: без секретов строка возвращается как есть', () => {
  assert.equal(redactUrl('/api/reports?azsId=548'), '/api/reports?azsId=548')
})

test('redactUrl: абсолютный URL остаётся абсолютным', () => {
  const out = redactUrl('https://example.test/api?access_token=zzz')
  assert.ok(out.startsWith('https://example.test/api?'))
  assert.ok(!out.includes('zzz'))
})

test('redactUrl: пустая строка', () => {
  assert.equal(redactUrl(''), '')
})
```

- [ ] **Step 2: Прогнать тесты и убедиться, что падают**

Run: `cd frontend && node --test "app/utils/diag/**/*.test.ts"`
Expected: FAIL — `Cannot find module './ringBuffer.ts'` / `'./redact.ts'`.

- [ ] **Step 3: Реализовать `ringBuffer.ts`**

```ts
export type RingBuffer<T> = {
  push: (item: T) => void
  toArray: () => T[]
  readonly size: number
  readonly dropped: number
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`createRingBuffer: capacity must be a positive integer, got ${String(capacity)}`)
  }
  const items: T[] = []
  let dropped = 0
  return {
    push(item: T): void {
      items.push(item)
      if (items.length > capacity) {
        items.shift()
        dropped += 1
      }
    },
    toArray: (): T[] => items.slice(),
    get size(): number { return items.length },
    get dropped(): number { return dropped }
  }
}
```

- [ ] **Step 4: Реализовать `redact.ts`**

```ts
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key'])
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'auth', 'sessid'])

export const REDACTED = '***'

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? REDACTED : value
  }
  return out
}

export function redactUrl(rawUrl: string): string {
  const raw = String(rawUrl ?? '')
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://local.invalid')
    let touched = false
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED)
        touched = true
      }
    }
    if (!touched) return raw
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}`
  } catch {
    return raw
  }
}
```

- [ ] **Step 5: Добавить npm-скрипт**

В `frontend/package.json`, в блок `"scripts"`, рядом с `"lint"`:

```json
"test:unit": "node --test \"app/utils/diag/**/*.test.ts\""
```

- [ ] **Step 6: Прогнать тесты — должны пройти**

Run: `cd frontend && npm run test:unit`
Expected: PASS, 10 тестов.

- [ ] **Step 7: Коммит**

```bash
git add frontend/app/utils/diag/ringBuffer.ts frontend/app/utils/diag/ringBuffer.test.ts frontend/app/utils/diag/redact.ts frontend/app/utils/diag/redact.test.ts frontend/package.json
git commit -m "feat(DIAG): кольцевой буфер и редакция секретов + скрипт test:unit"
```

---

### Task 2: `buildBundle` — чистая сборка бандла с обрезкой по размеру

**Files:**
- Create: `frontend/app/utils/diag/types.ts`
- Create: `frontend/app/utils/diag/buildBundle.ts`
- Create: `frontend/app/utils/diag/buildBundle.test.ts`

**Interfaces:**
- Consumes: `redactHeaders`, `redactUrl` из `./redact.ts`; `RingBuffer` из `./ringBuffer.ts` (только тип, буферы передаются уже развёрнутыми массивами).
- Produces: типы `NetEntry`, `ErrorEntry`, `UploadEntry`, `B24Entry`, `QueueSnapshot`, `DiagBundle`, `BuildBundleInput`; функция `buildBundle(input: BuildBundleInput): DiagBundle`; константа `MAX_BUNDLE_BYTES = 262144`.

- [ ] **Step 1: Написать падающий тест**

`frontend/app/utils/diag/buildBundle.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBundle, MAX_BUNDLE_BYTES } from './buildBundle.ts'
import type { BuildBundleInput } from './types.ts'

const baseInput = (): BuildBundleInput => ({
  diagSessionId: 'sess-1',
  sentAt: '2026-07-30T09:00:00.000Z',
  trigger: 'button',
  app: { build: 'dev', route: '/admin/1', isDemo: false },
  user: { userId: 498, azsId: '548', reportId: 12345, role: 'azs_admin' },
  device: { userAgent: 'UA', deviceMemory: 4, hardwareConcurrency: 8, screen: { w: 390, h: 844, dpr: 3 }, language: 'ru', platform: 'Android' },
  network: { onLine: true, effectiveType: '3g', downlink: 0.4, rtt: 1200, saveData: false },
  probe: { echoBytes: 307200, echoMs: 6000, echoKbps: 409, pingMsMedian: 180, pingLoss: 0 },
  startup: { navigationMs: 5300, ttfbMs: 900, domContentLoadedMs: 2100, resourceCount: 42 },
  queue: { activeCount: 1, maxConcurrency: 2, workerSessionId: 1, slots: [] },
  uploads: [],
  net: [],
  errors: [],
  b24: [],
  dropped: { net: 0, errors: 0, uploads: 0 }
})

test('переносит вход в бандл и ставит версию', () => {
  const bundle = buildBundle(baseInput())
  assert.equal(bundle.v, 1)
  assert.equal(bundle.diagSessionId, 'sess-1')
  assert.equal(bundle.user.azsId, '548')
  assert.equal(bundle.probe.echoKbps, 409)
})

test('редактирует секреты в net-записях', () => {
  const input = baseInput()
  input.net = [{
    url: '/api/reports?token=abc',
    method: 'GET',
    status: 200,
    startedAt: '2026-07-30T09:00:00.000Z',
    durationMs: 120,
    reqBytes: 0,
    resBytes: 512,
    headers: { Authorization: 'Bearer secret', 'X-Ok': 'keep' }
  }]
  const bundle = buildBundle(input)
  assert.equal(bundle.net[0]!.url, '/api/reports?token=***')
  assert.equal(bundle.net[0]!.headers.Authorization, '***')
  assert.equal(bundle.net[0]!.headers['X-Ok'], 'keep')
})

test('обрезает net при превышении потолка размера и отмечает это в dropped', () => {
  const input = baseInput()
  const bigHeaders: Record<string, string> = {}
  for (let h = 0; h < 40; h += 1) bigHeaders[`x-pad-${h}`] = 'p'.repeat(200)
  input.net = Array.from({ length: 150 }, (_, i) => ({
    url: `/api/reports/${i}`,
    method: 'GET',
    status: 200,
    startedAt: '2026-07-30T09:00:00.000Z',
    durationMs: 10,
    reqBytes: 0,
    resBytes: 0,
    headers: bigHeaders
  }))
  const bundle = buildBundle(input)
  const size = new TextEncoder().encode(JSON.stringify(bundle)).length
  assert.ok(size <= MAX_BUNDLE_BYTES, `размер ${size} должен быть <= ${MAX_BUNDLE_BYTES}`)
  assert.ok(bundle.net.length < 150)
  assert.ok(bundle.dropped.net > 0)
})

test('ошибки без stack не роняют сборку', () => {
  const input = baseInput()
  input.errors = [{ kind: 'onerror', message: 'boom', stack: undefined, source: 'app.js', line: 1, col: 2, at: '2026-07-30T09:00:00.000Z' }]
  const bundle = buildBundle(input)
  assert.equal(bundle.errors[0]!.message, 'boom')
})
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — `Cannot find module './buildBundle.ts'`.

- [ ] **Step 3: Создать `types.ts`**

```ts
export type DiagTrigger = 'button' | 'auto_upload_error'

export type NetEntry = {
  url: string
  method: string
  status: number
  startedAt: string
  durationMs: number
  reqBytes: number
  resBytes: number
  headers: Record<string, string>
}

export type ErrorEntry = {
  kind: 'onerror' | 'unhandledrejection' | 'console'
  message: string
  stack: string | undefined
  source: string
  line: number
  col: number
  at: string
}

export type UploadEntry = {
  photoCode: string
  fileSize: number
  fileType: string
  exifTakenAt: string | null
  startedAt: string
  durationMs: number
  outcome: 'ok' | 'error'
  httpStatus: number | null
  errorCode: string | null
  retryable: boolean | null
  attempt: number
  message: string
}

export type B24Entry = { method: string; durationMs: number; ok: boolean; errorCode: string | null }

export type QueueSlotSnapshot = {
  key: string
  confirmed: boolean
  uploadState: string
  uploaded: boolean
  fileSize: number
  fileType: string
  error: string
}

export type QueueSnapshot = {
  activeCount: number
  maxConcurrency: number
  workerSessionId: number
  slots: QueueSlotSnapshot[]
}

export type BuildBundleInput = {
  diagSessionId: string
  sentAt: string
  trigger: DiagTrigger
  app: { build: string; route: string; isDemo: boolean }
  user: { userId: number; azsId: string; reportId: number | null; role: string }
  device: {
    userAgent: string
    deviceMemory: number | null
    hardwareConcurrency: number | null
    screen: { w: number; h: number; dpr: number }
    language: string
    platform: string
  }
  network: {
    onLine: boolean
    effectiveType: string | null
    downlink: number | null
    rtt: number | null
    saveData: boolean | null
  }
  probe: {
    echoBytes: number | null
    echoMs: number | null
    echoKbps: number | null
    pingMsMedian: number | null
    pingLoss: number | null
  }
  startup: {
    navigationMs: number | null
    ttfbMs: number | null
    domContentLoadedMs: number | null
    resourceCount: number
  }
  queue: QueueSnapshot
  uploads: UploadEntry[]
  net: NetEntry[]
  errors: ErrorEntry[]
  b24: B24Entry[]
  dropped: { net: number; errors: number; uploads: number }
}

export type DiagBundle = BuildBundleInput & { v: 1 }
```

- [ ] **Step 4: Реализовать `buildBundle.ts`**

```ts
import { redactHeaders, redactUrl } from './redact.ts'
import type { BuildBundleInput, DiagBundle } from './types.ts'

export const MAX_BUNDLE_BYTES = 262_144

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length

/**
 * Собирает диаг-бандл из уже накопленного состояния.
 *
 * Чистая функция: не читает window/performance и ничего не отправляет — всё
 * нужное приходит аргументом. Это позволяет проверить сборку и обрезку тестами
 * и переиспользовать её в этапе 2 без изменений.
 *
 * При превышении MAX_BUNDLE_BYTES усечение идёт от самых старых записей:
 * сначала `net`, затем `b24`. Счётчики в `dropped` увеличиваются, чтобы при
 * разборе было видно, что часть данных отброшена, а не «ничего не происходило».
 */
export function buildBundle(input: BuildBundleInput): DiagBundle {
  const bundle: DiagBundle = {
    ...input,
    v: 1,
    net: input.net.map((entry) => ({
      ...entry,
      url: redactUrl(entry.url),
      headers: redactHeaders(entry.headers)
    })),
    dropped: { ...input.dropped }
  }

  while (byteLength(bundle) > MAX_BUNDLE_BYTES && bundle.net.length > 0) {
    bundle.net.shift()
    bundle.dropped.net += 1
  }
  while (byteLength(bundle) > MAX_BUNDLE_BYTES && bundle.b24.length > 0) {
    bundle.b24 = bundle.b24.slice(1)
  }

  return bundle
}
```

- [ ] **Step 5: Прогнать тесты — должны пройти**

Run: `cd frontend && npm run test:unit`
Expected: PASS, 14 тестов (10 из Task 1 + 4 новых).

- [ ] **Step 6: Коммит**

```bash
git add frontend/app/utils/diag/types.ts frontend/app/utils/diag/buildBundle.ts frontend/app/utils/diag/buildBundle.test.ts
git commit -m "feat(DIAG): чистая сборка бандла с редакцией и обрезкой по 256 КБ"
```

---

### Task 3: Бэкенд — `diagStore` (схема, вставка, чтение, ретеншен)

**Files:**
- Create: `backends/node/api/src/diag/diagStore.js`
- Create: `backends/node/api/tests/diagStore.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `createDiagStore({ pool, dbType })` → объект с `ensureSchema()`, `insert({ code, diagSessionId, userId, azsId, reportId, trigger, sizeBytes, bundle })` → строка, `getByCode(code)` → строка или `null`, `list({ azsId, dateFrom, dateTo, limit })` → массив строк **без** поля `bundle`, `deleteOlderThan(days)` → число удалённых.

- [ ] **Step 1: Написать падающий тест**

`backends/node/api/tests/diagStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagStore } from '../src/diag/diagStore.js';

const makePgPool = (rows = []) => ({
  _calls: [],
  async query(sql, params) {
    this._calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  }
});

test('ensureSchema создаёт таблицу и индексы идемпотентно', async () => {
  const pool = makePgPool();
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const sql = pool._calls.map((c) => c.sql).join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS diag_report/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  assert.match(sql, /code TEXT NOT NULL/);
});

test('insert передаёт бандл как параметр, а не склеивает в SQL', async () => {
  const pool = makePgPool([{ id: 1, code: 'A7F3QQ' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  const row = await store.insert({
    code: 'A7F3QQ',
    diagSessionId: 'sess-1',
    userId: 498,
    azsId: '548',
    reportId: 12345,
    trigger: 'button',
    sizeBytes: 2048,
    bundle: { v: 1, note: "it's fine" }
  });
  assert.equal(row.code, 'A7F3QQ');
  const call = pool._calls.at(-1);
  assert.match(call.sql, /INSERT INTO diag_report/);
  assert.equal(call.params[0], 'A7F3QQ');
  assert.equal(call.params[7], JSON.stringify({ v: 1, note: "it's fine" }));
});

test('insert кладёт серверный срез отдельной колонкой', async () => {
  const pool = makePgPool([{ id: 1, code: 'A7F3QQ' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.insert({
    code: 'A7F3QQ', diagSessionId: 's', userId: 1, azsId: '548', reportId: 1,
    trigger: 'button', sizeBytes: 10, bundle: { v: 1 },
    serverSlice: { oauth: { hasContext: true }, disk: { ok: false } }
  });
  const call = pool._calls.at(-1);
  assert.match(call.sql, /server_slice/);
  assert.equal(call.params[8], JSON.stringify({ oauth: { hasContext: true }, disk: { ok: false } }));
});

test('insert без серверного среза кладёт NULL', async () => {
  const pool = makePgPool([{ id: 1, code: 'B' }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.insert({
    code: 'B', diagSessionId: 's', userId: 1, azsId: '548', reportId: 1,
    trigger: 'button', sizeBytes: 10, bundle: { v: 1 }
  });
  assert.equal(pool._calls.at(-1).params[8], null);
});

test('getByCode возвращает null, когда ничего не найдено', async () => {
  const store = createDiagStore({ pool: makePgPool([]), dbType: 'postgresql' });
  assert.equal(await store.getByCode('NOPE00'), null);
});

test('list не тянет поле bundle и ограничивает выборку', async () => {
  const pool = makePgPool([{ id: 1 }]);
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  await store.list({ azsId: '548', dateFrom: '2026-07-01', dateTo: '2026-07-30', limit: 20 });
  const call = pool._calls.at(-1);
  assert.ok(!/SELECT \*/.test(call.sql), 'list не должен делать SELECT *');
  assert.ok(!/\bbundle\b/.test(call.sql), 'list не должен выбирать bundle');
  assert.match(call.sql, /LIMIT/);
  assert.ok(call.params.includes('548'));
});

test('deleteOlderThan возвращает число удалённых', async () => {
  const pool = {
    async query() { return { rows: [], rowCount: 7 }; }
  };
  const store = createDiagStore({ pool, dbType: 'postgresql' });
  assert.equal(await store.deleteOlderThan(30), 7);
});

test('mysql не поддерживается и падает с внятной ошибкой', () => {
  assert.throws(
    () => createDiagStore({ pool: makePgPool(), dbType: 'mysql' }),
    /diagStore: only PostgreSQL is supported/
  );
});
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd backends/node/api && node --test tests/diagStore.test.js`
Expected: FAIL — `Cannot find module '../src/diag/diagStore.js'`.

- [ ] **Step 3: Реализовать `diagStore.js`**

```js
/**
 * diagStore — хранение диагностических бандлов.
 *
 * Только PostgreSQL: DB_TYPE=postgresql и в .env, и в .env.timeweb. Для mysql
 * конструктор бросает ошибку сразу, а не отдаёт стор, который сломается на
 * первом запросе.
 *
 * ensureSchema() идемпотентен (CREATE TABLE/INDEX IF NOT EXISTS) — по образцу
 * reasonStore и databaseBrandStore.
 */
export const createDiagStore = ({ pool, dbType = 'postgresql' }) => {
  if (String(dbType).toLowerCase() !== 'postgresql') {
    throw new Error(`diagStore: only PostgreSQL is supported, got "${dbType}"`);
  }

  return {
    async ensureSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS diag_report (
          id BIGSERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          diag_session_id TEXT NULL,
          user_id BIGINT NULL,
          azs_id TEXT NULL,
          report_id BIGINT NULL,
          trigger TEXT NOT NULL,
          size_bytes INT NOT NULL,
          bundle JSONB NOT NULL,
          -- Серверная половина картины: состояние OAuth-токена, живая проба
          -- Диска с таймингом, пинг БД. Отдельной колонкой, а не внутри bundle:
          -- она не приходит от клиента, не подлежит проверке доверия и не должна
          -- влиять на потолок размера бандла.
          server_slice JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_azs_created
          ON diag_report (azs_id, created_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_session
          ON diag_report (diag_session_id)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_diag_report_created
          ON diag_report (created_at)
      `);
    },

    async insert({ code, diagSessionId, userId, azsId, reportId, trigger, sizeBytes, bundle, serverSlice = null }) {
      const result = await pool.query(
        `INSERT INTO diag_report
           (code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, bundle, server_slice)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, code, created_at`,
        [
          code,
          diagSessionId ?? null,
          Number.isFinite(Number(userId)) ? Number(userId) : null,
          azsId ?? null,
          Number.isFinite(Number(reportId)) ? Number(reportId) : null,
          trigger,
          Number(sizeBytes) || 0,
          JSON.stringify(bundle),
          serverSlice === null ? null : JSON.stringify(serverSlice)
        ]
      );
      return result.rows[0] ?? null;
    },

    async getByCode(code) {
      const result = await pool.query(
        'SELECT id, code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, bundle, server_slice, created_at FROM diag_report WHERE code = $1 LIMIT 1',
        [String(code || '')]
      );
      return result.rows[0] ?? null;
    },

    async list({ azsId = '', dateFrom = '', dateTo = '', limit = 50 } = {}) {
      const where = [];
      const params = [];
      let idx = 1;
      if (azsId) { where.push(`azs_id = $${idx}`); params.push(String(azsId)); idx += 1; }
      if (dateFrom) { where.push(`created_at >= $${idx}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); idx += 1; }
      if (dateTo) { where.push(`created_at <= $${idx}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); idx += 1; }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
      params.push(safeLimit);
      const result = await pool.query(
        `SELECT id, code, diag_session_id, user_id, azs_id, report_id, trigger, size_bytes, created_at
         FROM diag_report ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        params
      );
      return result.rows;
    },

    async deleteOlderThan(days) {
      const safeDays = Math.max(Number(days) || 30, 1);
      const result = await pool.query(
        `DELETE FROM diag_report WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(safeDays)]
      );
      return Number(result.rowCount || 0);
    }
  };
};
```

- [ ] **Step 4: Прогнать тесты — должны пройти**

Run: `cd backends/node/api && node --test tests/diagStore.test.js`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Коммит**

```bash
git add backends/node/api/src/diag/diagStore.js backends/node/api/tests/diagStore.test.js
git commit -m "feat(DIAG): стор диаг-бандлов — схема, вставка, чтение, ретеншен"
```

---

### Task 4: Бэкенд — серверная санитизация бандла и генерация кода

**Files:**
- Create: `backends/node/api/src/diag/sanitizeBundle.js`
- Create: `backends/node/api/tests/diagSanitize.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `sanitizeBundle(raw)` → `{ ok: true, bundle, sizeBytes }` либо `{ ok: false, error: string }`; `generateDiagCode(randomBytes)` → строка из 6 символов алфавита `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; константы `MAX_BUNDLE_BYTES = 262144`, `DIAG_CODE_ALPHABET`.

**Почему это отдельная единица.** Клиент уже редактирует секреты (Task 1–2), но доверять ему нельзя: бандл приходит из браузера и может быть подделан или собран старой версией фронта. Приватность обязана держаться на сервере, и именно поэтому она здесь под тестами.

- [ ] **Step 1: Написать падающий тест**

`backends/node/api/tests/diagSanitize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBundle, generateDiagCode, DIAG_CODE_ALPHABET } from '../src/diag/sanitizeBundle.js';

const validBundle = () => ({
  v: 1,
  diagSessionId: 'sess-1',
  sentAt: '2026-07-30T09:00:00.000Z',
  trigger: 'button',
  net: [{ url: '/api/x?token=abc', method: 'GET', status: 200, headers: { Authorization: 'Bearer s', 'X-Ok': 'k' } }],
  uploads: [],
  errors: [],
  b24: []
});

test('отклоняет не-объект', () => {
  assert.equal(sanitizeBundle(null).ok, false);
  assert.equal(sanitizeBundle('str').ok, false);
});

test('отклоняет неизвестную версию', () => {
  const res = sanitizeBundle({ ...validBundle(), v: 99 });
  assert.equal(res.ok, false);
  assert.match(res.error, /version/i);
});

test('отклоняет неизвестный trigger', () => {
  const res = sanitizeBundle({ ...validBundle(), trigger: 'hack' });
  assert.equal(res.ok, false);
  assert.match(res.error, /trigger/i);
});

test('повторно скрывает секреты, даже если клиент этого не сделал', () => {
  const res = sanitizeBundle(validBundle());
  assert.equal(res.ok, true);
  assert.equal(res.bundle.net[0].headers.Authorization, '***');
  assert.equal(res.bundle.net[0].headers['X-Ok'], 'k');
  assert.ok(!JSON.stringify(res.bundle).includes('Bearer s'));
  assert.ok(!JSON.stringify(res.bundle).includes('token=abc'));
});

test('чистит секреты в свободном тексте ошибок, загрузок и очереди', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'POST /api/x?token=LEAK failed', stack: 'Error: sessid=LEAK\n  at f' }];
  raw.uploads = [{ photoCode: 'p1', message: 'auth=LEAK' }];
  raw.queue = { activeCount: 0, maxConcurrency: 2, workerSessionId: 1, slots: [{ key: 'p1', error: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc' }] };
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  const serialized = JSON.stringify(res.bundle);
  assert.ok(!serialized.includes('LEAK'), serialized);
  assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiJ9'), serialized);
});

test('серверная чистка закрывает те же формы ключей, что и клиентская', () => {
  const forms = [
    'client_secret=LEAK', 'client-secret=LEAK', 'password=LEAK', 'auth_id=LEAK',
    'api-key=LEAK', 'apikey=LEAK', 'refresh-token=LEAK', 'session-id=LEAK',
    'secret=LEAK', 'pwd=LEAK', 'id_token=LEAK'
  ];
  for (const form of forms) {
    const raw = validBundle();
    raw.errors = [{ kind: 'onerror', message: form }];
    const res = sanitizeBundle(raw);
    assert.equal(res.ok, true, form);
    assert.ok(!JSON.stringify(res.bundle).includes('LEAK'), `утечка: ${form}`);
  }
});

test('значение с запятой маскируется целиком и на сервере', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'token=abc123,def456' }];
  const serialized = JSON.stringify(sanitizeBundle(raw).bundle);
  assert.ok(!serialized.includes('abc123'), serialized);
  assert.ok(!serialized.includes('def456'), serialized);
});

test('отсутствующие массивы не роняют санитизацию', () => {
  const raw = validBundle();
  delete raw.errors;
  delete raw.uploads;
  delete raw.queue;
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.deepEqual(res.bundle.errors, []);
  assert.deepEqual(res.bundle.uploads, []);
});

test('отклоняет бандл больше потолка', () => {
  const big = validBundle();
  big.errors = Array.from({ length: 5000 }, () => ({ kind: 'onerror', message: 'x'.repeat(200) }));
  const res = sanitizeBundle(big);
  assert.equal(res.ok, false);
  assert.match(res.error, /too_large/);
});

test('возвращает размер в байтах', () => {
  const res = sanitizeBundle(validBundle());
  assert.equal(res.ok, true);
  assert.equal(typeof res.sizeBytes, 'number');
  assert.ok(res.sizeBytes > 0);
});

test('generateDiagCode: 6 символов из безопасного алфавита', () => {
  const code = generateDiagCode(Buffer.from([0, 1, 2, 3, 4, 5]));
  assert.equal(code.length, 6);
  for (const ch of code) assert.ok(DIAG_CODE_ALPHABET.includes(ch), `${ch} вне алфавита`);
});

test('generateDiagCode: алфавит без похожих символов', () => {
  for (const ch of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!DIAG_CODE_ALPHABET.includes(ch), `${ch} не должен входить в алфавит`);
  }
});
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd backends/node/api && node --test tests/diagSanitize.test.js`
Expected: FAIL — `Cannot find module '../src/diag/sanitizeBundle.js'`.

- [ ] **Step 3: Реализовать `sanitizeBundle.js`**

```js
/**
 * sanitizeBundle — валидация и повторная редакция диаг-бандла на сервере.
 *
 * Клиент уже редактирует секреты, но бандл приходит из браузера: он может быть
 * подделан или собран устаревшей сборкой фронта. Приватность держится здесь.
 */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'auth', 'sessid']);
const ALLOWED_TRIGGERS = new Set(['button', 'auto_upload_error']);
const REDACTED = '***';

// Словарь выровнен по utils/maskSecret.js (SENSITIVE_KEYS) и расширен формами,
// которые реально встречаются в текстах ошибок. Порядок важен: длинные варианты
// раньше коротких, иначе `token` съест префикс у `access_token`.
const SECRET_TEXT_KEYS = [
  'access[_-]?token', 'refresh[_-]?token', 'refresh[_-]?id', 'id[_-]?token',
  '[a-z]{2,}[_-]token', 'token',
  'auth[_-]?id', 'authorization', 'auth',
  'session[_-]?id', 'sess[_-]?id', 'sessid', 'session', 'cookie',
  'api[_-]?key', 'client[_-]?secret', 'secret',
  'password', 'passwd', 'pwd'
].join('|');
// Запятая и точка с запятой НЕ терминаторы значения: иначе секрет с запятой
// маскируется частично и пригодный огрызок уезжает в базу.
const KV_RE = new RegExp(`\\b(${SECRET_TEXT_KEYS})"?\\s*[=:]\\s*"?([^&\\s"'<>)\\]}]+)`, 'gi');
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{4,})/gi;

/**
 * Чистит секреты в свободном тексте — сообщениях об ошибках и стеках.
 *
 * Текст ошибки почти всегда содержит URL упавшего запроса, а stack дублирует
 * message. Разбирать это как URL нельзя: строка произвольная. Поэтому ищем
 * пары «ключ=значение» и схемы авторизации.
 */
export const redactText = (text) => {
  const raw = String(text ?? '');
  if (!raw) return '';
  // BEARER_RE идёт ПЕРВЫМ. Иначе KV_RE съедает слово `Bearer` как значение
  // ключа `authorization` ("Authorization: Bearer <jwt>" -> "Authorization=***"),
  // после чего сам токен остаётся в тексте, а BEARER_RE уже не находит схему.
  return raw
    .replace(BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, key) => `${key}=${REDACTED}`);
};

export const MAX_BUNDLE_BYTES = 262_144;
export const DIAG_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const redactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? REDACTED : String(value);
  }
  return out;
};

const redactUrl = (rawUrl) => {
  const raw = String(rawUrl ?? '');
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://local.invalid');
    let touched = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    if (!touched) return raw;
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
};

export const sanitizeBundle = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'bundle_not_an_object' };
  }
  if (Number(raw.v) !== 1) {
    return { ok: false, error: 'unsupported_bundle_version' };
  }
  if (!ALLOWED_TRIGGERS.has(String(raw.trigger))) {
    return { ok: false, error: 'unknown_trigger' };
  }

  const bundle = {
    ...raw,
    net: Array.isArray(raw.net)
      ? raw.net.map((entry) => ({
        ...entry,
        url: redactUrl(entry?.url),
        headers: redactHeaders(entry?.headers)
      }))
      : [],
    // Свободный текст чистим и здесь: клиент это уже делает, но бандл приходит
    // из браузера и может быть собран устаревшей сборкой фронта либо подделан.
    errors: Array.isArray(raw.errors)
      ? raw.errors.map((entry) => ({
        ...entry,
        message: redactText(entry?.message),
        stack: entry?.stack === undefined ? undefined : redactText(entry.stack)
      }))
      : [],
    uploads: Array.isArray(raw.uploads)
      ? raw.uploads.map((entry) => ({ ...entry, message: redactText(entry?.message) }))
      : [],
    queue: raw.queue && typeof raw.queue === 'object'
      ? {
        ...raw.queue,
        slots: Array.isArray(raw.queue.slots)
          ? raw.queue.slots.map((slot) => ({ ...slot, error: redactText(slot?.error) }))
          : []
      }
      : raw.queue
  };

  const sizeBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: 'bundle_too_large' };
  }

  return { ok: true, bundle, sizeBytes };
};

/**
 * Короткий код для разговора с оператором («диагностика A7F3QQ»).
 * Алфавит без 0/O/1/I/L — чтобы код можно было продиктовать по телефону.
 */
export const generateDiagCode = (randomBytes) => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    const byte = randomBytes[i] ?? 0;
    code += DIAG_CODE_ALPHABET[byte % DIAG_CODE_ALPHABET.length];
  }
  return code;
};
```

- [ ] **Step 4: Прогнать тесты — должны пройти**

Run: `cd backends/node/api && node --test tests/diagSanitize.test.js`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add backends/node/api/src/diag/sanitizeBundle.js backends/node/api/tests/diagSanitize.test.js
git commit -m "feat(DIAG): серверная санитизация бандла и короткий код диагностики"
```

---

### Task 5: Бэкенд — роуты `ping`, `echo`, `report`, чтение

**Files:**
- Create: `backends/node/api/src/diag/diagRoutes.js`
- Create: `backends/node/api/tests/diagRoutes.test.js`

**Interfaces:**
- Consumes: `createDiagStore` (Task 3) — используется через параметр `store`; `sanitizeBundle`, `generateDiagCode` (Task 4).
- Produces: `createDiagRouter({ store, randomBytes, logger })` → Express Router с `GET /ping`, `POST /echo`, `POST /report`, `GET /reports`, `GET /reports/:code`. Экспортирует `DIAG_JSON_LIMIT = '512kb'`, `DIAG_ECHO_LIMIT = '1mb'`.

**Ключевое требование по монтированию** (исполняется в Task 6, здесь только фиксируется контракт): `/ping` и `/echo` не должны проходить через `attachAccessContext` — он читает настройки из БД на каждом запросе ([`server.js:439`](../../../backends/node/api/server.js)), и тогда замер RTT мерил бы нашу БД вместо сети.

- [ ] **Step 1: Написать падающий тест**

`backends/node/api/tests/diagRoutes.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDiagRouter } from '../src/diag/diagRoutes.js';

const silentLogger = { info() {}, warn() {}, error() {} };

const makeStore = () => ({
  inserted: [],
  async insert(row) { this.inserted.push(row); return { id: 1, code: row.code, created_at: new Date() }; },
  async getByCode(code) { return code === 'A7F3QQ' ? { id: 1, code, bundle: { v: 1 } } : null; },
  async list() { return [{ id: 1, code: 'A7F3QQ' }]; }
});

const startServer = (store) => {
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 498 }; next(); });
  app.use('/api/diag', createDiagRouter({
    store,
    randomBytes: () => Buffer.from([0, 1, 2, 3, 4, 5]),
    logger: silentLogger
  }));
  return app.listen(0);
};

const call = async (server, path, init = {}) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON — оставляем null */ }
  return { status: res.status, json, text };
};

const validBundle = () => ({
  v: 1, trigger: 'button', diagSessionId: 'sess-1',
  user: { userId: 498, azsId: '548', reportId: 12345 },
  net: [], uploads: [], errors: [], b24: []
});

test('GET /ping отдаёт метку времени и не трогает стор', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/ping');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.t, 'number');
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /echo считает принятые байты и не пишет в стор', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const body = Buffer.alloc(4096, 7);
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.bytes, 4096);
    assert.equal(typeof res.json.serverMs, 'number');
    assert.equal(store.inserted.length, 0);
  } finally { server.close(); }
});

test('POST /report сохраняет бандл и возвращает код', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.code, 'ABCDEF');
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].azsId, '548');
    assert.equal(store.inserted[0].trigger, 'button');
  } finally { server.close(); }
});

test('POST /report отклоняет неизвестную версию с 400', async () => {
  const server = startServer(makeStore());
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBundle(), v: 99 })
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /unsupported_bundle_version/);
  } finally { server.close(); }
});

test('POST /report отвечает 413 на тело сверх лимита', async () => {
  const server = startServer(makeStore());
  try {
    const huge = JSON.stringify({ ...validBundle(), pad: 'x'.repeat(600 * 1024) });
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge
    });
    assert.equal(res.status, 413);
  } finally { server.close(); }
});

test('POST /report: падение стора не отдаёт 500 наружу как краш', async () => {
  const store = makeStore();
  store.insert = async () => { throw new Error('db down'); };
  const server = startServer(store);
  try {
    const res = await call(server, '/api/diag/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle())
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /diag_report_failed/);
  } finally { server.close(); }
});

test('GET /reports/:code отдаёт 404 на неизвестный код', async () => {
  const server = startServer(makeStore());
  try {
    assert.equal((await call(server, '/api/diag/reports/NOPE00')).status, 404);
    assert.equal((await call(server, '/api/diag/reports/A7F3QQ')).status, 200);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd backends/node/api && node --test tests/diagRoutes.test.js`
Expected: FAIL — `Cannot find module '../src/diag/diagRoutes.js'`.

- [ ] **Step 3: Реализовать `diagRoutes.js`**

```js
import express from 'express';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { sanitizeBundle, generateDiagCode } from './sanitizeBundle.js';

export const DIAG_JSON_LIMIT = '512kb';
export const DIAG_ECHO_LIMIT = '1mb';

/**
 * diagRoutes — приём диагностических бандлов и активные пробы.
 *
 * /ping и /echo намеренно не делают ничего тяжёлого: их задача — измерить
 * сеть оператора, а не нашу БД. Поэтому они не обращаются к стору и должны
 * монтироваться без attachAccessContext (см. Task 6).
 */
export const createDiagRouter = ({ store, randomBytes = nodeRandomBytes, logger = console, serverSelfCheck = null }) => {
  const router = express.Router();

  router.get('/ping', (_req, res) => {
    res.json({ t: Date.now() });
  });

  router.post('/echo', express.raw({ type: '*/*', limit: DIAG_ECHO_LIMIT }), (req, res) => {
    const startedAt = Date.now();
    const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
    res.json({ bytes, serverMs: Date.now() - startedAt });
  });

  router.post('/report', express.json({ limit: DIAG_JSON_LIMIT }), async (req, res) => {
    const result = sanitizeBundle(req.body);
    if (!result.ok) {
      logger.warn('diag_report_rejected', { reason: result.error });
      return res.status(400).json({ error: result.error });
    }

    const { bundle, sizeBytes } = result;
    const code = generateDiagCode(randomBytes(6));

    // Серверный срез — best-effort и никогда не роняет приём бандла: клиентская
    // половина ценна сама по себе, терять её из-за зависшего Диска нельзя.
    // Реализация — Task 11; до неё serverSelfCheck === null.
    let serverSlice = null;
    if (serverSelfCheck) {
      try {
        serverSlice = await serverSelfCheck.run();
      } catch (error) {
        logger.warn('diag_server_slice_failed', { code, message: error.message });
      }
    }

    try {
      const row = await store.insert({
        code,
        diagSessionId: bundle.diagSessionId || null,
        userId: Number(req.user?.user_id || req.user?.id || 0) || null,
        azsId: bundle.user?.azsId || null,
        reportId: bundle.user?.reportId || null,
        trigger: bundle.trigger,
        sizeBytes,
        bundle,
        serverSlice
      });
      logger.info('diag_report_stored', {
        code, sizeBytes, trigger: bundle.trigger, azsId: bundle.user?.azsId || null
      });
      return res.json({ diagId: row?.id ?? null, code });
    } catch (error) {
      logger.error('diag_report_failed', { code, message: error.message });
      return res.status(500).json({ error: 'diag_report_failed', message: error.message });
    }
  });

  router.get('/reports', async (req, res) => {
    try {
      const items = await store.list({
        azsId: String(req.query.azsId || ''),
        dateFrom: String(req.query.dateFrom || ''),
        dateTo: String(req.query.dateTo || ''),
        limit: Number(req.query.limit || 50)
      });
      return res.json({ items });
    } catch (error) {
      return res.status(500).json({ error: 'diag_list_failed', message: error.message });
    }
  });

  router.get('/reports/:code', async (req, res) => {
    try {
      const row = await store.getByCode(req.params.code);
      if (!row) return res.status(404).json({ error: 'diag_report_not_found' });
      return res.json({ item: row });
    } catch (error) {
      return res.status(500).json({ error: 'diag_get_failed', message: error.message });
    }
  });

  return router;
};

export default createDiagRouter;
```

- [ ] **Step 4: Прогнать тесты — должны пройти**

Run: `cd backends/node/api && node --test tests/diagRoutes.test.js`
Expected: PASS, 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add backends/node/api/src/diag/diagRoutes.js backends/node/api/tests/diagRoutes.test.js
git commit -m "feat(DIAG): роуты приёма бандла, ping и echo-проба"
```

---

### Task 6: Wiring в `server.js` — обход глобального json-парсера, монтирование, ретеншен

**Files:**
- Modify: `backends/node/api/server.js:71` (глобальный `express.json()`)
- Modify: `backends/node/api/server.js` (импорт, монтирование, `ensureSchema`, крон-чистка)

**Interfaces:**
- Consumes: `createDiagRouter` (Task 5), `createDiagStore` (Task 3), существующие `verifyToken` (`server.js:436`), `attachAccessContext` (`server.js:437`), `pool` (`server.js:80-90`), `dbType` (`server.js:77`).
- Produces: работающие эндпоинты `/api/diag/*` на живом сервере.

**Почему нужен обход парсера.** `app.use(express.json())` на `server.js:71` действует глобально с дефолтным лимитом **100 КБ**. Бандл до 256 КБ был бы отбит с 413 ещё до нашего роута, поэтому диаг-пути опускают глобальный парсер и приносят свои (`512kb` для `/report`, `express.raw` 1 МБ для `/echo`).

- [ ] **Step 1: Заменить глобальный парсер на пропускающий диаг-пути**

Заменить строку `server.js:71` (`app.use(express.json());`) на:

```js
// Диаг-эндпоинты приносят свои парсеры: бандл до 512 КБ и echo-проба до 1 МБ
// не проходят под дефолтный 100-килобайтный лимит express.json(). Для всех
// остальных маршрутов поведение не меняется.
const globalJsonParser = express.json();
const DIAG_OWN_PARSER_PATHS = new Set(['/api/diag/report', '/api/diag/echo']);
app.use((req, res, next) => {
  if (DIAG_OWN_PARSER_PATHS.has(req.path)) return next();
  return globalJsonParser(req, res, next);
});
```

- [ ] **Step 2: Добавить импорты**

Рядом с остальными импортами роутеров (около `server.js:21`):

```js
import cron from 'node-cron';
import createDiagRouter from './src/diag/diagRoutes.js';
import { createDiagStore } from './src/diag/diagStore.js';
```

`node-cron` уже прямая зависимость (`package.json:17`) и статически импортируется в `src/auth/tokenRefreshScheduler.js:1`, поэтому статический импорт здесь безопасен. В самом `server.js` его пока нет.

- [ ] **Step 3: Создать стор и поднять схему**

Создание стора — рядом с остальными сторами, до блока `app.use('/api/...')`:

```js
const diagStore = createDiagStore({ pool, dbType });
```

Подъём схемы — **без `await`**, в блоке `ensureSchema` после `brandStore` (`server.js:1033`), ровно тем же стилем, что у соседей (`server.js:1019-1039` — fire-and-forget с `.then()/.catch()`; top-level `await` в этом файле не используется):

```js
diagStore.ensureSchema()
  .then(() => console.log('diag_report schema is ready'))
  .catch((error) => console.error('Failed to prepare diag_report schema', error));
```

- [ ] **Step 4: Смонтировать роутер двумя частями**

Рядом с прочими `app.use('/api/...')` (около `server.js:628`):

```js
// ping/echo — только verifyToken: attachAccessContext читает настройки из БД на
// каждом запросе (server.js:439), и тогда замер RTT мерил бы нашу БД, а не сеть.
const diagRouter = createDiagRouter({ store: diagStore });
app.use('/api/diag/ping', verifyToken, diagRouter);
app.use('/api/diag/echo', verifyToken, diagRouter);
app.use('/api/diag', verifyToken, attachAccessContext, diagRouter);
```

Проверить порядок: Express берёт первое совпадение, поэтому специфичные пути идут раньше общего `/api/diag`.

- [ ] **Step 5: Добавить крон-чистку ретеншена**

Рядом с существующими `cron.schedule` (образец — `src/auth/tokenRefreshScheduler.js:118`), раз в сутки в 03:30:

```js
if (String(process.env.SCHEDULER_ENABLED || 'true') !== 'false') {
  cron.schedule('30 3 * * *', async () => {
    try {
      const removed = await diagStore.deleteOlderThan(Number(process.env.DIAG_RETENTION_DAYS || 30));
      console.log(JSON.stringify({ event: 'diag_retention_cleanup', removed }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'diag_retention_failed', message: error.message }));
    }
  });
}
```

- [ ] **Step 6: Проверить, что сервер поднимается и все тесты зелёные**

Run: `cd backends/node/api && node --test tests/` — все существующие тесты (72 файла) плюс три новых должны проходить.
Expected: PASS, регрессий нет.

- [ ] **Step 6a: Интеграционный тест — обход глобального парсера реально работает**

Ревью Task 5 показало важное: тестовая обвязка роутера не повторяет реальное приложение (нет глобальных `cors()`/`express.json()`), поэтому 7 зелёных тестов **ничего не говорят** о поведении после монтирования. Обход парсера обязан быть доказан тестом, а не рассуждением.

Создать `backends/node/api/tests/diagParserBypass.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createDiagRouter from '../src/diag/diagRoutes.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Собирает приложение так же, как server.js: глобальные парсеры с обходом для
 * диаг-путей, затем роутер. Без этого 512 КБ и 1 МБ недостижимы — глобальный
 * express.json() с дефолтным потолком 100 КБ съест тело первым.
 */
const buildApp = () => {
  const app = express();
  const globalJsonParser = express.json();
  const DIAG_OWN_PARSER_PATHS = new Set(['/api/diag/report', '/api/diag/echo']);
  app.use((req, res, next) => {
    if (DIAG_OWN_PARSER_PATHS.has(req.path)) return next();
    return globalJsonParser(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.user = { user_id: 498 }; next(); });
  const store = {
    inserted: [],
    async insert(row) { this.inserted.push(row); return { id: 1, code: row.code, created_at: new Date() }; },
    async getByCode() { return null; },
    async list() { return []; }
  };
  app.use('/api/diag', createDiagRouter({ store, logger: silentLogger }));
  return { app, store };
};

const call = async (server, path, init) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
};

test('бандл на 300 КБ проходит сквозь глобальный парсер', async () => {
  const { app, store } = buildApp();
  const server = app.listen(0);
  try {
    const bundle = {
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: [],
      pad: 'x'.repeat(300 * 1024)
    };
    const body = JSON.stringify(bundle);
    assert.ok(body.length > 200 * 1024, `тело должно превышать дефолтный потолок 100 КБ, получено ${body.length}`);
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    // 300 КБ больше потолка бандла 256 КБ, поэтому ожидаем осмысленный отказ
    // санитизации, а НЕ 413 от глобального парсера.
    assert.notEqual(res.status, 413, 'глобальный парсер не должен перехватывать диаг-путь');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bundle_too_large');
  } finally { server.close(); }
});

test('бандл в пределах потолка сохраняется', async () => {
  const { app, store } = buildApp();
  const server = app.listen(0);
  try {
    const bundle = {
      v: 1, trigger: 'button', diagSessionId: 's',
      user: { userId: 498, azsId: '548', reportId: 1 },
      net: [], uploads: [], errors: [], b24: [],
      pad: 'x'.repeat(150 * 1024)
    };
    const body = JSON.stringify(bundle);
    assert.ok(body.length > 100 * 1024, 'тело должно превышать дефолтный потолок');
    const res = await call(server, '/api/diag/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    assert.equal(res.status, 200, `ожидался 200, получен ${res.status}`);
    assert.equal(store.inserted.length, 1);
  } finally { server.close(); }
});

test('echo получает сырые байты, а не разобранный JSON', async () => {
  const { app } = buildApp();
  const server = app.listen(0);
  try {
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.alloc(200 * 1024, 7)
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.bytes, 200 * 1024);
    assert.equal(res.json.buffered, true, 'echo обязан видеть Buffer, иначе замер врёт');
  } finally { server.close(); }
});

test('остальные маршруты по-прежнему разбираются глобальным парсером', async () => {
  const app = express();
  const globalJsonParser = express.json();
  const DIAG_OWN_PARSER_PATHS = new Set(['/api/diag/report', '/api/diag/echo']);
  app.use((req, res, next) => {
    if (DIAG_OWN_PARSER_PATHS.has(req.path)) return next();
    return globalJsonParser(req, res, next);
  });
  app.post('/api/other', (req, res) => res.json({ got: req.body?.a ?? null }));
  const server = app.listen(0);
  try {
    const res = await call(server, '/api/other', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 5 })
    });
    assert.equal(res.json.got, 5, 'обход не должен ломать обычные маршруты');
  } finally { server.close(); }
});
```

Run: `cd backends/node/api && node --test tests/diagParserBypass.test.js`
Expected: PASS, 4 теста. Если первый тест отдаёт 413 — обход не работает, и правка `server.js` из Step 1 сделана неверно.

- [ ] **Step 7: Проверить эндпоинты вручную**

Поднять окружение: `make dev-node`. Затем:

```bash
curl -i -X POST http://localhost:3000/api/diag/echo -H 'Content-Type: application/octet-stream' --data-binary @<(head -c 307200 /dev/urandom)
```

Expected: `401` без JWT (значит `verifyToken` навешен). С валидным JWT — `200 {"bytes":307200,...}`.

- [ ] **Step 8: Коммит**

```bash
git add backends/node/api/server.js
git commit -m "feat(DIAG): монтирование диаг-роутов, обход глобального json-лимита, ретеншен"
```

---

### Task 7: Фронт — коллектор и плагин сбора с холодного старта

**Files:**
- Create: `frontend/app/composables/diag/useDiagCollector.ts`
- Create: `frontend/app/plugins/00.diag.client.ts`

**Interfaces:**
- Consumes: `createRingBuffer` (Task 1), типы из `utils/diag/types.ts` (Task 2).
- Produces: `useDiagCollector()` → `{ diagSessionId, recordNet, recordError, recordUpload, recordB24, setQueueSnapshot, collectInput }`, где `collectInput(meta)` возвращает `Omit<BuildBundleInput, 'probe'>` (поле `probe` дозаполняет sender из Task 8). Заголовок `X-Diag-Session` уходит на все запросы к нашему origin.

> **`frontend/nuxt.config.ts` не трогаем ни в одной задаче этого плана.** В рабочем дереве у него есть незакоммиченные правки владельца (демо-режим: исключение модуля `b24jssdk-nuxt` и ключ `public.demo`). Правка того же блока `runtimeConfig.public` привела бы к коммиту чужой недоделанной работы. Поэтому поле `app.build` в этапе 1 всегда `'unknown'`, а `app.isDemo` всегда `false`. Когда демо-правки будут закоммичены, добавление ключа `appBuild: ''` и чтение `public.demo` — правка на две строки; занесено в ledger как отложенный minor.

- [ ] **Step 1: Реализовать коллектор**

`frontend/app/composables/diag/useDiagCollector.ts`:

```ts
import { createRingBuffer } from '~/utils/diag/ringBuffer'
import type {
  B24Entry, BuildBundleInput, DiagTrigger, ErrorEntry, NetEntry, QueueSnapshot, UploadEntry
} from '~/utils/diag/types'

const SESSION_KEY = 'diag_session_id'

const CAPS = { net: 150, errors: 50, uploads: 60, b24: 100 } as const

const netBuf = createRingBuffer<NetEntry>(CAPS.net)
const errorBuf = createRingBuffer<ErrorEntry>(CAPS.errors)
const uploadBuf = createRingBuffer<UploadEntry>(CAPS.uploads)
const b24Buf = createRingBuffer<B24Entry>(CAPS.b24)

let queueSnapshot: QueueSnapshot = { activeCount: 0, maxConcurrency: 0, workerSessionId: 0, slots: [] }
let sessionId = ''

const getOrCreateSessionId = (): string => {
  if (sessionId) return sessionId
  if (typeof window === 'undefined') return 'ssr'
  const stored = window.sessionStorage.getItem(SESSION_KEY)
  if (stored) { sessionId = stored; return sessionId }
  sessionId = crypto.randomUUID()
  window.sessionStorage.setItem(SESSION_KEY, sessionId)
  return sessionId
}

const readNetwork = (): BuildBundleInput['network'] => {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
  }
  const c = nav.connection
  return {
    onLine: Boolean(navigator.onLine),
    effectiveType: c?.effectiveType ?? null,
    downlink: typeof c?.downlink === 'number' ? c.downlink : null,
    rtt: typeof c?.rtt === 'number' ? c.rtt : null,
    saveData: typeof c?.saveData === 'boolean' ? c.saveData : null
  }
}

const readDevice = (): BuildBundleInput['device'] => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: navigator.userAgent,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    screen: { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0, dpr: window.devicePixelRatio ?? 1 },
    language: navigator.language || '',
    platform: navigator.platform || ''
  }
}

const readStartup = (): BuildBundleInput['startup'] => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const resources = performance.getEntriesByType('resource')
  return {
    navigationMs: nav ? Math.round(nav.duration) : null,
    ttfbMs: nav ? Math.round(nav.responseStart) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    resourceCount: resources.length
  }
}

export const useDiagCollector = () => ({
  diagSessionId: getOrCreateSessionId(),
  recordNet: (entry: NetEntry): void => { netBuf.push(entry) },
  recordError: (entry: ErrorEntry): void => { errorBuf.push(entry) },
  recordUpload: (entry: UploadEntry): void => { uploadBuf.push(entry) },
  recordB24: (entry: B24Entry): void => { b24Buf.push(entry) },
  setQueueSnapshot: (snapshot: QueueSnapshot): void => { queueSnapshot = snapshot },

  collectInput: (meta: {
    trigger: DiagTrigger
    app: BuildBundleInput['app']
    user: BuildBundleInput['user']
  }): Omit<BuildBundleInput, 'probe'> => ({
    diagSessionId: getOrCreateSessionId(),
    sentAt: new Date().toISOString(),
    trigger: meta.trigger,
    app: meta.app,
    user: meta.user,
    device: readDevice(),
    network: readNetwork(),
    startup: readStartup(),
    queue: queueSnapshot,
    uploads: uploadBuf.toArray(),
    net: netBuf.toArray(),
    errors: errorBuf.toArray(),
    b24: b24Buf.toArray(),
    dropped: { net: netBuf.dropped, errors: errorBuf.dropped, uploads: uploadBuf.dropped }
  })
})
```

- [ ] **Step 2: Реализовать плагин**

`frontend/app/plugins/00.diag.client.ts`:

```ts
/**
 * Диаг-рекордер. Ставится на буте, до инициализации фрейма и первых вызовов API.
 *
 * Что делает:
 *  1) оборачивает globalThis.fetch — все вызовы через $fetch (stores/api.ts:110
 *     создаёт клиент как $fetch.create, то есть ofetch поверх globalThis.fetch)
 *     попадают в буфер;
 *  2) добавляет заголовок X-Diag-Session на запросы к нашему origin — это точка
 *     сцепки для этапа 2, где к бандлу подклеивается серверная половина;
 *  3) подписывается на window.onerror и unhandledrejection — по B2 у нас до сих
 *     пор нет ни одного текста ошибки.
 *
 * Любой сбой рекордера гасится: диагностика не имеет права ломать сдачу отчёта.
 */
export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined') return

  const { diagSessionId, recordNet, recordError } = useDiagCollector()
  const originalFetch = globalThis.fetch.bind(globalThis)
  const appOrigin = window.location.origin

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAtMs = performance.now()
    const startedAt = new Date().toISOString()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()

    let patchedInit = init
    try {
      const isOwnOrigin = url.startsWith('/') || url.startsWith(appOrigin)
      if (isOwnOrigin) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('X-Diag-Session', diagSessionId)
        patchedInit = { ...init, headers }
      }
    } catch { /* заголовок не критичен — продолжаем без него */ }

    try {
      const response = await originalFetch(input, patchedInit)
      try {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => { headers[key] = value })
        recordNet({
          url, method, status: response.status, startedAt,
          durationMs: Math.round(performance.now() - startedAtMs),
          reqBytes: 0,
          resBytes: Number(response.headers.get('content-length') || 0),
          headers
        })
      } catch { /* запись в буфер не должна влиять на ответ */ }
      return response
    } catch (error) {
      try {
        recordNet({
          url, method, status: 0, startedAt,
          durationMs: Math.round(performance.now() - startedAtMs),
          reqBytes: 0, resBytes: 0,
          headers: { 'x-diag-network-error': String((error as Error)?.message || error) }
        })
      } catch { /* см. выше */ }
      throw error
    }
  }

  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      recordError({
        kind: 'onerror',
        message: String(event.message || ''),
        stack: event.error instanceof Error ? event.error.stack : undefined,
        source: String(event.filename || ''),
        line: Number(event.lineno || 0),
        col: Number(event.colno || 0),
        at: new Date().toISOString()
      })
    } catch { /* игнорируем */ }
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason
      recordError({
        kind: 'unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        source: '', line: 0, col: 0,
        at: new Date().toISOString()
      })
    } catch { /* игнорируем */ }
  })
})
```

- [ ] **Step 3: Проверить, что сборка проходит и старые тесты зелёные**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: lint без ошибок, 14 тестов проходят.

- [ ] **Step 4: Проверить сбор вживую**

Поднять `make dev-node`, открыть демо-режим приложения, в консоли браузера выполнить:

```js
await fetch('/api/diag/ping')
```

Затем в консоли проверить, что запрос попал в буфер: временно добавить `console.log(useDiagCollector().collectInput({ trigger: 'button', app: { build: 'dev', route: '/', isDemo: true }, user: { userId: 0, azsId: '', reportId: null, role: '' } }))`.
Expected: в `net` есть запись про `/api/diag/ping`; в `startup.navigationMs` число.

- [ ] **Step 5: Коммит**

```bash
git add frontend/app/composables/diag/useDiagCollector.ts frontend/app/plugins/00.diag.client.ts
git commit -m "feat(DIAG): коллектор и рекордер с холодного старта (fetch, ошибки, X-Diag-Session)"
```

---

### Task 8: Фронт — sender: пробы, троттлинг, ретрай через localStorage

**Files:**
- Create: `frontend/app/utils/diag/sendPolicy.ts`
- Create: `frontend/app/utils/diag/sendPolicy.test.ts`
- Create: `frontend/app/composables/diag/useDiagSender.ts`

**Interfaces:**
- Consumes: `buildBundle`, `MAX_BUNDLE_BYTES` (Task 2); `useDiagCollector` (Task 7); `useApiStore` (существующий, `stores/api.ts`).
- Produces: чистые `shouldSend(lastSentAtMs, nowMs)` → boolean и `trimPendingQueue(queue, maxItems)` → массив (обе в `sendPolicy.ts`); `useDiagSender()` → `{ send(trigger, meta), flushPending() }`, где `send` возвращает `{ ok: boolean; code: string | null }`.

- [ ] **Step 1: Написать падающий тест политики отправки**

`frontend/app/utils/diag/sendPolicy.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSend, trimPendingQueue, SEND_THROTTLE_MS, MAX_PENDING } from './sendPolicy.ts'

test('первая отправка разрешена', () => {
  assert.equal(shouldSend(null, 1_000_000), true)
})

test('повторная отправка внутри окна запрещена', () => {
  assert.equal(shouldSend(1_000_000, 1_000_000 + SEND_THROTTLE_MS - 1), false)
})

test('отправка ровно на границе окна разрешена', () => {
  assert.equal(shouldSend(1_000_000, 1_000_000 + SEND_THROTTLE_MS), true)
})

test('битая метка времени не блокирует отправку', () => {
  assert.equal(shouldSend(Number.NaN, 1_000_000), true)
})

test('очередь ретрая обрезается до предела, свежие сохраняются', () => {
  const queue = [1, 2, 3, 4, 5]
  const out = trimPendingQueue(queue, 3)
  assert.deepEqual(out, [3, 4, 5])
})

test('предел очереди по умолчанию — 3', () => {
  assert.equal(MAX_PENDING, 3)
})
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — `Cannot find module './sendPolicy.ts'`.

- [ ] **Step 3: Реализовать `sendPolicy.ts`**

```ts
export const SEND_THROTTLE_MS = 60_000
export const MAX_PENDING = 3

/**
 * Разрешать отправку не чаще одного раза в SEND_THROTTLE_MS.
 * Битая или отсутствующая метка времени трактуется как «раньше не отправляли»:
 * лучше отправить лишний бандл, чем потерять единственный.
 */
export function shouldSend(lastSentAtMs: number | null, nowMs: number): boolean {
  if (lastSentAtMs === null || !Number.isFinite(lastSentAtMs)) return true
  return nowMs - lastSentAtMs >= SEND_THROTTLE_MS
}

/** Оставить только последние maxItems элементов очереди ретрая. */
export function trimPendingQueue<T>(queue: T[], maxItems: number = MAX_PENDING): T[] {
  if (!Array.isArray(queue)) return []
  if (queue.length <= maxItems) return queue.slice()
  return queue.slice(queue.length - maxItems)
}
```

- [ ] **Step 4: Прогнать тесты — должны пройти**

Run: `cd frontend && npm run test:unit`
Expected: PASS, 20 тестов.

- [ ] **Step 5: Реализовать `useDiagSender.ts`**

```ts
import { buildBundle } from '~/utils/diag/buildBundle'
import { shouldSend, trimPendingQueue, MAX_PENDING } from '~/utils/diag/sendPolicy'
import type { BuildBundleInput, DiagBundle, DiagTrigger } from '~/utils/diag/types'

const LAST_SENT_KEY = 'diag_last_sent_at'
const PENDING_KEY = 'diag_pending'
/**
 * Размер пробы зависит от триггера.
 *
 * Автоотправка срабатывает в момент реального сбоя, когда канал уже занят
 * ретраями загрузки. 300 КБ на канале 40 кбит/с — это ещё ~60 с отдачи, то есть
 * диагностика ухудшала бы аварию, которую измеряет. 32 КБ дают ~5 с и всё так же
 * изолируют канал от Диска Битрикса.
 *
 * Кнопку жмут осознанно, обычно когда работа уже встала, — там полная проба
 * даёт более точный замер и мешать нечему.
 */
const ECHO_BYTES_BY_TRIGGER: Record<DiagTrigger, number> = {
  button: 307_200,
  auto_upload_error: 32_768
}
const PROBE_TIMEOUT_MS = 30_000
const PING_TIMEOUT_MS = 10_000
const PING_ATTEMPTS = 3

type SendMeta = { app: BuildBundleInput['app']; user: BuildBundleInput['user'] }

const readPending = (): DiagBundle[] => {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

const writePending = (queue: DiagBundle[]): void => {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(trimPendingQueue(queue, MAX_PENDING)))
  } catch { /* переполнен localStorage — не наша забота в этот момент */ }
}

export const useDiagSender = () => {
  const collector = useDiagCollector()
  const apiStore = useApiStore()
  const config = useRuntimeConfig()
  const apiUrl = String(config.public.apiUrl || '').replace(/\/$/, '')

  const authHeaders = (): Record<string, string> => {
    const jwt = apiStore.tokenJWT
    return jwt ? { Authorization: `Bearer ${jwt}` } : {}
  }

  /** Замер канала, изолированный от Диска Битрикса: echo принимает байты и сразу отвечает. */
  const probe = async (trigger: DiagTrigger): Promise<BuildBundleInput['probe']> => {
    const result: BuildBundleInput['probe'] = {
      echoBytes: null, echoMs: null, echoKbps: null, pingMsMedian: null, pingLoss: null
    }

    const echoBytes = ECHO_BYTES_BY_TRIGGER[trigger]

    try {
      const payload = new Uint8Array(echoBytes)
      crypto.getRandomValues(payload.subarray(0, Math.min(65_536, echoBytes)))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      const startedAt = performance.now()
      try {
        await fetch(`${apiUrl}/api/diag/echo`, {
          method: 'POST',
          body: payload,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() }
        })
        const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt))
        result.echoBytes = echoBytes
        result.echoMs = elapsedMs
        result.echoKbps = Math.round((echoBytes * 8) / elapsedMs)
      } finally { clearTimeout(timer) }
    } catch { /* канал мёртв — поля остаются null, это тоже сигнал */ }

    const samples: number[] = []
    let lost = 0
    for (let i = 0; i < PING_ATTEMPTS; i += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
      const startedAt = performance.now()
      try {
        await fetch(`${apiUrl}/api/diag/ping`, { signal: controller.signal, headers: authHeaders() })
        samples.push(performance.now() - startedAt)
      } catch { lost += 1 } finally { clearTimeout(timer) }
    }
    if (samples.length > 0) {
      const sorted = samples.slice().sort((a, b) => a - b)
      result.pingMsMedian = Math.round(sorted[Math.floor(sorted.length / 2)]!)
    }
    result.pingLoss = Math.round((lost / PING_ATTEMPTS) * 100)

    return result
  }

  const post = async (bundle: DiagBundle): Promise<string | null> => {
    const response = await $fetch<{ code: string }>(`${apiUrl}/api/diag/report`, {
      method: 'POST',
      body: bundle,
      headers: { 'Content-Type': 'application/json', ...authHeaders() }
    })
    return response?.code ?? null
  }

  const flushPending = async (): Promise<void> => {
    const queue = readPending()
    if (queue.length === 0) return
    const remaining: DiagBundle[] = []
    for (const bundle of queue) {
      try { await post(bundle) } catch { remaining.push(bundle) }
    }
    writePending(remaining)
  }

  const send = async (trigger: DiagTrigger, meta: SendMeta): Promise<{ ok: boolean; code: string | null }> => {
    try {
      const lastRaw = window.localStorage.getItem(LAST_SENT_KEY)
      const lastSentAtMs = lastRaw === null ? null : Number(lastRaw)
      if (!shouldSend(lastSentAtMs, Date.now())) return { ok: false, code: null }
      window.localStorage.setItem(LAST_SENT_KEY, String(Date.now()))

      const probeResult = await probe(trigger)
      const bundle = buildBundle({ ...collector.collectInput({ trigger, ...meta }), probe: probeResult })

      try {
        const code = await post(bundle)
        return { ok: true, code }
      } catch {
        writePending([...readPending(), bundle])
        return { ok: false, code: null }
      }
    } catch {
      return { ok: false, code: null }
    }
  }

  return { send, flushPending }
}
```

- [ ] **Step 6: Коммит**

```bash
git add frontend/app/utils/diag/sendPolicy.ts frontend/app/utils/diag/sendPolicy.test.ts frontend/app/composables/diag/useDiagSender.ts
git commit -m "feat(DIAG): отправка бандла — пробы канала, троттлинг, ретрай через localStorage"
```

---

### Task 9: Фронт — кнопка, автоотправка при сбое, экран ошибки

**Files:**
- Create: `frontend/app/components/diag/DiagButton.vue`
- Modify: `frontend/app/pages/admin/[reportId].client.vue` (запись исходов загрузки, снимок очереди, автоотправка, кнопка)
- Modify: `frontend/app/error.vue` (кнопка)

**Interfaces:**
- Consumes: `useDiagSender` (Task 8), `useDiagCollector` (Task 7), `useAppToast` (существующий).
- Produces: компонент `DiagButton` с пропсами `azsId?: string`, `reportId?: number | null`, `variant?: 'inline' | 'block'`.

- [ ] **Step 1: Создать `DiagButton.vue`**

```vue
<script setup lang="ts">
const props = withDefaults(defineProps<{
  azsId?: string
  reportId?: number | null
  role?: string
  variant?: 'inline' | 'block'
}>(), { azsId: '', reportId: null, role: '', variant: 'inline' })

const { send } = useDiagSender()
const toast = useAppToast()
const route = useRoute()
const userStore = useUserStore()
const busy = ref(false)

const onClick = async () => {
  if (busy.value) return
  busy.value = true
  try {
    const result = await send('button', {
      // build/isDemo — константы в этапе 1: nuxt.config.ts этот план не трогает
      // (см. врезку в Task 7), ключей appBuild и demo в закоммиченном конфиге нет.
      app: { build: 'unknown', route: String(route.fullPath || ''), isDemo: false },
      user: {
        // stores/user.ts держит id/login/isAdmin — полей userId и role там нет.
        userId: Number(userStore.id || 0),
        azsId: props.azsId,
        reportId: props.reportId,
        role: props.role
      }
    })
    if (result.ok && result.code) {
      toast.success(`Диагностика отправлена. Код: ${result.code}. Назовите его поддержке.`)
    } else {
      toast.info('Диагностика сохранена на устройстве и уйдёт, когда появится связь.')
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <B24Button
    color="air-secondary"
    :variant="props.variant === 'block' ? 'solid' : 'outline'"
    :loading="busy"
    label="Что-то не работает"
    @click="onClick"
  />
</template>
```

**Проверено:** `frontend/app/stores/user.ts:9-11` объявляет `id`, `login`, `isAdmin`. Полей `userId` и `role` в сторе **нет** — роль резолвится постранично (`getMyRole`), поэтому она приходит пропсом, а не из стора. Ключ `config.public.demo` существует (`nuxt.config.ts:39`), `appBuild` добавляется в Task 7 Step 0.

- [ ] **Step 2: Записывать исход каждой загрузки**

**Про `exifTakenAt`.** Спека (§3.3) закладывает в бандл время съёмки из EXIF, но на клиенте EXIF не разбирается: проверка свежести живёт на бэкенде (код `PHOTO_EXIF_TOO_OLD` в `src/reports/errorCodes.js`). Тащить парсер EXIF во фронт ради этого поля — выход за рамки минимального патча. Поэтому в этапе 1 поле остаётся `null`, а заполняется в этапе 2 из серверной половины бандла, где значение уже известно. Поле в схеме сохраняем, чтобы формат не менялся между этапами.

В `frontend/app/pages/admin/[reportId].client.vue`, в `runUploadTask` (около `:356`), добавить в начало функции после получения `slot`:

```ts
const diag = useDiagCollector()
const uploadStartedAtMs = performance.now()
const uploadStartedAt = new Date().toISOString()
```

В ветке успеха, сразу после `registerUploadSuccess()` (около `:404`):

```ts
diag.recordUpload({
  photoCode: slot.key,
  fileSize: task.file.size,
  fileType: task.file.type,
  exifTakenAt: null,
  startedAt: uploadStartedAt,
  durationMs: Math.round(performance.now() - uploadStartedAtMs),
  outcome: 'ok',
  httpStatus: 200,
  errorCode: null,
  retryable: null,
  attempt: task.id,
  message: ''
})
```

В ветке `catch`, сразу после `saveErrorDetail.value = errorDetail(error)` (около `:437`):

```ts
const httpStatus = Number((error as { statusCode?: number; status?: number })?.statusCode
  || (error as { status?: number })?.status || 0) || null
diag.recordUpload({
  photoCode: slot.key,
  fileSize: task.file.size,
  fileType: task.file.type,
  exifTakenAt: null,
  startedAt: uploadStartedAt,
  durationMs: Math.round(performance.now() - uploadStartedAtMs),
  outcome: 'error',
  httpStatus,
  errorCode: responseData?.errorCode ?? null,
  retryable,
  attempt: task.id,
  message: String(responseData?.message || responseData?.error || humanText)
})
diag.setQueueSnapshot({
  activeCount: uploadWorker.activeCount,
  maxConcurrency: uploadWorker.maxConcurrency,
  workerSessionId: uploadWorker.sessionId,
  slots: photoSlots.map((s) => ({
    key: s.key,
    confirmed: s.confirmed,
    uploadState: s.uploadState,
    uploaded: s.uploaded,
    fileSize: s.file?.size ?? 0,
    fileType: s.file?.type ?? '',
    error: s.error
  }))
})
void autoSendDiag()
```

- [ ] **Step 3: Добавить автоотправку в том же файле**

Рядом с прочими объявлениями функций страницы (после `runUploadTask`):

```ts
/**
 * Автоотправка диагностики при сбое загрузки. Даёт покрытие, не завися от того,
 * вспомнил ли оператор нажать кнопку на смене. Троттлинг живёт в sendPolicy,
 * поэтому пачка сбоев даёт одну отправку.
 */
const autoSendDiag = async (): Promise<void> => {
  try {
    const { send } = useDiagSender()
    await send('auto_upload_error', {
      app: { build: 'unknown', route: String(route.fullPath || ''), isDemo: false },
      user: {
        userId: Number(report.value?.adminUserId || 0),
        azsId: String(report.value?.azsId || ''),
        reportId: Number(route.params.reportId) || null,
        role: 'azs_admin'
      }
    })
  } catch { /* диагностика не имеет права ломать сдачу отчёта */ }
}
```

- [ ] **Step 4: Добавить кнопку на экран отчёта**

В шаблоне `[reportId].client.vue` блок ошибки сохранения начинается на строке **881** (`<div v-if="saveError" class="space-y-1">`) и заканчивается закрытием `</details>` после строки 889. Кнопку добавить **внутрь этого блока, после `</details>`** — тогда она появляется ровно там, где оператор видит ошибку:

```vue
      <DiagButton
        :azs-id="String(report?.azsId || '')"
        :report-id="Number(route.params.reportId) || null"
        role="azs_admin"
        variant="block"
      />
```

Дополнительно — кнопка при ошибках загрузки без `saveError`. Сразу после закрытия блока `v-if="saveError"`:

```vue
    <DiagButton
      v-if="!saveError && hasUploadErrors"
      :azs-id="String(report?.azsId || '')"
      :report-id="Number(route.params.reportId) || null"
      role="azs_admin"
      variant="block"
    />
```

- [ ] **Step 5: Добавить кнопку на экран ошибки**

В `frontend/app/error.vue`, в блок с кнопкой «Обновить» (`:50-57`), после `B24Button`:

```vue
<DiagButton variant="block" />
```

- [ ] **Step 6: Проверить сборку и линт**

Run: `cd frontend && npm run lint && npm run test:unit && npm run build`
Expected: без ошибок, 20 тестов проходят, сборка успешна.

- [ ] **Step 7: Коммит**

```bash
git add frontend/app/components/diag/DiagButton.vue "frontend/app/pages/admin/[reportId].client.vue" frontend/app/error.vue
git commit -m "feat(DIAG): кнопка «Что-то не работает», автоотправка при сбое, кнопка на экране ошибки"
```

---

### Task 10: Удалить мёртвую телеметрию и прогнать сценарии на устройстве

**Files:**
- Delete: `frontend/app/composables/useTelemetry.ts`
- Delete: `frontend/app/plugins/telemetry.client.ts`
- Modify: `docs/superpowers/specs/2026-07-30-diag-bundle-design.md` (§6.2 — тест-раннер во фронтенде появился)

**Interfaces:**
- Consumes: ничего.
- Produces: ничего. Задача снимает мёртвый код и фиксирует результат проверки.

**Обоснование удаления.** `useTelemetry` шлёт на `POST /api/telemetry/event`, которого в Node-бэкенде нет; `TELEMETRY_ENABLED=false`; вызовов `track()` нет ни на одной странице. Оба файла используют свой `X-Session-ID` — держать рядом второй механизм с пересекающимся идентификатором сессии значит запутаться при разборе инцидента.

- [ ] **Step 1: Убедиться, что потребителей нет**

Run: `cd frontend && grep -rn "useTelemetry\|telemetry" app/ --include='*.ts' --include='*.vue' | grep -v 'app/composables/useTelemetry.ts' | grep -v 'app/plugins/telemetry.client.ts'`
Expected: пусто. Если что-то найдено — сначала убрать потребителя, потом удалять файлы.

- [ ] **Step 2: Удалить файлы**

```bash
git rm frontend/app/composables/useTelemetry.ts frontend/app/plugins/telemetry.client.ts
```

- [ ] **Step 3: Проверить, что сборка и тесты целы**

Run: `cd frontend && npm run lint && npm run test:unit && npm run build`
Expected: без ошибок.

- [ ] **Step 4: Обновить §6.2 спеки**

В `docs/superpowers/specs/2026-07-30-diag-bundle-design.md` заменить утверждение «Во фронтенде нет тест-раннера» на факт: `node --test "app/utils/diag/**/*.test.ts"` работает на Node 25 без новых зависимостей (strip-only режим, только erasable-синтаксис); чистые утилиты покрыты тестами, а Vue-компоненты и плагин по-прежнему проверяются вручную.

- [ ] **Step 5: Прогнать сценарии на реальном Android в мобильном Битрикс24**

Отметить каждый:

- [ ] **Медленный канал.** Throttling Slow 3G → снять фото → загрузка падает → в `diag_report` есть запись с `trigger='auto_upload_error'`, `probe.echoKbps` < 100.
- [ ] **Наш бэкенд лежит.** Остановить контейнер → нажать кнопку → тост «сохранена на устройстве»; после подъёма бэкенда и перезахода бандл уехал (`flushPending`).
- [ ] **Экран ошибки.** Довести до `error.vue` → кнопка видна, отправка работает, в бандле есть запись в `errors` (кейс B2).
- [ ] **Приватность.** В сохранённом бандле нет байтов фото, нет GPS; все `authorization`/`cookie` равны `'***'`.
- [ ] **Троттлинг.** Три сбоя подряд в пределах минуты → ровно одна запись в `diag_report`.
- [ ] **Основной сценарий не сломан.** При рабочей сети отчёт сдаётся как раньше, кнопка «Сдать» активируется, лишних задержек нет.
- [ ] **iOS (если есть устройство).** Поля `network.*` пусты, бандл собирается и уезжает без ошибок.

- [ ] **Step 6: Коммит**

**Только явные пути.** `git add -A` и `git add .` запрещены во всех задачах этого плана: в рабочем дереве лежат незакоммиченные правки владельца (`docs/code-review-log.md`, `frontend/nuxt.config.ts`, `frontend/app/pages/reason/[reportId].client.vue`, два файла планов). Массовый стейджинг подметёт их в чужой коммит.

```bash
git add docs/superpowers/specs/2026-07-30-diag-bundle-design.md
git commit -m "chore(DIAG): удалить мёртвую телеметрию, зафиксировать результаты прогона на устройстве"
```

Удаление файлов уже застейджено через `git rm` в Step 2.

---

### Task 11: Серверный срез — состояние OAuth, живая проба Диска, пинг БД

**Files:**
- Create: `backends/node/api/src/diag/serverSelfCheck.js`
- Create: `backends/node/api/tests/diagServerSelfCheck.test.js`
- Modify: `backends/node/api/server.js` (создать срез и передать в роутер)

**Interfaces:**
- Consumes: `redactText` из `./sanitizeBundle.js` (Task 4); `authContextStore`, `bitrixClient`, `pool`, `dbType` из `server.js`; шов `serverSelfCheck` в `createDiagRouter` (Task 5).
- Produces: `createServerSelfCheck({ authContextStore, bitrixClient, pool, logger, now })` → `{ run(): Promise<object> }`.

**Зачем это в этапе 1.** Без серверной половины бандл говорит «загрузка упала, канал у оператора был в порядке», но не говорит, что именно сломалось у нас. Главный подозреваемый — OAuth (`wrong_client`, план ремедиации §0), и живая проба Диска показывает это прямо: при сломанном токене она вернёт код ошибки, который попадёт в бандл. Это превращает вердикт из «что-то у нас» в «вот что у нас».

**Три требования, которые нельзя нарушать.** Срез не имеет права бросать исключение — приём бандла важнее. Каждая проба ограничена по времени, иначе зависший Диск задержит запрос оператора. И в срез не попадают значения токенов — только факт наличия и длина.

- [ ] **Step 1: Написать падающий тест**

`backends/node/api/tests/diagServerSelfCheck.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSelfCheck } from '../src/diag/serverSelfCheck.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const FIXED_NOW = 1_784_000_000_000;

const makeDeps = (over = {}) => ({
  authContextStore: {
    async getLastAdmin() {
      return {
        key: 'portal:1',
        payload: JSON.stringify({ domain: 'x.bitrix24.ru', memberId: 'm1', authId: 'SECRETAUTH', refreshToken: 'SECRETREFRESH' }),
        updated_at: new Date(FIXED_NOW - 60_000).toISOString()
      };
    }
  },
  bitrixClient: { isConfigured: true, async callMethod() { return { result: [] }; } },
  pool: { async query() { return { rows: [{ ok: 1 }] }; } },
  logger: silentLogger,
  now: () => FIXED_NOW,
  ...over
});

test('здоровый случай: все пробы ок', async () => {
  const check = createServerSelfCheck(makeDeps());
  const out = await check.run();
  assert.equal(out.oauth.hasContext, true);
  assert.equal(out.oauth.domain, 'x.bitrix24.ru');
  assert.equal(out.oauth.ageSec, 60);
  assert.equal(out.disk.ok, true);
  assert.equal(typeof out.disk.ms, 'number');
  assert.equal(out.db.ok, true);
  assert.equal(typeof out.checkedAt, 'string');
});

test('значения токенов в срез не попадают', async () => {
  const check = createServerSelfCheck(makeDeps());
  const serialized = JSON.stringify(await check.run());
  assert.ok(!serialized.includes('SECRETAUTH'), serialized);
  assert.ok(!serialized.includes('SECRETREFRESH'), serialized);
  assert.equal((await check.run()).oauth.hasAuthId, true);
});

test('wrong_client из Диска попадает в срез кодом', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() { throw new Error('Bitrix error: wrong_client — invalid client secret'); }
    }
  }));
  const out = await check.run();
  assert.equal(out.disk.ok, false);
  assert.equal(out.disk.errorCode, 'wrong_client');
});

test('секрет в тексте ошибки Диска чистится', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() { throw new Error('failed: client_secret=LEAKVALUE'); }
    }
  }));
  const out = await check.run();
  assert.ok(!JSON.stringify(out).includes('LEAKVALUE'), JSON.stringify(out));
});

test('зависший Диск не держит срез дольше таймаута', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: { isConfigured: true, callMethod: () => new Promise(() => {}) },
    diskTimeoutMs: 40
  }));
  const startedAt = Date.now();
  const out = await check.run();
  assert.ok(Date.now() - startedAt < 2000, 'срез должен вернуться быстро');
  assert.equal(out.disk.ok, false);
  assert.match(String(out.disk.errorMessage), /timeout/);
});

test('падение хранилища контекста не роняет срез', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { async getLastAdmin() { throw new Error('db down'); } }
  }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, false);
  assert.equal(out.db.ok, true);
});

test('битый payload не роняет срез', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { async getLastAdmin() { return { payload: 'не json', updated_at: null }; } }
  }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, true);
  assert.equal(out.oauth.domain, null);
});

test('run никогда не бросает, даже если сломано всё', async () => {
  const check = createServerSelfCheck({
    authContextStore: null, bitrixClient: null, pool: null, logger: silentLogger, now: () => FIXED_NOW
  });
  const out = await check.run();
  assert.equal(out.oauth.hasContext, false);
  assert.equal(out.disk.ok, false);
  assert.equal(out.db.ok, false);
});
```

- [ ] **Step 2: Прогнать — должно падать**

Run: `cd backends/node/api && node --test tests/diagServerSelfCheck.test.js`
Expected: FAIL — `Cannot find module '../src/diag/serverSelfCheck.js'`.

- [ ] **Step 3: Реализовать `serverSelfCheck.js`**

```js
import { redactText } from './sanitizeBundle.js';

const DISK_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 2_000;
const MAX_ERROR_CHARS = 300;

// Коды, по которым сразу понятно, что сломалось на нашей стороне интеграции.
const KNOWN_ERROR_CODES = [
  'wrong_client', 'invalid_grant', 'invalid_token', 'expired_token',
  'NO_AUTH_FOUND', 'ACCESS_DENIED', 'insufficient_scope', 'QUERY_LIMIT_EXCEEDED'
];

const extractErrorCode = (message) => {
  const text = String(message || '');
  for (const code of KNOWN_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(text)) return code;
  }
  return null;
};

const cleanError = (error) => {
  const raw = String(error?.message || error || '');
  return redactText(raw).slice(0, MAX_ERROR_CHARS);
};

/**
 * Ограничивает пробу по времени. Зависший Диск не должен задерживать запрос
 * оператора: таймер unref'ится, чтобы не держать процесс живым.
 */
const withTimeout = async (factory, ms, label) => {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * serverSelfCheck — серверная половина диагностической картины.
 *
 * Клиент не видит состояние нашего OAuth-токена и ответ Диска Битрикса, а без
 * них нельзя отличить «сломался наш код» от «сломалась интеграция». Живая проба
 * Диска при сломанном токене вернёт wrong_client — это и есть искомый сигнал.
 *
 * Контракт: run() никогда не бросает, каждая проба ограничена по времени,
 * значения токенов в результат не попадают — только факт наличия и длина.
 */
export const createServerSelfCheck = ({
  authContextStore,
  bitrixClient,
  pool,
  logger = console,
  now = () => Date.now(),
  diskTimeoutMs = DISK_TIMEOUT_MS,
  dbTimeoutMs = DB_TIMEOUT_MS
}) => {
  const probeOauth = async () => {
    const empty = {
      hasContext: false, domain: null, memberId: null, updatedAt: null, ageSec: null,
      hasAuthId: false, hasRefreshToken: false, authIdLength: 0, refreshTokenLength: 0,
      clientConfigured: Boolean(bitrixClient?.isConfigured)
    };
    try {
      const row = await authContextStore?.getLastAdmin?.();
      if (!row) return empty;

      let payload = {};
      try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      } catch {
        payload = {};
      }

      const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
      const ageSec = updatedAt && !Number.isNaN(updatedAt.getTime())
        ? Math.round((now() - updatedAt.getTime()) / 1000)
        : null;

      const authId = String(payload.authId || payload.auth_id || '');
      const refreshToken = String(payload.refreshToken || payload.refresh_token || '');

      return {
        hasContext: true,
        domain: payload.domain ? String(payload.domain) : null,
        memberId: payload.memberId || payload.member_id ? String(payload.memberId || payload.member_id) : null,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : null,
        ageSec,
        // Только факт и длина: сами значения — секреты.
        hasAuthId: authId.length > 0,
        hasRefreshToken: refreshToken.length > 0,
        authIdLength: authId.length,
        refreshTokenLength: refreshToken.length,
        clientConfigured: Boolean(bitrixClient?.isConfigured)
      };
    } catch (error) {
      logger.warn('diag_selfcheck_oauth_failed', { message: cleanError(error) });
      return empty;
    }
  };

  const probeDisk = async () => {
    const startedAt = now();
    try {
      if (!bitrixClient?.callMethod) {
        return { ok: false, ms: 0, errorCode: null, errorMessage: 'bitrix_client_unavailable' };
      }
      await withTimeout(() => bitrixClient.callMethod('disk.storage.getlist', {}, {}), diskTimeoutMs, 'disk');
      return { ok: true, ms: now() - startedAt, errorCode: null, errorMessage: null };
    } catch (error) {
      const errorMessage = cleanError(error);
      return { ok: false, ms: now() - startedAt, errorCode: extractErrorCode(errorMessage), errorMessage };
    }
  };

  const probeDb = async () => {
    const startedAt = now();
    try {
      if (!pool?.query) return { ok: false, ms: 0, errorMessage: 'pool_unavailable' };
      await withTimeout(() => pool.query('SELECT 1'), dbTimeoutMs, 'db');
      return { ok: true, ms: now() - startedAt, errorMessage: null };
    } catch (error) {
      return { ok: false, ms: now() - startedAt, errorMessage: cleanError(error) };
    }
  };

  return {
    async run() {
      const [oauth, disk, db] = await Promise.all([probeOauth(), probeDisk(), probeDb()]);
      return {
        checkedAt: new Date(now()).toISOString(),
        app: {
          botMode: String(process.env.BITRIX_BOT_MODE || ''),
          nodeEnv: String(process.env.NODE_ENV || ''),
          schedulerEnabled: String(process.env.SCHEDULER_ENABLED || 'true') !== 'false'
        },
        oauth,
        disk,
        db
      };
    }
  };
};

export default createServerSelfCheck;
```

- [ ] **Step 4: Прогнать тесты — должны пройти**

Run: `cd backends/node/api && node --test tests/diagServerSelfCheck.test.js`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Подключить в `server.js`**

Импорт рядом с прочими диаг-импортами:

```js
import { createServerSelfCheck } from './src/diag/serverSelfCheck.js';
```

Создание — рядом с `diagStore`:

```js
const diagSelfCheck = createServerSelfCheck({ authContextStore, bitrixClient, pool });
```

И передать в роутер, заменив строку создания `diagRouter` из Task 6:

```js
const diagRouter = createDiagRouter({ store: diagStore, serverSelfCheck: diagSelfCheck });
```

- [ ] **Step 6: Прогнать весь бэкендный набор**

Run: `cd backends/node/api && node --test tests/`
Expected: PASS, регрессий нет.

- [ ] **Step 7: Коммит**

```bash
git add backends/node/api/src/diag/serverSelfCheck.js backends/node/api/tests/diagServerSelfCheck.test.js backends/node/api/server.js
git commit -m "feat(DIAG): серверный срез — состояние OAuth, живая проба Диска, пинг БД"
```

---

### Task 12: Тест паритета клиентской и серверной редакции

**Files:**
- Create: `backends/node/api/tests/diagRedactionParity.test.js`

**Interfaces:**
- Consumes: `redactText` из `frontend/app/utils/diag/redact.ts` (Task 1–2) и `redactText` из `backends/node/api/src/diag/sanitizeBundle.js` (Task 4). Никакого нового кода не производит.

**Зачем.** Логика редакции секретов намеренно продублирована: frontend и backend — разные npm-пакеты без общего модуля, а серверная чистка не должна зависеть от клиента (см. врезку в Task 4). Плата за это — расхождение, и оно уже случалось **дважды**: сначала в бриф Task 4 попал словарь без `errors`/`uploads`, потом — словарь раунда 2 без раундов 3–4, из-за чего серверный слой утекал `REFRESH_ID` и `Authorization: Bearer`, то есть был слабее того слоя, который подстраховывает.

Ловить это глазами не работает. Этот тест делает расхождение падающим тестом.

**Технически это возможно** потому, что Node 25 исполняет TypeScript нативно (strip-only), и бэкендный тест может импортировать клиентский `.ts` по относительному пути. Проверено: `import('../../../frontend/app/utils/diag/redact.ts')` отдаёт `REDACTED, redactHeaders, redactText, redactUrl`.

- [ ] **Step 1: Написать тест**

`backends/node/api/tests/diagRedactionParity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText as serverRedactText } from '../src/diag/sanitizeBundle.js';
import { redactText as clientRedactText } from '../../../frontend/app/utils/diag/redact.ts';

/**
 * Общий корпус. Каждая строка — форма, которая реально встречалась в этом
 * проекте либо была найдена ревью как утечка. Дополняйте корпус, а не
 * ослабляйте проверку.
 */
const CORPUS = [
  // формы, найденные ревью как утечки
  'client_secret=LEAKME', 'client-secret=LEAKME', 'password=LEAKME', 'passwd=LEAKME',
  'auth_id=LEAKME', 'authid=LEAKME', 'REFRESH_ID=LEAKME', 'refresh_id: LEAKME',
  'api-key=LEAKME', 'apikey=LEAKME', 'api_key=LEAKME',
  'private_token=LEAKME', 'bot_token=LEAKME',
  'session=LEAKME', 'session-id=LEAKME', 'sessid=LEAKME', 'Cookie: connect.sid=LEAKME',
  'secret=LEAKME', 'pwd=LEAKME', 'id_token=LEAKME', 'authorization=LEAKME',
  // схемы авторизации
  'at fetch (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.LEAKME)',
  'headers: {authorization: Bearer LEAKMEJWT}',
  'Bearer eyJhbGciOiJIUzI1NiJ9.LEAKME',
  'basic YWRtaW46LEAKME',
  // частичная маскировка
  'token=abc123,LEAKME', 'token=abc123;LEAKME',
  // реальные поля установки приложения
  'postInstall failed: {AUTH_ID: LEAKME, REFRESH_ID: LEAKME}',
  // JSON-форма
  '{"access_token":"LEAKME","azsId":"548"}',
  // то, что искажать нельзя
  'POST /api/reports?token=SECRETV&azsId=548 failed 502',
  'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)',
  'refresh token истёк',
  'Ошибка авторизации',
  ''
];

test('клиент и сервер чистят текст одинаково', () => {
  const divergent = [];
  for (const input of CORPUS) {
    const client = clientRedactText(input);
    const server = serverRedactText(input);
    if (client !== server) {
      divergent.push(`  вход:   ${JSON.stringify(input)}\n  клиент: ${JSON.stringify(client)}\n  сервер: ${JSON.stringify(server)}`);
    }
  }
  assert.equal(
    divergent.length, 0,
    `Редакция разошлась между слоями (${divergent.length} из ${CORPUS.length}):\n${divergent.join('\n')}`
  );
});

test('ни один слой не пропускает секрет из корпуса', () => {
  const leaks = [];
  for (const input of CORPUS) {
    if (!input.includes('LEAKME')) continue;
    for (const [layer, fn] of [['клиент', clientRedactText], ['сервер', serverRedactText]]) {
      const out = fn(input);
      if (out.includes('LEAKME')) leaks.push(`  ${layer}: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
  }
  assert.equal(leaks.length, 0, `Утечки:\n${leaks.join('\n')}`);
});

test('оба слоя сохраняют диагностически полезный контекст', () => {
  for (const fn of [clientRedactText, serverRedactText]) {
    const out = fn('POST /api/reports?token=SECRETV&azsId=548 failed 502');
    assert.ok(!out.includes('SECRETV'), out);
    assert.ok(out.includes('azsId=548'), out);
    assert.ok(out.includes('502'), out);
    assert.ok(out.includes('/api/reports'), out);
  }
});

test('оба слоя не искажают безобидную прозу', () => {
  for (const fn of [clientRedactText, serverRedactText]) {
    for (const msg of [
      'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)',
      'refresh token истёк',
      'Ошибка авторизации'
    ]) {
      assert.equal(fn(msg), msg);
    }
  }
});
```

- [ ] **Step 2: Прогнать — должно пройти сразу**

Run: `cd backends/node/api && node --test tests/diagRedactionParity.test.js`
Expected: PASS, 4 теста. Если паритет нарушен, тест печатает построчное расхождение — приводите **серверный** слой к клиентскому, он прошёл больше раундов ревью.

- [ ] **Step 3: Прогнать весь набор**

Run: `node --test "tests/**/*.test.js"`
Expected: без падений.

- [ ] **Step 4: Коммит**

```bash
git add backends/node/api/tests/diagRedactionParity.test.js
git commit -m "test(DIAG): паритет клиентской и серверной редакции секретов"
```

---

## Порядок и зависимости

```
Task 1 (утилиты) ──► Task 2 (buildBundle) ──► Task 8 (sender) ──► Task 9 (кнопка/автоотправка) ──► Task 10 (чистка + прогон)
                                                    ▲
Task 3 (стор) ──► Task 4 (санитизация) ──► Task 5 (роуты) ──► Task 6 (wiring) ─────┘
                                                                        ▲
                                              Task 7 (коллектор/плагин) ┘
```

Бэкенд (Task 3–6) и фронтовые утилиты (Task 1–2) независимы и могут идти параллельно. Task 7 зависит только от Task 1–2. Task 8 требует и Task 7, и работающего Task 6 (для проб). Task 9 — последний код, Task 10 — чистка и приёмка.

**Task 12 (тест паритета редакции)** идёт сразу после Task 4 — он фиксирует то, что уже дважды разъезжалось, и дальше держит оба слоя вместе.

**Task 11 (серверный срез)** идёт после Task 6: он использует `redactText` из Task 4 и шов `serverSelfCheck`, заложенный в Task 5. Колонка `server_slice` создаётся сразу в Task 3, поэтому миграция не нужна. До реализации Task 11 роутер работает с `serverSelfCheck === null` и просто пишет `NULL` в колонку — то есть Tasks 3–6 остаются самодостаточными и деплоятся без Task 11.
