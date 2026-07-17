# B3 — Ускорение холодного старта · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать дублирующие и последовательные вызовы на холодном старте фронта — один фрейм-хендшейк на сессию, один batch, `health`+`role` параллельно, роль кэшируется между экранами — не меняя наблюдаемого поведения.

**Architecture:** Три новые единицы (`~/types/access` — общий тип роли; `stores/access.ts` — Pinia-кэш роли/capabilities; `composables/useB24Frame.ts` — мемоизация фрейм-промиса) + идемпотентный `initApp` + параллелизация `index.checkBackend`. Шесть страниц переводятся с прямого `getMyRole()` на кэширующий `accessStore.ensureRole()`.

**Tech Stack:** Nuxt 3 / Vue 3 (composition), Pinia (`@pinia/nuxt`, setup-стиль), `@bitrix24/b24jssdk`. Алиас `~` → `frontend/app`.

> **⚠️ Верификация без тест-раннера.** Во фронте нет vitest/jest (только `npm run lint` = eslint и `npm run build` = nuxt/vue-tsc typecheck). Добавление тест-харнесса — вне объёма (владелец выбрал верификацию demo-таймингом + ручным чеклистом). Поэтому автоматический гейт на каждую задачу = **`npm run lint`**; структурные задачи дополнительно проверяются **`npm run build`**; поведение — **ручной смоук в demo-режиме** (`NUXT_PUBLIC_DEMO=1`). Это осознанное отклонение от TDD-дефолта навыка, продиктованное отсутствием раннера.

> **Рабочая директория для всех команд:** `frontend/`.

---

## Карта файлов

**Создаются:**
- `frontend/app/types/access.ts` — общие типы `AppRole`, `AppCapabilities` (единый источник).
- `frontend/app/stores/access.ts` — `useAccessStore`: кэш роли/capabilities + `ensureRole`/`applyPortalAdminFallback`.
- `frontend/app/composables/useB24Frame.ts` — мемоизированный `getFrame()`.

**Модифицируются:**
- `frontend/app/stores/api.ts` — типы `AppRole`/`AppCapabilities` → импорт из `~/types/access` (дедуп).
- `frontend/app/pages/settings.client.vue` — то же (дедуп локального типа) + миграция роли.
- `frontend/app/composables/useAppInit.ts` — идемпотентный batch.
- `frontend/app/middleware/01.app.page.or.slider.global.ts` — фрейм через `getFrame()`.
- `frontend/app/pages/index.client.vue` — параллелизация `checkBackend` + запись в `accessStore` + фрейм + тайминг-маркеры.
- `frontend/app/pages/reports.client.vue`, `brands.client.vue`, `reviewer.client.vue`, `admin/[reportId].client.vue` — фрейм через `getFrame()` + миграция роли на `accessStore`.

**Не трогаем:** `install.client.vue` (отдельный one-shot OAuth-flow до старта приложения).

---

## Task 1: Общий тип роли (`~/types/access`) + дедуп

**Files:**
- Create: `frontend/app/types/access.ts`
- Modify: `frontend/app/stores/api.ts:64-70`
- Modify: `frontend/app/pages/settings.client.vue:87-91`

- [ ] **Step 1: Создать файл общих типов**

`frontend/app/types/access.ts`:
```ts
export type AppRole = 'admin' | 'reviewer' | 'azs_admin'

export type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}
```

- [ ] **Step 2: `api.ts` — заменить локальные типы на импорт**

В `frontend/app/stores/api.ts` удалить локальные объявления (текущие строки 64-70):
```ts
type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}

type AppRole = 'admin' | 'reviewer' | 'azs_admin'
```
и добавить импорт в блок импортов вверху файла:
```ts
import type { AppRole, AppCapabilities } from '~/types/access'
```

- [ ] **Step 3: `settings.client.vue` — то же**

В `frontend/app/pages/settings.client.vue` удалить локальные объявления (текущие строки 87-91):
```ts
type AppRole = 'admin' | 'reviewer' | 'azs_admin'
type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}
```
и добавить в начало `<script setup>` (рядом с прочими импортами):
```ts
import type { AppRole, AppCapabilities } from '~/types/access'
```

- [ ] **Step 4: Линт**

Run: `npm run lint`
Expected: PASS (нет unused/undefined типов; `AppRole`/`AppCapabilities` резолвятся из `~/types/access`).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/types/access.ts frontend/app/stores/api.ts frontend/app/pages/settings.client.vue
git commit -m "refactor(B3): единый тип AppRole/AppCapabilities в ~/types/access"
```

---

## Task 2: Тайминг-маркеры старта + baseline «до»

Инструментируем старт ДО логических изменений, чтобы снять базовую структуру водопада.

**Files:**
- Modify: `frontend/app/pages/index.client.vue` (внутри `onMounted:336` и `checkBackend:286`)

- [ ] **Step 1: Обернуть фазы старта dev-only маркерами**

В `index.client.vue`, в `onMounted` (текущий блок ~336-351), обернуть фазы:
```ts
onMounted(async () => {
  try {
    isLoading.value = true
    initStepIndex.value = 0

    if (import.meta.dev) console.time('[b3] frame')
    $b24 = await $initializeB24Frame()
    if (import.meta.dev) console.timeEnd('[b3] frame')

    if (import.meta.dev) console.time('[b3] initApp')
    await initApp($b24, localesI18n, setLocale)
    if (import.meta.dev) console.timeEnd('[b3] initApp')

    await $b24.parent.setTitle(PAGE_TITLE)
    applyLocalPortalAdminFallback()
    initStepIndex.value = 1

    const contextReportId = resolveContextReportId($b24)
    if (import.meta.dev) console.time('[b3] checkBackend')
    await checkBackend()
    if (import.meta.dev) console.timeEnd('[b3] checkBackend')
    initStepIndex.value = 2
    // ...остальное без изменений
```

- [ ] **Step 2: Линт**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Снять baseline в demo-режиме**

Run: `NUXT_PUBLIC_DEMO=1 npm run dev`
Открыть приложение в браузере, DevTools → Network (фильтр `Fetch/XHR`, «Preserve log» off) + Console.
Зафиксировать в заметке (для сравнения в Task 9):
- сколько раз вызван фрейм-init и `/api/*` на холодном старте `/`;
- идут ли `/api/health` и `/api/me/role` **последовательно** (старт второго после ответа первого);
- при переходе `index → /admin/:id` — повторяются ли batch-вызовы (`app.info`/`app.option`/`profile`) и `me/role`.
- значения `[b3] frame/initApp/checkBackend` из Console.

Ожидаемый baseline (из спеки §1): фрейм-init 2× (middleware+страница), batch на каждом экране, `health`→`role` последовательно, `me/role` на каждом из 6 экранов.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/pages/index.client.vue
git commit -m "chore(B3): dev-only тайминг-маркеры фаз старта (baseline)"
```

---

## Task 3: `useAccessStore` — кэш роли/capabilities

**Files:**
- Create: `frontend/app/stores/access.ts`

- [ ] **Step 1: Создать стор**

`frontend/app/stores/access.ts`:
```ts
import type { AppRole, AppCapabilities } from '~/types/access'

type RoleResponse = {
  role: AppRole
  capabilities: AppCapabilities
}

type HealthLike = {
  role?: AppRole | null
  capabilities?: Partial<AppCapabilities> | null
}

/**
 * Единый источник роли/прав на сессию.
 * Заполняется один раз (index.checkBackend или ensureRole),
 * переживает SPA-навигацию → экраны не рефетчат /api/me/role.
 */
export const useAccessStore = defineStore('access', () => {
  const role = ref<AppRole>('azs_admin')
  const capabilities = ref<AppCapabilities>({ settings: false, reviewer: false, reports: true })
  const loaded = ref(false)

  function setFromRoleResponse(res: RoleResponse | null): void {
    if (!res?.role) return
    role.value = res.role
    if (res.capabilities) {
      capabilities.value = {
        settings: Boolean(res.capabilities.settings),
        reviewer: Boolean(res.capabilities.reviewer),
        reports: Boolean(res.capabilities.reports)
      }
    }
    loaded.value = true
  }

  // Фоллбэк из /api/health (partial capabilities). Роль перекрывает
  // только если своя ещё не выставлена getMyRole-ответом.
  function setFromHealth(health: HealthLike | null): void {
    if (health?.role && !loaded.value) {
      role.value = health.role
    }
    if (health?.capabilities && !loaded.value) {
      capabilities.value = {
        settings: Boolean(health.capabilities.settings),
        reviewer: Boolean(health.capabilities.reviewer),
        reports: Boolean(health.capabilities.reports)
      }
    }
  }

  // Портал-админ → всегда admin со всеми правами (override).
  function applyPortalAdminFallback(isPortalAdmin: boolean): void {
    if (!isPortalAdmin) return
    role.value = 'admin'
    capabilities.value = { settings: true, reviewer: true, reports: true }
  }

  // Дёргает /api/me/role только если роль ещё не загружена (или force).
  async function ensureRole(opts: { force?: boolean } = {}): Promise<void> {
    if (loaded.value && !opts.force) return
    const api = useApiStore()
    try {
      const res = await api.getMyRole()
      setFromRoleResponse(res)
    } catch (error) {
      console.warn('[access] getMyRole failed', error)
    }
  }

  return {
    role,
    capabilities,
    loaded,
    setFromRoleResponse,
    setFromHealth,
    applyPortalAdminFallback,
    ensureRole
  }
})
```

- [ ] **Step 2: Линт**

Run: `npm run lint`
Expected: PASS (`useApiStore`/`defineStore`/`ref` авто-импортируются Nuxt+Pinia; тип импортирован).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/stores/access.ts
git commit -m "feat(B3): useAccessStore — кэш роли/capabilities на сессию"
```

---

## Task 4: `useB24Frame` — мемоизация фрейм-промиса

**Files:**
- Create: `frontend/app/composables/useB24Frame.ts`

- [ ] **Step 1: Создать composable**

`frontend/app/composables/useB24Frame.ts`:
```ts
import type { B24Frame } from '@bitrix24/b24jssdk'

// Модульный синглтон: один фрейм-хендшейк на весь SPA-сеанс.
// Кэшируем ПРОМИС (не значение) — конкурентные вызовы (middleware + onMounted)
// схлопываются в один хендшейк.
let framePromise: Promise<B24Frame> | null = null

export function useB24Frame() {
  const { $initializeB24Frame } = useNuxtApp()

  const getFrame = (): Promise<B24Frame> => {
    if (!framePromise) {
      framePromise = ($initializeB24Frame as () => Promise<B24Frame>)()
    }
    return framePromise
  }

  // Сбросить кэш, чтобы следующий getFrame() переинициализировал
  // (напр. после фатальной ошибки init в middleware).
  const resetFrame = (): void => {
    framePromise = null
  }

  return { getFrame, resetFrame }
}
```

- [ ] **Step 2: Линт**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/composables/useB24Frame.ts
git commit -m "feat(B3): useB24Frame — мемоизация фрейм-промиса на сессию"
```

---

## Task 5: Идемпотентный `initApp`

**Files:**
- Modify: `frontend/app/composables/useAppInit.ts:50-60`

- [ ] **Step 1: Спрятать batch за флагом `isInitB24Helper`**

В `useAppInit.ts`, в `initApp` заменить безусловный вызов `initB24Helper` (текущие строки ~50-60):
```ts
    await initB24Helper(
      $b24,
      [
        LoadDataType.App,
        LoadDataType.AppOptions,
        LoadDataType.UserOptions,
        LoadDataType.Currency,
        LoadDataType.Profile
      ]
    )
    isInitB24Helper.value = true
```
на идемпотентный:
```ts
    // Тяжёлый batch (app.info/app.option/user.option/currency/profile) — один раз
    // на сессию. Повторный initApp (переход index→отчёт, прямой вход) сеть не гоняет;
    // стор-популяция ниже читает уже загруженный getB24Helper() и безопасно повторяется.
    if (!isInitB24Helper.value) {
      await initB24Helper(
        $b24,
        [
          LoadDataType.App,
          LoadDataType.AppOptions,
          LoadDataType.UserOptions,
          LoadDataType.Currency,
          LoadDataType.Profile
        ]
      )
      isInitB24Helper.value = true
    }
```
Остальное (`const data = {...}` из `getB24Helper()` и запись в сторы) — **без изменений**.

- [ ] **Step 2: Линт + сборка (типы)**

Run: `npm run lint && npm run build`
Expected: PASS. (`build` подтверждает, что `getB24Helper()` доступен после гарда и типы не поехали.)

- [ ] **Step 3: Смоук — прямой вход**

Run: `NUXT_PUBLIC_DEMO=1 npm run dev`
Проверить: прямой вход на `/admin/<любой demo reportId>` (index не открывался) — экран отчёта инициализируется, данные грузятся (batch отработал один раз). Затем переход на `/` и обратно на отчёт — в Network batch **не повторяется**.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/composables/useAppInit.ts
git commit -m "perf(B3): идемпотентный initApp — batch один раз на сессию"
```

---

## Task 6: Мемоизированный фрейм в middleware и страницах

Заменяем прямые `$initializeB24Frame()` на `getFrame()`. `install.client.vue` не трогаем.

**Files:**
- Modify: `frontend/app/middleware/01.app.page.or.slider.global.ts:41-59`
- Modify: `frontend/app/pages/index.client.vue` (декларация + `onMounted`)
- Modify: `frontend/app/pages/reports.client.vue:33`
- Modify: `frontend/app/pages/settings.client.vue:1190`
- Modify: `frontend/app/pages/brands.client.vue:315`
- Modify: `frontend/app/pages/admin/[reportId].client.vue:706`

- [ ] **Step 1: Middleware**

В `middleware/01.app.page.or.slider.global.ts` заменить блок `try/catch` (строки 41-59):
```ts
  try {
    const { $initializeB24Frame } = useNuxtApp()
    await $initializeB24Frame()

    $logger.log('>> stop')
  } catch (error: unknown) {
    const appError = createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
      data: { description: 'Problem in middleware' },
      cause: error,
      fatal: true
    })

    $logger.error(appError)

    showError(appError)
    return Promise.reject(appError)
  }
```
на:
```ts
  const { getFrame, resetFrame } = useB24Frame()
  try {
    await getFrame()

    $logger.log('>> stop')
  } catch (error: unknown) {
    resetFrame() // дать возможность переинициализации на повторном заходе
    const appError = createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
      data: { description: 'Problem in middleware' },
      cause: error,
      fatal: true
    })

    $logger.error(appError)

    showError(appError)
    return Promise.reject(appError)
  }
```

- [ ] **Step 2: Страницы — заменить декларацию и вызовы**

В каждой из `index.client.vue`, `reports.client.vue`, `settings.client.vue`, `brands.client.vue`, `admin/[reportId].client.vue`:

Заменить строку декларации:
```ts
const { $initializeB24Frame } = useNuxtApp()
```
на:
```ts
const { getFrame } = useB24Frame()
```
И каждый вызов `await $initializeB24Frame()` → `await getFrame()`.
(В `index.client.vue` это в т.ч. строка внутри `onMounted` с тайминг-маркером `[b3] frame` из Task 2 — заменить `$initializeB24Frame()` на `getFrame()` внутри неё.)

Примечание: если в файле останется неиспользуемый `useNuxtApp`-импорт — eslint это подсветит; убрать, если `$initializeB24Frame` был единственным потребителем.

- [ ] **Step 3: Линт + сборка**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Смоук — фрейм-инициализация**

Run: `NUXT_PUBLIC_DEMO=1 npm run dev`
Проверить: приложение стартует; в Console нет ошибок фрейма; навигация `/` → `/reports` → `/settings` → `/` работает. В demo-режиме — единый мок-фрейм (нет ошибок дабл-инициализации).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/middleware/01.app.page.or.slider.global.ts frontend/app/pages/index.client.vue frontend/app/pages/reports.client.vue frontend/app/pages/settings.client.vue frontend/app/pages/brands.client.vue "frontend/app/pages/admin/[reportId].client.vue"
git commit -m "perf(B3): единый фрейм-хендшейк на сессию (useB24Frame в middleware+страницах)"
```

---

## Task 7: `index.checkBackend` — параллелизация + запись в `accessStore`

**Files:**
- Modify: `frontend/app/pages/index.client.vue:286-320` (`checkBackend`) + потребители `currentRole`/`currentCapabilities`

- [ ] **Step 1: Подключить accessStore и распараллелить health+role**

В `index.client.vue` добавить рядом с прочими сторами:
```ts
const accessStore = useAccessStore()
```
Заменить тело `checkBackend` (строки 286-319) на:
```ts
const checkBackend = async () => {
  try {
    if (!apiStore.isInitTokenJWT) {
      await apiStore.ensureFreshToken({ force: true })
    }

    // health и role независимы после токена — параллельно (минус один round-trip).
    const [health, roleResponse] = await Promise.all([
      apiStore.checkHealth(),
      apiStore.getMyRole().catch((roleError) => {
        console.warn('Role endpoint failed, using /api/health role payload', roleError)
        return null
      })
    ])

    accessStore.setFromHealth(health)
    accessStore.setFromRoleResponse(roleResponse)
    accessStore.applyPortalAdminFallback(userStore.isAdmin)

    healthStatus.value = 'ok'
    healthText.value = 'Backend доступен'
  } catch (error) {
    accessStore.applyPortalAdminFallback(userStore.isAdmin)
    healthStatus.value = 'error'
    healthText.value = `API ошибка: ${extractApiErrorMessage(error)}`
  }
}
```
Примечание: порядок `setFromHealth` → `setFromRoleResponse` сохраняет прежний приоритет (роль из `getMyRole` перекрывает health; `setFromHealth` пишет роль только пока `loaded=false`).

- [ ] **Step 2: `currentRole`/`currentCapabilities` → computed из стора**

Заменить локальные `ref` (строки 25-50) на computed поверх `accessStore` (`storeToRefs`), сохранив имена, чтобы шаблон и логика (`:365`, `:99-111`, `:470/503`) не менялись:
```ts
import { storeToRefs } from 'pinia'
// ...
const accessStore = useAccessStore()
const { role: currentRole, capabilities: currentCapabilities } = storeToRefs(accessStore)
```
Удалить прежний локальный `applyLocalPortalAdminFallback` (строки 52-62) и заменить его вызовы (`:316` уже убран в Step 1; `onMounted:345`) на:
```ts
accessStore.applyPortalAdminFallback(userStore.isAdmin)
```
(строку `applyLocalPortalAdminFallback()` в `onMounted` заменить на вызов выше).

- [ ] **Step 3: Линт + сборка**

Run: `npm run lint && npm run build`
Expected: PASS. (Проверяет, что `currentRole.value`/`currentCapabilities.value` как computed совместимы со всеми чтениями в файле.)

- [ ] **Step 4: Смоук по ролям с index**

Run: `NUXT_PUBLIC_DEMO=1 npm run dev`
Проверить (demo-роль переключается через demoData — см. заметку по demo):
- `admin`/портал-админ: меню показывает settings/reviewer/reports;
- в Network `/api/health` и `/api/me/role` стартуют **одновременно** (параллельно);
- редирект `azs_admin` при активном отчёте работает.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/pages/index.client.vue
git commit -m "perf(B3): параллельные health+role на старте, роль в accessStore"
```

---

## Task 8: Миграция потребителей роли (5 страниц)

Каждая страница: `await apiStore.getMyRole()` → `await accessStore.ensureRole()`, чтение из `accessStore`. Кэш → нет рефетча при навигации.

**Files:**
- Modify: `frontend/app/pages/settings.client.vue:965-975`
- Modify: `frontend/app/pages/reports.client.vue:36-38`
- Modify: `frontend/app/pages/brands.client.vue:320-330`
- Modify: `frontend/app/pages/reviewer.client.vue:770-778`
- Modify: `frontend/app/pages/admin/[reportId].client.vue:709-714`

- [ ] **Step 1: settings — `loadRoleContext`**

Добавить стор (рядом с прочими): `const accessStore = useAccessStore()`.
Заменить тело `loadRoleContext` (965-975):
```ts
    const response = await apiStore.getMyRole()
    currentRole.value = response.role || 'azs_admin'
    roleCapabilities.value = {
      settings: Boolean(response.capabilities?.settings),
      reviewer: Boolean(response.capabilities?.reviewer),
      reports: Boolean(response.capabilities?.reports)
    }
    applyPortalAdminFallback()
```
на:
```ts
    await accessStore.ensureRole()
    accessStore.applyPortalAdminFallback(userStore.isAdmin)
    currentRole.value = accessStore.role
    roleCapabilities.value = { ...accessStore.capabilities }
```
(Локальные `currentRole`/`roleCapabilities` и локальный `applyPortalAdminFallback` в settings оставляем — шаблон settings на них завязан; меняем только источник данных. `userStore` в settings уже используется.)

- [ ] **Step 2: reports**

Добавить `const accessStore = useAccessStore()`. Заменить (36-38):
```ts
    const roleResp = await apiStore.getMyRole()
    hasAccess.value = Boolean(
      roleResp.capabilities?.reviewer || roleResp.capabilities?.settings || roleResp.capabilities?.reports
    )
```
на:
```ts
    await accessStore.ensureRole()
    hasAccess.value = Boolean(
      accessStore.capabilities.reviewer || accessStore.capabilities.settings || accessStore.capabilities.reports
    )
```

- [ ] **Step 3: brands**

Добавить `const accessStore = useAccessStore()`. Заменить блок role-check (320-330):
```ts
    try {
      const role = await apiStore.getMyRole()
      isAdminReady.value = Boolean(role.capabilities?.settings)
    } catch {
      // portal-admin fallback
      const userStore = useUserStore()
      if (userStore.isAdmin) {
        isAdminReady.value = true
      }
    }
```
на:
```ts
    await accessStore.ensureRole()
    const userStore = useUserStore()
    accessStore.applyPortalAdminFallback(userStore.isAdmin)
    isAdminReady.value = Boolean(accessStore.capabilities.settings)
```

- [ ] **Step 4: reviewer — `loadRoleAccess`**

Добавить `const accessStore = useAccessStore()`. Заменить тело `loadRoleAccess` (770-778):
```ts
    const response = await apiStore.getMyRole()
    hasReviewerAccess.value = Boolean(response.capabilities?.reviewer || response.capabilities?.settings)
    hasSettingsAccess.value = Boolean(response.capabilities?.settings)
```
на:
```ts
    await accessStore.ensureRole()
    hasReviewerAccess.value = Boolean(accessStore.capabilities.reviewer || accessStore.capabilities.settings)
    hasSettingsAccess.value = Boolean(accessStore.capabilities.settings)
```

- [ ] **Step 5: admin/[reportId] — `onMounted`**

Добавить `const accessStore = useAccessStore()`. Заменить (709-714):
```ts
    try {
      const roleResponse = await apiStore.getMyRole()
      hasSettingsAccess.value = Boolean(roleResponse?.capabilities?.settings)
    } catch {
      // Ошибка получения роли — кнопка остаётся скрытой (безопасный дефолт)
    }
```
на:
```ts
    await accessStore.ensureRole()
    hasSettingsAccess.value = Boolean(accessStore.capabilities.settings)
```

- [ ] **Step 6: Линт + сборка**

Run: `npm run lint && npm run build`
Expected: PASS. Убрать неиспользуемые импорты, если eslint подсветит (напр. `apiStore` где больше не нужен).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/pages/settings.client.vue frontend/app/pages/reports.client.vue frontend/app/pages/brands.client.vue frontend/app/pages/reviewer.client.vue "frontend/app/pages/admin/[reportId].client.vue"
git commit -m "perf(B3): страницы читают роль из accessStore (кэш, без рефетча при навигации)"
```

---

## Task 9: Замер «после» + полный смоук-чеклист

**Files:** нет (верификация).

- [ ] **Step 1: Замер «после» в demo**

Run: `NUXT_PUBLIC_DEMO=1 npm run dev`
Снять те же метрики, что в Task 2 Step 3, и сравнить:
- фрейм-init — **1 раз** на сессию (было 2×);
- batch (`app.*`/`profile`) — **1 раз**, при переходе index→отчёт **не повторяется** (было на каждом экране);
- `/api/health` и `/api/me/role` — **параллельно** (было последовательно);
- `/api/me/role` — не вызывается повторно при навигации между экранами после первого (было на каждом из 6).

Зафиксировать before/after в заметке к коммиту/PR.

- [ ] **Step 2: Полный ручной смоук-чеклист (все роли + прямой вход)**

Пройти в demo (и, при доступности, на прод-стенде):
1. `admin`/портал-админ: все экраны в меню; навигация index→settings→reports→brands→reviewer без рефетча роли (Network).
2. `reviewer`: доступен экран проверяющего; нет settings.
3. `azs_admin`: активный отчёт → редирект `/admin/:id`; нет активного → экран ожидания.
4. **Прямой вход `/admin/:reportId`** (index не открывался): фрейм+данные инициализируются, роль резолвится, кнопка «Настройки» видна только при `capabilities.settings`.
5. Фоллбэк: бэкенд недоступен, пользователь портал-админ → роль `admin`, без «голой» ошибки.
6. Повторный вход/смена роли не залипает на устаревшей кэш-роли.

- [ ] **Step 3: Финальная сборка**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit (если были правки по итогам смоука) + сводка**

```bash
git add -A
git commit -m "test(B3): смоук all-roles + прямой вход; замер before/after холодного старта"
```
В сообщение/PR вынести before/after из Step 1.

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:** §3.1 useB24Frame → Task 4+6; §3.2 useAccessStore → Task 3 (+ потребители Task 7-8); §3.3 идемпотентный initApp → Task 5; §3.4 параллелизация → Task 7; §3.5 миграция 6 страниц → Task 7 (index) + Task 8 (5 страниц); §3.6 тайминг-маркеры → Task 2; §5 верификация → Task 2 (baseline) + Task 9 (after+смоук). Общий тип (обнаружен при написании плана: `AppRole` дублируется) → Task 1. Пробелов нет.

**Плейсхолдеры:** нет TBD/TODO; в каждом код-шаге — реальный код и точные пути.

**Консистентность типов/имён:** `AppRole`/`AppCapabilities` — единый источник `~/types/access` (Task 1), используется в `access.ts`, `api.ts`, `settings`. Методы стора (`ensureRole`, `setFromRoleResponse`, `setFromHealth`, `applyPortalAdminFallback`) названы одинаково в Task 3 и вызовах Task 7-8. `getFrame`/`resetFrame` — одинаково в Task 4 и Task 6.
