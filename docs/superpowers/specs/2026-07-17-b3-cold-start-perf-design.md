# Дизайн: B3 — ускорение холодного старта приложения

> Дата: **2026-07-17**. Источник: [azs-remediation-plan-2026-07-06.md](../../azs-remediation-plan-2026-07-06.md) §3 · B3 (P1).
> Кодовая база: `frontend/app` (Nuxt 3, Vue 3, Pinia). Бэкенд в этом заходе **не трогаем**.
> Объём согласован с владельцем: **фронт-вины a+b+c**, Подход 1 (access-стор + идемпотентный init + мемоизация фрейма). Бэкенд-кэш `attachAccessContext` (d) — вне объёма.

---

## 1. Проблема (подтверждено кодом)

Холодный старт делает цепочку **последовательных** сетевых round-trip-ов, часть из которых дублируется на каждом экране и на каждой SPA-навигации.

**Единый фрейм-хендшейк вызывается многократно:**
- Глобальный middleware `middleware/01.app.page.or.slider.global.ts:43` вызывает `$initializeB24Frame()` на **каждую** смену маршрута.
- Затем `onMounted` **каждой** страницы вызывает `$initializeB24Frame()` ещё раз: `index.client.vue:342`, `admin/[reportId].client.vue:706`, `reports.client.vue:33`, `settings.client.vue:1190`.

**Старт `index.client.vue` — строго последовательный** (`onMounted:336` → `checkBackend:286`):
1. `$initializeB24Frame()` (`:342`)
2. `initApp()` (`:343`) — внутри `useAppInit.initApp:42` тяжёлый batch `initB24Helper` (`:50`): `app.info` + `app.option` + `user.option` + `currency` + `profile`.
3. `$b24.parent.setTitle()` (`:344`)
4. `checkBackend()` (`:350`) — тоже последовательно:
   - `ensureFreshToken({force:true})` при `!isInitTokenJWT` (`:289`) — `POST /api/getToken`.
   - `checkHealth()` (`:292`) — `GET /api/health`.
   - `getMyRole()` (`:295`) — `GET /api/me/role`.
   `checkHealth` и `getMyRole` **независимы** после токена, но идут друг за другом.

**Роль не переживает навигацию.** `getMyRole()` вызывают **6 страниц**, у каждой свой локальный `currentRole` и (в 2 местах) свой `applyLocalPortalAdminFallback`:
`index.client.vue:295`, `settings.client.vue:967`, `reports.client.vue:36`, `brands.client.vue:321`, `reviewer.client.vue:772`, `admin/[reportId].client.vue:710`.
Переход `index → любой экран` заново гоняет `initApp` (batch) + `getMyRole`.

Факт из плана: прод-фронт `/` = 200 за ~5.3 с; цель по замеру — заметно быстрее (ориентир <2.5 с на прод-сети).

## 2. Цель и не-цели

**Цель:** убрать дублирующие и последовательные вызовы на старте и между экранами, не меняя наблюдаемого поведения (резолв роли, редиректы, прямой вход на отчёт из бота).

**Не-цели (вне объёма этого захода):**
- Бэкенд-кэш настроек в `attachAccessContext` (пункт d плана).
- B2 (401/`auth_context` при возврате), B8/B4 (загрузка/кнопка «Сдать») — отдельные задачи.
- Любой рефакторинг, не служащий ускорению старта.

## 3. Дизайн

Пять хорошо ограниченных единиц. Каждую можно понять и проверить отдельно.

### 3.1 `composables/useB24Frame.ts` (новый) — мемоизация фрейма
Модульный синглтон, кэширующий **промис** `$initializeB24Frame()`:

```ts
import type { B24Frame } from '@bitrix24/b24jssdk'

let framePromise: Promise<B24Frame> | null = null

export function useB24Frame() {
  const { $initializeB24Frame } = useNuxtApp()
  const getFrame = (): Promise<B24Frame> => (framePromise ??= $initializeB24Frame())
  const resetFrame = (): void => { framePromise = null } // на случай фатальной ошибки инициализации
  return { getFrame, resetFrame }
}
```

- Middleware и все страницы берут фрейм через `getFrame()` вместо прямого `$initializeB24Frame()` → **один хендшейк на сессию**, переиспользуется на всех SPA-переходах.
- В demo-режиме мемоизация даёт единый стабильный мок (сейчас `initializeB24Frame` demo-плагина создаёт новый мок на каждый вызов).
- **Кэшируем промис, не значение** — конкурентные вызовы (middleware + onMounted почти одновременно) не создают два хендшейка.
- При фатальной ошибке инициализации в middleware вызвать `resetFrame()`, чтобы повтор был возможен.

### 3.2 `stores/access.ts` (новый Pinia-стор) — кэш роли/capabilities
Единый источник роли на сессию.

```ts
// состояние
role: AppRole            // дефолт 'azs_admin'
capabilities: AppCapabilities  // { settings, reviewer, reports }
loaded: boolean          // роль уже получена в этой сессии

// действия
async ensureRole(api, opts?: { force?: boolean }): Promise<void>
applyPortalAdminFallback(isPortalAdmin: boolean): void
setFromRoleResponse(res): void   // из getMyRole
setFromHealth(health): void      // фоллбэк из checkHealth (partial capabilities)
```

- `ensureRole` вызывает `api.getMyRole()` **только если** `!loaded || force`; иначе no-op (данные уже в сторе). Ошибку `getMyRole` глотает как сейчас (в `index` уже `try/catch` с фоллбэком на `health`).
- `applyPortalAdminFallback` централизует нынешний дубль (`index.client.vue:52-62` и аналог в `settings`): если `userStore.isAdmin` → `role='admin'`, все capabilities `true`.
- Приоритет источников сохраняем как в текущем `index` (`:300-311`): `getMyRole.role` > `health.role`; capabilities — из `getMyRole`, иначе из `health`.
- Типы `AppRole` / `AppCapabilities` — переиспользуем существующие (объявлены в `stores/api.ts`).

### 3.3 `useAppInit.initApp` — идемпотентность тяжёлого batch
Флаг `isInitB24Helper` уже есть (`useAppInit.ts:18`, ставится в `:60`), но `initApp` вызывает `initB24Helper` безусловно (`:50`).

```ts
if (!isInitB24Helper.value) {
  await initB24Helper($b24, [App, AppOptions, UserOptions, Currency, Profile])
  isInitB24Helper.value = true
}
// стор-популяция из getB24Helper() остаётся всегда — идемпотентна и дёшева
```

- Сетевой batch не повторяется на повторных `initApp` (переход index→отчёт, прямой вход).
- Чтение `getB24Helper().appInfo/appOptions/...` и запись в сторы (`user.initFromBatch`, `appSettings.*`, `userSettings.*`, `api.init`) **оставляем** — это локальные операции, безопасно повторять; они гарантируют, что сторы заполнены и на прямом входе.

### 3.4 `index.checkBackend` — параллелизация независимых вызовов
```ts
if (!apiStore.isInitTokenJWT) {
  await apiStore.ensureFreshToken({ force: true })
}
const [health, roleResponse] = await Promise.all([
  apiStore.checkHealth(),
  apiStore.getMyRole().catch(() => null)   // сохраняем текущую терпимость к падению роли
])
// результат → accessStore.setFromRoleResponse / setFromHealth (+ applyPortalAdminFallback)
```

- `checkHealth` + `getMyRole` идут параллельно (оба зависят только от токена) — минус один round-trip.
- Роль/capabilities пишем в `accessStore`, а не в локальные `ref`.

### 3.5 Миграция потребителей роли (6 страниц)
`apiStore.getMyRole()` → `accessStore.ensureRole(apiStore)`; локальные `currentRole`/`currentCapabilities` читают из `accessStore` (через `storeToRefs` / computed).
Затрагиваются: `index`, `settings`, `reports`, `brands`, `reviewer`, `admin/[reportId]`.
Правка однотипная. После первого `ensureRole` навигация между экранами роль **не рефетчит**.

### 3.6 Dev-only тайминг-маркеры
Вокруг фаз старта (frame / initApp / token / health+role) — маркеры под `import.meta.dev`:

```ts
if (import.meta.dev) console.time('[b3] frame'); ... console.timeEnd('[b3] frame')
```

В прод-сборку не попадают. Нужны только для замера before/after в demo-режиме.

## 4. Поток данных — старт после изменений

```
middleware: getFrame() ─┐ (мемо)
index.onMounted:        └─> getFrame() [reuse] → initApp() [batch 1 раз]
                             → Promise.all( checkHealth, getMyRole ) → accessStore
                             → навигация по role из accessStore
отчёт.onMounted (переход или диплинк):
                             getFrame() [reuse] → initApp() [batch skip]
                             → accessStore.ensureRole() [no-op, уже loaded]
```

Итог: 1 фрейм-хендшейк, 1 batch, `health`+`role` параллельно, роль кэширована.

## 5. Верификация

**Тайминг (demo-режим `NUXT_PUBLIC_DEMO=1`):** через Browser-панель открыть старт, снять водопад `/api/*` и dev-маркеры before/after; зафиксировать сокращение (число round-trip-ов и суммарное время фаз старта).

**Ручной смоук-чеклист (обязателен перед коммитом):**
1. Роль `admin` (портал-админ): меню показывает все экраны; переход index→settings→reports→brands→reviewer не рефетчит роль (проверить в Network).
2. Роль `reviewer`: доступен экран проверяющего; нет доступа к settings.
3. Роль `azs_admin`: при наличии активного отчёта — редирект на `/admin/:id`; при отсутствии — экран ожидания.
4. **Прямой вход на `/admin/:reportId`** (диплинк из бота, index не открывался): фрейм и данные инициализируются, роль резолвится, экран отчёта работает.
5. Фоллбэк: бэкенд недоступен, но пользователь портал-админ → `applyPortalAdminFallback` даёт роль `admin` (не «голая» ошибка).
6. Переключение ролей/повторный вход не залипает на устаревшей кэш-роли (при необходимости — `ensureRole({force:true})`).

Фронт-тест-раннера нет — проверки ручные (зафиксировано в backlog-master).

## 6. Риски и митигции

| Риск | Митигция |
|---|---|
| Мемоизация стороннего `$initializeB24Frame` ломает контекст | Родительский фрейм один на весь SPA-сеанс → переиспользование корректно; `resetFrame()` на фатальной ошибке init. Проверяется чек-листом (прямой вход + навигация). |
| Идемпотентный `initApp` ломает прямой вход на отчёт | Гард — по `isInitB24Helper`, не по «index уже отработал»: на прямом входе флаг `false` → batch выполняется один раз. Стор-популяция остаётся всегда. Чек-лист п.4. |
| Устаревшая кэш-роль при смене прав | Роль стабильна в пределах сессии; на подозрение — `ensureRole({force:true})`. Чек-лист п.6. |
| Регресс резолва роли (приоритет health vs getMyRole) | Сохраняем текущую логику приоритета (`index:300-311`) внутри `accessStore.setFrom*`. |
| Миграция 6 страниц вносит расхождения | Правка однотипная; каждую страницу проверяем по роли в чек-листе. |

## 7. Файлы

**Новые:** `frontend/app/composables/useB24Frame.ts`, `frontend/app/stores/access.ts`.
**Правки:** `frontend/app/composables/useAppInit.ts`, `frontend/app/middleware/01.app.page.or.slider.global.ts`, `frontend/app/pages/index.client.vue`, `frontend/app/pages/settings.client.vue`, `frontend/app/pages/reports.client.vue`, `frontend/app/pages/brands.client.vue`, `frontend/app/pages/reviewer.client.vue`, `frontend/app/pages/admin/[reportId].client.vue`.

## 8. Открытые вопросы
Нет. Объём, подход и верификация согласованы.
