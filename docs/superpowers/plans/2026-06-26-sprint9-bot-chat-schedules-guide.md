# Спринт 9 — Implementation Plan (только бот в чат · встройка · расписания · гайд)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Все уведомления приложения — только сообщением бота в чат Битрикс (колокольчик вырезан); встройка `IMMOBILE_CONTEXT_MENU` открывает дашборд управляющего; удобное управление расписаниями (план дня + глобальное); актуальный ролевой юзер-гайд на всех экранах.

**Architecture:** Node API (`backends/node/api`, ESM, тесты `node:test`) + Nuxt-фронт (`frontend`, без тест-харнесса → smoke-верификация) + Postgres. Прод = master, FF-пуш + bump `BUILD_REV` обеих стадий Dockerfile.

**Tech Stack:** Node 20 / Express 5 / `node:test`, Nuxt 3 / Vue 3 / Pinia, Bitrix24 REST (`imbot.v2.Chat.Message.send`, `placement.bind`).

**Рабочая директория бэка:** `backends/node/api`. Запуск тестов: `node --test tests/<file>.test.js`.

**Порядок фаз:** РЭ-1 → РЭ-3 → РЭ-2 → РЭ-4. Каждая фаза — самостоятельный коммит, выкатывается независимо.

---

## File Structure

**РЭ-1 (уведомления):**
- Modify: `backends/node/api/src/notifications/notificationService.js` — bot-only + `alertAdmins`
- Modify: `backends/node/api/server.js:398-413` — прокинуть `adminUserIds` в сервис
- Test: `backends/node/api/tests/notificationService.test.js` — переписать fallback-тесты

**РЭ-3 (расписания):**
- Modify: `backends/node/api/src/reports/dispatchPlanStore.js` — `cancelPlanned()` (PG+MySQL)
- Modify: `backends/node/api/src/reports/reportsRoutes.js` — `id` в items `GET /plan`; `POST /plan/slot/cancel`
- Test: `backends/node/api/tests/dispatchPlanStoreCancel.test.js` (новый)
- Create: `frontend/app/components/schedule/ScheduleManager.vue` — блок «План на день»
- Modify: `frontend/app/pages/reviewer.client.vue:1257-1347` — встроить ScheduleManager
- Modify: `frontend/app/stores/api.ts` — `getDayPlan`, `cancelSlot`

**РЭ-2 (встройка):**
- Modify: `backends/node/api/server.js:141-215,838-859` — обобщить привязку + `IMMOBILE_CONTEXT_MENU`
- Test: `backends/node/api/tests/placementBind.test.js` (новый)
- Modify: `frontend/app/pages/index.client.vue:199-260,336-382` — роут placement→/reviewer

**РЭ-4 (гайд):**
- Modify: `frontend/app/components/help/HelpGuide.vue` — актуализировать 3 вкладки
- Modify: `frontend/app/pages/{index,settings,reports,brands}.client.vue`, `admin/[reportId].client.vue` — кнопка «Справка»

---

# ФАЗА РЭ-1 — Уведомления только через бота

**Контекст для исполнителя:** Сейчас `notificationService.notify()` при сбое бота вызывает `sendViaNotify` → `bitrixClient.notifyUser` → `im.notify.personal.add` (колокольчик). Задача: убрать колокольчик полностью; при сбое бота — слать алерт портал-админам **тем же ботом** в их личный чат; при полном отказе — лог `notification_undelivered`.

### Task 1.1: Тест — режим по умолчанию = bot, колокольчик не вызывается никогда

**Files:**
- Test: `backends/node/api/tests/notificationService.test.js`

- [ ] **Step 1: Заменить устаревший fallback-тест на bot-only тесты**

Открой `tests/notificationService.test.js`. Найди тест `notifyDispatch falls back to notify channel when bot send fails` (начинается на стр. 57). Удали его целиком и вставь на его место:

```js
test('notify uses bot by default (mode not specified)', async () => {
  const botCalls = [];
  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) { botCalls.push({ method, payload }); return { id: 1 }; },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    botId: 42
  });
  const result = await service.notify({ userId: 5, message: 'привет' });
  assert.equal(result.channel, 'bot');
  assert.equal(botCalls[0].method, 'imbot.v2.Chat.Message.send');
});

test('on bot failure notify alerts admins via bot, never the bell', async () => {
  const calls = [];
  let notifyUserCalled = false;
  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        calls.push({ method, payload });
        // первый вызов (доставка сотруднику) падает, последующие (алерт админам) — успех
        if (payload.dialogId === '5') throw new Error('BOT_TOKEN_NOT_SPECIFIED');
        return { id: 2 };
      },
      async notifyUser() { notifyUserCalled = true; return { ok: true }; }
    },
    botId: 42,
    adminUserIds: [900, 901]
  });
  const result = await service.notify({ userId: 5, message: 'пора сдать отчёт', azsId: 'azs-1' });
  assert.equal(notifyUserCalled, false, 'колокольчик не должен вызываться');
  assert.equal(result.channel, 'admin_alert');
  assert.equal(result.delivered, false);
  const adminMsgs = calls.filter((c) => c.payload.dialogId === '900' || c.payload.dialogId === '901');
  assert.equal(adminMsgs.length, 2);
  assert.match(adminMsgs[0].payload.fields.message, /Не удалось доставить/);
  assert.match(adminMsgs[0].payload.fields.message, /azs-1/);
});

test('on total bot failure (no admins reachable) returns undelivered without throwing', async () => {
  const service = createNotificationService({
    bitrixClient: {
      async callMethod() { throw new Error('BOT_TOKEN_NOT_SPECIFIED'); },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    botId: 42,
    adminUserIds: [900]
  });
  const result = await service.notify({ userId: 5, message: 'x' });
  assert.equal(result.delivered, false);
  assert.equal(result.channel, 'undelivered');
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backends/node/api && node --test tests/notificationService.test.js`
Expected: FAIL — старый код по умолчанию `mode='notify'`, вызывает `notifyUser` / нет `adminUserIds`.

### Task 1.2: Реализация bot-only в notificationService

**Files:**
- Modify: `backends/node/api/src/notifications/notificationService.js`

- [ ] **Step 1: Режим по умолчанию → bot; принять adminUserIds**

В `createNotificationService` (стр. 83-92) замени строку:
```js
  mode = process.env.BITRIX_BOT_MODE || 'notify',
```
на:
```js
  mode = process.env.BITRIX_BOT_MODE || 'bot',
```
и добавь в деструктуризацию параметров (после `botId = ...`, стр. 86) новую строку:
```js
  adminUserIds = [],
```

- [ ] **Step 2: Добавить функцию alertAdmins**

Сразу после `ensureBotId` (после стр. 115, перед `const notify`) вставь:
```js
  const alertAdmins = async ({ botError, userId, azsId, context }) => {
    const ids = Array.isArray(adminUserIds) ? adminUserIds.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      return false;
    }
    const azsPart = azsId ? ` по АЗС ${azsId}` : '';
    const text = `⚠️ Не удалось доставить сообщение сотруднику ${Number(userId)}${azsPart}.\nПричина: ${botError}`;
    let delivered = false;
    for (const adminId of ids) {
      try {
        const bid = await ensureBotId(context);
        if (!bid) {
          break;
        }
        await sendViaBot({ bitrixClient, botId: bid, userId: adminId, message: text, context });
        delivered = true;
      } catch (alertError) {
        if (typeof logger?.error === 'function') {
          logger.error('notification_undelivered', {
            adminId: Number(adminId),
            forUserId: Number(userId),
            azsId: azsId ?? null,
            original: String(botError),
            alertError: alertError?.message || String(alertError)
          });
        }
      }
    }
    return delivered;
  };
```

- [ ] **Step 3: Переписать тело notify — bot-only, без колокольчика**

Замени весь блок выбора транспорта (текущие стр. 165-239: `if (resolvedMode === 'bot') { ... }` вместе с финальным notify-блоком) на:
```js
    let botError = null;
    try {
      const runtimeBotId = await ensureBotId(context);
      if (!runtimeBotId) {
        throw new Error('BITRIX_BOT_ID is required (bot-only delivery)');
      }
      const trySend = async (bid) => sendViaBot({ bitrixClient, botId: bid, userId, message, keyboard, context });

      let result;
      try {
        result = await trySend(runtimeBotId);
      } catch (firstError) {
        const reason = firstError?.message || String(firstError);
        if (BOT_NOT_FOUND_PATTERN.test(reason) && typeof ensureBot === 'function') {
          logger.warn('bot_self_heal_triggered', { reason, userId });
          const healed = await ensureBot(context);
          const healedBotId = Number(healed?.botId || 0);
          if (healedBotId) {
            currentBotId = healedBotId;
            result = await trySend(healedBotId);
          } else {
            throw firstError;
          }
        } else {
          throw firstError;
        }
      }

      logDelivery('bot');
      return { channel: 'bot', result, delivered: true };
    } catch (error) {
      botError = error?.message || String(error);
      logger.warn('bot_channel_degraded', { reason: botError, dialogId: String(Number(userId)) });
      logAuthProblem(botError);
      // Колокольчик НИКОГДА. Вместо него — алерт админам тем же ботом.
      const alerted = await alertAdmins({ botError, userId, azsId, context });
      logDelivery(alerted ? 'admin_alert' : 'undelivered', { botError });
      return { channel: alerted ? 'admin_alert' : 'undelivered', delivered: false, botError };
    }
```

- [ ] **Step 4: Удалить мёртвый notify-транспорт и неиспользуемые параметры**

1. Удали функцию `sendViaNotify` (стр. 72-81) целиком.
2. В сигнатуре `notify` (стр. 117-128) удали параметры `fallbackToNotify = true` и `fallbackSuffix = ''` и связанный комментарий NOTIF-1 о fallback. Удали `const withSuffix = ...` (стр. 161-163) — он больше не используется.
3. Оставь `resolvedMode`/`normalizeMode` нетронутыми (не мешают), но они теперь не влияют на ветвление.

- [ ] **Step 5: Запустить тесты — убедиться, что проходят**

Run: `cd backends/node/api && node --test tests/notificationService.test.js`
Expected: PASS (все тесты файла, включая существующий `notifyDispatch ... mode=bot`).

- [ ] **Step 6: Греп-гард — im.notify не на пути рассылки**

Run: `cd backends/node/api && grep -rn "notifyUser\|im.notify" src/notifications/ src/dispatch/dispatchService.js src/dispatch/timeoutWatcher.js`
Expected: ни одного вызова `notifyUser(`/`im.notify` в `src/notifications/notificationService.js`. (Определение `notifyUser` в `bitrixRestClient.js` может остаться как мёртвый код — отдельной задачей не трогаем.)

### Task 1.3: Прокинуть adminUserIds в сервис из настроек доступа

**Files:**
- Modify: `backends/node/api/server.js:398-413`

- [ ] **Step 1: Подмешать adminUserIds при создании сервиса**

`adminUserIds` нужно брать из настроек доступа (`normalizeAccessSettings`) с env-фоллбэком `SYSTEM_ADMIN_USER_IDS`/`ADMIN_USER_IDS`. На момент создания сервиса (стр. 398) настройки уже доступны через `settingsStore`. Поскольку сервис создаётся синхронно, передаём env-список сразу, а полный список из настроек дочитываем лениво не нужно — портал-админ почти всегда задан в env `SYSTEM_ADMIN_USER_IDS`. Добавь импорт вверху server.js (рядом с прочими импортами `src/access`):
```js
import { normalizeAccessSettings } from './src/access/roleResolver.js';
```
(если уже импортируется — не дублируй).

В объект `createNotificationService({ ... })` (стр. 398-413) добавь поле:
```js
  adminUserIds: (() => {
    const fromEnv = String(process.env.SYSTEM_ADMIN_USER_IDS || process.env.ADMIN_USER_IDS || '')
      .split(/[\s,]+/).map(Number).filter(Boolean);
    return fromEnv;
  })(),
```

- [ ] **Step 2: Проверить, что сервер стартует без ошибок импорта**

Run: `cd backends/node/api && node --check server.js`
Expected: без вывода (синтаксис ок).

- [ ] **Step 3: Commit**

```bash
cd backends/node/api && node --test tests/notificationService.test.js && cd ../../.. && \
git add backends/node/api/src/notifications/notificationService.js backends/node/api/server.js backends/node/api/tests/notificationService.test.js && \
git commit -m "feat(NOTIF-BOT-ONLY): уведомления только ботом в чат; колокольчик вырезан, сбой → алерт админам ботом

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# ФАЗА РЭ-3 — Управление расписаниями (план дня + глобальное)

**Контекст:** `GET /reports/plan?date=` уже возвращает слоты дня. Нужно: добавить `id` слота в ответ, метод `cancelPlanned({id})` в стор, роут `POST /reports/plan/slot/cancel`. «Пересоздать слот» и «создать вне расписания» переиспользуют существующий `POST /reports/manual`; «перевыпустить день» — существующий `POST /reports/today/reissue`.

### Task 3.1: Тест — cancelPlanned переводит planned-слот в cancelled

**Files:**
- Test: `backends/node/api/tests/dispatchPlanStoreCancel.test.js` (новый)

- [ ] **Step 1: Написать тест с in-memory pool-моком**

Создай `tests/dispatchPlanStoreCancel.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';

test('cancelPlanned updates a planned row to cancelled by id', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rowCount: 1, rows: [] };
    }
  };
  const store = createDispatchPlanStore({ pool, dbType: 'postgres' });
  const res = await store.cancelPlanned({ id: 17 });
  assert.equal(res.cancelled, 1);
  assert.match(queries[0].sql, /UPDATE dispatch_plan SET status='cancelled'/i);
  assert.match(queries[0].sql, /WHERE id=\$1 AND status='planned'/i);
  assert.deepEqual(queries[0].params, [17]);
});
```

Факт (проверено): фабрика — `export const createDispatchPlanStore = ({ pool, dbType } = {})`; `dbType !== 'mysql'` → Postgres-стор (`createPostgresStore(pool)`), использующий `pool.query(sql, params)` → `{ rowCount, rows }`. Импорт именованный: `import { createDispatchPlanStore } from '../src/reports/dispatchPlanStore.js';` (есть и `export default`).

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backends/node/api && node --test tests/dispatchPlanStoreCancel.test.js`
Expected: FAIL — `store.cancelPlanned is not a function`.

### Task 3.2: Реализовать cancelPlanned (Postgres + MySQL)

**Files:**
- Modify: `backends/node/api/src/reports/dispatchPlanStore.js`

- [ ] **Step 1: Добавить метод в Postgres-ветку**

Рядом с `markDispatched` (стр. 111) в Postgres-объекте добавь:
```js
  async cancelPlanned({ id }) {
    const res = await pool.query(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='planned'`,
      [Number(id)]
    );
    return { cancelled: res.rowCount ?? 0 };
  },
```

- [ ] **Step 2: Добавить метод в MySQL-ветку**

Рядом с `markDispatched` (стр. 256) в MySQL-объекте добавь:
```js
  async cancelPlanned({ id }) {
    const [res] = await pool.query(
      `UPDATE dispatch_plan SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='planned'`,
      [Number(id)]
    );
    return { cancelled: res?.affectedRows ?? 0 };
  },
```

- [ ] **Step 3: Запустить тест — PASS**

Run: `cd backends/node/api && node --test tests/dispatchPlanStoreCancel.test.js`
Expected: PASS.

### Task 3.3: Добавить id в GET /plan и роут POST /plan/slot/cancel

**Files:**
- Modify: `backends/node/api/src/reports/reportsRoutes.js`

- [ ] **Step 1: Добавить id слота в items GET /plan**

В цикле сборки items (стр. 1043-1051) добавь первой строкой объекта:
```js
          id: row.id,
```

- [ ] **Step 2: Добавить роут отмены слота сразу после GET /plan (после стр. 1057)**

```js
  router.post('/plan/slot/cancel', async (req, res) => {
    if (!canUseReviewerTools(req)) return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
    try {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ error: 'bad_request', message: 'id слота обязателен' });
      if (!dispatchPlanStore || typeof dispatchPlanStore.cancelPlanned !== 'function') {
        return res.status(503).json({ error: 'plan_mode_unavailable', message: 'План рассылки недоступен' });
      }
      const result = await dispatchPlanStore.cancelPlanned({ id });
      return res.json({ ok: true, cancelled: result.cancelled });
    } catch (error) {
      return res.status(502).json({ error: 'plan_cancel_failed', message: error.message });
    }
  });
```

- [ ] **Step 3: Проверить синтаксис и существующие тесты роутов**

Run: `cd backends/node/api && node --check src/reports/reportsRoutes.js && node --test tests/`
Expected: синтаксис ок; весь набор тестов зелёный (или без новых падений относительно baseline).

- [ ] **Step 4: Commit (backend РЭ-3)**

```bash
git add backends/node/api/src/reports/dispatchPlanStore.js backends/node/api/src/reports/reportsRoutes.js backends/node/api/tests/dispatchPlanStoreCancel.test.js && \
git commit -m "feat(SCHEDULE-API): cancelPlanned + POST /reports/plan/slot/cancel + id слота в GET /plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.4: Стора api.ts — методы getDayPlan/cancelSlot

**Files:**
- Modify: `frontend/app/stores/api.ts`

- [ ] **Step 1: Добавить методы по образцу getSettings/saveSettings**

Стор использует обёртку `$api('/api/...', { method, body, headers: { Authorization: \`Bearer ${tokenJWT.value}\` } })` (body — объект, не JSON-строка; путь включает `/api`). Рядом с `getSettings`/`saveSettings` (стр. 180-201) добавь:
```ts
    const getDayPlan = async (date: string): Promise<{ items: any[]; planDate: string | null; enabled: boolean }> => {
      return await $api(`/api/reports/plan?date=${encodeURIComponent(date)}`, {
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const cancelSlot = async (id: number): Promise<{ ok: boolean; cancelled: number }> => {
      return await $api('/api/reports/plan/slot/cancel', {
        method: 'POST',
        body: { id },
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }
```
Затем добавь `getDayPlan` и `cancelSlot` в объект, который стор возвращает (там же, где экспонируются `getSettings`, `saveSettings` и пр.).

- [ ] **Step 2: Проверить типы**

Run: `cd frontend && pnpm exec nuxi typecheck 2>&1 | tail -20` (или `pnpm run typecheck`, если есть скрипт)
Expected: без новых ошибок типов в `stores/api.ts`.

### Task 3.5: Компонент ScheduleManager.vue (план на день)

**Files:**
- Create: `frontend/app/components/schedule/ScheduleManager.vue`

- [ ] **Step 1: Создать компонент**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useApiStore } from '~/stores/api'

const api = useApiStore()
const today = new Date().toISOString().slice(0, 10)
const date = ref(today)
const items = ref<any[]>([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true; error.value = ''
  try {
    const res: any = await api.getDayPlan(date.value)
    items.value = Array.isArray(res?.items) ? res.items : []
  } catch (e: any) {
    error.value = e?.message || 'Не удалось загрузить план'
  } finally {
    loading.value = false
  }
}

async function cancel(id: number) {
  await api.cancelSlot(id)
  await load()
}

onMounted(load)
</script>

<template>
  <div class="schedule-manager">
    <div class="row">
      <label>Дата</label>
      <input type="date" v-model="date" @change="load" />
      <button @click="load">Обновить</button>
    </div>
    <p v-if="loading">Загрузка…</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <table v-else-if="items.length">
      <thead><tr><th>АЗС</th><th>Время</th><th>Статус</th><th></th></tr></thead>
      <tbody>
        <tr v-for="it in items" :key="it.id">
          <td>{{ it.azsTitle || it.azsId }}</td>
          <td>{{ it.baseTime }}</td>
          <td>{{ it.status }}</td>
          <td>
            <button v-if="it.status === 'planned'" @click="cancel(it.id)">Отменить</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else>На выбранную дату запланированных запросов нет.</p>
  </div>
</template>
```
(Стили/классы выровняй под существующие компоненты reviewer — переиспользуй имеющиеся утилитарные классы вместо нового CSS, где возможно.)

### Task 3.6: Встроить ScheduleManager в карточку управляющего

**Files:**
- Modify: `frontend/app/pages/reviewer.client.vue:1257-1347`

- [ ] **Step 1: Вставить блок «План на день» в карточку расписания**

В секции «Расписание рассылки» (~1257-1347), под существующим редактором времён, добавь подзаголовок и компонент:
```vue
        <h4 class="schedule-subhead">План на день</h4>
        <ScheduleManager />
```
Импорт компонента (если в проекте не авто-импорт компонентов — проверь `nuxt.config.ts`/components dir; обычно Nuxt авто-импортит из `components/`). При необходимости добавь явный импорт в `<script setup>`:
```ts
import ScheduleManager from '~/components/schedule/ScheduleManager.vue'
```

- [ ] **Step 2: Smoke-верификация (нет фронт-тестов)**

Запусти фронт локально и открой экран управляющего; убедись:
- блок «План на день» показывает слоты выбранной даты;
- смена даты перезагружает список;
- кнопка «Отменить» у planned-слота переводит его в `cancelled` и список обновляется;
- кнопки «Перевыпустить на сегодня» / «Создать вне расписания» (существующие) на месте и работают.

Команда запуска фронта: см. `makefile` цель `dev-front` (или `cd frontend && pnpm dev`). Зафиксируй наблюдения (скриншот/описание) — это пруф готовности.

- [ ] **Step 3: Commit (frontend РЭ-3)**

```bash
git add frontend/app/components/schedule/ScheduleManager.vue frontend/app/pages/reviewer.client.vue frontend/app/stores/api.ts && \
git commit -m "feat(SCHEDULE-UI): блок «План на день» — список слотов + отмена; методы api getDayPlan/cancelSlot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# ФАЗА РЭ-2 — Встройка IMMOBILE_CONTEXT_MENU → дашборд управляющего

**Контекст:** Сейчас `ensureRestAppUriPlacement` (server.js:141-215) биндит только `REST_APP_URI`. Нужно дополнительно забиндить `IMMOBILE_CONTEXT_MENU` (идемпотентно) в install-флоу, а фронт при `PLACEMENT=IMMOBILE_CONTEXT_MENU` должен открывать `/reviewer`.

### Task 2.1: Тест — install биндит IMMOBILE_CONTEXT_MENU

**Files:**
- Test: `backends/node/api/tests/placementBind.test.js` (новый)

- [ ] **Step 1: Извлечь функцию привязки в экспортируемую и протестировать**

Сначала проверь: экспортируется ли логика привязки. Сейчас `ensureRestAppUriPlacement` — локальная в server.js. Чтобы её протестировать, вынеси её в новый модуль `src/bitrix/placementBinder.js` (экспорт `ensureAppPlacements`) и импортируй в server.js. Тест:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAppPlacements } from '../src/bitrix/placementBinder.js';

test('ensureAppPlacements binds both REST_APP_URI and IMMOBILE_CONTEXT_MENU when none exist', async () => {
  const bound = [];
  const bitrixClient = {
    async callMethodWithAuth(method, payload) {
      if (method === 'placement.get') return [];
      if (method === 'placement.bind') { bound.push(payload.PLACEMENT); return true; }
      return null;
    }
  };
  await ensureAppPlacements({ bitrixClient, authId: 'a1', context: {}, handlerUrl: 'https://app.example/' });
  assert.ok(bound.includes('REST_APP_URI'));
  assert.ok(bound.includes('IMMOBILE_CONTEXT_MENU'));
});

test('ensureAppPlacements does not rebind an already-bound placement', async () => {
  const bound = [];
  const bitrixClient = {
    async callMethodWithAuth(method, payload) {
      if (method === 'placement.get') return [{ placement: 'REST_APP_URI' }, { placement: 'IMMOBILE_CONTEXT_MENU' }];
      if (method === 'placement.bind') { bound.push(payload.PLACEMENT); return true; }
      return null;
    }
  };
  await ensureAppPlacements({ bitrixClient, authId: 'a1', context: {}, handlerUrl: 'https://app.example/' });
  assert.equal(bound.length, 0);
});
```

- [ ] **Step 2: Запустить — FAIL (модуля ещё нет)**

Run: `cd backends/node/api && node --test tests/placementBind.test.js`
Expected: FAIL — `Cannot find module '../src/bitrix/placementBinder.js'`.

### Task 2.2: Вынести и обобщить привязку встроек

**Files:**
- Create: `backends/node/api/src/bitrix/placementBinder.js`
- Modify: `backends/node/api/server.js:141-215,838-859`

- [ ] **Step 1: Создать placementBinder.js**

Перенеси логику из server.js (141-215) в модуль, обобщив на список встроек. Содержимое:
```js
const PLACEMENTS = [
  {
    code: 'REST_APP_URI',
    title: 'Фото-отчёт АЗС',
    description: 'Открытие отчёта АЗС по ссылке из уведомления',
    en: { title: 'AZS Photo Report', description: 'Open AZS photo report from bot link' }
  },
  {
    code: 'IMMOBILE_CONTEXT_MENU',
    title: 'Порядок на АЗС',
    description: 'Открыть интерфейс управляющего АЗС',
    en: { title: 'AZS Order', description: 'Open AZS reviewer interface' }
  }
];

const bindOne = async ({ bitrixClient, authId, context, handlerUrl, p }) => {
  await bitrixClient.callMethodWithAuth('placement.bind', {
    PLACEMENT: p.code,
    HANDLER: handlerUrl,
    TITLE: p.title,
    DESCRIPTION: p.description,
    LANG_ALL: {
      ru: { TITLE: p.title, DESCRIPTION: p.description, GROUP_NAME: '' },
      en: { TITLE: p.en.title, DESCRIPTION: p.en.description, GROUP_NAME: '' }
    }
  }, authId, context).catch(async (error) => {
    if (!String(error?.message || '').includes('ERROR_PLACEMENT_MAX_COUNT')) throw error;
    const after = await bitrixClient.callMethodWithAuth('placement.get', {}, authId, context);
    const list = Array.isArray(after) ? after : [];
    if (!list.find((row) => String(row?.placement || '').trim() === p.code)) throw error;
  });
};

export const ensureAppPlacements = async ({ bitrixClient, authId, context, handlerUrl }) => {
  if (!authId) throw new Error('AUTH_ID is required to bind placements');
  if (!handlerUrl) throw new Error('APP_BASE_URL or VIRTUAL_HOST is required to bind placements');
  const placements = await bitrixClient.callMethodWithAuth('placement.get', {}, authId, context);
  const existing = new Set((Array.isArray(placements) ? placements : []).map((r) => String(r?.placement || '').trim()));
  const results = [];
  for (const p of PLACEMENTS) {
    if (existing.has(p.code)) { results.push({ code: p.code, alreadyExists: true }); continue; }
    await bindOne({ bitrixClient, authId, context, handlerUrl, p });
    results.push({ code: p.code, alreadyExists: false });
  }
  return { bound: true, handler: handlerUrl, placements: results };
};

export default ensureAppPlacements;
```

- [ ] **Step 2: Переключить server.js на новый модуль**

1. Удали локальную `ensureRestAppUriPlacement` (141-215) из server.js.
2. Добавь импорт вверху: `import { ensureAppPlacements } from './src/bitrix/placementBinder.js';`
3. В install-флоу (838-859) замени вызов `ensureRestAppUriPlacement({...})` на `ensureAppPlacements({ bitrixClient, authId, context, handlerUrl })`. Подгони обработку результата (раньше читались `restAppUri`/`alreadyExists` — теперь `result.placements`-массив; в ответе install верни его как есть или сведи к прежней форме, не ломая фронт `install.client.vue`).

- [ ] **Step 3: Запустить тесты — PASS**

Run: `cd backends/node/api && node --test tests/placementBind.test.js && node --check server.js`
Expected: PASS; синтаксис server.js ок.

- [ ] **Step 4: Commit (backend РЭ-2)**

```bash
git add backends/node/api/src/bitrix/placementBinder.js backends/node/api/server.js backends/node/api/tests/placementBind.test.js && \
git commit -m "feat(PLACEMENT): привязка IMMOBILE_CONTEXT_MENU рядом с REST_APP_URI (идемпотентно)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.3: Фронт — placement IMMOBILE_CONTEXT_MENU открывает /reviewer

**Files:**
- Modify: `frontend/app/pages/index.client.vue:199-260,336-382`

- [ ] **Step 1: Определять placement по title и роутить на /reviewer**

В `parsePlacementOptions`/роутинге (199-260, 336-382) добавь в начале логики выбора экрана (перед `contextReportId`-веткой, ~стр. 356):
```ts
const placementTitle = String(($frame as any)?.placement?.title || route.query?.PLACEMENT || '').trim()
if (placementTitle === 'IMMOBILE_CONTEXT_MENU') {
  await navigateTo('/reviewer')
  return
}
```
(Подгони доступ к `$frame.placement.title` под фактический способ чтения placement в этом файле — там уже есть `$frame.placement?.options`.)

- [ ] **Step 2: Заглушка для оператора без прав reviewer**

Экран `/reviewer` уже гейтируется по capability `reviewer`. Убедись, что при отсутствии права показывается понятное сообщение «Этот раздел для управляющего» (а не пустой экран/краш). Если такой заглушки нет — добавь в `reviewer.client.vue` ранний `v-if="!caps.reviewer"` блок с текстом.

- [ ] **Step 3: Smoke-верификация**

В мобильном Битрикс открой чат → контекстное меню → пункт «Порядок на АЗС» → должен открыться дашборд управляющего. Для управляющего — дашборд; для оператора — заглушка. Зафиксируй пруф.

- [ ] **Step 4: Commit (frontend РЭ-2)**

```bash
git add frontend/app/pages/index.client.vue frontend/app/pages/reviewer.client.vue && \
git commit -m "feat(PLACEMENT-UI): IMMOBILE_CONTEXT_MENU открывает дашборд управляющего

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# ФАЗА РЭ-4 — Юзер-гайд: актуализировать и вывести на все экраны

**Контекст:** `HelpGuide.vue` уже имеет 3 вкладки (Администратор АЗС / Управляющий / Настройки). Контент устарел; кнопка «Справка» только на reviewer.

### Task 4.1: Актуализировать контент трёх вкладок

**Files:**
- Modify: `frontend/app/components/help/HelpGuide.vue`

- [ ] **Step 1: Обновить вкладку «Администратор АЗС»**

Перепиши секции под текущее поведение. Обязательно отрази: запросы приходят **сообщением бота в чат Битрикс** (не колокольчик); как открыть задание из сообщения; съёмка живого фото; статусы (в работе / сдан / просрочен). Добавь пункт «Если не пришло сообщение — проверьте, что бот приложения не отключён в чатах».

- [ ] **Step 2: Обновить вкладку «Управляющий»**

Отрази: сводка за период; лента событий; **новый блок «План на день»** (просмотр слотов, отмена/пересоздание, перевыпуск дня, запрос вне расписания); фотолента (фильтры, пересылка фото в чаты); открытие интерфейса из контекстного меню чата (IMMOBILE_CONTEXT_MENU).

- [ ] **Step 3: Обновить вкладку «Настройки»**

Отрази: привязка смарт-процессов; поле «Администратор АЗС»; обязательные фото; расписание/таймаут/джиттер; роли (admin/reviewer/azs_admin); бренды и внешний доступ к фото; «уведомления только через бота» + что для этого нужно (бот зарегистрирован, `BITRIX_BOT_MODE=bot`).

- [ ] **Step 4: Smoke — открыть каждую вкладку, проверить отсутствие устаревших/пустых секций.**

### Task 4.2: Вывести кнопку «Справка» на все экраны

**Files:**
- Modify: `frontend/app/pages/index.client.vue`, `settings.client.vue`, `reports.client.vue`, `brands.client.vue`, `admin/[reportId].client.vue`

- [ ] **Step 1: Добавить HelpButton в шапку каждого экрана**

По образцу reviewer (`<HelpButton default-role="reviewer" class="w-7 h-7" />`) добавь в шапку:
- `index.client.vue` → `default-role="reviewer"` (или роль текущего пользователя);
- `settings.client.vue`, `brands.client.vue` → `default-role="settings"`;
- `reports.client.vue` → `default-role="reviewer"`;
- `admin/[reportId].client.vue` → `default-role="admin"`.

Если `HelpButton` не авто-импортится — добавь `import HelpButton from '~/components/help/HelpButton.vue'`.

- [ ] **Step 2: Smoke — на каждом из 6 экранов видна кнопка «Справка», открывает drawer на нужной вкладке.**

- [ ] **Step 3: Commit (РЭ-4)**

```bash
git add frontend/app/components/help/HelpGuide.vue frontend/app/pages/ && \
git commit -m "docs(GUIDE): актуализирован ролевой гайд + кнопка «Справка» на всех экранах

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# Финал спринта — деплой

- [ ] **Bump BUILD_REV обеих стадий Dockerfile** (frontend-builder и api-builder) на `2026-06-26-sprint9` — иначе Timeweb buildkit отдаст старый код из layer-кэша (см. [[timeweb-deploy-buildcache]]).
- [ ] **FF-пуш в master**, дождаться деплоя.
- [ ] **Пост-деплой:** `JOB_SECRET` в env; `BITRIX_BOT_MODE=bot`; «Перерегистрировать бота» (иначе bot-only без рабочего бота = ни одного уведомления, только алерты-undelivered в логе).
- [ ] **Пруф деплоя:** греп имени `_nuxt`-чанка на проде сменилось; в логах `notification_delivery channel=bot`, нет `im.notify`.

---

## Замечания по верификации
- Бэкенд: полноценный TDD на `node:test`, прогон `node --test tests/`.
- Фронт: тест-харнесса в репо нет → smoke-верификация с фиксацией пруфа (скриншот/описание поведения) — соответствует практике репо.
- Перед merge — `superpowers:requesting-code-review`.
