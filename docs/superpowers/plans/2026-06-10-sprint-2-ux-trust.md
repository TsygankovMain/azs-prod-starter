# Спринт 2 «Интерфейс, которому верят» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждое действие пользователя даёт видимый результат (успех/ошибка/процесс), ошибки перестают быть тупиком, ключевые мобильные сценарии оператора АЗС становятся эргономичными.

**Architecture:** Точечные правки страниц Nuxt 3 + два новых переиспользуемых слоя: toast-уведомления и confirm-диалог. Никаких изменений бэкенда. Все страницы — `*.client.vue` внутри iframe Битрикс24, компоненты — `@bitrix24/b24ui-nuxt` (префикс `B24`).

**Tech Stack:** Nuxt 3, Vue 3 Composition API, @bitrix24/b24ui-nuxt, Tailwind-классы проекта.

**Контекст для исполнителя (персоны):**
- **Оператор АЗС** — сдаёт фотоотчёт с телефона на бегу (страницы `admin/[reportId]`, `reason/[reportId]`, `index`).
- **Проверяющий (reviewer)** — массово проверяет отчёты с десктопа/планшета (`reviewer`).
- **Админ** — смотрит аналитику R1–R5 (`reports`), настраивает приложение (`settings`).

---

## Параметры спринта

| Параметр | Значение |
|---|---|
| Длительность | 2 недели |
| Состав | 1 frontend-разработчик (или fullstack) |
| Capacity (фокус-дни) | ~8 дней |
| Committed объём | 8 дней (S2-01…S2-07) |
| Зависимости | От спринта 1 не зависит; можно выполнять параллельно вторым человеком |

## Бэклог спринта

| ID | Задача | Оценка | Приоритет | Зависимости |
|---|---|---|---|---|
| S2-01 | Toast-слой уведомлений (composable + рендер) | 1 д | Must | — |
| S2-02 | Состояния действий проверяющего: pending/disabled/результат | 1.5 д | Must | S2-01 |
| S2-03 | Ошибки без тупика: error.vue + кнопки «Повторить» | 1.5 д | Must | — |
| S2-04 | Подтверждение массовых действий (confirm-диалог) | 1 д | Must | — |
| S2-05 | Скелетоны загрузки в аналитике R1–R5 и ленте reviewer | 1.5 д | Should | — |
| S2-06 | Мобильная эргономика страницы причины просрочки | 1 д | Should | — |
| S2-07 | Главная: обработка ошибки открытия отчёта + авто-проверка | 0.5 д | Should | S2-01 |
| S2-08 | (Stretch) Сохранение активной вкладки отчётов R1–R5 | 0.5 д | Could | — |
| S2-09 | (Stretch) Доступность: aria-pressed на фильтрах, эмодзи aria-hidden | 0.5 д | Could | — |
| S2-10 | (Stretch) Удалить неиспользуемый `BackendStatus.vue` | 0.25 д | Could | — |

**Вне скоупа:** редизайн экранов; тестовая инфраструктура фронтенда (vitest) — в спринте проверка ручными чек-листами + lint + build; изменения бэкенд-API.

**Верификация на каждом коммите:**

```bash
cd frontend && pnpm lint && pnpm build   # ожидаемо: без ошибок
```

Ручная проверка — через `make dev-node` и открытие приложения на dev-портале Битрикс24 (мобильные сценарии — эмуляция устройства в DevTools, ширина 390px).

---

### Task S2-01: Toast-слой уведомлений

**Files:**
- Create: `frontend/app/composables/useToast.ts`
- Create: `frontend/app/components/AppToasts.vue`
- Modify: `frontend/app/layouts/default.vue`, `frontend/app/layouts/placement.vue`, `frontend/app/layouts/slider.vue` (подключить `<AppToasts />`)

**Проблема (аудит):** обратная связь разбросана по inline-`B24Alert`; на длинных страницах (`settings`, `reviewer`) сообщение появляется вне вьюпорта — пользователь не видит результат «Сохранить»/«Отправить».

- [ ] **Step 1: Проверить, нет ли готового тоста в UI-ките** (чтобы не дублировать):

```bash
grep -ril "toast" frontend/node_modules/@bitrix24/b24ui-nuxt/dist | head
```

Если в b24ui есть рабочий Toast/useToast — использовать его, шаги 2–3 свести к обёртке-композаблу с тем же интерфейсом (`success`/`error`), чтобы страницы не зависели от библиотеки напрямую.

- [ ] **Step 2: Реализовать `useToast.ts`** (module-level state = синглтон; SSR не актуален — страницы client-only):

```ts
export interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

const items = ref<ToastItem[]>([]);
let nextId = 1;

export function useToast() {
  function push(kind: ToastItem['kind'], text: string, timeoutMs: number) {
    const id = nextId++;
    items.value = [...items.value, { id, kind, text }];
    if (timeoutMs > 0) setTimeout(() => dismiss(id), timeoutMs);
  }
  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id);
  }
  return {
    items,
    success: (text: string) => push('success', text, 4000),
    error: (text: string) => push('error', text, 7000), // ошибки висят дольше
    info: (text: string) => push('info', text, 4000),
    dismiss,
  };
}
```

- [ ] **Step 3: `AppToasts.vue`** — фиксированный контейнер, не перекрывающий нижнюю навигацию Битрикса:

```vue
<script setup lang="ts">
const { items, dismiss } = useToast();
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2">
    <B24Alert
      v-for="t in items"
      :key="t.id"
      :color="t.kind === 'error' ? 'danger' : t.kind === 'success' ? 'success' : 'primary'"
      :description="t.text"
      closable
      @close="dismiss(t.id)"
    />
  </div>
</template>
```

(Точные пропсы `B24Alert` — `color`/`closable` — сверить с использованием в существующих страницах, например в `reviewer.client.vue`; названия цветов взять оттуда же.)

- [ ] **Step 4: Подключить `<AppToasts />`** в конец template всех трёх layout'ов.

- [ ] **Step 5: Ручная проверка** — временно вызвать `useToast().success('test')` из любой страницы: тост появляется поверх контента, сам исчезает, крестик работает, на 390px не перекрывает контент. Временный вызов убрать.

- [ ] **Step 6:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "feat(ui): toast notification layer (useToast + AppToasts)"`

**Acceptance Criteria:**
- [ ] Тост виден из любой позиции скролла на всех layout'ах.
- [ ] Ошибки автоскрываются медленнее успехов и закрываются вручную.
- [ ] Никаких изменений в существующих inline-алертах (миграция — в задачах ниже).

---

### Task S2-02: Состояния действий проверяющего

**Files:**
- Modify: `frontend/app/pages/reviewer.client.vue` (`requestReportAgain` :541-564, `resyncReport` :611-623, feed-кнопки :1045-1058; образец правильного паттерна — `resyncingIds` :611, :1064)

**Проблема (аудит):** «Запросить повторно» и ресинк ловят ошибку только в `console.error` — проверяющий уверен, что запрос ушёл, а АЗС не получила push (операционный риск). Кнопки без `disabled`/спиннера: двойной тап = дубль ручного отчёта.

- [ ] **Step 1: Универсальный pending-хелпер в `<script setup>` страницы:**

```ts
const pendingActions = ref<Set<string>>(new Set());

async function withPending(key: string, fn: () => Promise<void>) {
  if (pendingActions.value.has(key)) return; // защита от двойного клика
  pendingActions.value = new Set(pendingActions.value).add(key);
  try {
    await fn();
  } finally {
    const next = new Set(pendingActions.value);
    next.delete(key);
    pendingActions.value = next;
  }
}
```

- [ ] **Step 2: Обернуть `requestReportAgain`:**

```ts
const toast = useToast();

async function requestReportAgain(/* существующие аргументы */) {
  await withPending(`again:${azsId}`, async () => {
    try {
      // ...существующий вызов apiStore.createManualReport(...)
      toast.success('Повторный запрос отправлен АЗС');
      await loadAll();
    } catch (error) {
      console.error('requestReportAgain failed', error);
      toast.error('Не удалось отправить запрос. Проверьте соединение и повторите.');
    }
  });
}
```

Аналогично — `resyncReport` (там pending уже есть через `resyncingIds`, добавить только `toast.error` в catch) и обработчики feed-кнопок (:1045-1058).

- [ ] **Step 3: Привязать состояние к кнопкам в template:**

```vue
<B24Button
  :disabled="pendingActions.has(`again:${item.azsId}`)"
  :loading="pendingActions.has(`again:${item.azsId}`)"
  @click="requestReportAgain(item)"
/>
```

(Если у `B24Button` нет prop `loading` — оставить `disabled` + текст «Отправляем…»; сверить по употреблению B24Button в этом же файле.)

- [ ] **Step 4: Ручной чек-лист:**
  - быстрый двойной клик по «Запросить повторно» → ровно один запрос в Network;
  - убить бэкенд (`docker stop` api) → клик → красный тост с текстом, кнопка разблокирована, консоль без unhandled rejection;
  - успешный запрос → зелёный тост + лента обновилась.

- [ ] **Step 5:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "fix(reviewer): pending state, double-click guard and visible result for reviewer actions"`

**Acceptance Criteria:**
- [ ] Ни одно действие проверяющего не завершается молча — всегда тост успеха или ошибки.
- [ ] Двойной клик не создаёт дубль ручного отчёта.
- [ ] Во время запроса кнопка визуально заблокирована.

---

### Task S2-03: Ошибки без тупика

**Files:**
- Modify: `frontend/app/error.vue` (:17-30)
- Modify: `frontend/app/pages/reviewer.client.vue`, `frontend/app/pages/reports.client.vue` (блоки `loadError`)
- Modify: `frontend/app/components/reports/R1Summary.vue:66-72`, `R4Card.vue:108-114`, `R5Wall.vue` (пустые catch у `getAzsOptions`)

**Проблема (аудит):** `error.vue` показывает технический текст («fetch failed», statusCode), содержит `console.log` в проде (:30) и не даёт действия (`clear=false`) — пользователь в iframe в тупике. На экранах данных ошибка загрузки — алерт без кнопки повтора. Сбой загрузки справочника АЗС молча оставляет фильтры пустыми.

- [ ] **Step 1: Переписать `error.vue`:** убрать `console.log`; человеческое сообщение + действие:

```ts
const friendlyMessage = computed(() => {
  const raw = String(props.error?.message ?? '');
  if (raw.includes('Unable to initialize Bitrix24Frame')) {
    return 'Приложение нужно открывать из портала Битрикс24.';
  }
  if (props.error?.statusCode === 404) return 'Страница не найдена.';
  return 'Не удалось загрузить приложение. Проверьте соединение и попробуйте ещё раз.';
});

function reloadApp() {
  window.location.reload();
}
```

В template: `friendlyMessage` + кнопка `B24Button` «Обновить» → `reloadApp()`. Техническую деталь (`error.message`) показывать мелким текстом под спойлером «Подробности» — поддержке пригодится, пользователя не пугает.

- [ ] **Step 2: Кнопка «Повторить» у ошибок загрузки** — в `reviewer.client.vue` и `reports.client.vue` рядом с алертом `loadError`:

```vue
<B24Alert color="danger" :description="loadError">
  <template #actions>
    <B24Button size="sm" @click="loadAll()">Повторить</B24Button>
  </template>
</B24Alert>
```

(Слот/способ вставки кнопки сверить с фактическим API B24Alert; допустимо разместить кнопку отдельной строкой под алертом.)

- [ ] **Step 3: Деградация фильтра АЗС стала видимой** — в `R1Summary.vue:66-72`, `R4Card.vue:108-114`, `R5Wall.vue` заменить пустой `catch {}`:

```ts
const azsOptionsError = ref(false);
try {
  // ...существующая загрузка getAzsOptions
  azsOptionsError.value = false;
} catch {
  azsOptionsError.value = true;
}
```

Рядом с фильтром при `azsOptionsError` — компактный текст «Список АЗС не загрузился» + кнопка-иконка повтора, вызывающая ту же загрузку.

- [ ] **Step 4: Ручной чек-лист:**
  - остановить бэкенд, открыть приложение → `error.vue` с человеческим текстом и рабочей кнопкой «Обновить» (после `docker start` обновление приводит на рабочую страницу);
  - остановить бэкенд на открытой странице reviewer, нажать «Повторить» после старта бэкенда → данные загрузились без перезагрузки iframe;
  - в консоли прода нет `console.log` из error.vue.

- [ ] **Step 5:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "feat(ux): human-readable error screen with reload, retry buttons on load errors, visible AZS-filter degradation"`

**Acceptance Criteria:**
- [ ] Ни одного экрана-тупика: у каждой ошибки есть действие (Обновить/Повторить).
- [ ] Технические сообщения скрыты под «Подробности».
- [ ] Сбой справочника АЗС виден пользователю и восстановим без перезагрузки.

---

### Task S2-04: Подтверждение массовых действий

**Files:**
- Create: `frontend/app/components/ConfirmDialog.vue`
- Create: `frontend/app/composables/useConfirm.ts`
- Modify: `frontend/app/pages/reviewer.client.vue` (`sendManualRequest` :498, `handleGeneratePlan`, `runTimeout`)

**Проблема (аудит):** в приложении нет ни одного confirm-диалога. «Запросить у N АЗС» рассылает push десяткам станций по одному клику без отката.

- [ ] **Step 1: `useConfirm.ts`** — промис-интерфейс:

```ts
interface ConfirmOptions {
  title: string;
  text: string;
  confirmLabel?: string;
}

const state = ref<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      state.value = { ...options, resolve };
    });
  }
  function answer(ok: boolean) {
    state.value?.resolve(ok);
    state.value = null;
  }
  return { state, confirm, answer };
}
```

- [ ] **Step 2: `ConfirmDialog.vue`** — на базе модалки UI-кита (`B24Modal`/`B24Dialog` — взять тот, что уже используется в проекте; если модалок нет — простая обёртка `fixed inset-0` + карточка). Кнопки: «Отмена» (secondary) и `confirmLabel` (primary). Подключить в те же layout'ы, что и AppToasts.

- [ ] **Step 3: Обернуть действия в `reviewer.client.vue`:**

```ts
const { confirm } = useConfirm();

async function sendManualRequest() {
  const count = selectedAzsIds.value.length; // фактическое имя коллекции взять из кода
  const ok = await confirm({
    title: 'Отправить запрос отчёта?',
    text: `Push-уведомление получат ${count} АЗС. Отменить рассылку будет нельзя.`,
    confirmLabel: `Отправить (${count})`,
  });
  if (!ok) return;
  // ...существующая логика
}
```

Аналогично `handleGeneratePlan` («Сформировать план на дату — текущий план будет дополнен/перезаписан») и `runTimeout` («Запустить проверку просрочек сейчас»). Формулировки текстов — в этих примерах, финальные правки согласуются на ревью.

- [ ] **Step 4: Ручной чек-лист:** Esc/клик мимо = отмена; «Отмена» не шлёт запрос; подтверждение шлёт ровно один запрос; число АЗС в тексте совпадает с выбранным фильтром.

- [ ] **Step 5:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "feat(ux): confirmation dialog for mass dispatch, plan generation and timeout run"`

**Acceptance Criteria:**
- [ ] Массовая рассылка невозможна одним кликом; в подтверждении видно число затрагиваемых АЗС.
- [ ] Диалог переиспользуемый (промис-API), доступен с клавиатуры (Esc = отмена).

---

### Task S2-05: Скелетоны загрузки

**Files:**
- Create: `frontend/app/components/SkeletonBlock.vue`
- Modify: `frontend/app/components/reports/R1Summary.vue`, `R2Rating.vue`, `R3Trend.vue`, `R4Card.vue`, `R5Wall.vue` (блоки «Загрузка…»)
- Modify: `frontend/app/pages/reviewer.client.vue` (лента при `isLoading`)

**Проблема (аудит):** текст «Загрузка…» вместо скелетонов; на медленной мобильной сети контент «прыгает» при появлении (CLS), ощущение медленного приложения.

- [ ] **Step 1: `SkeletonBlock.vue`:**

```vue
<template>
  <div
    class="animate-pulse rounded-md bg-gray-200/70 dark:bg-gray-700/40"
    :style="{ height, width }"
  />
</template>

<script setup lang="ts">
withDefaults(defineProps<{ height?: string; width?: string }>(), {
  height: '1rem',
  width: '100%',
});
</script>
```

(Палитру под тёмную тему сверить с токенами b24ui, используемыми в проекте.)

- [ ] **Step 2: Заменить «Загрузка…» в R1–R5** — скелет повторяет финальную сетку, чтобы не было прыжка. Пример для KPI-блока R1:

```vue
<div v-if="isLoading" class="grid grid-cols-2 gap-3 md:grid-cols-4">
  <SkeletonBlock v-for="i in 4" :key="i" height="72px" />
</div>
```

Для таблиц (R2/R4): 6 строк `SkeletonBlock height="40px"`. Для графиков (R3/R5): один блок высотой как итоговый svg-контейнер.

- [ ] **Step 3: Лента reviewer** — при `isLoading` 5 карточек-скелетонов высотой средней карточки события.

- [ ] **Step 4: Ручной чек-лист (DevTools → Network → Slow 4G):** при открытии каждого отчёта R1–R5 скелет соответствует финальной разметке, контент не прыгает; тёмная тема — скелет различим.

- [ ] **Step 5:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "feat(ux): skeleton loading states for analytics R1-R5 and reviewer feed"`

**Acceptance Criteria:**
- [ ] Нигде в R1–R5 и ленте reviewer не остался текст «Загрузка…».
- [ ] Скелет повторяет сетку контента (визуально нет сдвига при загрузке).

---

### Task S2-06: Мобильная эргономика страницы причины

**Files:**
- Modify: `frontend/app/pages/reason/[reportId].client.vue` (пресеты причин :152-165; блок сохранения)

**Проблема (аудит):** кнопки-пресеты `px-3 py-2` мелкие для пальца; поле «Другое» без автофокуса; кнопка «Сохранить» не закреплена — оператор заполняет форму «на бегу» у колонки.

- [ ] **Step 1: Пресеты — крупная сетка** вместо `flex-wrap`:

```vue
<div class="grid grid-cols-2 gap-2">
  <button
    v-for="reason in presets"
    :key="reason.id"
    type="button"
    class="min-h-12 rounded-lg border px-3 py-2 text-left text-sm leading-tight"
    :class="selected === reason.id ? 'border-blue-500 bg-blue-50 font-medium' : 'border-gray-300'"
    :aria-pressed="selected === reason.id"
    @click="selectReason(reason.id)"
  >
    {{ reason.label }}
  </button>
</div>
```

(Имена `presets`/`selected`/`selectReason` заменить на фактические из файла; стилевые классы выровнять с текущими.)

- [ ] **Step 2: Автофокус «Другое»:**

```ts
const otherInputRef = ref<HTMLTextAreaElement | null>(null);
watch(selected, async (value) => {
  if (value === 'other') {
    await nextTick();
    otherInputRef.value?.focus();
  }
});
```

- [ ] **Step 3: Sticky-кнопка сохранения** — обернуть существующую кнопку:

```vue
<div class="sticky bottom-0 -mx-4 border-t bg-white/95 p-3 backdrop-blur dark:bg-gray-900/95">
  <B24Button block :disabled="!canSave" :loading="saving" @click="save">
    Сохранить причину
  </B24Button>
</div>
```

Нижний отступ контента (`pb-16` уже есть) согласовать, чтобы sticky-панель не перекрывала последний элемент.

- [ ] **Step 4: Ручной чек-лист (эмуляция 390×844):** все пресеты ≥48px высотой, попадание пальцем уверенное; выбор «Другое» открывает клавиатуру сразу; «Сохранить» всегда видна при любой высоте клавиатуры/скролле; двойной тап по «Сохранить» не создаёт два запроса (`saving`-флаг).

- [ ] **Step 5:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "feat(ux): mobile-first reason page — large preset targets, autofocus, sticky save"`

**Acceptance Criteria:**
- [ ] Тап-таргеты пресетов ≥48px, сетка 2 колонки на мобильном.
- [ ] «Сохранить» закреплена снизу и защищена от двойного тапа.
- [ ] Выбор «Другое» автофокусирует поле ввода.

---

### Task S2-07: Главная — ошибка открытия отчёта + авто-проверка

**Files:**
- Modify: `frontend/app/pages/index.client.vue` (`openAdminReport` :109-118; экран «Нет активного отчёта» :439-469)

**Проблема (аудит):** `openAdminReport` без try/catch — сетевой сбой даёт unhandled rejection и вечный спиннер кнопки. Оператор, получивший push, на экране «Нет активного отчёта» должен вручную жать «Проверить снова».

- [ ] **Step 1: Обернуть `openAdminReport`:**

```ts
const toast = useToast();
const openingReport = ref(false);

async function openAdminReport() {
  if (openingReport.value) return;
  openingReport.value = true;
  try {
    // ...существующий await apiStore.getMyActiveReport(20) и переход
  } catch (error) {
    console.error('openAdminReport failed', error);
    toast.error('Не удалось открыть отчёт. Проверьте соединение и попробуйте ещё раз.');
  } finally {
    openingReport.value = false;
  }
}
```

Кнопке — `:loading="openingReport"` вместо `loading-auto`, чтобы спиннер гарантированно сбрасывался.

- [ ] **Step 2: Авто-поллинг на экране ожидания:**

```ts
let recheckTimer: ReturnType<typeof setInterval> | null = null;

watch(showNoActiveReport, (visible) => { // фактический флаг экрана взять из кода
  if (visible && !recheckTimer) {
    recheckTimer = setInterval(() => recheckAdminReport(), 45_000);
  } else if (!visible && recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}, { immediate: true });

onUnmounted(() => { if (recheckTimer) clearInterval(recheckTimer); });
```

Под кнопкой «Проверить снова» — подпись: «Проверяем автоматически каждую минуту».

- [ ] **Step 3: Ручной чек-лист:** при остановленном бэкенде клик по кнопке → тост ошибки, спиннер сброшен; на экране ожидания в Network виден периодический запрос раз в 45 с; уход со страницы останавливает поллинг (Network пуст).

- [ ] **Step 4:** `pnpm lint && pnpm build` → чисто. **Commit** — `git commit -m "fix(home): error handling for opening report, auto-recheck for active report screen"`

**Acceptance Criteria:**
- [ ] Кнопка открытия отчёта не зависает в спиннере ни при каком исходе.
- [ ] Появившийся отчёт подхватывается без действий пользователя ≤60 с.
- [ ] Поллинг останавливается при уходе со страницы/появлении отчёта.

---

### Stretch-задачи (берём при наличии запаса)

**S2-08 Сохранение вкладки отчётов** — `frontend/app/pages/reports.client.vue`: `activeTab` ↔ `route.query.tab` (через `router.replace`, без записи в историю на каждый клик); возврат на страницу открывает последний раздел. Заодно в `ReportNav.vue` мобильная панель: полная подпись активного таба.

**S2-09 Доступность** — `reviewer.client.vue`: `aria-pressed` на тогглах периода/статуса; смысловые эмодзи (`getEventIcon` :330-337) обернуть `<span aria-hidden="true">` + текстовая метка рядом для скринридера.

**S2-10 Убрать `BackendStatus.vue`** — компонент не импортируется нигде (подтверждено grep'ом аудита). Удалить файл либо (решение на ревью) подключить в `layouts/default.vue` как глобальный индикатор недоступности бэкенда с авто-перепроверкой.

---

## Definition of Done спринта

- [ ] `cd frontend && pnpm lint && pnpm build` — без ошибок и новых warning'ов.
- [ ] Все ручные чек-листы задач выполнены на десктопе + мобильной эмуляции 390px и зафиксированы в PR (скриншоты до/после для S2-05, S2-06).
- [ ] Бэкенд-тесты не тронуты и зелёные: `cd backends/node/api && node --test "tests/*.test.js"`.
- [ ] Прогон на dev-портале Битрикс24: сценарии «проверяющий массово запрашивает отчёты», «оператор сдаёт причину с телефона», «админ смотрит R1–R5 на Slow 4G».
- [ ] `docs/CHANGELOG.md` дополнен.

## Риски спринта

| Риск | Митигация |
|---|---|
| В `@bitrix24/b24ui-nuxt` может быть готовый toast/modal с другим API | S2-01 Step 1 / S2-04 Step 2 начинаются с проверки UI-кита; свои компоненты — только если готовых нет |
| Точные имена переменных/слотов в страницах отличаются от примеров плана | Примеры кода — целевые паттерны; имена сверять с фактическим кодом файла перед правкой |
| Нет автотестов фронта — регрессии ловятся только руками | Ручные чек-листы обязательны в DoD; build+lint на каждом коммите; изменения изолированы по страницам |
| iframe Битрикса ограничивает `window.location.reload` поведение | Проверить кнопку «Обновить» из error.vue именно внутри портала на dev-стенде (S2-03 Step 4) |

## Метрики успеха (2–4 недели после релиза)

- 0 дублей ручных отчётов от двойных кликов (по данным `manualReports`).
- Снижение обращений «нажал — ничего не произошло» от проверяющих до нуля.
- Время сдачи причины просрочки с телефона — субъективно «в один присест» (опрос 2–3 операторов).
- Ни одного скриншота с техническим текстом ошибки от пользователей.
