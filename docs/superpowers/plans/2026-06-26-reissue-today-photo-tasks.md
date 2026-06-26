# «Перевыпустить задания на сегодня» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать админу одну кнопку «Перевыпустить задания на сегодня»: снять все несданные сегодняшние задания (по всем АЗС), уведомить затронутых сотрудников бота об отмене и пересоздать план на сегодня по расписанию из настроек.

**Architecture:** Новый терминальный статус `dispatch_log.status='cancelled'` (мягкая отмена, не удаление). Чистая оркестрация в `reissueTodayService` (тестируется на стабах). Тонкий роут `POST /api/reports/today/reissue` (dry-run + выполнение) переиспользует существующие `loadEnabledAzsCandidates`, `generateDailyPlan`, `notificationService.notify`. Кнопка + модалка-подтверждение на дашборде проверяющего рядом с расписанием.

**Tech Stack:** Node 20 + Express (ESM), PostgreSQL/MySQL (двухдиалектный стор), Nuxt 3 + Vue 3 + Bitrix24 UI Kit (`B24*`), тесты — `node:test` + `node:assert/strict`.

**Спека:** [docs/superpowers/specs/2026-06-26-reissue-today-photo-tasks-design.md](../specs/2026-06-26-reissue-today-photo-tasks-design.md)

---

## Соглашения и предусловия

- **Рабочая папка бэкенда:** `backends/node/api`. Тесты: `node --test tests/<file>.test.js` (в `package.json` скрипта `test` нет; гонять напрямую). `"type":"module"` → ESM-импорты.
- **Ветка:** работать в отдельной feature-ветке. **НЕ пушить в `master`** — push в master = автодеплой прода (см. bug-backlog workflow). Коммитить по задаче; пуш/мерж — по согласованию с продактом.
- **Двухдиалектный стор:** `reportsStore.js` и `dispatchPlanStore.js` имеют ДВЕ фабрики — `createPostgresStore` / `createMysqlStore`. Любой новый метод стора добавляем в ОБЕ.
- **Статусы `dispatch_log`:** `reserved`, `new`, `in_progress`, `done`, `expired`, `failed` (+ новый `cancelled`). `done` = сдан. Статус — `TEXT`, без enum → DDL менять НЕ нужно.

## Карта файлов

| Файл | Что делаем |
|------|-----------|
| `backends/node/api/src/reports/reportsStore.js` | +3 метода (`listNotSubmittedForDate`, `cancelNotSubmittedForDate`, `listSubmittedAzsForDate`) в обе фабрики; сделать `cancelled` инертным в `getSummary`/`listOverdueReports`/`getActiveReportForAzsOnDate` |
| `backends/node/api/src/reports/reissueTodayService.js` | **создать** — чистая оркестрация |
| `backends/node/api/src/reports/reportsRoutes.js` | +роут `POST /today/reissue`; импорт сервиса |
| `backends/node/api/tests/reportsStoreReissue.test.js` | **создать** — fake-pool тесты новых методов |
| `backends/node/api/tests/reissueTodayService.test.js` | **создать** — тесты оркестрации на стабах |
| `backends/node/api/tests/reissueTodayRoute.test.js` | **создать** — тест роута (гард + dry-run) |
| `frontend/app/stores/api.ts` | +метод `reissueTodayTasks` |
| `frontend/app/pages/reviewer.client.vue` | +кнопка, модалка, обработчик, тост |
| `docs/CHANGELOG.md` | запись о фиче |

---

## Task 1: Сделать статус `cancelled` инертным (KPI/таймаут/напоминания)

Чтобы снятые (`cancelled`) задания не считались просроченными, не «оживлялись» timeoutWatcher'ом и не триггерили напоминания.

**Files:**
- Modify: `backends/node/api/src/reports/reportsStore.js` (строки 240, 293 — PG; 655, 707 — MySQL; `getActiveReportForAzsOnDate` PG ~445 и MySQL ~860)

- [ ] **Step 1: PG — `listOverdueReports` overdue-предикат (≈строка 240)**

Заменить:
```js
         AND status NOT IN ('done', 'expired')
```
на:
```js
         AND status NOT IN ('done', 'expired', 'cancelled')
```

- [ ] **Step 2: PG — `getSummary` overdue-предикат (≈строка 293)**

Заменить `` `deadline_at < $${idx}`, `status NOT IN ('done', 'expired')` `` так, чтобы предикат стал `status NOT IN ('done', 'expired', 'cancelled')`:
```js
    const overdueWhere = [...where, `deadline_at IS NOT NULL`, `deadline_at < $${idx}`, `status NOT IN ('done', 'expired', 'cancelled')`];
```

- [ ] **Step 3: MySQL — те же два предиката (≈строки 655 и 707)**

Строка ≈655:
```js
         AND status NOT IN ('done', 'expired', 'cancelled')
```
Строка ≈707:
```js
    const overdueWhere = [...where, 'deadline_at IS NOT NULL', 'deadline_at < ?', "status NOT IN ('done', 'expired', 'cancelled')"];
```

- [ ] **Step 4: `getActiveReportForAzsOnDate` — не считать `cancelled` активным (PG ≈445 и MySQL ≈860)**

В обоих диалектах в `WHERE` после строки с `slot_key NOT LIKE ...` добавить `AND status <> 'cancelled'`. PG-версия становится:
```js
       WHERE azs_id = $1
         AND (slot_key LIKE $2 OR slot_key LIKE $3)
         AND slot_key NOT LIKE $4
         AND status <> 'cancelled'
```
MySQL — аналогично с `?`.

- [ ] **Step 5: Тест — `getActiveReportForAzsOnDate` возвращает null, если живых строк нет (только cancelled)**

Добавить в новый файл `tests/reportsStoreReissue.test.js` (полный каркас fake-pool ниже, в Task 2 Step 1) тест-кейс:
```js
test('getActiveReportForAzsOnDate: только cancelled → null', async () => {
  const pool = createFakePgPool([
    { slot_key: '2026-06-26:0900', azs_id: '101', admin_user_id: 11, status: 'cancelled', deadline_at: null },
  ]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const r = await store.getActiveReportForAzsOnDate({ azsId: '101', planDate: '2026-06-26' });
  assert.equal(r, null);
});
```
*(Этот кейс зависит от fake-pool из Task 2; гонять после Task 2 Step 1. Предикаты overdue из Step 1–3 — DB-bound, проверяются ручным смоуком в Task 8 Step 3.)*

- [ ] **Step 6: Commit**
```bash
git add backends/node/api/src/reports/reportsStore.js
git commit -m "feat(reports): make 'cancelled' status inert in summary/overdue/active queries"
```

---

## Task 2: Новые методы стора (оба диалекта)

**Files:**
- Modify: `backends/node/api/src/reports/reportsStore.js` (добавить методы в объект, возвращаемый из `createPostgresStore` И `createMysqlStore` — рядом с `setReportStatus`)
- Create: `backends/node/api/tests/reportsStoreReissue.test.js`

- [ ] **Step 1: Написать падающий тест (fake-pool)**

`tests/reportsStoreReissue.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsStore } from '../src/reports/reportsStore.js';

// LIKE c '%'-вайлдкардами → RegExp
const like = (val, pattern) =>
  new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$')
    .test(String(val ?? ''));

export const createFakePgPool = (seed = []) => {
  const rows = seed.map((r, i) => ({ id: i + 1, report_item_id: null, deadline_at: null, ...r }));
  const matchDay = (r, p1, p2, p3) => (like(r.slot_key, p1) || like(r.slot_key, p2)) && !like(r.slot_key, p3);
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const [p1, p2, p3] = params;
      if (text.startsWith('SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log')) {
        return { rows: rows.filter((r) => matchDay(r, p1, p2, p3) && !['done', 'cancelled'].includes(r.status)) };
      }
      if (text.startsWith("UPDATE dispatch_log SET status='cancelled'")) {
        let n = 0;
        for (const r of rows) if (matchDay(r, p1, p2, p3) && !['done', 'cancelled'].includes(r.status)) { r.status = 'cancelled'; n += 1; }
        return { rowCount: n };
      }
      if (text.startsWith('SELECT DISTINCT azs_id FROM dispatch_log')) {
        const set = [...new Set(rows.filter((r) => matchDay(r, p1, p2, p3) && r.status === 'done').map((r) => r.azs_id))];
        return { rows: set.map((azs_id) => ({ azs_id })) };
      }
      // getActiveReportForAzsOnDate (Task 1 Step 5): SELECT * ... WHERE azs_id=$1 ...
      if (text.startsWith('SELECT * FROM dispatch_log')) {
        const live = rows.filter((r) => String(r.azs_id) === String(params[0])
          && (like(r.slot_key, params[1]) || like(r.slot_key, params[2]))
          && !like(r.slot_key, params[3]) && r.status !== 'cancelled');
        return { rows: live.length ? [live[0]] : [] };
      }
      throw new Error('unexpected SQL: ' + text);
    },
  };
};

const SEED = [
  { slot_key: '2026-06-26:0900', azs_id: '101', admin_user_id: 11, status: 'new' },
  { slot_key: '2026-06-26:1400', azs_id: '102', admin_user_id: 12, status: 'reserved' },
  { slot_key: '2026-06-26:0900', azs_id: '103', admin_user_id: 13, status: 'done' },
  { slot_key: 'manual:2026-06-26:1600', azs_id: '104', admin_user_id: 14, status: 'expired' },
  { slot_key: '2026-06-26:0900:reminder:1', azs_id: '101', admin_user_id: 11, status: 'new' },
  { slot_key: '2026-06-25:0900', azs_id: '105', admin_user_id: 15, status: 'new' },
];

test('listNotSubmittedForDate: сегодняшние не-done/не-cancelled, без reminder и чужих дней', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  const rows = await store.listNotSubmittedForDate({ planDate: '2026-06-26' });
  assert.deepEqual(rows.map((r) => r.azsId).sort(), ['101', '102', '104']);
  assert.equal(rows.every((r) => typeof r.adminUserId === 'number'), true);
});

test('listSubmittedAzsForDate: только сданные АЗС', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  assert.deepEqual(await store.listSubmittedAzsForDate({ planDate: '2026-06-26' }), ['103']);
});

test('cancelNotSubmittedForDate: помечает и идемпотентен', async () => {
  const store = createReportsStore({ pool: createFakePgPool(SEED), dbType: 'postgres' });
  assert.equal(await store.cancelNotSubmittedForDate({ planDate: '2026-06-26' }), 3);
  assert.equal((await store.listNotSubmittedForDate({ planDate: '2026-06-26' })).length, 0);
  assert.equal(await store.cancelNotSubmittedForDate({ planDate: '2026-06-26' }), 0);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test tests/reportsStoreReissue.test.js`
Expected: FAIL — `store.listNotSubmittedForDate is not a function`.

- [ ] **Step 3: Реализовать методы — PostgreSQL (в `createPostgresStore`, рядом с `setReportStatus`)**
```js
  async listNotSubmittedForDate({ planDate }) {
    if (!planDate) return [];
    const result = await pool.query(
      `SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status NOT IN ('done', 'cancelled')
       ORDER BY id`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rows.map((r) => ({
      id: Number(r.id),
      azsId: String(r.azs_id),
      adminUserId: Number(r.admin_user_id),
      reportItemId: r.report_item_id == null ? null : Number(r.report_item_id),
      status: r.status,
    }));
  },

  async cancelNotSubmittedForDate({ planDate }) {
    if (!planDate) return 0;
    const result = await pool.query(
      `UPDATE dispatch_log SET status='cancelled', updated_at = NOW()
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status NOT IN ('done', 'cancelled')`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rowCount ?? 0;
  },

  async listSubmittedAzsForDate({ planDate }) {
    if (!planDate) return [];
    const result = await pool.query(
      `SELECT DISTINCT azs_id FROM dispatch_log
       WHERE (slot_key LIKE $1 OR slot_key LIKE $2)
         AND slot_key NOT LIKE $3
         AND status = 'done'`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result.rows.map((r) => String(r.azs_id));
  },
```

- [ ] **Step 4: Реализовать методы — MySQL (в `createMysqlStore`, рядом с `setReportStatus`)**
```js
  async listNotSubmittedForDate({ planDate }) {
    if (!planDate) return [];
    const [rows] = await pool.execute(
      `SELECT id, azs_id, admin_user_id, report_item_id, status FROM dispatch_log
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status NOT IN ('done', 'cancelled')
       ORDER BY id`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return rows.map((r) => ({
      id: Number(r.id),
      azsId: String(r.azs_id),
      adminUserId: Number(r.admin_user_id),
      reportItemId: r.report_item_id == null ? null : Number(r.report_item_id),
      status: r.status,
    }));
  },

  async cancelNotSubmittedForDate({ planDate }) {
    if (!planDate) return 0;
    const [result] = await pool.execute(
      `UPDATE dispatch_log SET status='cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status NOT IN ('done', 'cancelled')`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return result?.affectedRows ?? 0;
  },

  async listSubmittedAzsForDate({ planDate }) {
    if (!planDate) return [];
    const [rows] = await pool.execute(
      `SELECT DISTINCT azs_id FROM dispatch_log
       WHERE (slot_key LIKE ? OR slot_key LIKE ?)
         AND slot_key NOT LIKE ?
         AND status = 'done'`,
      [`${planDate}:%`, `manual:${planDate}:%`, '%:reminder:%']
    );
    return rows.map((r) => String(r.azs_id));
  },
```

- [ ] **Step 5: Запустить — зелёный (вместе с Task 1 Step 5)**

Run: `node --test tests/reportsStoreReissue.test.js`
Expected: PASS (4 теста).

- [ ] **Step 6: Commit**
```bash
git add backends/node/api/src/reports/reportsStore.js backends/node/api/tests/reportsStoreReissue.test.js
git commit -m "feat(reports): store methods to list/cancel today's not-submitted tasks"
```

---

## Task 3: Сервис оркестрации `reissueTodayService`

**Files:**
- Create: `backends/node/api/src/reports/reissueTodayService.js`
- Create: `backends/node/api/tests/reissueTodayService.test.js`

- [ ] **Step 1: Падающий тест**

`tests/reissueTodayService.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reissueToday } from '../src/reports/reissueTodayService.js';

const makeDeps = (over = {}) => {
  const notifyCalls = [];
  const genCalls = [];
  const deps = {
    planDate: '2026-06-26',
    reportsStore: {
      async listNotSubmittedForDate() {
        return [
          { id: 1, azsId: '101', adminUserId: 11, reportItemId: null, status: 'new' },
          { id: 2, azsId: '102', adminUserId: 12, reportItemId: null, status: 'reserved' },
          { id: 3, azsId: '101', adminUserId: 11, reportItemId: null, status: 'expired' },
        ];
      },
      async listSubmittedAzsForDate() { return ['103']; },
      async cancelNotSubmittedForDate() { return 3; },
    },
    dispatchPlanStore: {},
    settings: { timezone: 'Europe/Moscow' },
    candidates: [
      { azsId: '101', adminUserId: 11 },
      { azsId: '102', adminUserId: 12 },
      { azsId: '103', adminUserId: 13 },
    ],
    notify: async (a) => { notifyCalls.push(a); },
    notifyContext: { authId: 'x' },
    generateDailyPlan: async (a) => { genCalls.push(a); return { planned: a.candidates.length }; },
    logger: { warn() {} },
    ...over,
  };
  return { deps, notifyCalls, genCalls };
};

test('dryRun: считает, ничего не меняет', async () => {
  let cancelled = false;
  const { deps, notifyCalls, genCalls } = makeDeps({
    reportsStore: {
      async listNotSubmittedForDate() { return [{ id: 1, azsId: '101', adminUserId: 11, reportItemId: null, status: 'new' }]; },
      async listSubmittedAzsForDate() { return ['103']; },
      async cancelNotSubmittedForDate() { cancelled = true; return 1; },
    },
  });
  const r = await reissueToday({ ...deps, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.affected, 1);
  assert.equal(r.azsAffected, 1);
  assert.equal(r.submittedKept, 1);
  assert.equal(r.skippedSubmittedAzs, 1); // 103 уже сдал → не пересоздаём
  assert.equal(r.willRegenerate, 2);      // 101,102
  assert.equal(cancelled, false);
  assert.equal(notifyCalls.length, 0);
  assert.equal(genCalls.length, 0);
});

test('execute: отмена + дедуп-уведомления + пропуск сдавших + регенерация', async () => {
  const { deps, notifyCalls, genCalls } = makeDeps();
  const r = await reissueToday({ ...deps, dryRun: false });
  assert.equal(r.cancelled, 3);
  assert.equal(r.notified, 2);                       // users 11,12 (11 дедуплицирован)
  assert.equal(r.notifyFailed, 0);
  assert.deepEqual(notifyCalls.map((c) => c.userId).sort(), [11, 12]);
  assert.equal(genCalls.length, 1);
  assert.deepEqual(genCalls[0].candidates.map((c) => c.azsId).sort(), ['101', '102']); // без 103
  assert.equal(genCalls[0].regenerate, true);
  assert.equal(r.regenerated, 2);
  assert.equal(r.skippedSubmittedAzs, 1);
});

test('execute: сбой одного уведомления не валит операцию (best-effort)', async () => {
  const { deps } = makeDeps({ notify: async (a) => { if (a.userId === 12) throw new Error('boom'); } });
  const r = await reissueToday({ ...deps, dryRun: false });
  assert.equal(r.notified, 1);
  assert.equal(r.notifyFailed, 1);
  assert.equal(r.regenerated, 2); // регенерация всё равно прошла
});
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test tests/reissueTodayService.test.js`
Expected: FAIL — cannot find module `reissueTodayService.js`.

- [ ] **Step 3: Реализовать сервис**

`src/reports/reissueTodayService.js`:
```js
/**
 * reissueTodayService — оркестрация «Перевыпустить задания на сегодня».
 * Чистая логика без HTTP/Bitrix: снять несданные → уведомить → пересоздать.
 * Все побочные зависимости (store, notify, generateDailyPlan) инжектируются.
 */

const DEFAULT_CANCEL_MESSAGE =
  'Задание на фотоотчёт на сегодня отменено — расписание изменилось. Скоро придёт обновлённое задание.';

export const reissueToday = async ({
  planDate,
  dryRun = false,
  reportsStore,
  dispatchPlanStore,
  settings,
  candidates = [],
  notify,
  notifyContext = {},
  notifyMessage = DEFAULT_CANCEL_MESSAGE,
  generateDailyPlan,
  logger = console,
}) => {
  if (!planDate) throw new Error('reissueToday requires planDate');

  const notSubmitted = await reportsStore.listNotSubmittedForDate({ planDate });
  const submittedAzs = new Set((await reportsStore.listSubmittedAzsForDate({ planDate })).map(String));

  const affected = notSubmitted.length;
  const azsAffected = new Set(notSubmitted.map((r) => String(r.azsId))).size;
  const submittedKept = submittedAzs.size;

  const regenCandidates = candidates.filter((c) => !submittedAzs.has(String(c.azsId)));
  const skippedSubmittedAzs = candidates.length - regenCandidates.length;

  if (dryRun) {
    return { dryRun: true, planDate, affected, azsAffected, submittedKept, skippedSubmittedAzs, willRegenerate: regenCandidates.length };
  }

  const cancelled = await reportsStore.cancelNotSubmittedForDate({ planDate });

  const userIds = [...new Set(notSubmitted.map((r) => Number(r.adminUserId)).filter(Boolean))];
  let notified = 0;
  let notifyFailed = 0;
  for (const userId of userIds) {
    try {
      await notify({ userId, message: notifyMessage, context: notifyContext });
      notified += 1;
    } catch (err) {
      notifyFailed += 1;
      logger.warn?.('reissue_notify_failed', { userId, message: err?.message });
    }
  }

  let regenerated = 0;
  if (regenCandidates.length > 0) {
    const summary = await generateDailyPlan({
      planDate, candidates: regenCandidates, settings, planStore: dispatchPlanStore, regenerate: true, logger,
    });
    regenerated = Number(summary?.planned ?? 0);
  }

  return { dryRun: false, planDate, affected, azsAffected, submittedKept, cancelled, notified, notifyFailed, regenerated, skippedSubmittedAzs };
};

export default reissueToday;
```

- [ ] **Step 4: Запустить — зелёный**

Run: `node --test tests/reissueTodayService.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Commit**
```bash
git add backends/node/api/src/reports/reissueTodayService.js backends/node/api/tests/reissueTodayService.test.js
git commit -m "feat(reports): reissueToday orchestration service"
```

---

## Task 4: Роут `POST /api/reports/today/reissue`

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js` (импорт сервиса вверху; новый роут рядом с `/plan/generate`, ≈после строки 1091)
- Create: `backends/node/api/tests/reissueTodayRoute.test.js`

- [ ] **Step 1: Падающий тест роута**

`tests/reissueTodayRoute.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

function makeRes() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this._payload = p; return p; } };
}
function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      return layer.route.stack.filter((l) => !method || l.method === method.toLowerCase() || !l.method)[0]?.handle || null;
    }
  }
  return null;
}
const baseDeps = () => ({
  reportsStore: {
    async listNotSubmittedForDate() { return []; },
    async listSubmittedAzsForDate() { return []; },
    async cancelNotSubmittedForDate() { return 0; },
  },
  dispatchService: {},
  settingsStore: { async read() { return { timezone: 'Europe/Moscow', azs: { entityTypeId: 1, fields: { admin: 'UF_X' } } }; } },
  bitrixClient: { async listCrmItems() { return []; } },
  notificationService: { async notify() {} },
  authContextStore: {},
  crmSyncJobStore: {},
  dispatchPlanStore: { async ensureSchema() {}, upsertPlanned() {}, async listByDate() { return []; } },
});

test('POST /today/reissue: 403 без capabilities.settings', async () => {
  const router = createReportsRouter(baseDeps());
  const handler = getHandler(router, 'post', '/today/reissue');
  assert.ok(handler, 'route exists');
  const req = { body: {}, accessContext: { capabilities: { reviewer: true } }, bitrixContext: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /today/reissue: dryRun возвращает счётчики для админа', async () => {
  const router = createReportsRouter(baseDeps());
  const handler = getHandler(router, 'post', '/today/reissue');
  const req = { body: { dryRun: true }, accessContext: { capabilities: { settings: true } }, bitrixContext: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.ok, true);
  assert.equal(res._payload.dryRun, true);
  assert.equal(res._payload.affected, 0);
  assert.equal(res._payload.planDate?.length, 10);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test tests/reissueTodayRoute.test.js`
Expected: FAIL — `route exists` assert (handler null) или 404-стиль.

- [ ] **Step 3: Импорт сервиса вверху `reportsRoutes.js`**

Рядом с импортом `generateDailyPlan` добавить:
```js
import { reissueToday } from './reissueTodayService.js';
```

- [ ] **Step 4: Добавить роут (после обработчика `/plan/generate`, ≈строка 1091)**
```js
  router.post('/today/reissue', async (req, res) => {
    if (!req.accessContext?.capabilities?.settings) {
      return res.status(403).json({ error: 'forbidden', message: 'Settings (admin) access is required' });
    }
    try {
      if (!dispatchPlanStore || typeof dispatchPlanStore.upsertPlanned !== 'function') {
        return res.status(503).json({ error: 'plan_mode_unavailable', message: 'План рассылки недоступен (хранилище не инициализировано)' });
      }
      await dispatchPlanStore.ensureSchema();
      const settings = await settingsStore.read();
      const tz = String(settings?.timezone || 'Europe/Moscow').trim();
      const planDate = normalizePlanDate(req.body?.date) || todayInTz(tz);
      const dryRun = Boolean(req.body?.dryRun);
      const context = req.bitrixContext || {};
      const candidates = await loadEnabledAzsCandidates({ settings, bitrixClient, context });

      const result = await reissueToday({
        planDate,
        dryRun,
        reportsStore,
        dispatchPlanStore,
        settings,
        candidates,
        notify: (a) => notificationService.notify(a),
        notifyContext: context,
        generateDailyPlan,
        logger: console,
      });

      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(502).json({ error: 'reissue_failed', message: error.message });
    }
  });
```

- [ ] **Step 5: Запустить — зелёный**

Run: `node --test tests/reissueTodayRoute.test.js`
Expected: PASS (2 теста).

- [ ] **Step 6: Commit**
```bash
git add backends/node/api/src/reports/reportsRoutes.js backends/node/api/tests/reissueTodayRoute.test.js
git commit -m "feat(reports): POST /today/reissue endpoint (admin-only, dry-run + execute)"
```

---

## Task 5: Метод фронта `reissueTodayTasks`

**Files:**
- Modify: `frontend/app/stores/api.ts` (тело стора рядом с `generateDispatchPlan` ≈строка 381; и в return-объекте ≈строка 731)

- [ ] **Step 1: Добавить метод (после `generateDispatchPlan`)**
```ts
    const reissueTodayTasks = async (opts: { date?: string; dryRun?: boolean } = {}): Promise<{
      ok: boolean
      planDate: string
      dryRun: boolean
      affected: number
      azsAffected: number
      submittedKept: number
      skippedSubmittedAzs: number
      willRegenerate?: number
      cancelled?: number
      notified?: number
      notifyFailed?: number
      regenerated?: number
    }> => {
      return await $api('/api/reports/today/reissue', {
        method: 'POST',
        body: { ...opts },
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }
```

- [ ] **Step 2: Экспортировать в return-объекте стора (рядом с `generateDispatchPlan,`)**
```ts
      generateDispatchPlan,
      reissueTodayTasks,
```

- [ ] **Step 3: Проверка типов/сборки**

Run: `cd frontend && npx nuxi typecheck` (если настроено) или `npx vue-tsc --noEmit`.
Expected: без новых ошибок типов в `api.ts`. *(Если typecheck в проекте не настроен — пропустить, проверим в Task 6 смоуком сборки.)*

- [ ] **Step 4: Commit**
```bash
git add frontend/app/stores/api.ts
git commit -m "feat(api): reissueTodayTasks store method"
```

---

## Task 6: Кнопка + модалка на дашборде проверяющего

**Files:**
- Modify: `frontend/app/pages/reviewer.client.vue` (script: рядом с `handleGeneratePlan` ≈строка 708; template: рядом с карточкой плана/расписания ≈строки 1285–1476)

- [ ] **Step 1: Состояние + обработчик (script, рядом с `planGenerating`/`handleGeneratePlan`)**
```ts
const reissuing = ref(false)
const reissueMessage = ref('')
const reissueError = ref('')

const handleReissueToday = async () => {
  reissueMessage.value = ''
  reissueError.value = ''

  let preview
  try {
    preview = await apiStore.reissueTodayTasks({ dryRun: true })
  } catch (error) {
    reissueError.value = extractApiError(error, 'Не удалось получить предпросмотр')
    return
  }

  const ok = await confirm({
    title: 'Перевыпустить задания на сегодня?',
    text: `Будет снято ${preview.affected} несданных заданий по ${preview.azsAffected} АЗС. `
      + `Сданные (${preview.submittedKept}) останутся, уже сдавшие АЗС (${preview.skippedSubmittedAzs}) пропустим. `
      + `Пересоздание возьмёт времена из настроек — убедитесь, что новое расписание сохранено.`,
    confirmLabel: 'Перевыпустить',
  })
  if (!ok) return

  reissuing.value = true
  try {
    const result = await apiStore.reissueTodayTasks({})
    reissueMessage.value = `Снято ${result.cancelled}, пересоздано ${result.regenerated}, уведомлено ${result.notified}`
      + (result.skippedSubmittedAzs ? `, пропущено сдавших ${result.skippedSubmittedAzs}` : '')
    setTimeout(() => { reissueMessage.value = '' }, 6000)
    await loadDispatchPlan()
  } catch (error) {
    reissueError.value = extractApiError(error, 'Ошибка при перевыпуске заданий')
  } finally {
    reissuing.value = false
  }
}
```

- [ ] **Step 2: Кнопка (template, под кнопкой «Сформировать график» / рядом с расписанием)**
```vue
              <button
                class="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="reissuing || !hasSettingsAccess"
                :title="!hasSettingsAccess ? 'Только администратор' : undefined"
                @click="handleReissueToday"
              >
                {{ reissuing ? 'Перевыпуск…' : 'Перевыпустить задания на сегодня' }}
              </button>
              <span v-if="reissueMessage" class="text-sm text-green-700 font-medium">{{ reissueMessage }}</span>
              <span v-if="reissueError" class="text-sm text-red-600">{{ reissueError }}</span>
              <p v-if="hasSettingsAccess" class="text-xs text-gray-400">
                Снимет несданные задания на сегодня по всем АЗС, предупредит сотрудников и пересоздаст по текущему расписанию. Сданные не трогает.
              </p>
```

- [ ] **Step 3: Смоук сборки фронта**

Run: `cd frontend && npm run build` (или `npx nuxi build`).
Expected: сборка проходит без ошибок; кнопка присутствует в `reviewer.client.vue`.

- [ ] **Step 4: Commit**
```bash
git add frontend/app/pages/reviewer.client.vue
git commit -m "feat(reviewer): 'reissue today's tasks' button with dry-run confirm"
```

---

## Task 7 (опционально, можно отложить): удаление пустых CRM-карточек снятых задач

YAGNI: v1 оставляет пустые карточки (помечены отменёнными в приложении). Делать ТОЛЬКО если продакт подтвердит, что пустые карточки в CRM мешают. Зависит от живого admin-OAuth (BUG-022), поэтому строго best-effort.

**Files:**
- Modify: `backends/node/api/src/dispatch/bitrixRestClient.js` (добавить `deleteCrmItem` рядом с `getCrmItem` ≈строка 520)
- Modify: `backends/node/api/src/reports/reissueTodayService.js` (best-effort вызов после `cancel`)

- [ ] **Step 1: Хелпер `deleteCrmItem` (в объекте клиента)**
```js
    async deleteCrmItem({ entityTypeId, id, context = {} }) {
      if (!Number(entityTypeId) || !Number(id)) return false;
      await call('crm.item.delete', { entityTypeId: Number(entityTypeId), id: Number(id) }, context);
      return true;
    },
```

- [ ] **Step 2: Тест (стаб клиента) + best-effort вызов в сервисе**

Добавить в `reissueToday` параметры `deleteCrmItem` (async, опц.), `crmEntityTypeId`, `crmContext`; после `cancelNotSubmittedForDate` пройтись по `notSubmitted.filter(r => r.reportItemId)` и best-effort `await deleteCrmItem({...}).catch(() => {})`, считая `crmDeleted`. Тест: стаб бросает на одном id → операция не падает, `crmDeleted` верный. *(Точный код — при активации задачи; v1 не блокирует.)*

- [ ] **Step 3: Commit** (если делаем)
```bash
git commit -am "feat(reports): best-effort delete empty CRM cards on reissue (flagged)"
```

---

## Task 8: Полный прогон, смоук, документация

- [ ] **Step 1: Все бэкенд-тесты**

Run: `cd backends/node/api && node --test tests/`
Expected: PASS, 0 падений (включая существующие 73 файла + 3 новых).

- [ ] **Step 2: Smoke сервиса локально (dev-окружение)**

Поднять node-бэкенд (`make dev-node`). Войти админом. На дашборде: изменить расписание → «Сохранить расписание». Затем «Перевыпустить задания на сегодня» → подтвердить.
Ожидаемо: тост со счётчиками; затронутые сотрудники получают сообщение бота об отмене; новые плановые слоты появляются (проверить вкладку плана); на следующем тике планировщика рассылаются новые задания.

- [ ] **Step 3: Smoke БД — `cancelled` инертен**

После перевыпуска выполнить (psql/mysql):
```sql
-- снятые задания не считаются просроченными и не «оживают»
SELECT status, COUNT(*) FROM dispatch_log
 WHERE slot_key LIKE '<today>:%' GROUP BY status;
```
Ожидаемо: есть строки `cancelled`; в сводке отчётов (R1) они НЕ в «Открыто»/«Просрочено»; timeoutWatcher на следующем прогоне не меняет `cancelled`→`expired`.

- [ ] **Step 4: Запись в CHANGELOG**

Добавить в `docs/CHANGELOG.md` (вверх, в текущий релиз):
```markdown
- **Перевыпуск заданий на сегодня (смена расписания среди дня).** Кнопка для админа на дашборде: снимает несданные сегодняшние задания по всем АЗС (статус `cancelled`), предупреждает сотрудников сообщением бота и пересоздаёт план на сегодня по текущему расписанию из настроек. Сданные отчёты и фото не трогаются; уже сдавшие АЗС повторно не дёргаются. Эндпоинт `POST /api/reports/today/reissue` (только админ, с предпросмотром dryRun).
```

- [ ] **Step 5: Commit**
```bash
git add docs/CHANGELOG.md
git commit -m "docs: changelog for reissue-today feature"
```

---

## Self-Review (выполнено при написании плана)

**1. Покрытие спеки:** Очистка несданных → Task 2 (`cancelNotSubmittedForDate`) + Task 3. Сохранение сданных → `status NOT IN ('done',...)` + skip submitted (Task 3). Уведомление бота → Task 3 (notify, дедуп, best-effort). Пересоздание из настроек → Task 4 (`generateDailyPlan(regenerate)`). Предпросмотр + подтверждение → Task 4 (dryRun) + Task 6. Только админ → Task 4 (`capabilities.settings`). `cancelled` инертен (KPI/таймаут/напоминания) → Task 1. Таймзона → Task 4 (`todayInTz`). UI на дашборде → Task 6. Тесты → Tasks 2–4. CRM-карточки (опц.) → Task 7. Покрыто.

**2. Плейсхолдеры:** код приведён в каждом шаге; единственное помеченное «при активации» — опциональный Task 7 (вне v1).

**3. Согласованность имён/типов:** `listNotSubmittedForDate`/`cancelNotSubmittedForDate`/`listSubmittedAzsForDate` — одинаковы в сторе (Task 2), сервисе (Task 3), тестах. `reissueToday` — сервис (Task 3) ↔ импорт в роуте (Task 4). `reissueTodayTasks` — api.ts (Task 5) ↔ вызовы во вью (Task 6). Поля ответа (`affected/azsAffected/submittedKept/skippedSubmittedAzs/willRegenerate/cancelled/notified/notifyFailed/regenerated/dryRun/planDate`) совпадают между сервисом, роутом, тестами и фронтом.

## Открытые предположения (из спеки — подтвердить при ревью)
- R1 мягкая отмена (`cancelled`), не удаление.
- R2 пропускать уже сдавших сегодня.
- R3 новое расписание сохраняется в настройках до кнопки (подсказка в модалке).
- Task 7 (удаление CRM-карточек) отложено за пределы v1.
