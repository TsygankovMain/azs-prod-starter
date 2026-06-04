# FEAT-B: Поиск АЗС в ручном запросе — Implementation Plan

> **Для агентов-исполнителей:** используйте superpowers:subagent-driven-development или superpowers:executing-plans. Шаги размечены чекбоксами (`- [ ]`).

**Goal:** Добавить поле поиска (фильтрации) по названию/номеру над списком АЗС в карточке «Запросить отчёт вне расписания» экрана проверяющего. При активном фильтре кнопка «Все» выбирает только _видимые_ опции; кнопка «Снять» снимает отметку со всех (включая скрытые) — привычное поведение для bulk-операций.

**Architecture:** Чисто клиентский фильтр. Список `azsOptions` (~71 запись) уже загружается при монтировании страницы через `loadAzsOptions`. Новый `ref` `azsSearchQuery` + `computed filteredAzsOptions` формируют отображаемое подмножество без каких-либо дополнительных HTTP-запросов. Бэкенд (`GET /api/reports/azs-options?search=...`) уже поддерживает серверный поиск, но при 71 записи накладные расходы на дополнительный запрос выше пользы — оставляем эндпоинт нетронутым.

**Tech Stack:** Nuxt 3, Vue 3 Composition API, Tailwind CSS 4, `@bitrix24/b24ui-nuxt` (компонент `B24Input`). Фронт-тест-раннер (vitest / jest / @vue/test-utils) в `frontend/package.json` **отсутствует** — раздел тестирования заменён конкретными шагами ручной проверки в браузере.

---

## Контекст реальных файлов (проверено перед составлением плана)

| Место | Строки | Что там |
|---|---|---|
| `reviewer.client.vue` | 69 | `const azsOptions = ref<AzsOption[]>([])` |
| `reviewer.client.vue` | 109–114 | `const manualRequest = reactive({ azsIds, mode, scheduleDate, scheduleTime })` |
| `reviewer.client.vue` | 383–401 | `loadAzsOptions()` — загружает список в `azsOptions` |
| `reviewer.client.vue` | 471–484 | `selectAllAzs`, `clearAllAzs`, `toggleAzsSelection` |
| `reviewer.client.vue` | 1159–1285 | Карточка «Запросить отчёт вне расписания» (HTML) |
| `reviewer.client.vue` | 1172–1174 | Кнопки «Все» / «Снять» |
| `reviewer.client.vue` | 1177–1198 | `v-for="opt in azsOptions"` — чек-лист АЗС |
| `reportsRoutes.js` | 768–827 | `GET /azs-options` — уже принимает `?search=` (серверный фильтр, не используем) |

---

## File Structure

| Файл | Действие | За что отвечает |
|---|---|---|
| `frontend/app/pages/reviewer.client.vue` | **Modify** | Добавить `ref azsSearchQuery`, `computed filteredAzsOptions`, обновить `selectAllAzs`, добавить `<input>` поиска над списком, заменить `v-for="opt in azsOptions"` на `v-for="opt in filteredAzsOptions"` |

Никакие другие файлы не затрагиваются: бэкенд не меняется, хранилище (`stores/api.ts`) не меняется.

---

## Task 1: Реактивное состояние поиска и вычисляемый список

### Task 1 — Script-блок: `<script setup>`

- [ ] **Step 1.1: Добавить `ref` для строки поиска**

  Вставить сразу после строки `const azsOptions = ref<AzsOption[]>([])` (строка ~69):

  ```ts
  const azsSearchQuery = ref('')
  ```

- [ ] **Step 1.2: Добавить `computed filteredAzsOptions`**

  Вставить сразу после объявления `azsSearchQuery` (т.е. после строки из шага 1.1):

  ```ts
  const filteredAzsOptions = computed(() => {
    const q = azsSearchQuery.value.trim().toLowerCase()
    if (!q) return azsOptions.value
    return azsOptions.value.filter(o =>
      o.label.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q)
    )
  })
  ```

  Логика: фильтрует по полю `label` (название АЗС, например «АЗС 42») и по полю `value` (строковый ID). Это покрывает поиск и по номеру, и по названию.

- [ ] **Step 1.3: Обновить `selectAllAzs` — выбирать только видимые**

  Найти функцию `selectAllAzs` (строки ~471–473):

  ```ts
  // БЫЛО:
  const selectAllAzs = () => {
    manualRequest.azsIds = azsOptions.value.map(o => o.value)
  }
  ```

  Заменить на:

  ```ts
  // СТАЛО:
  const selectAllAzs = () => {
    const visibleIds = filteredAzsOptions.value.map(o => o.value)
    // Добавляем видимые к уже выбранным (если часть была выбрана вне фильтра)
    const merged = new Set([...manualRequest.azsIds, ...visibleIds])
    manualRequest.azsIds = [...merged]
  }
  ```

  Поведение: если пользователь вводит «42» в поиск и нажимает «Все» — выбирается только АЗС 42; ранее выбранные станции (скрытые фильтром) остаются в списке. Это соответствует стандартному UX фильтруемых мультиселектов (аналог Gmail/Trello).

  `clearAllAzs` — **не меняем**: «Снять всё» должно снимать выделение со всех станций, включая скрытые. Это ожидаемое поведение (снял фильтр — видишь что ничего не выбрано).

- [ ] **Step 1.4: Сброс поиска при успешной отправке**

  В функции `sendManualRequest` после строки `manualRequest.azsIds = []` (строка ~519) добавить:

  ```ts
  azsSearchQuery.value = ''
  ```

  Это гарантирует, что после успешной отправки поле поиска очищается вместе со списком.

---

## Task 2: Шаблон — поле поиска и обновлённый список

### Task 2 — Template-блок: карточка «Запросить отчёт вне расписания»

- [ ] **Step 2.1: Добавить `<input>` поиска над списком АЗС**

  Найти блок начала списка АЗС в шаблоне. Это область между строками ~1169–1177:

  ```html
  <!-- БЫЛО: -->
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <label class="text-xs text-gray-500">АЗС (выберите одну или несколько)</label>
      <div class="flex gap-2 text-xs">
        <button class="text-blue-600 hover:underline" @click="selectAllAzs">Все</button>
        <span class="text-gray-300">|</span>
        <button class="text-gray-500 hover:underline" @click="clearAllAzs">Снять</button>
      </div>
    </div>
    <div class="max-h-44 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
  ```

  Заменить на:

  ```html
  <!-- СТАЛО: -->
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <label class="text-xs text-gray-500">АЗС (выберите одну или несколько)</label>
      <div class="flex gap-2 text-xs">
        <button class="text-blue-600 hover:underline" @click="selectAllAzs">Все</button>
        <span class="text-gray-300">|</span>
        <button class="text-gray-500 hover:underline" @click="clearAllAzs">Снять</button>
      </div>
    </div>

    <!-- Поиск по АЗС -->
    <div class="relative mb-1.5">
      <input
        v-model="azsSearchQuery"
        type="text"
        placeholder="Поиск АЗС…"
        class="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
      >
      <button
        v-if="azsSearchQuery"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
        @click="azsSearchQuery = ''"
      >
        ✕
      </button>
    </div>

    <div class="max-h-44 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
  ```

  Инпут использует нативный `<input type="text">` с Tailwind-классами, соответствующими стилям страницы. Кнопка «✕» появляется только когда поле непустое — позволяет одним кликом сбросить фильтр.

  > **Почему не `B24Input`:** `B24Input` — обёртка без `placeholder`-пропа в v-model-режиме (в settings.client.vue она используется в `B24FormField`). Нативный `<input>` с Tailwind здесь проще, компактнее и полностью соответствует стилям страницы. При желании можно заменить на `B24Input` с пропами `v-model="azsSearchQuery" placeholder="Поиск АЗС…"` — поведение идентично.

- [ ] **Step 2.2: Заменить `v-for="opt in azsOptions"` на `filteredAzsOptions`**

  Найти строку ~1179:

  ```html
  <!-- БЫЛО: -->
  <label
    v-for="opt in azsOptions"
  ```

  Заменить на:

  ```html
  <!-- СТАЛО: -->
  <label
    v-for="opt in filteredAzsOptions"
  ```

- [ ] **Step 2.3: Обновить заглушку «нет АЗС»**

  Найти строку ~1195:

  ```html
  <!-- БЫЛО: -->
  <div v-if="azsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
    Нет доступных АЗС
  </div>
  ```

  Заменить на:

  ```html
  <!-- СТАЛО: -->
  <div v-if="azsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
    Нет доступных АЗС
  </div>
  <div v-else-if="filteredAzsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
    Ничего не найдено по «{{ azsSearchQuery }}»
  </div>
  ```

  Логика: первый блок — если список вообще не загрузился; второй — если поиск дал пустой результат.

- [ ] **Step 2.4: Добавить счётчик видимых при активном поиске**

  Найти строку ~1199–1201 (счётчик выбранных):

  ```html
  <!-- БЫЛО: -->
  <p v-if="manualRequest.azsIds.length > 0" class="text-xs text-blue-600 mt-1">
    Выбрано: {{ manualRequest.azsIds.length }} АЗС
  </p>
  ```

  Заменить на:

  ```html
  <!-- СТАЛО: -->
  <p class="text-xs mt-1 flex gap-2">
    <span v-if="manualRequest.azsIds.length > 0" class="text-blue-600">
      Выбрано: {{ manualRequest.azsIds.length }} АЗС
    </span>
    <span
      v-if="azsSearchQuery && filteredAzsOptions.length < azsOptions.length"
      class="text-gray-400"
    >
      (показано {{ filteredAzsOptions.length }} из {{ azsOptions.length }})
    </span>
  </p>
  ```

  Счётчик «показано N из 71» появляется только когда фильтр активен и скрывает хотя бы одну запись — минимально навязчивый, но информативный.

---

## Task 3: Ручная проверка в браузере

> Тест-раннер для фронта (vitest/jest) в проекте **отсутствует** (проверено: `frontend/package.json` содержит только `nuxt`, `@bitrix24/*`, `@nuxtjs/i18n`, `@pinia/nuxt`, Tailwind, Luxon — без тестовых зависимостей). Следующие шаги заменяют TDD-цикл.

- [ ] **Step 3.1: Базовый рендер**

  Открыть страницу проверяющего (`/reviewer`) в браузере. Найти карточку «Запросить отчёт вне расписания». Убедиться:
  - Над списком АЗС отображается поле ввода с placeholder «Поиск АЗС…»
  - Список АЗС показывает все ~71 запись (поле пустое)
  - Кнопки «Все» и «Снять» на месте
  - Счётчик «(показано N из 71)» не виден (поле пустое)

- [ ] **Step 3.2: Фильтрация по номеру**

  Ввести в поле поиска числовую строку, которая есть в базе (например «42»). Убедиться:
  - Список сужается — видны только АЗС, в `label` или `value` которых есть «42»
  - Появляется счётчик «(показано K из 71)»
  - Остальные АЗС скрыты, scroll-контейнер не прокручивается лишний раз

- [ ] **Step 3.3: Фильтрация по названию**

  Ввести часть текстового названия (например «Север»). Убедиться:
  - Показаны только АЗС, у которых `label` содержит «север» (регистронезависимо)

- [ ] **Step 3.4: Кнопка сброса (✕)**

  При непустом поле нажать «✕» справа. Убедиться:
  - Поле очищается
  - Список возвращается к полному (все 71 АЗС)
  - Кнопка «✕» исчезает

- [ ] **Step 3.5: «Выбрать все» при активном фильтре**

  Ввести фильтр (например «1»), нажать «Все». Убедиться:
  - В `manualRequest.azsIds` добавились только видимые АЗС (те что прошли фильтр)
  - Счётчик «Выбрано: K АЗС» отражает корректное число
  - Другие АЗС (скрытые) не выбраны

  Затем очистить фильтр («✕»): полный список видно, выбранные подсвечены синим, прочие — нет.

- [ ] **Step 3.6: «Снять все» при активном фильтре**

  Установить фильтр, выбрать несколько АЗС, нажать «Снять». Убедиться:
  - `manualRequest.azsIds` полностью пуст (включая АЗС, скрытые фильтром)
  - Счётчик «Выбрано» исчезает

- [ ] **Step 3.7: Пустой результат поиска**

  Ввести строку, которой нет ни в одном названии (например «zzz»). Убедиться:
  - Список пуст, виден текст «Ничего не найдено по «zzz»»
  - Исходное «Нет доступных АЗС» не отображается

- [ ] **Step 3.8: Очистка после отправки**

  Выбрать несколько АЗС, нажать «Запросить у N АЗС». После появления зелёного алерта «Задание отправлено для N АЗС» убедиться:
  - Поле поиска пустое
  - Список показывает все АЗС (фильтр сброшен)
  - Ни одна АЗС не выбрана

- [ ] **Step 3.9: Проверка производительности (визуальная)**

  Очистить поле, ввести по одной букве последовательно. Убедиться:
  - Список обновляется мгновенно без заметного lag-а (computed + 71 строк — доли мс)

---

## UX-решения (обоснование)

| Решение | Почему |
|---|---|
| Клиентский фильтр, без доп. запросов | 71 запись загружается один раз при монтировании; серверный поиск добавил бы latency и мигание списка |
| «Все» выбирает только видимые | Стандарт для фильтруемых мультиселектов; пользователь ожидает «выбрать всё что вижу» |
| «Снять» снимает всё (включая скрытые) | Деструктивное действие всегда должно быть полным; иначе возможны «призраки» в скрытых строках |
| Кнопка ✕ только при непустом поле | Не занимает место в пустом состоянии; нативный UX (браузерные инпуты) |
| Сообщение «Ничего не найдено по «…»» | Отличает «список не загрузился» от «поиск дал 0» |
| Счётчик «показано N из 71» только при активном фильтре | Дополнительный шум только когда информативен |
| Нативный `<input>` вместо `B24Input` | `B24Input` используется внутри `B24FormField` с label-слотом — избыточно для мини-поиска; нативный + Tailwind компактнее и стилистически совместим со страницей |

---

## Риски и открытые вопросы

1. **Случай `label` без номера:** если `azsOptions.label` содержит только название без числового ID (зависит от данных CRM), поиск по числу (`o.value.toLowerCase().includes(q)`) всё равно работает через `value` (ID). Поведение корректно в обоих форматах данных.

2. **Производительность при росте базы:** 71 → несколько сотен АЗС — computed всё ещё мгновенный. Если база вырастет до тысяч — стоит перейти на серверный поиск (эндпоинт уже готов к `?search=`).

3. **Сохранение фильтра между сессиями:** сейчас фильтр не сохраняется (in-memory ref, сбрасывается при перезагрузке страницы). Если нужна персистентность — отдельная задача.

4. **i18n:** строки «Поиск АЗС…», «Ничего не найдено по…», «(показано N из M)» захардкожены на русском. Если проект переведут на i18n-систему (`@nuxtjs/i18n`), их нужно вынести в `locales/*.json`. Сейчас все строки на странице тоже захардкожены на русском — не вводим исключения.
