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
      enabled: string
    }
  }
  photoType: {
    entityTypeId: number
    fields: {
      code: string
      title: string
      sort: string
      active: string
    }
  }
  report: {
    entityTypeId: number
    fields: {
      azs: string
      trigger: string
      folderId: string
      photos: string
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
type ModuleKey = 'azs' | 'photoType' | 'report'
type FieldMapKey =
  | 'admin'
  | 'reviewers'
  | 'photoSet'
  | 'enabled'
  | 'code'
  | 'title'
  | 'sort'
  | 'active'
  | 'azs'
  | 'trigger'
  | 'folderId'
  | 'photos'

type SmartProcessOption = {
  label: string
  value: number
}

type CrmFieldOption = {
  label: string
  value: string
  type: string
  isMultiple: boolean
  isReadOnly: boolean
  statusType?: string
}

type StageOption = {
  label: string
  value: string
}

type FieldRequirement = {
  key: FieldMapKey
  label: string
  type: string
  multiple?: boolean
  createType: string
  createPostfix: string
}

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
const smartProcesses = ref<SmartProcessOption[]>([])
const fieldsByModule = reactive<Record<ModuleKey, CrmFieldOption[]>>({
  azs: [],
  photoType: [],
  report: []
})
const reportStages = ref<StageOption[]>([])
const portalLoadError = ref('')
const creatingFieldKey = ref('')

const azsFieldRequirements: FieldRequirement[] = [
  { key: 'admin', label: 'Администратор АЗС', type: 'Пользователь', createType: 'employee', createPostfix: 'ADMIN' },
  { key: 'reviewers', label: 'Проверяющие', type: 'Пользователь, множественное', multiple: true, createType: 'employee', createPostfix: 'REVIEWERS' },
  { key: 'photoSet', label: 'Набор обязательных фото', type: 'Привязка к СП Типы фото, множественное', multiple: true, createType: 'crm', createPostfix: 'PHOTO_SET' },
  { key: 'enabled', label: 'Активна', type: 'Да/Нет', createType: 'boolean', createPostfix: 'ENABLED' }
]

const photoTypeFieldRequirements: FieldRequirement[] = [
  { key: 'code', label: 'Код фото', type: 'Строка', createType: 'string', createPostfix: 'CODE' },
  { key: 'title', label: 'Название фото', type: 'Строка', createType: 'string', createPostfix: 'TITLE' },
  { key: 'sort', label: 'Сортировка', type: 'Число', createType: 'integer', createPostfix: 'SORT' },
  { key: 'active', label: 'Активность', type: 'Да/Нет', createType: 'boolean', createPostfix: 'ACTIVE' }
]

const reportFieldRequirements: FieldRequirement[] = [
  { key: 'azs', label: 'АЗС', type: 'Привязка к СП АЗС или строка', createType: 'crm', createPostfix: 'AZS' },
  { key: 'trigger', label: 'Тип запуска', type: 'Строка auto/manual', createType: 'string', createPostfix: 'TRIGGER' },
  { key: 'folderId', label: 'Папка Диска', type: 'Строка', createType: 'string', createPostfix: 'FOLDER_ID' },
  { key: 'photos', label: 'Загруженные фото', type: 'Файл, множественное', multiple: true, createType: 'file', createPostfix: 'PHOTOS' }
]

function makeEmptySettings(): SettingsTree {
  return {
    azs: {
      entityTypeId: 0,
      fields: {
        admin: '',
        reviewers: '',
        photoSet: '',
        enabled: ''
      }
    },
    photoType: {
      entityTypeId: 0,
      fields: {
        code: '',
        title: '',
        sort: '',
        active: ''
      }
    },
    report: {
      entityTypeId: 0,
      fields: {
        azs: '',
        trigger: '',
        folderId: '',
        photos: ''
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
  normalized.photoType.entityTypeId = Number(normalized.photoType.entityTypeId || 0)
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

  Object.assign(form.photoType, {
    entityTypeId: nextSettings.photoType.entityTypeId
  })
  Object.assign(form.photoType.fields, nextSettings.photoType.fields)

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
        enabled: form.azs.fields.enabled
      }
    },
    photoType: {
      entityTypeId: Number(form.photoType.entityTypeId || 0),
      fields: {
        code: form.photoType.fields.code,
        title: form.photoType.fields.title,
        sort: form.photoType.fields.sort,
        active: form.photoType.fields.active
      }
    },
    report: {
      entityTypeId: Number(form.report.entityTypeId || 0),
      fields: {
        azs: form.report.fields.azs,
        trigger: form.report.fields.trigger,
        folderId: form.report.fields.folderId,
        photos: form.report.fields.photos
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

function getB24Result(data: unknown): unknown {
  const response = data as { getData?: () => unknown }
  const payload = typeof response?.getData === 'function' ? response.getData() : data
  return (payload as { result?: unknown })?.result ?? payload
}

async function callB24(method: string, params: JsonObject = {}) {
  if (!$b24) {
    throw new Error('Bitrix24 frame is not initialized')
  }

  const response = await $b24.callMethod(method, params)
  return getB24Result(response)
}

function entitySelectValue(module: ModuleKey) {
  return String(form[module].entityTypeId || '')
}

function setEntitySelectValue(module: ModuleKey, value: string) {
  form[module].entityTypeId = Number(value || 0)
  void loadFieldsForModule(module)
  if (module === 'report') {
    void loadReportStages()
  }
}

function getModuleFieldValue(module: ModuleKey, key: FieldMapKey) {
  return String((form[module].fields as Record<string, string>)[key] || '')
}

function setModuleFieldValue(module: ModuleKey, key: FieldMapKey, value: string) {
  ;(form[module].fields as Record<string, string>)[key] = value
}

function normalizeFieldOptions(fields: JsonObject): CrmFieldOption[] {
  return Object.entries(fields)
    .map(([value, raw]) => {
      const field = isPlainObject(raw) ? raw : {}
      return {
        value,
        label: `${String(field.title || value)} (${value})`,
        type: String(field.type || ''),
        isMultiple: Boolean(field.isMultiple),
        isReadOnly: Boolean(field.isReadOnly),
        statusType: String(field.statusType || '')
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

function makeFieldName(entityTypeId: number, postfix: string) {
  const safePostfix = String(postfix || 'FIELD')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 24)
  return `UF_CRM_${entityTypeId}_${safePostfix}`.slice(0, 50)
}

function createPayloadForField(entityTypeId: number, requirement: FieldRequirement) {
  return {
    moduleId: 'crm',
    field: {
      entityId: `CRM_${entityTypeId}`,
      fieldName: makeFieldName(entityTypeId, requirement.createPostfix),
      userTypeId: requirement.createType,
      multiple: requirement.multiple ? 'Y' : 'N',
      mandatory: 'N',
      showFilter: 'Y',
      editInList: 'Y',
      isSearchable: requirement.createType === 'string' ? 'Y' : 'N',
      editFormLabel: {
        ru: requirement.label,
        en: requirement.createPostfix
      }
    }
  }
}

async function loadSmartProcesses() {
  portalLoadError.value = ''
  try {
    const result = await callB24('crm.type.list', {
      order: { title: 'ASC' }
    })
    const types = Array.isArray(result?.types) ? result.types : []
    smartProcesses.value = types
      .map((item: JsonObject) => ({
        label: `${String(item.title || 'Смарт-процесс')} (${String(item.entityTypeId)})`,
        value: Number(item.entityTypeId)
      }))
      .filter((item: SmartProcessOption) => Number.isFinite(item.value) && item.value > 0)
  } catch (error) {
    portalLoadError.value = error instanceof Error ? error.message : String(error)
  }
}

async function loadFieldsForModule(module: ModuleKey) {
  const entityTypeId = Number(form[module].entityTypeId || 0)
  fieldsByModule[module] = []
  if (!entityTypeId) {
    return
  }

  try {
    const result = await callB24('crm.item.fields', {
      entityTypeId,
      useOriginalUfNames: 'N'
    })
    fieldsByModule[module] = normalizeFieldOptions((result?.fields ?? {}) as JsonObject)
    if (module === 'report') {
      await loadReportStages()
    }
  } catch (error) {
    portalLoadError.value = error instanceof Error ? error.message : String(error)
  }
}

function normalizeStageOptions(items: unknown): StageOption[] {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item) => {
      const row = isPlainObject(item) ? item : {}
      const value = String(row.STATUS_ID || row.statusId || '')
      const name = String(row.NAME || row.name || value)
      return {
        value,
        label: `${name} (${value})`
      }
    })
    .filter((item) => item.value)
}

async function loadReportStages() {
  reportStages.value = []
  const stageField = fieldsByModule.report.find((field) => field.value === 'stageId' || field.value === 'stage_id')
  const statusType = String(stageField?.statusType || '')
  if (!statusType) {
    return
  }

  try {
    const result = await callB24('crm.status.entity.items', {
      entityId: statusType
    })
    reportStages.value = normalizeStageOptions(result)
  } catch (error) {
    portalLoadError.value = error instanceof Error ? error.message : String(error)
  }
}

async function loadPortalMetadata() {
  await loadSmartProcesses()
  await Promise.all([
    loadFieldsForModule('azs'),
    loadFieldsForModule('photoType'),
    loadFieldsForModule('report')
  ])
}

async function createMappedField(module: ModuleKey, requirement: FieldRequirement) {
  const entityTypeId = Number(form[module].entityTypeId || 0)
  if (!entityTypeId) {
    saveError.value = 'Сначала выберите смарт-процесс'
    return
  }

  creatingFieldKey.value = `${module}.${requirement.key}`
  saveError.value = ''
  saveSuccess.value = ''

  try {
    const result = await callB24('userfieldconfig.add', createPayloadForField(entityTypeId, requirement))
    await loadFieldsForModule(module)
    const fieldName = String(result?.field?.fieldName || '')
    const createdOption = fieldsByModule[module].find((item) => item.value.toUpperCase() === fieldName.toUpperCase())
    if (createdOption) {
      setModuleFieldValue(module, requirement.key, createdOption.value)
    }
    saveSuccess.value = `Поле "${requirement.label}" создано`
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    creatingFieldKey.value = ''
  }
}

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
    await loadPortalMetadata()
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

    <B24Alert
      v-if="portalLoadError"
      color="air-primary-alert"
      title="Не удалось загрузить метаданные портала"
      :description="portalLoadError"
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
                Выберите СП АЗС и сопоставьте поля карточки станции.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="space-y-4">
          <B24FormField label="Смарт-процесс АЗС">
            <select
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :value="entitySelectValue('azs')"
              :disabled="!isAdminReady"
              @change="setEntitySelectValue('azs', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Выберите СП</option>
              <option v-for="item in smartProcesses" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </B24FormField>

          <div class="overflow-auto">
            <table class="min-w-full text-sm">
              <tbody>
                <tr v-for="requirement in azsFieldRequirements" :key="requirement.key" class="border-b border-gray-100">
                  <td class="w-[38%] py-2 pr-3">
                    <div class="font-medium">{{ requirement.label }}</div>
                    <div class="text-xs text-gray-500">{{ requirement.type }}</div>
                  </td>
                  <td class="py-2 pr-2">
                    <select
                      class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
                      :value="getModuleFieldValue('azs', requirement.key)"
                      :disabled="!isAdminReady || !form.azs.entityTypeId"
                      @change="setModuleFieldValue('azs', requirement.key, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">Не сопоставлено</option>
                      <option v-for="field in fieldsByModule.azs" :key="field.value" :value="field.value">
                        {{ field.label }}
                      </option>
                    </select>
                  </td>
                  <td class="w-[120px] py-2 text-right">
                    <B24Button
                      size="xs"
                      color="air-secondary"
                      label="Создать"
                      :disabled="!isAdminReady || !form.azs.entityTypeId || Boolean(creatingFieldKey)"
                      loading-auto
                      @click="createMappedField('azs', requirement)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
                Типы фото
              </ProseH3>
              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Справочник обязательных фото, который выбирается в карточке АЗС.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="space-y-4">
          <B24FormField label="Смарт-процесс Типы фото">
            <select
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :value="entitySelectValue('photoType')"
              :disabled="!isAdminReady"
              @change="setEntitySelectValue('photoType', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Выберите СП</option>
              <option v-for="item in smartProcesses" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </B24FormField>

          <div class="overflow-auto">
            <table class="min-w-full text-sm">
              <tbody>
                <tr v-for="requirement in photoTypeFieldRequirements" :key="requirement.key" class="border-b border-gray-100">
                  <td class="w-[38%] py-2 pr-3">
                    <div class="font-medium">{{ requirement.label }}</div>
                    <div class="text-xs text-gray-500">{{ requirement.type }}</div>
                  </td>
                  <td class="py-2 pr-2">
                    <select
                      class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
                      :value="getModuleFieldValue('photoType', requirement.key)"
                      :disabled="!isAdminReady || !form.photoType.entityTypeId"
                      @change="setModuleFieldValue('photoType', requirement.key, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">Не сопоставлено</option>
                      <option v-for="field in fieldsByModule.photoType" :key="field.value" :value="field.value">
                        {{ field.label }}
                      </option>
                    </select>
                  </td>
                  <td class="w-[120px] py-2 text-right">
                    <B24Button
                      size="xs"
                      color="air-secondary"
                      label="Создать"
                      :disabled="!isAdminReady || !form.photoType.entityTypeId || Boolean(creatingFieldKey)"
                      loading-auto
                      @click="createMappedField('photoType', requirement)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
                Используем штатные поля title, assignedById, begindate, closedate и stageId; здесь сопоставляются только недостающие поля.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="space-y-4">
          <B24FormField label="Смарт-процесс Отчёт АЗС">
            <select
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :value="entitySelectValue('report')"
              :disabled="!isAdminReady"
              @change="setEntitySelectValue('report', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Выберите СП</option>
              <option v-for="item in smartProcesses" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </B24FormField>

          <div class="overflow-auto">
            <table class="min-w-full text-sm">
              <tbody>
                <tr v-for="requirement in reportFieldRequirements" :key="requirement.key" class="border-b border-gray-100">
                  <td class="w-[38%] py-2 pr-3">
                    <div class="font-medium">{{ requirement.label }}</div>
                    <div class="text-xs text-gray-500">{{ requirement.type }}</div>
                  </td>
                  <td class="py-2 pr-2">
                    <select
                      class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
                      :value="getModuleFieldValue('report', requirement.key)"
                      :disabled="!isAdminReady || !form.report.entityTypeId"
                      @change="setModuleFieldValue('report', requirement.key, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">Не сопоставлено</option>
                      <option v-for="field in fieldsByModule.report" :key="field.value" :value="field.value">
                        {{ field.label }}
                      </option>
                    </select>
                  </td>
                  <td class="w-[120px] py-2 text-right">
                    <B24Button
                      size="xs"
                      color="air-secondary"
                      label="Создать"
                      :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
                      loading-auto
                      @click="createMappedField('report', requirement)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
                Стадии отчёта, общий timezone, таймаут и джиттер.
              </ProseP>
            </div>
          </div>
        </template>

        <div class="grid gap-3 sm:grid-cols-2">
          <B24FormField
            label="Стадия: новая"
            class="w-full"
          >
            <select
              v-model="form.report.stages.new"
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :disabled="!isAdminReady || !reportStages.length"
            >
              <option value="">Выберите стадию</option>
              <option v-for="stage in reportStages" :key="stage.value" :value="stage.value">
                {{ stage.label }}
              </option>
            </select>
          </B24FormField>
          <B24FormField
            label="Стадия: в работе"
            class="w-full"
          >
            <select
              v-model="form.report.stages.inProgress"
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :disabled="!isAdminReady || !reportStages.length"
            >
              <option value="">Выберите стадию</option>
              <option v-for="stage in reportStages" :key="stage.value" :value="stage.value">
                {{ stage.label }}
              </option>
            </select>
          </B24FormField>
          <B24FormField
            label="Стадия: выполнено"
            class="w-full"
          >
            <select
              v-model="form.report.stages.done"
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :disabled="!isAdminReady || !reportStages.length"
            >
              <option value="">Выберите стадию</option>
              <option v-for="stage in reportStages" :key="stage.value" :value="stage.value">
                {{ stage.label }}
              </option>
            </select>
          </B24FormField>
          <B24FormField
            label="Стадия: просрочено"
            class="w-full"
          >
            <select
              v-model="form.report.stages.expired"
              class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
              :disabled="!isAdminReady || !reportStages.length"
            >
              <option value="">Выберите стадию</option>
              <option v-for="stage in reportStages" :key="stage.value" :value="stage.value">
                {{ stage.label }}
              </option>
            </select>
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
