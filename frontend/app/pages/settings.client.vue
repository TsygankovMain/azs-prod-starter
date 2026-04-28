<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

type SettingsTree = {
  azs: {
    entityTypeId: number
    fields: {
      admin: string
      reviewers: string
      photoSet: string
      schedule: string
      timezone: string
      enabled: string
    }
  }
  report: {
    entityTypeId: number
    fields: {
      azs: string
      admin: string
      slotTime: string
      scheduledAt: string
      deadlineAt: string
      trigger: string
      folderId: string
      photos: string
      photoStatus: string
    }
    stages: {
      new: string
      inProgress: string
      done: string
      expired: string
    }
    timeoutMinutes: number
    dispatchJitterMinutes: number
  }
  disk: {
    rootFolderId: number
    folderNameTemplate: string
  }
  timezone: string
}

type JsonObject = Record<string, unknown>

const PAGE_TITLE = 'Настройки АЗС'

const { locales: localesI18n, setLocale } = useI18n()
useHead({ title: PAGE_TITLE })

const { $logger, initApp, b24Helper, destroyB24Helper, processErrorGlobal } = useAppInit('SettingsPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const userStore = useUserStore()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const isSaving = ref(false)
const isLoaded = ref(false)
const loadError = ref('')
const saveError = ref('')
const saveSuccess = ref('')
const defaultsData = ref<JsonObject>({})
const loadedSnapshot = ref('')

function makeEmptySettings(): SettingsTree {
  return {
    azs: {
      entityTypeId: 0,
      fields: {
        admin: '',
        reviewers: '',
        photoSet: '',
        schedule: '',
        timezone: '',
        enabled: ''
      }
    },
    report: {
      entityTypeId: 0,
      fields: {
        azs: '',
        admin: '',
        slotTime: '',
        scheduledAt: '',
        deadlineAt: '',
        trigger: '',
        folderId: '',
        photos: '',
        photoStatus: ''
      },
      stages: {
        new: '',
        inProgress: '',
        done: '',
        expired: ''
      },
      timeoutMinutes: 0,
      dispatchJitterMinutes: 0
    },
    disk: {
      rootFolderId: 0,
      folderNameTemplate: ''
    },
    timezone: ''
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value !== 'object') {
    return value
  }

  return JSON.parse(JSON.stringify(value))
}

function deepMerge<T>(base: T, override: JsonObject = {}): T {
  const result = deepClone(base)
  const resultRecord = result as JsonObject

  Object.entries(override).forEach(([key, value]) => {
    if (isPlainObject(value) && isPlainObject(resultRecord[key])) {
      resultRecord[key] = deepMerge(resultRecord[key], value)
      return
    }

    resultRecord[key] = deepClone(value)
  })

  return result
}

function normalizeSettings(
  settings: JsonObject = {},
  defaults: JsonObject = {}
): SettingsTree {
  const normalized = deepMerge(
    deepMerge(makeEmptySettings(), defaults),
    settings
  )

  normalized.azs.entityTypeId = Number(normalized.azs.entityTypeId || 0)
  normalized.report.entityTypeId = Number(normalized.report.entityTypeId || 0)
  normalized.report.timeoutMinutes = Number(normalized.report.timeoutMinutes || 0)
  normalized.report.dispatchJitterMinutes = Number(normalized.report.dispatchJitterMinutes || 0)
  normalized.disk.rootFolderId = Number(normalized.disk.rootFolderId || 0)

  return normalized
}

const form = reactive<SettingsTree>(makeEmptySettings())

function applySettings(nextSettings: SettingsTree) {
  Object.assign(form.azs, {
    entityTypeId: nextSettings.azs.entityTypeId
  })
  Object.assign(form.azs.fields, nextSettings.azs.fields)

  Object.assign(form.report, {
    entityTypeId: nextSettings.report.entityTypeId,
    timeoutMinutes: nextSettings.report.timeoutMinutes,
    dispatchJitterMinutes: nextSettings.report.dispatchJitterMinutes
  })
  Object.assign(form.report.fields, nextSettings.report.fields)
  Object.assign(form.report.stages, nextSettings.report.stages)

  Object.assign(form.disk, nextSettings.disk)
  form.timezone = nextSettings.timezone
}

function readSettings(): SettingsTree {
  return deepClone({
    azs: {
      entityTypeId: Number(form.azs.entityTypeId || 0),
      fields: {
        admin: form.azs.fields.admin,
        reviewers: form.azs.fields.reviewers,
        photoSet: form.azs.fields.photoSet,
        schedule: form.azs.fields.schedule,
        timezone: form.azs.fields.timezone,
        enabled: form.azs.fields.enabled
      }
    },
    report: {
      entityTypeId: Number(form.report.entityTypeId || 0),
      fields: {
        azs: form.report.fields.azs,
        admin: form.report.fields.admin,
        slotTime: form.report.fields.slotTime,
        scheduledAt: form.report.fields.scheduledAt,
        deadlineAt: form.report.fields.deadlineAt,
        trigger: form.report.fields.trigger,
        folderId: form.report.fields.folderId,
        photos: form.report.fields.photos,
        photoStatus: form.report.fields.photoStatus
      },
      stages: {
        new: form.report.stages.new,
        inProgress: form.report.stages.inProgress,
        done: form.report.stages.done,
        expired: form.report.stages.expired
      },
      timeoutMinutes: Number(form.report.timeoutMinutes || 0),
      dispatchJitterMinutes: Number(form.report.dispatchJitterMinutes || 0)
    },
    disk: {
      rootFolderId: Number(form.disk.rootFolderId || 0),
      folderNameTemplate: form.disk.folderNameTemplate
    },
    timezone: form.timezone
  })
}

const isAdminReady = computed(() => userStore.id > 0 ? userStore.isAdmin : true)
const isDirty = computed(() => JSON.stringify(readSettings()) !== loadedSnapshot.value)
const canSave = computed(() => isLoaded.value && isAdminReady.value && !isLoading.value && !isSaving.value)
const statusLabel = computed(() => {
  if (!isLoaded.value) {
    return 'загрузка'
  }

  if (isDirty.value) {
    return 'есть изменения'
  }

  return 'синхронизировано'
})
const statusColor = computed(() => {
  if (!isLoaded.value) {
    return 'air-secondary'
  }

  if (isDirty.value) {
    return 'air-primary-alert'
  }

  return 'air-primary-success'
})

async function loadSettings() {
  if (!$b24) {
    return
  }

  isLoading.value = true
  loadError.value = ''
  saveError.value = ''
  saveSuccess.value = ''

  try {
    const response = await apiStore.getSettings()
    defaultsData.value = deepClone(response.defaults ?? {})

    const normalized = normalizeSettings(
      response.settings ?? {},
      response.defaults ?? {}
    )

    applySettings(normalized)
    loadedSnapshot.value = JSON.stringify(normalized)
    isLoaded.value = true
    $logger.info('Settings loaded', response)
  } catch (error) {
    const normalized = normalizeSettings()
    applySettings(normalized)
    loadedSnapshot.value = JSON.stringify(normalized)
    isLoaded.value = true
    loadError.value = error instanceof Error ? error.message : String(error)
    $logger.warn('Settings load failed, using empty form', error)
  } finally {
    isLoading.value = false
  }
}

async function saveSettings() {
  if (!canSave.value) {
    return
  }

  isSaving.value = true
  saveError.value = ''
  saveSuccess.value = ''

  try {
    const response = await apiStore.saveSettings(readSettings())
    const normalized = normalizeSettings(
      response.settings ?? readSettings(),
      defaultsData.value
    )

    applySettings(normalized)
    loadedSnapshot.value = JSON.stringify(normalized)
    saveSuccess.value = 'Настройки сохранены'
    $logger.info('Settings saved', response)
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
    $logger.error('Settings save failed', error)
  } finally {
    isSaving.value = false
  }
}

function resetToLoaded() {
  if (!isLoaded.value) {
    return
  }

  applySettings(JSON.parse(loadedSnapshot.value || '{}') as SettingsTree)
  saveError.value = ''
  saveSuccess.value = ''
}

onMounted(async () => {
  try {
    isLoading.value = true
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadSettings()
  } catch (error) {
    processErrorGlobal(error)
  } finally {
    isLoading.value = false
  }
})

onUnmounted(() => {
  if (b24Helper.value) {
    destroyB24Helper()
  }
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1360px] flex-col gap-4 p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 items-start gap-3">
        <B24Button
          color="air-secondary"
          label="Назад"
          @click="$router.push('/')"
        />
        <div class="min-w-0">
          <ProseH2 class="mb-1">
            Настройки отчёта АЗС
          </ProseH2>
          <ProseP class="mb-0 max-w-[840px] text-sm text-(--ui-color-base-70)">
            Настройка привязок сущностей, полей, стадий, таймингов и папок без перехода в backend.
          </ProseP>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <B24Badge
          rounded
          size="md"
          :color="statusColor"
          inverted
          :label="statusLabel"
        />
        <B24Badge
          rounded
          size="md"
          :color="isAdminReady ? 'air-primary-success' : 'air-primary-alert'"
          inverted
          :label="isAdminReady ? 'доступ администратора' : 'только просмотр'"
        />
      </div>
    </div>

    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Не удалось загрузить настройки"
      :description="loadError"
    />

    <B24Alert
      v-if="!isAdminReady && isLoaded"
      color="air-secondary"
      title="Просмотр доступен, редактирование отключено"
      description="Сохранение настроек доступно только для администратора портала."
    />

    <div class="grid gap-4 xl:grid-cols-2">
      <B24Card
        variant="outline"
        :b24ui="{
          body: 'p-4 sm:p-5',
          header: 'p-4 sm:p-5',
        }"
      >
        <template #header>
          <div class="flex items-start justify-between gap-3">
            <div>
              <ProseH3 class="mb-1">
                АЗС
              </ProseH3>
              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Базовая сущность, поля карточки, расписание и флаг активности.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="grid gap-3 sm:grid-cols-2">
          <B24FormField
            label="ID сущности АЗС"
            class="w-full"
          >
            <B24InputNumber
              v-model="form.azs.entityTypeId"
              class="w-full"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле администратора"
            class="w-full"
          >
            <B24Input
              v-model="form.azs.fields.admin"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле согласующих"
            class="w-full"
          >
            <B24Input
              v-model="form.azs.fields.reviewers"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле набора фото"
            class="w-full"
          >
            <B24Input
              v-model="form.azs.fields.photoSet"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле расписания"
            class="w-full"
          >
            <B24Input
              v-model="form.azs.fields.schedule"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле часового пояса"
            class="w-full"
          >
            <B24Input
              v-model="form.azs.fields.timezone"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле включения"
            class="w-full sm:col-span-2"
          >
            <B24Input
              v-model="form.azs.fields.enabled"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
        </div>
      </B24Card>

      <B24Card
        variant="outline"
        :b24ui="{
          body: 'p-4 sm:p-5',
          header: 'p-4 sm:p-5',
        }"
      >
        <template #header>
          <div class="flex items-start justify-between gap-3">
            <div>
              <ProseH3 class="mb-1">
                Отчёт
              </ProseH3>
              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Сущность отчёта, её поля и статусы жизненного цикла.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="grid gap-3 sm:grid-cols-2">
          <B24FormField
            label="ID сущности отчёта"
            class="w-full"
          >
            <B24InputNumber
              v-model="form.report.entityTypeId"
              class="w-full"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле АЗС"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.azs"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле администратора"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.admin"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле времени слота"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.slotTime"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле даты планирования"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.scheduledAt"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле дедлайна"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.deadlineAt"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле триггера"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.trigger"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле папки"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.folderId"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле фото"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.photos"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Поле статуса фото"
            class="w-full"
          >
            <B24Input
              v-model="form.report.fields.photoStatus"
              class="w-full"
              placeholder="UF_CRM_..."
              :disabled="!isAdminReady"
            />
          </B24FormField>
        </div>
      </B24Card>

      <B24Card
        variant="outline"
        :b24ui="{
          body: 'p-4 sm:p-5',
          header: 'p-4 sm:p-5',
        }"
      >
        <template #header>
          <div class="flex items-start justify-between gap-3">
            <div>
              <ProseH3 class="mb-1">
                Сроки и этапы
              </ProseH3>
              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Настройка стадий отчёта и параметров автоматической отправки.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="grid gap-3 sm:grid-cols-2">
          <B24FormField
            label="Стадия: новая"
            class="w-full"
          >
            <B24Input
              v-model="form.report.stages.new"
              class="w-full"
              placeholder="NEW"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Стадия: в работе"
            class="w-full"
          >
            <B24Input
              v-model="form.report.stages.inProgress"
              class="w-full"
              placeholder="IN_PROGRESS"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Стадия: выполнено"
            class="w-full"
          >
            <B24Input
              v-model="form.report.stages.done"
              class="w-full"
              placeholder="DONE"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Стадия: просрочено"
            class="w-full"
          >
            <B24Input
              v-model="form.report.stages.expired"
              class="w-full"
              placeholder="EXPIRED"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Таймаут, минут"
            class="w-full"
          >
            <B24InputNumber
              v-model="form.report.timeoutMinutes"
              class="w-full"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Джиттер отправки, минут"
            class="w-full"
          >
            <B24InputNumber
              v-model="form.report.dispatchJitterMinutes"
              class="w-full"
              :disabled="!isAdminReady"
            />
          </B24FormField>
        </div>
      </B24Card>

      <B24Card
        variant="outline"
        :b24ui="{
          body: 'p-4 sm:p-5',
          header: 'p-4 sm:p-5',
        }"
      >
        <template #header>
          <div class="flex items-start justify-between gap-3">
            <div>
              <ProseH3 class="mb-1">
                Диск и часовой пояс
              </ProseH3>
              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Папка для файлов отчёта, шаблон имени каталога и общий timezone.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="grid gap-3 sm:grid-cols-2">
          <B24FormField
            label="Корневая папка Диска"
            class="w-full"
          >
            <B24InputNumber
              v-model="form.disk.rootFolderId"
              class="w-full"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Шаблон имени папки"
            class="w-full"
          >
            <B24Input
              v-model="form.disk.folderNameTemplate"
              class="w-full"
              placeholder="{azs} / {date}"
              :disabled="!isAdminReady"
            />
          </B24FormField>
          <B24FormField
            label="Часовой пояс"
            class="w-full sm:col-span-2"
          >
            <B24Input
              v-model="form.timezone"
              class="w-full"
              placeholder="Europe/Moscow"
              :disabled="!isAdminReady"
            />
          </B24FormField>
        </div>
      </B24Card>
    </div>

    <B24Card
      variant="outline"
      :b24ui="{
        body: 'p-4 sm:p-5',
        header: 'p-4 sm:p-5',
      }"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1">
          <ProseH3 class="mb-0">
            Управление
          </ProseH3>
          <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
            Сохранение отправляет весь объект `settings`, перезагрузка подтягивает `defaults` и сохранённые значения.
          </ProseP>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <B24Button
            color="air-secondary"
            label="Перезагрузить"
            loading-auto
            :disabled="isSaving"
            @click="loadSettings"
          />
          <B24Button
            color="air-tertiary"
            label="Сбросить"
            :disabled="!isLoaded || !isDirty || isSaving"
            @click="resetToLoaded"
          />
          <B24Button
            color="air-primary-success"
            label="Сохранить"
            loading-auto
            :disabled="!canSave"
            @click="saveSettings"
          />
        </div>
      </div>

      <div class="mt-4 flex flex-col gap-2">
        <B24Alert
          v-if="saveError"
          color="air-primary-alert"
          title="Не удалось сохранить"
          :description="saveError"
        />
        <B24Alert
          v-if="saveSuccess"
          color="air-primary-success"
          title="Готово"
          :description="saveSuccess"
        />
      </div>
    </B24Card>
  </div>
</template>
