<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

type ReasonItem = {
  code: string
  label: string
}

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
  }
  report: {
    entityTypeId: number
    fields: {
      azs: string
      trigger: string
      folderId: string
      photos: string
      reason: string
    }
    stages: {
      new: string
      inProgress: string
      done: string
      expired: string
    }
    timeoutMinutes: number
    dispatchJitterMinutes: number
    dispatchTimes: string[]
    workWindow: { start: string; end: string }
    reasons: ReasonItem[]
    responsibleChatId: string
  }
  disk: {
    rootFolderId: number
    folderNameTemplate: string
  }
  timezone: string
  access: {
    adminUserIds: number[]
    reviewerUserIds: number[]
    azsAdminUserIds: number[]
  }
}

type JsonObject = Record<string, unknown>
type AppRole = 'admin' | 'reviewer' | 'azs_admin'
type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}
type ModuleKey = 'azs' | 'photoType' | 'report'
type FieldMapKey =
  | 'admin'
  | 'reviewers'
  | 'photoSet'
  | 'enabled'
  | 'azs'
  | 'trigger'
  | 'folderId'
  | 'photos'
  | 'reason'

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
const isRefreshingBotAvatar = ref(false)
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
const currentRole = ref<AppRole>('azs_admin')
const roleCapabilities = ref<AppCapabilities>({
  settings: false,
  reviewer: false,
  reports: true
})

// ─── Section navigation state ────────────────────────────────────────────────
type SectionId = 'azs' | 'photo-type' | 'report' | 'reasons' | 'stages' | 'disk' | 'access' | 'manage'
const activeSection = ref<SectionId>('azs')
const mobileOpenSection = ref<SectionId | ''>('azs')

function scrollToSection(id: SectionId) {
  activeSection.value = id
  const el = document.getElementById(`section-${id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function applySystemAdminFallback() {
  if (Number(userStore.id || 0) !== 498) {
    return
  }

  currentRole.value = 'admin'
  roleCapabilities.value = {
    settings: true,
    reviewer: true,
    reports: true
  }
}

const azsFieldRequirements: FieldRequirement[] = [
  { key: 'admin', label: 'Администратор АЗС', type: 'Пользователь', createType: 'employee', createPostfix: 'ADMIN' },
  { key: 'reviewers', label: 'Проверяющие', type: 'Пользователь, множественное', multiple: true, createType: 'employee', createPostfix: 'REVIEWERS' },
  { key: 'photoSet', label: 'Набор обязательных фото', type: 'Привязка к СП Типы фото, множественное', multiple: true, createType: 'crm', createPostfix: 'PHOTO_SET' },
  { key: 'enabled', label: 'Активна', type: 'Да/Нет', createType: 'boolean', createPostfix: 'ENABLED' }
]

const reportFieldRequirements: FieldRequirement[] = [
  { key: 'azs', label: 'АЗС', type: 'Привязка к СП АЗС или строка', createType: 'crm', createPostfix: 'AZS' },
  { key: 'trigger', label: 'Тип запуска', type: 'Строка auto/manual', createType: 'string', createPostfix: 'TRIGGER' },
  { key: 'folderId', label: 'Папка Диска', type: 'Строка', createType: 'string', createPostfix: 'FOLDER_ID' },
  { key: 'photos', label: 'Загруженные фото', type: 'Файл, множественное', multiple: true, createType: 'file', createPostfix: 'PHOTOS' },
  { key: 'reason', label: 'Причина просрочки', type: 'Строка (UF причины)', createType: 'string', createPostfix: 'REASON' }
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
      entityTypeId: 0
    },
    report: {
      entityTypeId: 0,
      fields: {
        azs: '',
        trigger: '',
        folderId: '',
        photos: '',
        reason: ''
      },
      stages: {
        new: '',
        inProgress: '',
        done: '',
        expired: ''
      },
      timeoutMinutes: 60,
      dispatchJitterMinutes: 15,
      dispatchTimes: [],
      workWindow: { start: '07:00', end: '22:00' },
      reasons: [],
      responsibleChatId: ''
    },
    disk: {
      rootFolderId: 0,
      folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}'
    },
    timezone: 'Europe/Moscow',
    access: {
      adminUserIds: [],
      reviewerUserIds: [],
      azsAdminUserIds: []
    }
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

function toPositiveInt(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.trunc(parsed))
}

function normalizeUserIdList(value: unknown): number[] {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n;]+/g)

  return [...new Set(
    source
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0)
      .map((item) => Math.floor(item))
  )]
}

function userIdListToInput(value: number[]): string {
  return normalizeUserIdList(value).join(', ')
}

function parseUserIdInput(value: string): number[] {
  return normalizeUserIdList(value)
}

function isFetchErrorLike(value: unknown): value is { data?: unknown, message?: string } {
  return Boolean(value) && typeof value === 'object'
}

function toErrorMessage(error: unknown, fallback = 'Неизвестная ошибка'): string {
  if (isFetchErrorLike(error)) {
    const data = error.data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const payload = data as Record<string, unknown>
      const message = String(payload.message || '').trim()
      const details = Array.isArray(payload.details)
        ? payload.details.map((item) => String(item || '').trim()).filter(Boolean)
        : []

      const unique = new Set<string>()
      if (message) {
        unique.add(message)
      }
      for (const detail of details) {
        if (!detail) {
          continue
        }
        if (message && message.includes(detail)) {
          continue
        }
        unique.add(detail)
      }

      const combined = [...unique].join('\n')
      if (combined) {
        return combined
      }
    }

    const message = String(error.message || '').trim()
    if (message) {
      return message
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  return fallback
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
  normalized.report.timeoutMinutes = toPositiveInt(normalized.report.timeoutMinutes, 60, 1)
  normalized.report.dispatchJitterMinutes = toPositiveInt(normalized.report.dispatchJitterMinutes, 15, 0)
  normalized.report.dispatchTimes = Array.isArray(normalized.report.dispatchTimes)
    ? normalized.report.dispatchTimes.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  normalized.report.reasons = Array.isArray(normalized.report.reasons)
    ? normalized.report.reasons.map(r => ({ code: String(r?.code || ''), label: String(r?.label || '') }))
        .filter(r => r.code.trim() && r.label.trim())
    : []
  normalized.report.responsibleChatId = String(normalized.report.responsibleChatId || '').trim()
  normalized.disk.rootFolderId = toPositiveInt(normalized.disk.rootFolderId, 0, 0)
  normalized.disk.folderNameTemplate = String(normalized.disk.folderNameTemplate || '').trim() || '{yyyy-mm}/{dd}/{azs}_{azs_name}'
  normalized.access = {
    adminUserIds: normalizeUserIdList(normalized.access?.adminUserIds),
    reviewerUserIds: normalizeUserIdList(normalized.access?.reviewerUserIds),
    azsAdminUserIds: normalizeUserIdList(normalized.access?.azsAdminUserIds)
  }

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

  Object.assign(form.report, {
    entityTypeId: nextSettings.report.entityTypeId,
    timeoutMinutes: nextSettings.report.timeoutMinutes,
    dispatchJitterMinutes: nextSettings.report.dispatchJitterMinutes,
    dispatchTimes: [...nextSettings.report.dispatchTimes],
    workWindow: { ...nextSettings.report.workWindow }
  })
  Object.assign(form.report.fields, nextSettings.report.fields)
  Object.assign(form.report.stages, nextSettings.report.stages)
  // NEW: reasons (копия массива)
  form.report.reasons = Array.isArray(nextSettings.report?.reasons)
    ? nextSettings.report.reasons.map(r => ({ code: r.code, label: r.label }))
    : []
  // NEW: responsibleChatId
  form.report.responsibleChatId = String(nextSettings.report?.responsibleChatId || '')

  Object.assign(form.disk, nextSettings.disk)
  form.timezone = nextSettings.timezone
  Object.assign(form.access, {
    adminUserIds: [...nextSettings.access.adminUserIds],
    reviewerUserIds: [...nextSettings.access.reviewerUserIds],
    azsAdminUserIds: [...nextSettings.access.azsAdminUserIds]
  })
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
      entityTypeId: Number(form.photoType.entityTypeId || 0)
    },
    report: {
      entityTypeId: Number(form.report.entityTypeId || 0),
      fields: {
        azs: form.report.fields.azs,
        trigger: form.report.fields.trigger,
        folderId: form.report.fields.folderId,
        photos: form.report.fields.photos,
        reason: form.report.fields.reason
      },
      reasons: form.report.reasons.map(r => ({ code: String(r.code || '').trim(), label: String(r.label || '').trim() })).filter(r => r.code && r.label),
      responsibleChatId: String(form.report.responsibleChatId || '').trim(),
      stages: {
        new: form.report.stages.new,
        inProgress: form.report.stages.inProgress,
        done: form.report.stages.done,
        expired: form.report.stages.expired
      },
      timeoutMinutes: toPositiveInt(form.report.timeoutMinutes, 60, 1),
      dispatchJitterMinutes: toPositiveInt(form.report.dispatchJitterMinutes, 15, 0),
      dispatchTimes: [...new Set(form.report.dispatchTimes.map((item) => String(item || '').trim()).filter(Boolean))].sort(),
      workWindow: {
        start: String(form.report.workWindow?.start || '07:00'),
        end: String(form.report.workWindow?.end || '22:00')
      }
    },
    disk: {
      rootFolderId: Number(form.disk.rootFolderId || 0),
      folderNameTemplate: String(form.disk.folderNameTemplate || '').trim() || '{yyyy-mm}/{dd}/{azs}_{azs_name}'
    },
    timezone: form.timezone,
    access: {
      adminUserIds: normalizeUserIdList(form.access.adminUserIds),
      reviewerUserIds: normalizeUserIdList(form.access.reviewerUserIds),
      azsAdminUserIds: normalizeUserIdList(form.access.azsAdminUserIds)
    }
  })
}

const isAdminReady = computed(() => roleCapabilities.value.settings)
const accessAdminInput = computed({
  get: () => userIdListToInput(form.access.adminUserIds),
  set: (value: string) => {
    form.access.adminUserIds = parseUserIdInput(value)
  }
})
const accessReviewerInput = computed({
  get: () => userIdListToInput(form.access.reviewerUserIds),
  set: (value: string) => {
    form.access.reviewerUserIds = parseUserIdInput(value)
  }
})
const accessAzsAdminInput = computed({
  get: () => userIdListToInput(form.access.azsAdminUserIds),
  set: (value: string) => {
    form.access.azsAdminUserIds = parseUserIdInput(value)
  }
})
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

// ─── Section completion computed ─────────────────────────────────────────────
const sectionComplete = computed(() => ({
  azs: Boolean(
    form.azs.entityTypeId
    && form.azs.fields.admin
    && form.azs.fields.reviewers
    && form.azs.fields.photoSet
    && form.azs.fields.enabled
  ),
  photoType: Boolean(form.photoType.entityTypeId),
  report: Boolean(
    form.report.entityTypeId
    && form.report.fields.azs
    && form.report.fields.folderId
  ),
  reasons: Boolean(
    form.report.fields.reason
    && form.report.reasons.length > 0
    && form.report.responsibleChatId
  ),
  stages: Boolean(
    form.report.stages.new
    && form.report.stages.inProgress
    && form.report.stages.done
    && form.report.stages.expired
  ),
  disk: Boolean(form.disk.rootFolderId && form.disk.folderNameTemplate && form.timezone),
  access: Boolean(form.access.adminUserIds.length),
  manage: true
}))

// ─── Smart-process select items (for B24Select) ───────────────────────────────
const smartProcessSelectItems = computed(() =>
  smartProcesses.value.map((item) => ({ label: item.label, value: String(item.value) }))
)

// ─── Navigation sections definition ──────────────────────────────────────────
const navSections = computed(() => [
  { id: 'azs' as SectionId, label: 'АЗС', complete: sectionComplete.value.azs },
  { id: 'photo-type' as SectionId, label: 'Типы фото', complete: sectionComplete.value.photoType },
  { id: 'report' as SectionId, label: 'Отчёт', complete: sectionComplete.value.report },
  { id: 'reasons' as SectionId, label: 'Причины просрочек', complete: sectionComplete.value.reasons },
  { id: 'stages' as SectionId, label: 'Сроки и этапы', complete: sectionComplete.value.stages },
  { id: 'disk' as SectionId, label: 'Диск и часовой пояс', complete: sectionComplete.value.disk },
  { id: 'access' as SectionId, label: 'Роли доступа', complete: sectionComplete.value.access },
  { id: 'manage' as SectionId, label: 'Управление', complete: true }
])

// ─── Helpers for B24Select controlled binding ─────────────────────────────────
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

function fieldSelectItems(module: ModuleKey) {
  return fieldsByModule[module].map((f) => ({ label: f.label, value: f.value }))
}

function stageSelectItems() {
  return reportStages.value.map((s) => ({ label: s.label, value: s.value }))
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

async function loadRoleContext() {
  try {
    const response = await apiStore.getMyRole()
    currentRole.value = response.role || 'azs_admin'
    roleCapabilities.value = {
      settings: Boolean(response.capabilities?.settings),
      reviewer: Boolean(response.capabilities?.reviewer),
      reports: Boolean(response.capabilities?.reports)
    }
    applySystemAdminFallback()
  } catch {
    currentRole.value = 'azs_admin'
    roleCapabilities.value = {
      settings: false,
      reviewer: false,
      reports: true
    }
    applySystemAdminFallback()
  }
}

async function saveSettings() {
  if (!canSave.value) {
    return
  }

  if (!String(form.report.fields.folderId || '').trim()) {
    saveError.value = 'Сопоставьте поле "Папка Диска" в разделе "Отчёт".'
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
    saveError.value = toErrorMessage(error, 'Не удалось сохранить настройки')
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

async function refreshBotAvatar() {
  if (isRefreshingBotAvatar.value) {
    return
  }
  isRefreshingBotAvatar.value = true
  saveError.value = ''
  saveSuccess.value = ''
  try {
    const result = await apiStore.refreshBotAvatar()
    saveSuccess.value = result?.botId
      ? `Аватарка бота обновлена (botId ${result.botId})`
      : 'Аватарка бота обновлена'
  } catch (error) {
    const data = (error as { data?: { message?: string; error?: string } })?.data
    saveError.value = data?.message || data?.error || (error instanceof Error ? error.message : 'Не удалось обновить аватарку бота')
  } finally {
    isRefreshingBotAvatar.value = false
  }
}

// ─── Редактор каталога причин ─────────────────────────────────────────────────
const DEFAULT_REASONS_SEED = [
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'delivery', label: 'Приёмка товара' },
  { code: 'queue', label: 'Очередь / много гостей' },
  { code: 'wc_busy', label: 'Санузел занят' },
  { code: 'staff', label: 'Нехватка персонала' },
  { code: 'other', label: 'Другое (требует текст)' }
]

function addReasonItem() {
  if (!Array.isArray(form.report.reasons)) form.report.reasons = []
  form.report.reasons.push({ code: '', label: '' })
}

function removeReasonItem(index: number) {
  form.report.reasons.splice(index, 1)
}

function seedDefaultReasons() {
  form.report.reasons = DEFAULT_REASONS_SEED.map(r => ({ ...r }))
}

function addDispatchTimeSlot() {
  if (!Array.isArray(form.report.dispatchTimes)) {
    form.report.dispatchTimes = []
  }
  form.report.dispatchTimes.push('09:00')
}

function removeDispatchTimeSlot(index: number) {
  form.report.dispatchTimes.splice(index, 1)
}

onMounted(async () => {
  try {
    isLoading.value = true
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    applySystemAdminFallback()
    await loadRoleContext()
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
  <!-- Page shell -->
  <div class="mx-auto flex w-full max-w-[1360px] flex-col gap-4 p-4 pb-24">
    <!-- ── Page header ──────────────────────────────────────────────────────── -->
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
          :label="isAdminReady ? 'роль: администратор' : `роль: ${currentRole}`"
        />
        <HelpButton default-role="settings" />
      </div>
    </div>

    <!-- ── Global alerts ────────────────────────────────────────────────────── -->
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
      description="Сохранение настроек доступно только для роли Администратор приложения."
    />
    <B24Alert
      v-if="portalLoadError"
      color="air-primary-alert"
      title="Не удалось загрузить метаданные портала"
      :description="portalLoadError"
    />

    <!-- ── Main layout: sidebar (desktop) + sections ────────────────────────── -->
    <div class="flex gap-6">
      <!-- LEFT SIDEBAR (desktop only) -->
      <aside class="hidden lg:block w-52 shrink-0">
        <div class="sticky top-4 rounded-lg border border-(--ui-color-base-20) bg-(--ui-color-base-0) p-3">
          <p class="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-50)">
            Разделы
          </p>
          <nav class="flex flex-col gap-0.5">
            <button
              v-for="section in navSections"
              :key="section.id"
              type="button"
              class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-(--ui-color-base-10)"
              :class="activeSection === section.id ? 'bg-(--ui-color-base-10) font-semibold text-(--ui-color-base-90)' : 'text-(--ui-color-base-70)'"
              @click="scrollToSection(section.id)"
            >
              <span class="truncate">{{ section.label }}</span>
              <span
                v-if="section.complete"
                class="ml-1 shrink-0 text-green-500"
                title="Заполнено"
              >✓</span>
              <span
                v-else
                class="ml-1 shrink-0 h-1.5 w-1.5 rounded-full bg-amber-400"
                title="Не заполнено"
              />
            </button>
          </nav>
        </div>
      </aside>

      <!-- CONTENT COLUMN -->
      <div class="min-w-0 flex-1 flex flex-col gap-4">

        <!-- ── MOBILE: Accordion navigation (< lg) ─────────────────────────── -->
        <div class="lg:hidden">
          <B24Accordion
            :model-value="mobileOpenSection"
            type="single"
            collapsible
            :items="navSections.map((s) => ({
              value: s.id,
              label: s.label,
              slot: s.id
            }))"
            @update:model-value="(v) => { mobileOpenSection = (v as SectionId | '') }"
          >
            <!-- АЗС section slot -->
            <template #azs-body>
              <div class="space-y-4 p-4">
                <!-- АЗС smart-process -->
                <B24FormField label="Смарт-процесс АЗС">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Смарт-процесс АЗС
                      <B24Tooltip text="Смарт-процесс (СП) в CRM Битрикс24, карточки которого соответствуют станциям. Должен иметь поля admin, reviewers, photoSet, enabled.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Select
                    :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                    :model-value="entitySelectValue('azs')"
                    :disabled="!isAdminReady"
                    placeholder="Выберите СП"
                    class="w-full"
                    @update:model-value="(v) => setEntitySelectValue('azs', String(v ?? ''))"
                  />
                </B24FormField>

                <!-- AZS field mapping table -->
                <div class="overflow-auto">
                  <table class="min-w-full text-sm">
                    <tbody>
                      <tr v-for="req in azsFieldRequirements" :key="req.key" class="border-b border-(--ui-color-base-20)">
                        <td class="w-[38%] py-2 pr-3">
                          <div class="font-medium">{{ req.label }}</div>
                          <div class="text-xs text-(--ui-color-base-50)">{{ req.type }}</div>
                        </td>
                        <td class="py-2 pr-2">
                          <B24Select
                            :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('azs')]"
                            :model-value="getModuleFieldValue('azs', req.key)"
                            :disabled="!isAdminReady || !form.azs.entityTypeId"
                            placeholder="Не сопоставлено"
                            class="w-full"
                            @update:model-value="(v) => setModuleFieldValue('azs', req.key, String(v ?? ''))"
                          />
                        </td>
                        <td class="w-[100px] py-2 text-right">
                          <B24Button
                            size="xs"
                            color="air-secondary"
                            label="Создать"
                            :disabled="!isAdminReady || !form.azs.entityTypeId || Boolean(creatingFieldKey)"
                            loading-auto
                            @click="createMappedField('azs', req)"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>

            <!-- Типы фото section slot -->
            <template #photo-type-body>
              <div class="space-y-4 p-4">
                <B24FormField label="Смарт-процесс Типы фото">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Смарт-процесс Типы фото
                      <B24Tooltip text="Справочный СП — каждая его запись это один тип фото (например «Фасад», «Ценник»). Выбирается в карточке АЗС для формирования обязательного набора.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Select
                    :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                    :model-value="entitySelectValue('photoType')"
                    :disabled="!isAdminReady"
                    placeholder="Выберите СП"
                    class="w-full"
                    @update:model-value="(v) => setEntitySelectValue('photoType', String(v ?? ''))"
                  />
                </B24FormField>
                <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                  Достаточно выбрать смарт-процесс. Идентификатор и название каждой позиции берутся из стандартных полей записи. Порядок показа — по возрастанию id записи.
                </ProseP>
              </div>
            </template>

            <!-- Отчёт section slot -->
            <template #report-body>
              <div class="space-y-4 p-4">
                <B24FormField label="Смарт-процесс Отчёт АЗС">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Смарт-процесс Отчёт АЗС
                      <B24Tooltip text="СП, в котором хранятся отчёты сотрудников. Используются штатные поля title, assignedById, begindate, closedate, stageId; дополнительные поля сопоставляются ниже.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Select
                    :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                    :model-value="entitySelectValue('report')"
                    :disabled="!isAdminReady"
                    placeholder="Выберите СП"
                    class="w-full"
                    @update:model-value="(v) => setEntitySelectValue('report', String(v ?? ''))"
                  />
                </B24FormField>

                <div class="overflow-auto">
                  <table class="min-w-full text-sm">
                    <tbody>
                      <tr v-for="req in reportFieldRequirements" :key="req.key" class="border-b border-(--ui-color-base-20)">
                        <td class="w-[38%] py-2 pr-3">
                          <div class="font-medium">{{ req.label }}</div>
                          <div class="text-xs text-(--ui-color-base-50)">{{ req.type }}</div>
                        </td>
                        <td class="py-2 pr-2">
                          <B24Select
                            :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('report')]"
                            :model-value="getModuleFieldValue('report', req.key)"
                            :disabled="!isAdminReady || !form.report.entityTypeId"
                            placeholder="Не сопоставлено"
                            class="w-full"
                            @update:model-value="(v) => setModuleFieldValue('report', req.key, String(v ?? ''))"
                          />
                        </td>
                        <td class="w-[100px] py-2 text-right">
                          <B24Button
                            size="xs"
                            color="air-secondary"
                            label="Создать"
                            :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
                            loading-auto
                            @click="createMappedField('report', req)"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>

            <!-- Причины просрочек section slot -->
            <template #reasons-body>
              <div class="space-y-4 p-4">
                <!-- Поле UF причины -->
                <B24FormField label="UF-поле причины на отчёте">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      UF-поле причины на отчёте
                      <B24Tooltip text="Строковое пользовательское поле на карточке отчёта для хранения причины просрочки. Создайте поле через кнопку или выберите существующее.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <div class="flex gap-2">
                    <B24Select
                      :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('report')]"
                      :model-value="form.report.fields.reason"
                      :disabled="!isAdminReady || !form.report.entityTypeId"
                      placeholder="Не сопоставлено"
                      class="flex-1"
                      @update:model-value="(v) => { form.report.fields.reason = String(v ?? '') }"
                    />
                    <B24Button
                      size="sm"
                      color="air-secondary"
                      label="Создать"
                      :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
                      loading-auto
                      @click="createMappedField('report', { key: 'reason', label: 'Причина просрочки', type: 'Строка (UF причины)', createType: 'string', createPostfix: 'REASON' })"
                    />
                  </div>
                </B24FormField>

                <!-- ID чата ответственных -->
                <B24FormField label="ID общего чата ответственных">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      ID общего чата ответственных
                      <B24Tooltip text="Числовой ID чата Битрикс24, в который бот будет пересылать причину. Пусто — пересылка отключена, причина всё равно записывается.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Input
                    v-model="form.report.responsibleChatId"
                    class="w-full"
                    placeholder="12345"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>

                <!-- Список причин (редактор) -->
                <B24FormField label="Список причин">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Список причин
                      <B24Tooltip text="Каждая причина — код (латиница, уникальный) и подпись (отображается оператору). Код 'other' — причина со свободным текстом.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <div class="space-y-2">
                    <div
                      v-for="(reason, idx) in form.report.reasons"
                      :key="`reason-m-${idx}`"
                      class="flex items-center gap-2"
                    >
                      <B24Input
                        v-model="form.report.reasons[idx].code"
                        class="w-28"
                        placeholder="код"
                        :disabled="!isAdminReady"
                      />
                      <B24Input
                        v-model="form.report.reasons[idx].label"
                        class="flex-1"
                        placeholder="Подпись"
                        :disabled="!isAdminReady"
                      />
                      <B24Button
                        size="xs"
                        color="air-primary-alert"
                        label="Удалить"
                        :disabled="!isAdminReady"
                        @click="removeReasonItem(idx)"
                      />
                    </div>
                    <div class="flex gap-2">
                      <B24Button
                        size="xs"
                        color="air-secondary"
                        label="Добавить"
                        :disabled="!isAdminReady"
                        @click="addReasonItem"
                      />
                      <B24Button
                        size="xs"
                        color="air-tertiary"
                        label="Seed по умолчанию"
                        :disabled="!isAdminReady || form.report.reasons.length > 0"
                        @click="seedDefaultReasons"
                      />
                    </div>
                    <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                      Кнопка «Seed по умолчанию» заполняет стандартный набор. Список редактируется свободно — никакого хардкода в бизнес-логике нет.
                    </ProseP>
                  </div>
                </B24FormField>
              </div>
            </template>

            <!-- Сроки и этапы section slot -->
            <template #stages-body>
              <div class="grid gap-3 p-4 sm:grid-cols-2">
                <B24FormField label="Стадия: новая" class="w-full">
                  <B24Select
                    v-model="form.report.stages.new"
                    :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                    :disabled="!isAdminReady || !reportStages.length"
                    placeholder="Выберите стадию"
                    class="w-full"
                  />
                </B24FormField>
                <B24FormField label="Стадия: в работе" class="w-full">
                  <B24Select
                    v-model="form.report.stages.inProgress"
                    :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                    :disabled="!isAdminReady || !reportStages.length"
                    placeholder="Выберите стадию"
                    class="w-full"
                  />
                </B24FormField>
                <B24FormField label="Стадия: выполнено" class="w-full">
                  <B24Select
                    v-model="form.report.stages.done"
                    :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                    :disabled="!isAdminReady || !reportStages.length"
                    placeholder="Выберите стадию"
                    class="w-full"
                  />
                </B24FormField>
                <B24FormField label="Стадия: просрочено" class="w-full">
                  <B24Select
                    v-model="form.report.stages.expired"
                    :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                    :disabled="!isAdminReady || !reportStages.length"
                    placeholder="Выберите стадию"
                    class="w-full"
                  />
                </B24FormField>
                <B24FormField label="Таймаут, минут" class="w-full">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Таймаут, минут
                      <B24Tooltip text="Сколько минут отводится сотруднику на сдачу отчёта после получения запроса. По истечении статус переходит в «Просрочено».">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24InputNumber
                    v-model="form.report.timeoutMinutes"
                    class="w-full"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Джиттер отправки, минут" class="w-full">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Джиттер отправки, минут
                      <B24Tooltip text="Случайная задержка (в минутах) для каждой АЗС при авто-рассылке. Разбрасывает запросы во времени, чтобы не нагружать сервер одновременно.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24InputNumber
                    v-model="form.report.dispatchJitterMinutes"
                    class="w-full"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Авто-отправка по времени" class="w-full sm:col-span-2">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Авто-отправка по времени
                      <B24Tooltip text="Список времён (HH:MM) для автоматической рассылки запросов отчёта. Бот отправит push в каждую из указанных точек. Поле необязательное — можно оставить пустым.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <div class="space-y-2">
                    <div
                      v-for="(slot, index) in form.report.dispatchTimes"
                      :key="`dispatch-time-${index}`"
                      class="flex items-center gap-2"
                    >
                      <input
                        v-model="form.report.dispatchTimes[index]"
                        type="time"
                        step="60"
                        class="w-full rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                        :disabled="!isAdminReady"
                      >
                      <B24Button
                        size="xs"
                        color="air-primary-alert"
                        label="Удалить"
                        :disabled="!isAdminReady"
                        @click="removeDispatchTimeSlot(index)"
                      />
                    </div>
                    <B24Button
                      size="xs"
                      color="air-secondary"
                      label="Добавить время"
                      :disabled="!isAdminReady"
                      @click="addDispatchTimeSlot"
                    />
                    <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                      Выберите время через тайм-пикер. В эти моменты бот автоматически отправит запрос отчёта.
                    </ProseP>
                  </div>
                </B24FormField>
                <B24FormField label="Рабочее окно рассылки" class="w-full sm:col-span-2">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Рабочее окно рассылки
                      <B24Tooltip text="Случайное время запроса отчёта будет ограничено этим окном — раньше начала и позже конца запросы не уйдут.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <div class="flex items-center gap-3">
                    <label class="text-sm text-(--ui-color-base-70)">с</label>
                    <input
                      v-model="form.report.workWindow.start"
                      type="time"
                      step="60"
                      class="rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                      :disabled="!isAdminReady"
                    >
                    <label class="text-sm text-(--ui-color-base-70)">до</label>
                    <input
                      v-model="form.report.workWindow.end"
                      type="time"
                      step="60"
                      class="rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                      :disabled="!isAdminReady"
                    >
                  </div>
                </B24FormField>
              </div>
            </template>

            <!-- Диск и часовой пояс section slot -->
            <template #disk-body>
              <div class="grid gap-3 p-4 sm:grid-cols-2">
                <B24FormField label="Корневая папка Диска" class="w-full">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Корневая папка Диска
                      <B24Tooltip text="ID папки Диск.Бизнес (Bitrix24 Drive), в которой будут создаваться подкаталоги для фото каждого отчёта. Найти ID можно в адресной строке при открытии папки.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24InputNumber
                    v-model="form.disk.rootFolderId"
                    class="w-full"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Шаблон имени папки" class="w-full">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Шаблон имени папки
                      <B24Tooltip text="Шаблон пути подкаталога внутри корневой папки. Переменные: {yyyy-mm} — год-месяц, {dd} — день, {azs} — id АЗС, {azs_name} — название. Пример: {yyyy-mm}/{dd}/{azs}_{azs_name}">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Input
                    v-model="form.disk.folderNameTemplate"
                    class="w-full"
                    placeholder="{yyyy-mm}/{dd}/{azs}_{azs_name}"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Часовой пояс" class="w-full sm:col-span-2">
                  <B24Input
                    v-model="form.timezone"
                    class="w-full"
                    placeholder="Europe/Moscow"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
              </div>
            </template>

            <!-- Роли доступа section slot -->
            <template #access-body>
              <div class="grid gap-3 p-4">
                <B24FormField label="Администраторы" class="w-full">
                  <template #label>
                    <span class="inline-flex items-center gap-1">
                      Администраторы (userId через запятую)
                      <B24Tooltip text="ID пользователей Битрикс24 с полным доступом к настройкам и управлению приложением. Найти userId: профиль сотрудника → адресная строка.">
                        <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                      </B24Tooltip>
                    </span>
                  </template>
                  <B24Input
                    v-model="accessAdminInput"
                    class="w-full"
                    placeholder="1, 7, 42"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Проверяющие (userId через запятую)" class="w-full">
                  <B24Input
                    v-model="accessReviewerInput"
                    class="w-full"
                    placeholder="11, 25"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <B24FormField label="Администраторы АЗС (userId через запятую, опционально)" class="w-full">
                  <B24Input
                    v-model="accessAzsAdminInput"
                    class="w-full"
                    placeholder="по умолчанию все пользователи"
                    :disabled="!isAdminReady"
                  />
                </B24FormField>
                <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                  Пользователь вне списков получает роль Администратор АЗС. Администратор портала по умолчанию получает роль Администратор.
                </ProseP>
              </div>
            </template>

            <!-- Управление section slot -->
            <template #manage-body>
              <div class="space-y-3 p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <B24Button
                    color="air-tertiary"
                    label="Обновить аватарку бота"
                    loading-auto
                    :disabled="!isAdminReady || isRefreshingBotAvatar"
                    @click="refreshBotAvatar"
                  />
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
                </div>
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
            </template>
          </B24Accordion>
        </div>

        <!-- ── DESKTOP: full section cards (≥ lg) ──────────────────────────── -->
        <div class="hidden lg:flex lg:flex-col lg:gap-4">

          <!-- АЗС -->
          <B24Card
            id="section-azs"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">АЗС</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.azs ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.azs ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Выберите СП АЗС и сопоставьте поля карточки станции.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="space-y-4">
              <B24FormField label="Смарт-процесс АЗС">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Смарт-процесс АЗС
                    <B24Tooltip text="Смарт-процесс (СП) в CRM Битрикс24, карточки которого соответствуют станциям. Должен иметь поля admin, reviewers, photoSet, enabled.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Select
                  :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                  :model-value="entitySelectValue('azs')"
                  :disabled="!isAdminReady"
                  placeholder="Выберите СП"
                  class="w-full"
                  @update:model-value="(v) => setEntitySelectValue('azs', String(v ?? ''))"
                />
              </B24FormField>

              <div class="overflow-auto">
                <table class="min-w-full text-sm">
                  <tbody>
                    <tr v-for="req in azsFieldRequirements" :key="req.key" class="border-b border-(--ui-color-base-20)">
                      <td class="w-[38%] py-2 pr-3">
                        <div class="font-medium">{{ req.label }}</div>
                        <div class="text-xs text-(--ui-color-base-50)">{{ req.type }}</div>
                      </td>
                      <td class="py-2 pr-2">
                        <B24Select
                          :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('azs')]"
                          :model-value="getModuleFieldValue('azs', req.key)"
                          :disabled="!isAdminReady || !form.azs.entityTypeId"
                          placeholder="Не сопоставлено"
                          class="w-full"
                          @update:model-value="(v) => setModuleFieldValue('azs', req.key, String(v ?? ''))"
                        />
                      </td>
                      <td class="w-[120px] py-2 text-right">
                        <B24Button
                          size="xs"
                          color="air-secondary"
                          label="Создать"
                          :disabled="!isAdminReady || !form.azs.entityTypeId || Boolean(creatingFieldKey)"
                          loading-auto
                          @click="createMappedField('azs', req)"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </B24Card>

          <!-- Типы фото -->
          <B24Card
            id="section-photo-type"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Типы фото</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.photoType ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.photoType ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Справочник обязательных фото, который выбирается в карточке АЗС.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="space-y-4">
              <B24FormField label="Смарт-процесс Типы фото">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Смарт-процесс Типы фото
                    <B24Tooltip text="Справочный СП — каждая его запись это один тип фото (например «Фасад», «Ценник»). Выбирается в карточке АЗС для формирования обязательного набора.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Select
                  :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                  :model-value="entitySelectValue('photoType')"
                  :disabled="!isAdminReady"
                  placeholder="Выберите СП"
                  class="w-full"
                  @update:model-value="(v) => setEntitySelectValue('photoType', String(v ?? ''))"
                />
              </B24FormField>

              <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                Достаточно выбрать смарт-процесс. Идентификатор и название каждой позиции берутся из стандартных полей записи. Порядок показа — по возрастанию id записи.
              </ProseP>
            </div>
          </B24Card>

          <!-- Отчёт -->
          <B24Card
            id="section-report"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Отчёт</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.report ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.report ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Используем штатные поля title, assignedById, begindate, closedate и stageId; здесь сопоставляются только недостающие поля.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="space-y-4">
              <B24FormField label="Смарт-процесс Отчёт АЗС">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Смарт-процесс Отчёт АЗС
                    <B24Tooltip text="СП, в котором хранятся отчёты сотрудников. Используются штатные поля title, assignedById, begindate, closedate, stageId; дополнительные поля сопоставляются ниже.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Select
                  :items="[{ label: 'Выберите СП', value: '' }, ...smartProcessSelectItems]"
                  :model-value="entitySelectValue('report')"
                  :disabled="!isAdminReady"
                  placeholder="Выберите СП"
                  class="w-full"
                  @update:model-value="(v) => setEntitySelectValue('report', String(v ?? ''))"
                />
              </B24FormField>

              <div class="overflow-auto">
                <table class="min-w-full text-sm">
                  <tbody>
                    <tr v-for="req in reportFieldRequirements" :key="req.key" class="border-b border-(--ui-color-base-20)">
                      <td class="w-[38%] py-2 pr-3">
                        <div class="font-medium">{{ req.label }}</div>
                        <div class="text-xs text-(--ui-color-base-50)">{{ req.type }}</div>
                      </td>
                      <td class="py-2 pr-2">
                        <B24Select
                          :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('report')]"
                          :model-value="getModuleFieldValue('report', req.key)"
                          :disabled="!isAdminReady || !form.report.entityTypeId"
                          placeholder="Не сопоставлено"
                          class="w-full"
                          @update:model-value="(v) => setModuleFieldValue('report', req.key, String(v ?? ''))"
                        />
                      </td>
                      <td class="w-[120px] py-2 text-right">
                        <B24Button
                          size="xs"
                          color="air-secondary"
                          label="Создать"
                          :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
                          loading-auto
                          @click="createMappedField('report', req)"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </B24Card>

          <!-- Причины просрочек -->
          <B24Card
            id="section-reasons"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Причины просрочек</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.reasons ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.reasons ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    UF-поле причины на карточке отчёта, список причин и чат ответственных. Список редактируется здесь — нет хардкода.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="space-y-4">
              <!-- Поле UF причины -->
              <B24FormField label="UF-поле причины на отчёте">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    UF-поле причины на отчёте
                    <B24Tooltip text="Строковое пользовательское поле на карточке отчёта для хранения причины просрочки. Создайте поле через кнопку или выберите существующее.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <div class="flex gap-2">
                  <B24Select
                    :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('report')]"
                    :model-value="form.report.fields.reason"
                    :disabled="!isAdminReady || !form.report.entityTypeId"
                    placeholder="Не сопоставлено"
                    class="flex-1"
                    @update:model-value="(v) => { form.report.fields.reason = String(v ?? '') }"
                  />
                  <B24Button
                    size="sm"
                    color="air-secondary"
                    label="Создать"
                    :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
                    loading-auto
                    @click="createMappedField('report', { key: 'reason', label: 'Причина просрочки', type: 'Строка (UF причины)', createType: 'string', createPostfix: 'REASON' })"
                  />
                </div>
              </B24FormField>

              <!-- ID чата ответственных -->
              <B24FormField label="ID общего чата ответственных">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    ID общего чата ответственных
                    <B24Tooltip text="Числовой ID чата Битрикс24, в который бот будет пересылать причину. Пусто — пересылка отключена, причина всё равно записывается.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Input
                  v-model="form.report.responsibleChatId"
                  class="w-full"
                  placeholder="12345"
                  :disabled="!isAdminReady"
                />
              </B24FormField>

              <!-- Список причин (редактор) -->
              <B24FormField label="Список причин">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Список причин
                    <B24Tooltip text="Каждая причина — код (латиница, уникальный) и подпись (отображается оператору). Код 'other' — причина со свободным текстом.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <div class="space-y-2">
                  <div
                    v-for="(reason, idx) in form.report.reasons"
                    :key="`reason-d-${idx}`"
                    class="flex items-center gap-2"
                  >
                    <B24Input
                      v-model="form.report.reasons[idx].code"
                      class="w-32"
                      placeholder="код"
                      :disabled="!isAdminReady"
                    />
                    <B24Input
                      v-model="form.report.reasons[idx].label"
                      class="flex-1"
                      placeholder="Подпись"
                      :disabled="!isAdminReady"
                    />
                    <B24Button
                      size="xs"
                      color="air-primary-alert"
                      label="Удалить"
                      :disabled="!isAdminReady"
                      @click="removeReasonItem(idx)"
                    />
                  </div>
                  <div class="flex gap-2">
                    <B24Button
                      size="xs"
                      color="air-secondary"
                      label="Добавить"
                      :disabled="!isAdminReady"
                      @click="addReasonItem"
                    />
                    <B24Button
                      size="xs"
                      color="air-tertiary"
                      label="Seed по умолчанию"
                      :disabled="!isAdminReady || form.report.reasons.length > 0"
                      @click="seedDefaultReasons"
                    />
                  </div>
                  <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                    Кнопка «Seed по умолчанию» заполняет стандартный набор. Список редактируется свободно — никакого хардкода в бизнес-логике нет.
                  </ProseP>
                </div>
              </B24FormField>
            </div>
          </B24Card>

          <!-- Сроки и этапы -->
          <B24Card
            id="section-stages"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Сроки и этапы</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.stages ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.stages ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Стадии отчёта, общий timezone, таймаут и джиттер.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="grid gap-3 sm:grid-cols-2">
              <B24FormField label="Стадия: новая" class="w-full">
                <B24Select
                  v-model="form.report.stages.new"
                  :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                  :disabled="!isAdminReady || !reportStages.length"
                  placeholder="Выберите стадию"
                  class="w-full"
                />
              </B24FormField>
              <B24FormField label="Стадия: в работе" class="w-full">
                <B24Select
                  v-model="form.report.stages.inProgress"
                  :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                  :disabled="!isAdminReady || !reportStages.length"
                  placeholder="Выберите стадию"
                  class="w-full"
                />
              </B24FormField>
              <B24FormField label="Стадия: выполнено" class="w-full">
                <B24Select
                  v-model="form.report.stages.done"
                  :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                  :disabled="!isAdminReady || !reportStages.length"
                  placeholder="Выберите стадию"
                  class="w-full"
                />
              </B24FormField>
              <B24FormField label="Стадия: просрочено" class="w-full">
                <B24Select
                  v-model="form.report.stages.expired"
                  :items="[{ label: 'Выберите стадию', value: '' }, ...stageSelectItems()]"
                  :disabled="!isAdminReady || !reportStages.length"
                  placeholder="Выберите стадию"
                  class="w-full"
                />
              </B24FormField>
              <B24FormField label="Таймаут, минут" class="w-full">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Таймаут, минут
                    <B24Tooltip text="Сколько минут отводится сотруднику на сдачу отчёта после получения запроса. По истечении статус переходит в «Просрочено».">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24InputNumber
                  v-model="form.report.timeoutMinutes"
                  class="w-full"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Джиттер отправки, минут" class="w-full">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Джиттер отправки, минут
                    <B24Tooltip text="Случайная задержка (в минутах) для каждой АЗС при авто-рассылке. Разбрасывает запросы во времени, чтобы не нагружать сервер одновременно.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24InputNumber
                  v-model="form.report.dispatchJitterMinutes"
                  class="w-full"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Авто-отправка по времени" class="w-full sm:col-span-2">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Авто-отправка по времени
                    <B24Tooltip text="Список времён (HH:MM) для автоматической рассылки запросов отчёта. Бот отправит push в каждую из указанных точек. Поле необязательное — можно оставить пустым.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <div class="space-y-2">
                  <div
                    v-for="(slot, index) in form.report.dispatchTimes"
                    :key="`dispatch-time-${index}`"
                    class="flex items-center gap-2"
                  >
                    <input
                      v-model="form.report.dispatchTimes[index]"
                      type="time"
                      step="60"
                      class="w-full rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                      :disabled="!isAdminReady"
                    >
                    <B24Button
                      size="xs"
                      color="air-primary-alert"
                      label="Удалить"
                      :disabled="!isAdminReady"
                      @click="removeDispatchTimeSlot(index)"
                    />
                  </div>
                  <B24Button
                    size="xs"
                    color="air-secondary"
                    label="Добавить время"
                    :disabled="!isAdminReady"
                    @click="addDispatchTimeSlot"
                  />
                  <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                    Выберите время через тайм-пикер. В эти моменты бот автоматически отправит запрос отчёта.
                  </ProseP>
                </div>
              </B24FormField>
              <B24FormField label="Рабочее окно рассылки" class="w-full sm:col-span-2">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Рабочее окно рассылки
                    <B24Tooltip text="Случайное время запроса отчёта будет ограничено этим окном — раньше начала и позже конца запросы не уйдут.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <div class="flex items-center gap-3">
                  <label class="text-sm text-(--ui-color-base-70)">с</label>
                  <input
                    v-model="form.report.workWindow.start"
                    type="time"
                    step="60"
                    class="rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                    :disabled="!isAdminReady"
                  >
                  <label class="text-sm text-(--ui-color-base-70)">до</label>
                  <input
                    v-model="form.report.workWindow.end"
                    type="time"
                    step="60"
                    class="rounded border border-(--ui-color-base-30) bg-(--ui-color-base-0) px-3 py-2 text-sm"
                    :disabled="!isAdminReady"
                  >
                </div>
              </B24FormField>
            </div>
          </B24Card>

          <!-- Диск и часовой пояс -->
          <B24Card
            id="section-disk"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Диск и часовой пояс</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.disk ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.disk ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Папка для файлов отчёта, шаблон имени каталога и общий timezone.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="grid gap-3 sm:grid-cols-2">
              <B24FormField label="Корневая папка Диска" class="w-full">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Корневая папка Диска
                    <B24Tooltip text="ID папки Диск.Бизнес (Bitrix24 Drive), в которой будут создаваться подкаталоги для фото каждого отчёта. Найти ID можно в адресной строке при открытии папки.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24InputNumber
                  v-model="form.disk.rootFolderId"
                  class="w-full"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Шаблон имени папки" class="w-full">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Шаблон имени папки
                    <B24Tooltip text="Шаблон пути подкаталога внутри корневой папки. Переменные: {yyyy-mm} — год-месяц, {dd} — день, {azs} — id АЗС, {azs_name} — название. Пример: {yyyy-mm}/{dd}/{azs}_{azs_name}">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Input
                  v-model="form.disk.folderNameTemplate"
                  class="w-full"
                  placeholder="{yyyy-mm}/{dd}/{azs}_{azs_name}"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Часовой пояс" class="w-full sm:col-span-2">
                <B24Input
                  v-model="form.timezone"
                  class="w-full"
                  placeholder="Europe/Moscow"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
            </div>
          </B24Card>

          <!-- Роли доступа -->
          <B24Card
            id="section-access"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <template #header>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <ProseH3 class="mb-0">Роли доступа</ProseH3>
                    <B24Badge
                      rounded
                      size="sm"
                      :color="sectionComplete.access ? 'air-primary-success' : 'air-secondary'"
                      inverted
                      :label="sectionComplete.access ? 'готово' : 'заполнить'"
                    />
                  </div>
                  <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                    Приоритет ролей: Администратор > Проверяющий > Администратор АЗС.
                  </ProseP>
                </div>
              </div>
            </template>

            <div class="grid gap-3">
              <B24FormField label="Администраторы" class="w-full">
                <template #label>
                  <span class="inline-flex items-center gap-1">
                    Администраторы (userId через запятую)
                    <B24Tooltip text="ID пользователей Битрикс24 с полным доступом к настройкам и управлению приложением. Найти userId: профиль сотрудника → адресная строка.">
                      <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
                    </B24Tooltip>
                  </span>
                </template>
                <B24Input
                  v-model="accessAdminInput"
                  class="w-full"
                  placeholder="1, 7, 42"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Проверяющие (userId через запятую)" class="w-full">
                <B24Input
                  v-model="accessReviewerInput"
                  class="w-full"
                  placeholder="11, 25"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <B24FormField label="Администраторы АЗС (userId через запятую, опционально)" class="w-full">
                <B24Input
                  v-model="accessAzsAdminInput"
                  class="w-full"
                  placeholder="по умолчанию все пользователи"
                  :disabled="!isAdminReady"
                />
              </B24FormField>
              <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
                Пользователь вне списков получает роль Администратор АЗС. Администратор портала по умолчанию получает роль Администратор.
              </ProseP>
            </div>
          </B24Card>

          <!-- Управление -->
          <B24Card
            id="section-manage"
            variant="outline"
            :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="space-y-1">
                <ProseH3 class="mb-0">Управление</ProseH3>
                <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
                  Сохранение отправляет весь объект <code>settings</code>, перезагрузка подтягивает <code>defaults</code> и сохранённые значения.
                </ProseP>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <B24Button
                  color="air-tertiary"
                  label="Обновить аватарку бота"
                  loading-auto
                  :disabled="!isAdminReady || isRefreshingBotAvatar"
                  @click="refreshBotAvatar"
                />
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
      </div>
    </div>

    <!-- ── Sticky save bar ──────────────────────────────────────────────────── -->
    <div class="fixed bottom-0 left-0 right-0 z-50 border-t border-(--ui-color-base-20) bg-(--ui-color-base-0)/95 px-4 py-3 backdrop-blur-sm">
      <div class="mx-auto flex max-w-[1360px] items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <B24Badge
            rounded
            size="md"
            :color="statusColor"
            inverted
            :label="statusLabel"
          />
          <span
            v-if="isDirty"
            class="text-sm text-(--ui-color-base-70)"
          >Есть несохранённые изменения</span>
        </div>
        <B24Button
          color="air-primary-success"
          label="Сохранить настройки"
          loading-auto
          :disabled="!canSave"
          @click="saveSettings"
        />
      </div>
    </div>
  </div>
</template>
