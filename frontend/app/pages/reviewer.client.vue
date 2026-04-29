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

const PAGE_TITLE = 'Проверка отчётов АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('ReviewerPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const userStore = useUserStore()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const manualError = ref('')
const manualSuccess = ref('')
const timeoutMessage = ref('')
const reports = ref<ReportRow[]>([])
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
  azsId: '',
  limit: 100
})

const manualCandidate = reactive({
  azsId: '',
  adminUserId: 0,
  slotDate: '',
  slotHHmm: ''
})

const statusColor = (status: string) => {
  if (status === 'done') {
    return 'air-primary-success'
  }
  if (status === 'failed') {
    return 'air-primary-alert'
  }
  return 'air-secondary'
}

const summaryCards = computed(() => ([
  { key: 'total', label: 'Всего', value: summary.value.total, color: 'air-secondary' },
  { key: 'open', label: 'В работе', value: summary.value.open, color: 'air-primary' },
  { key: 'done', label: 'DONE', value: summary.value.done, color: 'air-primary-success' },
  { key: 'expired', label: 'EXPIRED', value: summary.value.expired, color: 'air-primary-alert' },
  { key: 'overdue', label: 'Просрочено', value: summary.value.overdue, color: 'air-primary-alert' }
]))

const loadSummary = async () => {
  const response = await apiStore.getReportsSummary({
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    azsId: filters.azsId || undefined
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
        azsId: filters.azsId || undefined,
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
  manualSuccess.value = ''
  try {
    const result = await apiStore.createManualReport({
      azsId: manualCandidate.azsId.trim(),
      adminUserId: Number(manualCandidate.adminUserId),
      slotDate: manualCandidate.slotDate.trim() || undefined,
      slotHHmm: manualCandidate.slotHHmm.trim() || undefined
    })
    const summary = result.summary as Record<string, unknown>
    const duplicates = Array.isArray(result.items)
      ? result.items.filter((item) => Boolean((item as Record<string, unknown>).duplicate))
      : []
    const duplicateSlots = duplicates
      .map((item) => String((item as Record<string, unknown>).slotKey || ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')

    manualSuccess.value = `Создано: ${String(summary.created || 0)}, дублей: ${String(summary.duplicates || 0)}${duplicateSlots ? `. Дубли слотов: ${duplicateSlots}` : ''}`
    await loadReports()
  } catch (error) {
    manualError.value = error instanceof Error ? error.message : 'Не удалось создать ручной отчёт'
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

onMounted(async () => {
  try {
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    manualCandidate.adminUserId = userStore.id || 1
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadReports()
  } catch (error) {
    processErrorGlobal(error)
  }
})
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-4 py-4 space-y-4">
    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH2>Экран Проверяющего</ProseH2>
          <div class="flex items-center gap-2">
            <B24Badge v-if="isLoading" color="air-secondary">загрузка...</B24Badge>
            <B24Button color="air-secondary" label="Обновить" loading-auto @click="loadReports" />
            <B24Button color="air-primary-alert" label="Проверить просрочки" loading-auto @click="runTimeout" />
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
        <B24FormField label="АЗС ID">
          <B24Input v-model="filters.azsId" placeholder="azs-17" />
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
      <div class="grid grid-cols-1 md:grid-cols-4 gap-2">
        <B24FormField label="АЗС ID">
          <B24Input v-model="manualCandidate.azsId" placeholder="azs-17" />
        </B24FormField>
        <B24FormField label="Админ user id">
          <B24InputNumber v-model="manualCandidate.adminUserId" :min="1" />
        </B24FormField>
        <B24FormField label="Дата слота">
          <B24Input v-model="manualCandidate.slotDate" placeholder="2026-04-28" />
        </B24FormField>
        <B24FormField label="Время слота HHmm">
          <B24Input v-model="manualCandidate.slotHHmm" placeholder="0930" />
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
                <B24Button
                  size="xs"
                  color="air-secondary"
                  label="Открыть экран админа"
                  loading-auto
                  @click="navigateTo(`/admin/${item.id}`)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </B24Card>
  </div>
</template>
