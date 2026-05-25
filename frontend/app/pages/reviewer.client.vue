<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

type ReportRow = {
  id: number
  slotKey: string
  azsId: string
  adminUserId: number
  status: string
  reportItemId: number | null
  jitterMinutes: number | null
  scheduledAt: string | null
  deadlineAt: string | null
  errorText: string | null
  diskFolderId: number | null
  createdAt: string | null
  updatedAt: string | null
}

type Summary = {
  total: number
  overdue: number
  open: number
  done: number
  expired: number
  failed: number
}

type AzsOption = {
  value: string
  label: string
  adminUserId: number
}

type ManualResultItem = {
  azsId?: string
  ok?: boolean
  duplicate?: boolean
  reportItemId?: number
  reportId?: number
  slotKey?: string
  error?: string
}

const PAGE_TITLE = 'Проверка отчётов АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('ReviewerPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const manualError = ref('')
const manualErrorDetails = ref<string[]>([])
const manualSuccess = ref('')
const timeoutMessage = ref('')
const hasReviewerAccess = ref(false)
const reports = ref<ReportRow[]>([])
const azsOptions = ref<AzsOption[]>([])
const azsSearch = ref('')
const manualResults = ref<ManualResultItem[]>([])
const portalDomain = ref('')
const reportEntityTypeId = ref(0)
const summary = ref<Summary>({
  total: 0,
  overdue: 0,
  open: 0,
  done: 0,
  expired: 0,
  failed: 0
})

const filters = reactive({
  dateFrom: '',
  dateTo: '',
  status: '',
  azsIds: [] as string[],
  limit: 100
})

const manualCandidate = reactive({
  azsIds: [] as string[],
  slotDate: '',
  slotTime: ''
})

const toSlotHHmm = (value: string): string => {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/)
  if (!match) {
    return ''
  }
  return `${match[1]}${match[2]}`
}

const statusColor = (status: string) => {
  if (status === 'done') {
    return 'air-primary-success'
  }
  if (status === 'failed') {
    return 'air-primary-alert'
  }
  return 'air-secondary'
}

const manualResultStatusColor = (item: ManualResultItem) => {
  if (item.ok && !item.duplicate) {
    return 'air-primary-success'
  }
  if (item.duplicate) {
    return 'air-secondary'
  }
  return 'air-primary-alert'
}

const summaryCards = computed(() => ([
  { key: 'total', label: 'Всего', value: summary.value.total, color: 'air-secondary' },
  { key: 'open', label: 'В работе', value: summary.value.open, color: 'air-primary' },
  { key: 'done', label: 'DONE', value: summary.value.done, color: 'air-primary-success' },
  { key: 'expired', label: 'EXPIRED', value: summary.value.expired, color: 'air-primary-alert' },
  { key: 'overdue', label: 'Просрочено', value: summary.value.overdue, color: 'air-primary-alert' }
]))

const azsQuery = computed(() => {
  const ids = Array.isArray(filters.azsIds)
    ? filters.azsIds.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  return ids.length > 0 ? ids.join(',') : undefined
})

const filteredAzsOptions = computed(() => {
  const query = azsSearch.value.trim().toLowerCase()
  const selected = new Set([
    ...filters.azsIds,
    ...manualCandidate.azsIds
  ].map((item) => String(item || '').trim()).filter(Boolean))

  return azsOptions.value.filter((item) => (
    selected.has(item.value)
    || !query
    || item.label.toLowerCase().includes(query)
    || item.value.includes(query)
  ))
})

const selectedManualAzsOptions = computed(() => {
  const selected = new Set(manualCandidate.azsIds.map((item) => String(item || '').trim()).filter(Boolean))
  return azsOptions.value.filter((item) => selected.has(item.value))
})

const loadAzsOptions = async () => {
  try {
    const response = await apiStore.getAzsOptions({
      search: azsSearch.value.trim() || undefined,
      limit: 500
    })
    azsOptions.value = response.items
      .map((item) => ({
        value: String(item.id || '').trim(),
        label: `${String(item.title || `АЗС ${item.id}`).trim()} (${String(item.id)})${Number(item.adminUserId || 0) > 0 ? ` · админ ${String(item.adminUserId)}` : ''}`,
        adminUserId: Number(item.adminUserId || 0)
      }))
      .filter((item) => item.value)
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  } catch (error) {
    console.warn('Failed to load AZS options for reviewer filter', error)
    azsOptions.value = []
  }
}

const loadReviewerSettings = async () => {
  const response = await apiStore.getSettings()
  const settings = (response.settings ?? {}) as Record<string, unknown>
  const report = (settings.report ?? {}) as Record<string, unknown>
  reportEntityTypeId.value = Number(report.entityTypeId || 0)
}

const loadSummary = async () => {
  const response = await apiStore.getReportsSummary({
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    azsId: azsQuery.value
  })
  summary.value = response.summary
}

const loadReports = async () => {
  isLoading.value = true
  loadError.value = ''
  try {
    const [reportsResponse] = await Promise.all([
      apiStore.getReports({
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
        status: filters.status || undefined,
        azsId: azsQuery.value,
        limit: filters.limit
      }),
      loadSummary()
    ])
    reports.value = reportsResponse.items
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Не удалось загрузить отчёты'
  } finally {
    isLoading.value = false
  }
}

const applyStatusFilter = async (status: string) => {
  filters.status = status
  await loadReports()
}

const createManual = async () => {
  manualError.value = ''
  manualErrorDetails.value = []
  manualSuccess.value = ''
  manualResults.value = []
  try {
    const selectedAzsIds = manualCandidate.azsIds.map((item) => String(item || '').trim()).filter(Boolean)
    const result = await apiStore.createManualReport({
      candidates: selectedAzsIds.map((azsId) => {
        const option = azsOptions.value.find((item) => item.value === azsId)
        return {
          azsId,
          adminUserId: Number(option?.adminUserId || 0)
        }
      }),
      slotDate: manualCandidate.slotDate.trim() || undefined,
      slotHHmm: toSlotHHmm(manualCandidate.slotTime) || undefined
    })
    const summary = result.summary as Record<string, unknown>
    manualResults.value = Array.isArray(result.items)
      ? result.items.map((item) => item as ManualResultItem)
      : []
    const duplicates = manualResults.value.filter((item) => Boolean(item.duplicate))
    const duplicateSlots = duplicates
      .map((item) => String(item.slotKey || ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    const failed = Number(summary.failed || 0)

    manualSuccess.value = `Создано: ${String(summary.created || 0)}, дублей: ${String(summary.duplicates || 0)}, ошибок: ${String(failed)}${duplicateSlots ? `. Дубли слотов: ${duplicateSlots}` : ''}`
    await loadReports()
  } catch (error) {
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
        details?: string[]
      }
      message?: string
    })?.data
    manualError.value = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось создать ручной отчёт')
    manualErrorDetails.value = Array.isArray(responseData?.details)
      ? responseData.details.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  }
}

const runTimeout = async () => {
  timeoutMessage.value = ''
  try {
    const result = await apiStore.runTimeoutWatcher(200)
    const summary = result.summary as Record<string, unknown>
    timeoutMessage.value = `Просрочки обработаны: total=${String(summary.total || 0)}, expired=${String(summary.expired || 0)}`
    await loadReports()
  } catch (error) {
    timeoutMessage.value = error instanceof Error ? error.message : 'Ошибка timeout watcher'
  }
}

const openExternalUrl = (url: string) => {
  if (!url) {
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

const openReportCrmCard = (item: ReportRow) => {
  if (!portalDomain.value || !reportEntityTypeId.value || !item.reportItemId) {
    return
  }
  openExternalUrl(`https://${portalDomain.value}/crm/type/${reportEntityTypeId.value}/details/${item.reportItemId}/`)
}

const openPhotoFolder = (item: ReportRow) => {
  if (!portalDomain.value || !item.diskFolderId) {
    return
  }
  openExternalUrl(`https://${portalDomain.value}/docs/?folderId=${item.diskFolderId}`)
}

const loadRoleAccess = async () => {
  try {
    const response = await apiStore.getMyRole()
    hasReviewerAccess.value = Boolean(response.capabilities?.reviewer || response.capabilities?.settings)
  } catch {
    hasReviewerAccess.value = false
  }
}

onMounted(async () => {
  try {
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    const authData = $b24.auth.getAuthData()
    portalDomain.value = authData === false
      ? ''
      : String(authData.domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
    await loadRoleAccess()
    if (!hasReviewerAccess.value) {
      loadError.value = 'Недостаточно прав: раздел проверки доступен только ролям Администратор и Проверяющий.'
      return
    }
    const now = new Date()
    const to2 = (n: number) => String(n).padStart(2, '0')
    manualCandidate.slotDate = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`
    manualCandidate.slotTime = `${to2(now.getUTCHours())}:${to2(now.getUTCMinutes())}`
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadReviewerSettings()
    await loadAzsOptions()
    await loadReports()
  } catch (error) {
    processErrorGlobal(error)
  }
})
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-4 py-4 space-y-4">
    <B24Alert
      v-if="!hasReviewerAccess"
      color="air-primary-alert"
      title="Доступ запрещён"
      description="Раздел проверки доступен только ролям Администратор и Проверяющий."
    />

    <template v-else>
    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH2>Экран Проверяющего</ProseH2>
          <div class="flex items-center gap-2">
            <B24Badge v-if="isLoading" color="air-secondary">загрузка...</B24Badge>
            <B24Button color="air-secondary" label="Обновить" loading-auto @click="loadReports" />
            <B24Button color="air-primary-alert" label="Проверить просрочки" loading-auto @click="runTimeout" />
            <HelpButton default-role="reviewer" />
          </div>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-5 gap-2">
        <B24FormField label="Дата с">
          <B24Input v-model="filters.dateFrom" placeholder="2026-04-28" />
        </B24FormField>
        <B24FormField label="Дата по">
          <B24Input v-model="filters.dateTo" placeholder="2026-04-28" />
        </B24FormField>
        <B24FormField label="Статус">
          <B24Input v-model="filters.status" placeholder="done/reserved/failed" />
        </B24FormField>
        <B24FormField label="АЗС (множественный выбор)">
          <B24Input
            v-model="azsSearch"
            class="mb-2"
            placeholder="Поиск по названию или ID"
            @change="loadAzsOptions"
          />
          <select
            v-model="filters.azsIds"
            multiple
            class="h-[92px] w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
          >
            <option
              v-for="item in filteredAzsOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </option>
          </select>
        </B24FormField>
        <B24FormField label="Лимит">
          <B24InputNumber v-model="filters.limit" :min="1" :max="500" />
        </B24FormField>
      </div>

      <template #footer>
        <B24Button color="air-primary" label="Применить фильтры" loading-auto @click="loadReports" />
      </template>
    </B24Card>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
      <B24Card
        v-for="card in summaryCards"
        :key="card.key"
        variant="outline"
        :b24ui="{ body: 'py-3 px-3' }"
      >
        <div class="flex items-center justify-between">
          <ProseP class="text-[12px] text-gray-500">{{ card.label }}</ProseP>
          <B24Badge :color="card.color">{{ card.value }}</B24Badge>
        </div>
      </B24Card>
    </div>

    <B24Card>
      <template #header>
        <ProseH3>Быстрые фильтры</ProseH3>
      </template>
      <div class="flex flex-wrap gap-2">
        <B24Button size="xs" color="air-secondary" label="Все" loading-auto @click="applyStatusFilter('')" />
        <B24Button size="xs" color="air-primary" label="new" loading-auto @click="applyStatusFilter('new')" />
        <B24Button size="xs" color="air-primary" label="in_progress" loading-auto @click="applyStatusFilter('in_progress')" />
        <B24Button size="xs" color="air-primary-success" label="done" loading-auto @click="applyStatusFilter('done')" />
        <B24Button size="xs" color="air-primary-alert" label="expired" loading-auto @click="applyStatusFilter('expired')" />
        <B24Button size="xs" color="air-primary-alert" label="failed" loading-auto @click="applyStatusFilter('failed')" />
      </div>
    </B24Card>

    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Ошибка загрузки отчётов"
      :description="loadError"
    />

    <B24Card>
      <template #header>
        <ProseH3>Ручной запуск отчёта</ProseH3>
      </template>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
        <B24FormField label="АЗС для запуска">
          <B24Input
            v-model="azsSearch"
            class="mb-2"
            placeholder="Поиск АЗС"
            @change="loadAzsOptions"
          />
          <select
            v-model="manualCandidate.azsIds"
            multiple
            class="h-[132px] w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
          >
            <option
              v-for="item in filteredAzsOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </option>
          </select>
          <ProseP class="mb-0 mt-1 text-xs text-gray-500">
            Выбрано: {{ selectedManualAzsOptions.length }}
          </ProseP>
        </B24FormField>
        <B24FormField label="Дата слота">
          <input
            v-model="manualCandidate.slotDate"
            type="date"
            class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
          >
        </B24FormField>
        <B24FormField label="Время слота">
          <input
            v-model="manualCandidate.slotTime"
            type="time"
            step="60"
            class="w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm"
          >
        </B24FormField>
      </div>
      <template #footer>
        <B24Button color="air-primary" label="Создать сейчас" loading-auto @click="createManual" />
      </template>
    </B24Card>

    <B24Alert
      v-if="manualSuccess"
      color="air-primary-success"
      title="Ручной запуск выполнен"
      :description="manualSuccess"
    />
    <B24Alert
      v-if="manualError"
      color="air-primary-alert"
      title="Ошибка ручного запуска"
      :description="manualError"
    />
    <B24Card v-if="manualErrorDetails.length" variant="outline">
      <template #header>
        <ProseH3>Что исправить</ProseH3>
      </template>
      <ul class="list-disc pl-5 text-sm">
        <li v-for="detail in manualErrorDetails" :key="detail">
          {{ detail }}
        </li>
      </ul>
    </B24Card>
    <B24Card v-if="manualResults.length" variant="outline">
      <template #header>
        <ProseH3>Результат ручного запуска</ProseH3>
      </template>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="text-left border-b border-gray-200">
              <th class="py-2 pr-3">АЗС</th>
              <th class="py-2 pr-3">Статус</th>
              <th class="py-2 pr-3">Слот</th>
              <th class="py-2 pr-3">Ошибка</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in manualResults" :key="`${item.azsId || 'row'}-${index}`" class="border-b border-gray-100">
              <td class="py-2 pr-3">{{ item.azsId || '—' }}</td>
              <td class="py-2 pr-3">
                <B24Badge :color="manualResultStatusColor(item)">
                  {{ item.duplicate ? 'дубль' : (item.ok ? 'создан' : 'ошибка') }}
                </B24Badge>
              </td>
              <td class="py-2 pr-3">{{ item.slotKey || '—' }}</td>
              <td class="py-2 pr-3">{{ item.error || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </B24Card>
    <B24Alert
      v-if="timeoutMessage"
      color="air-secondary"
      title="Timeout watcher"
      :description="timeoutMessage"
    />

    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH3>Отчёты</ProseH3>
          <B24Badge color="air-secondary">Всего: {{ reports.length }}</B24Badge>
        </div>
      </template>

      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="text-left border-b border-gray-200">
              <th class="py-2 pr-3">ID</th>
              <th class="py-2 pr-3">АЗС</th>
              <th class="py-2 pr-3">Слот</th>
              <th class="py-2 pr-3">Дедлайн</th>
              <th class="py-2 pr-3">Статус</th>
              <th class="py-2 pr-3">Отчёт CRM</th>
              <th class="py-2 pr-3">Папка фото</th>
              <th class="py-2 pr-3">Действие</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in reports" :key="item.id" class="border-b border-gray-100">
              <td class="py-2 pr-3">{{ item.id }}</td>
              <td class="py-2 pr-3">{{ item.azsId }}</td>
              <td class="py-2 pr-3">{{ item.slotKey }}</td>
              <td class="py-2 pr-3">{{ item.deadlineAt || '—' }}</td>
              <td class="py-2 pr-3">
                <B24Badge :color="statusColor(item.status)">
                  {{ item.status }}
                </B24Badge>
              </td>
              <td class="py-2 pr-3">{{ item.reportItemId || '—' }}</td>
              <td class="py-2 pr-3">
                {{ item.diskFolderId || '—' }}
              </td>
              <td class="py-2 pr-3">
                <div class="flex flex-wrap gap-1">
                <B24Button
                  size="xs"
                  color="air-secondary"
                  label="Экран админа"
                  loading-auto
                  @click="navigateTo(`/admin/${item.id}`)"
                />
                <B24Button
                  size="xs"
                  color="air-secondary"
                  label="Карточка отчёта"
                  :disabled="!item.reportItemId || !reportEntityTypeId || !portalDomain"
                  @click="openReportCrmCard(item)"
                />
                <B24Button
                  size="xs"
                  color="air-secondary"
                  label="Папка фото"
                  :disabled="!item.diskFolderId || !portalDomain"
                  @click="openPhotoFolder(item)"
                />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </B24Card>
    </template>
  </div>
</template>
