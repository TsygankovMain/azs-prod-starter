# FEAT-D: Админ АЗС сразу на свой экран — Implementation Plan

> **Для агентов:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (рекомендовано) или `superpowers:executing-plans`. Шаги используют формат `- [ ]` для отслеживания.

**Goal:** После инициализации пользователи с ролью `azs_admin` (capabilities: `{ settings:false, reviewer:false, reports:true }`) видят экран загрузки → сразу попадают на `/admin/{id}`, минуя стартовое меню. Если активного отчёта нет — получают экран ожидания с понятным сообщением. Пользователи с другими ролями (`admin`, `reviewer`) поведения не меняют. Кнопка «Настройки» на странице `/admin/[reportId]` скрывается, если у пользователя нет `settings`-capability.

**Architecture:** Изменения только на фронтенде, два файла. Бэкенд (`/api/me/role`, `/api/health`, `/api/reports/my-active`) остаётся без изменений — ACL уже работает. Логика авто-редиректа в `index.client.vue` уже частично есть (строки 271–276): `azs_admin` уже редиректится, если активный отчёт найден. Проблема: при отсутствии отчёта код падает до `isInit.value = true` и показывает меню (строки 277–278) — для `azs_admin` это ненужно. Также на `/admin/[reportId]` кнопка «Настройки» рендерится безусловно (строка 771).

**Tech Stack:** Nuxt 3 / Vue 3 (Composition API, `<script setup lang="ts">`), Bitrix24 UI Kit (префикс `B24`). Тест-раннер в `frontend/package.json` отсутствует — шаги верификации ручные.

---

## File Structure

| Файл | Что меняем |
|---|---|
| `frontend/app/pages/index.client.vue` | **Modify.** (1) Добавляем `ref` `isAzsAdminWaiting` для экрана ожидания. (2) В блоке `onMounted`, после неудачного редиректа (`redirectedToActive === false` для `azs_admin`), переключаем `isAzsAdminWaiting.value = true` вместо `isInit.value = true`. (3) Добавляем условный блок шаблона "Нет активного отчёта" для `azs_admin`. (4) Блок `v-if="isInit"` остаётся, но `visibleScreens` для `azs_admin` всё равно пуст — это residual-безопасность; прямой показ меню уже не происходит. |
| `frontend/app/pages/admin/[reportId].client.vue` | **Modify.** (1) Добавляем `ref` `hasSettingsAccess` (по умолчанию `false`). (2) Запрашиваем роль через `apiStore.getMyRole()` в `onMounted`. (3) Кнопку «Настройки» (строка 771) оборачиваем в `v-if="hasSettingsAccess"`. |

---

## Task 1: Авто-редирект `azs_admin` и экран ожидания в `index.client.vue`

**Цель:** Пользователь с ролью `azs_admin` никогда не видит стартовое меню. Либо сразу попадает на `/admin/{id}`, либо видит экран ожидания.

- [ ] **Step 1.1** Открыть `frontend/app/pages/index.client.vue`. Найти блок `const isInit = ref(false)` (строка 17). Сразу после него добавить:
  ```ts
  const isAzsAdminWaiting = ref(false)
  ```

- [ ] **Step 1.2** Найти функцию `openMyActiveReportIfAny` (строки 234–246). Убедиться, что функция возвращает `true` при успешном редиректе и `false` при отсутствии отчёта или ошибке — код уже так работает, изменений не требуется.

- [ ] **Step 1.3** Найти в `onMounted` блок после `checkBackend()` (строки 266–278):
  ```ts
  if (currentRole.value === 'azs_admin') {
    const redirectedToActive = await openMyActiveReportIfAny()
    if (redirectedToActive) {
      return
    }
  }
  initStepIndex.value = 3
  isInit.value = true
  ```
  Заменить его на:
  ```ts
  if (currentRole.value === 'azs_admin') {
    const redirectedToActive = await openMyActiveReportIfAny()
    if (redirectedToActive) {
      return
    }
    // Нет активного отчёта — показываем экран ожидания вместо меню
    initStepIndex.value = 3
    isAzsAdminWaiting.value = true
    return
  }
  initStepIndex.value = 3
  isInit.value = true
  ```

- [ ] **Step 1.4** В шаблоне, после закрывающего `</B24Card>` блока с `v-if="isInit"` (строка ~381), добавить блок экрана ожидания для `azs_admin`:
  ```html
  <!-- Экран ожидания для azs_admin: нет активного отчёта -->
  <B24Card v-if="isAzsAdminWaiting">
    <template #header>
      <div class="flex flex-row items-center justify-between gap-3">
        <div>
          <ProseH2>Фото-отчёты АЗС</ProseH2>
          <ProseP>Ожидание задания</ProseP>
        </div>
        <B24Badge :color="healthStatus === 'ok' ? 'air-primary-success' : (healthStatus === 'error' ? 'air-primary-alert' : 'air-secondary')">
          {{ healthText }}
        </B24Badge>
      </div>
    </template>
    <B24Alert
      color="air-secondary"
      title="Нет активного отчёта"
      description="На данный момент для вас нет активного задания на загрузку фото. Дождитесь уведомления от бота или обратитесь к проверяющему."
    />
    <template #footer>
      <div class="flex flex-row items-center justify-between w-full gap-3">
        <ProseP class="text-[12px] text-gray-500">
          Пользователь: {{ userStore.id || 'unknown' }} | Роль: {{ currentRole }}
        </ProseP>
        <B24Button
          color="air-secondary"
          label="Проверить снова"
          loading-auto
          @click="recheckAdminReport"
        />
      </div>
    </template>
  </B24Card>
  ```

- [ ] **Step 1.5** Добавить функцию `recheckAdminReport` в `<script setup>` (после `openAdminReport`, строка ~116):
  ```ts
  const recheckAdminReport = async () => {
    homeNotice.value = ''
    isAzsAdminWaiting.value = false
    isLoading.value = true
    initStepIndex.value = 2
    try {
      const redirected = await openMyActiveReportIfAny()
      if (!redirected) {
        isAzsAdminWaiting.value = true
      }
    } finally {
      isLoading.value = false
    }
  }
  ```

- [ ] **Step 1.6** Убедиться, что блок `v-if="!isInit && !isLoading"` (строка ~384) не показывает алерт «Инициализация не завершена» для `azs_admin` в состоянии ожидания. Изменить условие:
  ```html
  <B24Alert
    v-if="!isInit && !isAzsAdminWaiting && !isLoading"
    color="air-primary-alert"
    title="Инициализация не завершена"
    description="Проверьте запуск через Bitrix24 iframe и доступность backend."
  />
  ```

---

## Task 2: Скрытие кнопки «Настройки» в `/admin/[reportId]` без settings-capability

**Цель:** На экране фотоотчёта кнопка «Настройки» доступна только пользователям с `capabilities.settings === true`. Для `azs_admin` (settings: false) кнопка скрыта.

- [ ] **Step 2.1** Открыть `frontend/app/pages/admin/[reportId].client.vue`. После блока объявления `const isSubmitting = ref(false)` (строка ~63) добавить:
  ```ts
  const hasSettingsAccess = ref(false)
  ```

- [ ] **Step 2.2** В функции `onMounted` (строки 703–715), после `await initApp(...)`, добавить запрос роли:
  ```ts
  try {
    const roleResponse = await apiStore.getMyRole()
    hasSettingsAccess.value = Boolean(roleResponse?.capabilities?.settings)
  } catch {
    // Ошибка получения роли — кнопка остаётся скрытой (безопасный дефолт)
  }
  ```
  Финальный `onMounted` выглядит:
  ```ts
  onMounted(async () => {
    try {
      workerHalted.value = false
      $b24 = await $initializeB24Frame()
      await initApp($b24, localesI18n, setLocale)
      await $b24.parent.setTitle(PAGE_TITLE)
      try {
        const roleResponse = await apiStore.getMyRole()
        hasSettingsAccess.value = Boolean(roleResponse?.capabilities?.settings)
      } catch {
        // Ошибка получения роли — кнопка настроек скрыта (безопасный дефолт)
      }
      await loadReport()
      await nextTick()
      await ensureCameraForActiveSlot()
    } catch (error) {
      processErrorGlobal(error)
    }
  })
  ```

- [ ] **Step 2.3** Найти кнопку «Настройки» в шаблоне (строки 767–773):
  ```html
  <B24Button
    color="air-primary"
    variant="outline"
    size="xs"
    label="Настройки"
    @click="openSettings"
  />
  ```
  Добавить `v-if="hasSettingsAccess"`:
  ```html
  <B24Button
    v-if="hasSettingsAccess"
    color="air-primary"
    variant="outline"
    size="xs"
    label="Настройки"
    @click="openSettings"
  />
  ```

---

## Task 3: Ручная верификация

**Тест-раннер во фронтенде отсутствует** (`frontend/package.json` содержит только `lint`, `build`, `dev`). Проверка выполняется вручную в запущенном приложении.

- [ ] **Step 3.1 — Сценарий A: azs_admin с активным отчётом**
  1. Войти в Bitrix24 под пользователем, чей `user_id` присутствует в `access.azsAdminUserIds` (настройки бэкенда).
  2. Убедиться, что для этого пользователя бэкенд возвращает активный отчёт (`/api/reports/my-active` → `item.id > 0`).
  3. Открыть корневую страницу приложения (`/`).
  4. **Ожидаемое:** Видна панель загрузки (3 шага). Меню карточек не появляется. Приложение сразу переходит на `/admin/{id}`.
  5. **Что проверить:** В URL — `/admin/{id}`, заголовок страницы «Фотоотчёт АЗС: загрузка», кнопки «Открыть: ...» отсутствуют.

- [ ] **Step 3.2 — Сценарий B: azs_admin без активного отчёта**
  1. Войти под тем же пользователем, у которого нет активного отчёта (либо все отчёты в статусе `done`/`expired`).
  2. Открыть корневую страницу приложения (`/`).
  3. **Ожидаемое:** Видна панель загрузки → появляется карточка «Нет активного отчёта» с кнопкой «Проверить снова». Меню карточек не показывается.
  4. Нажать «Проверить снова» — если отчёт по-прежнему отсутствует, карточка ожидания снова отображается.

- [ ] **Step 3.3 — Сценарий C: azs_admin на экране /admin/{id}, кнопка «Настройки»**
  1. Открыть `/admin/{id}` (любой способ попасть на страницу).
  2. **Ожидаемое:** В sticky-шапке кнопка «Настройки» отсутствует. Кнопка «Выйти» присутствует.
  3. В DevTools / Network проверить вызов `/api/me/role` — ответ `{ capabilities: { settings: false } }`.

- [ ] **Step 3.4 — Сценарий D: reviewer — меню остаётся**
  1. Войти под пользователем с ролью `reviewer` (есть в `access.reviewerUserIds`).
  2. Открыть корневую страницу.
  3. **Ожидаемое:** Панель загрузки → карточка меню с одним экраном «Экран Проверяющего» (без «Настройки», без «Экран Администратора АЗС»). Авто-редиректа нет.

- [ ] **Step 3.5 — Сценарий E: admin (portal admin / adminUserIds) — меню и настройки**
  1. Войти под пользователем с ролью `admin`.
  2. Открыть корневую страницу.
  3. **Ожидаемое:** Все три карточки в меню (настройки, проверяющий, администратор АЗС). Авто-редиректа нет.
  4. Перейти на `/admin/{id}`. **Ожидаемое:** Кнопка «Настройки» отображается.

- [ ] **Step 3.6 — Сценарий F: contextReportId в URL (deeplink)**
  1. Открыть страницу с `?reportId=123` в URL (Bitrix24 deep-link).
  2. **Ожидаемое:** Независимо от роли, приложение перенаправляет на `/admin/123`. Этот путь (строки 266–269 `index.client.vue`) не затронут изменениями.

---

## Edge Cases и риски

| Ситуация | Поведение после FEAT-D |
|---|---|
| Роль ещё не загружена (лоадер) | `isAzsAdminWaiting` и `isInit` — оба `false`; отображается `B24Card v-if="isLoading"` (уже есть). Алерт «Инициализация не завершена» скрыт, т.к. `!isAzsAdminWaiting` проверяется. |
| `/api/me/role` вернул ошибку в `index.client.vue` | `checkBackend` вызывает `applyLocalPortalAdminFallback()` при ошибке (строки 228–230). Для портал-администраторов роль станет `admin` — меню отобразится. Для non-admin без ответа `currentRole` останется дефолтным `azs_admin` (строка 22) → экран ожидания. Это безопасно. |
| `/api/me/role` вернул ошибку в `admin/[reportId]` | `hasSettingsAccess` остаётся `false` → кнопка «Настройки» скрыта. Безопасный дефолт — никакой дополнительной обработки не нужно. |
| Несколько активных отчётов (limit=20 в `getMyActiveReport`) | `response.item` — первый из списка (бэкенд возвращает `items[0]` в поле `item`). Редирект идёт на первый отчёт. Несколько отчётов — отдельная бизнес-задача, не в скоупе. |
| Отчёт найден, редирект выполнен, но `/admin/{id}` загружается медленно | После `navigateTo` Vue Router переходит на страницу; `isLoading` там управляется своим `loadReport()`. Состояние `isAzsAdminWaiting` не влияет на другие страницы. |
| Кнопка «Выйти» (`leaveReport`) ведёт на `/` | Для `azs_admin` это вернёт на главную, где снова сработает авто-редирект. Если отчёт закончился — появится экран ожидания. Это корректное UX-поведение. |
| Параллельный рендер `isAzsAdminWaiting` и `isInit` оба true | Невозможно по коду: ветка `azs_admin` всегда завершается `return` после выставления `isAzsAdminWaiting = true`, не доходя до `isInit = true`. |
