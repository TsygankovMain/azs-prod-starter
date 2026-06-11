<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

type ReportRow = {
  id: number
  slotKey: string
  azsId: string
  azsTitle?: string | null
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
  trigger?: string
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

type FeedAction = 'request-again' | 'open-photos' | 'open-card'

type FeedEvent = {
  id: string
  type: 'created' | 'done' | 'expired' | 'in_progress' | 'failed' | 'manual'
  timestamp: string
  azsId: string
  azsTitle: string
  reportRow: ReportRow
  subtitle?: string
  buttons?: Array<{ label: string; action: FeedAction; disabled?: boolean }>
}

const PAGE_TITLE = 'Проверка отчётов АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('ReviewerPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const toast = useAppToast()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const saveScheduleError = ref('')
const saveScheduleSuccess = ref('')
const manualError = ref('')
const manualSuccess = ref('')
const timeoutMessage = ref('')
const hasReviewerAccess = ref(false)
const reports = ref<ReportRow[]>([])
const azsOptions = ref<AzsOption[]>([])
const azsSearchQuery = ref('')
const filteredAzsOptions = computed(() => {
  const q = azsSearchQuery.value.trim().toLowerCase()
  if (!q) return azsOptions.value
  return azsOptions.value.filter(o =>
    o.label.toLowerCase().includes(q) ||
    o.value.toLowerCase().includes(q)
  )
})
const azsMap = ref<Map<string, string>>(new Map())
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

const period = ref<'today' | 'yesterday' | 'week' | 'custom'>('today')
const customDateFrom = ref('')
const customDateTo = ref('')
const statusFilter = ref<string>('')
const feedFilterMode = ref<'all' | 'problems'>('all')
// AZS filter for feed (#3)
const azsFilter = ref<string>('')

const scheduleSettings = reactive({
  dispatchTimes: [] as string[],
  dispatchJitterMinutes: 15,
  timeoutMinutes: 30,
  newTimeInput: ''
})

const timeSlots = computed(() => {
  const slots: string[] = []
  for (let h = 6; h <= 22; h++) {
    for (let m = 0; m < 60; m += 15) {
      const hh = String(h).padStart(2, '0')
      const mm = String(m).padStart(2, '0')
      slots.push(`${hh}:${mm}`)
    }
  }
  return slots
})

const manualRequest = reactive({
  azsIds: [] as string[],
  mode: 'now' as 'now' | 'schedule',
  scheduleDate: '',
  scheduleTime: ''
})

// $fetch (ofetch) puts the backend JSON body on error.data. Prefer the API's
// human-readable message/details over the generic "[POST] ...: 400" string.
const extractApiError = (error: unknown, fallback: string): string => {
  const data = (error as { data?: { message?: string; details?: string[] } })?.data
  if (data) {
    if (Array.isArray(data.details) && data.details.length) {
      return data.details.join('; ')
    }
    if (typeof data.message === 'string' && data.message.trim()) {
      return data.message
    }
  }
  return error instanceof Error ? error.message : fallback
}

const getDateRange = () => {
  const now = new Date()
  const to2 = (n: number) => String(n).padStart(2, '0')

  const todayStr = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`

  if (period.value === 'today') {
    return { from: todayStr, to: todayStr }
  } else if (period.value === 'yesterday') {
    const yesterday = new Date(now)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const yesterdayStr = `${yesterday.getUTCFullYear()}-${to2(yesterday.getUTCMonth() + 1)}-${to2(yesterday.getUTCDate())}`
    return { from: yesterdayStr, to: yesterdayStr }
  } else if (period.value === 'week') {
    const weekAgo = new Date(now)
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
    const weekAgoStr = `${weekAgo.getUTCFullYear()}-${to2(weekAgo.getUTCMonth() + 1)}-${to2(weekAgo.getUTCDate())}`
    return { from: weekAgoStr, to: todayStr }
  } else {
    return { from: customDateFrom.value, to: customDateTo.value }
  }
}

const getPeriodLabel = () => {
  if (period.value === 'today') return 'Сегодня'
  if (period.value === 'yesterday') return 'Вчера'
  if (period.value === 'week') return 'За неделю'
  return 'За выбранный период'
}

const getLocaleDate = () => {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const parts = formatter.formatToParts(now)
  const formatted = parts.map(p => p.value).join('')
  return `Сегодня, ${formatted.charAt(0).toUpperCase() + formatted.slice(1)}`
}

const doneCount = computed(() => summary.value.done)
const totalCount = computed(() => summary.value.total)
const openCount = computed(() => summary.value.open)
const failedCount = computed(() => summary.value.expired + summary.value.failed)
const donePercent = computed(() => {
  if (totalCount.value === 0) return 0
  return Math.round((doneCount.value / totalCount.value) * 1000) / 10
})

const progressBar = computed(() => {
  if (totalCount.value === 0) {
    return { done: 0, open: 0, failed: 0 }
  }
  return {
    done: (doneCount.value / totalCount.value) * 100,
    open: (openCount.value / totalCount.value) * 100,
    failed: (failedCount.value / totalCount.value) * 100
  }
})

// Mini-KPI for selected AZS (#3) — derived client-side from existing reports data
const azsFilterKpi = computed(() => {
  if (!azsFilter.value) return null
  const rows = reports.value.filter(r => r.azsId === azsFilter.value)
  const total = rows.length
  const done = rows.filter(r => r.status === 'done').length
  const overdue = rows.filter(r => r.status === 'expired').length
  const inProgress = rows.filter(r => r.status === 'in_progress' || r.status === 'created').length
  return { total, done, overdue, inProgress }
})

const deriveEvents = (): FeedEvent[] => {
  const events: FeedEvent[] = []

  for (const report of reports.value) {
    const reportTitle = String(report.azsTitle || '').trim()
    const azsTitle = reportTitle || azsMap.value.get(report.azsId) || `АЗС ${report.azsId}`

    // Created event (always)
    const createdDate = report.createdAt ? new Date(report.createdAt) : null
    if (createdDate) {
      const triggerLabel = report.trigger === 'manual' ? 'управляющий' : 'автоматическая рассылка'
      events.push({
        id: `created-${report.id}`,
        type: 'created',
        timestamp: report.createdAt!,
        azsId: report.azsId,
        azsTitle,
        reportRow: report,
        subtitle: `Запросил ${triggerLabel}`
      })
    }

    // Status-based event
    if (report.status === 'done' && report.updatedAt) {
      events.push({
        id: `done-${report.id}`,
        type: 'done',
        timestamp: report.updatedAt,
        azsId: report.azsId,
        azsTitle,
        reportRow: report,
        buttons: [
          { label: 'Открыть папку', action: 'open-photos', disabled: !report.diskFolderId },
          { label: 'Открыть карточку', action: 'open-card', disabled: !(report.reportItemId && reportEntityTypeId.value) }
        ]
      })
    } else if (report.status === 'expired' && report.updatedAt) {
      events.push({
        id: `expired-${report.id}`,
        type: 'expired',
        timestamp: report.updatedAt,
        azsId: report.azsId,
        azsTitle,
        reportRow: report,
        buttons: [
          { label: 'Запросить повторно', action: 'request-again' },
          { label: 'Открыть папку', action: 'open-photos', disabled: !report.diskFolderId },
          { label: 'Открыть карточку', action: 'open-card', disabled: !(report.reportItemId && reportEntityTypeId.value) }
        ]
      })
    } else if (report.status === 'in_progress' && report.updatedAt) {
      events.push({
        id: `progress-${report.id}`,
        type: 'in_progress',
        timestamp: report.updatedAt,
        azsId: report.azsId,
        azsTitle,
        reportRow: report
      })
    } else if (report.status === 'failed' && report.updatedAt) {
      events.push({
        id: `failed-${report.id}`,
        type: 'failed',
        timestamp: report.updatedAt,
        azsId: report.azsId,
        azsTitle,
        reportRow: report,
        subtitle: report.errorText ? `Причина: ${report.errorText}` : undefined
      })
    }
  }

  // Sort descending by timestamp
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return events
}

const allEvents = computed(() => deriveEvents())

const filteredEvents = computed(() => {
  let result = allEvents.value

  if (feedFilterMode.value === 'problems') {
    result = result.filter(e => e.type === 'expired' || e.type === 'failed')
  }

  if (statusFilter.value) {
    const statusMap: Record<string, string[]> = {
      done: ['done'],
      open: ['in_progress', 'created'],
      failed: ['expired', 'failed']
    }
    const allowed = statusMap[statusFilter.value] || []
    result = result.filter(e => allowed.includes(e.type))
  }

  // AZS filter (#3)
  if (azsFilter.value) {
    result = result.filter(e => e.azsId === azsFilter.value)
  }

  return result
})

const formatTime = (isoString: string): string => {
  try {
    const date = new Date(isoString)
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  } catch {
    return ''
  }
}

const getEventIcon = (event: FeedEvent): string => {
  if (event.type === 'created') return '📣'
  if (event.type === 'done') return '✓'
  if (event.type === 'expired') return '⚠'
  if (event.type === 'in_progress') return '⏳'
  if (event.type === 'failed') return '⚠'
  return '•'
}

const getEventBgColor = (event: FeedEvent): string => {
  if (event.type === 'created') return 'bg-blue-100 text-blue-700'
  if (event.type === 'done') return 'bg-green-100 text-green-700'
  if (event.type === 'expired' || event.type === 'failed') return 'bg-red-100 text-red-700'
  if (event.type === 'in_progress') return 'bg-yellow-100 text-yellow-700'
  return 'bg-gray-100 text-gray-700'
}

const getEventTitle = (event: FeedEvent): string => {
  if (event.type === 'created') return `Создан отчёт для ${event.azsTitle}`
  if (event.type === 'done') return `${event.azsTitle} сдала отчёт`
  if (event.type === 'expired') return `${event.azsTitle} — отчёт не сдан вовремя`
  if (event.type === 'in_progress') return `${event.azsTitle} — фотографии загружаются`
  if (event.type === 'failed') return `Ошибка обработки отчёта для ${event.azsTitle}`
  return ''
}

const loadAll = async () => {
  const range = getDateRange()
  if (!range.from || !range.to) {
    loadError.value = 'Пожалуйста, выберите корректный период'
    return
  }

  isLoading.value = true
  loadError.value = ''
  try {
    const [reportsResponse, summaryResponse] = await Promise.all([
      apiStore.getReports({
        dateFrom: range.from,
        dateTo: range.to,
        limit: 200
      }),
      apiStore.getReportsSummary({
        dateFrom: range.from,
        dateTo: range.to
      })
    ])
    reports.value = reportsResponse.items
    summary.value = summaryResponse.summary
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Не удалось загрузить отчёты'
  } finally {
    isLoading.value = false
  }
  // Non-fatal: load dispatch plan independently so a 502 doesn't break the screen
  void loadDispatchPlan()
}

const changePeriod = (newPeriod: typeof period.value) => {
  period.value = newPeriod
  loadAll()
}

const loadAzsOptions = async () => {
  try {
    const response = await apiStore.getAzsOptions({ limit: 500 })
    azsOptions.value = response.items.map(item => ({
      value: String(item.id || '').trim(),
      label: `${String(item.title || `АЗС ${item.id}`).trim()}`,
      adminUserId: Number(item.adminUserId || 0)
    }))

    azsMap.value = new Map(
      response.items.map(item => [
        String(item.id || '').trim(),
        `АЗС ${String(item.title || item.id || '').trim()}`
      ])
    )
  } catch (error) {
    console.warn('Failed to load AZS options', error)
  }
}

const loadScheduleSettings = async () => {
  try {
    const response = await apiStore.getSettings()
    const settings = (response.settings ?? {}) as Record<string, unknown>
    const report = (settings.report ?? {}) as Record<string, unknown>
    reportEntityTypeId.value = Number(report.entityTypeId || 0)

    const times = report.dispatchTimes
    if (Array.isArray(times)) {
      scheduleSettings.dispatchTimes = times.map(t => String(t).trim()).filter(Boolean)
    }

    const jitter = report.dispatchJitterMinutes
    if (typeof jitter === 'number') {
      scheduleSettings.dispatchJitterMinutes = jitter
    }

    const timeout = report.timeoutMinutes
    if (typeof timeout === 'number') {
      scheduleSettings.timeoutMinutes = timeout
    }
  } catch (error) {
    console.warn('Failed to load schedule settings', error)
  }
}

const removeDispatchTime = (index: number) => {
  scheduleSettings.dispatchTimes.splice(index, 1)
}

const addDispatchTime = () => {
  const time = scheduleSettings.newTimeInput.trim()
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    if (!scheduleSettings.dispatchTimes.includes(time)) {
      scheduleSettings.dispatchTimes.push(time)
      scheduleSettings.dispatchTimes.sort()
      scheduleSettings.newTimeInput = ''
    }
  }
}

const saveSchedule = async () => {
  saveScheduleError.value = ''
  saveScheduleSuccess.value = ''
  try {
    const response = await apiStore.getSettings()
    const settings = (response.settings ?? {}) as Record<string, unknown>
    const report = (settings.report ?? {}) as Record<string, unknown>

    const updated = {
      ...settings,
      report: {
        ...report,
        dispatchTimes: scheduleSettings.dispatchTimes,
        dispatchJitterMinutes: scheduleSettings.dispatchJitterMinutes,
        timeoutMinutes: scheduleSettings.timeoutMinutes
      }
    }

    await apiStore.saveSettings(updated)
    saveScheduleSuccess.value = 'Расписание сохранено'
    setTimeout(() => { saveScheduleSuccess.value = '' }, 3000)
  } catch (error) {
    saveScheduleError.value = error instanceof Error ? error.message : 'Ошибка при сохранении'
  }
}

// Multi-select helpers (#5)
const selectAllAzs = () => {
  const visibleIds = filteredAzsOptions.value.map(o => o.value)
  const merged = new Set([...manualRequest.azsIds, ...visibleIds])
  manualRequest.azsIds = [...merged]
}
const clearAllAzs = () => {
  manualRequest.azsIds = []
}
const toggleAzsSelection = (value: string) => {
  const idx = manualRequest.azsIds.indexOf(value)
  if (idx === -1) {
    manualRequest.azsIds.push(value)
  } else {
    manualRequest.azsIds.splice(idx, 1)
  }
}

const sendManualRequest = async () => {
  manualError.value = ''
  manualSuccess.value = ''

  if (manualRequest.azsIds.length === 0) {
    manualError.value = 'Выберите хотя бы одну АЗС'
    return
  }

  try {
    const now = new Date()
    const to2 = (n: number) => String(n).padStart(2, '0')
    const defaultDate = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`
    const defaultTime = `${to2(now.getUTCHours())}:${to2(now.getUTCMinutes())}`

    const slotDate = manualRequest.mode === 'schedule' ? manualRequest.scheduleDate : defaultDate
    const slotTime = manualRequest.mode === 'schedule' ? manualRequest.scheduleTime : defaultTime
    const slotHHmm = slotTime.replace(':', '')

    // Build candidates array for all selected AZS
    const candidates = manualRequest.azsIds.map(id => {
      const azs = azsOptions.value.find(o => o.value === id)
      return { azsId: id, adminUserId: azs?.adminUserId ?? 0 }
    })

    await apiStore.createManualReport({
      candidates,
      slotDate,
      slotHHmm
    })

    const count = manualRequest.azsIds.length
    manualSuccess.value = `Задание отправлено для ${count} АЗС`
    manualRequest.azsIds = []
    azsSearchQuery.value = ''
    manualRequest.mode = 'now'

    await loadAll()
  } catch (error) {
    manualError.value = extractApiError(error, 'Ошибка при отправке задания')
  }
}

const requestReportAgain = async (event: FeedEvent) => {
  await withPending(`again:${event.azsId}:${event.reportRow.id}`, async () => {
    try {
      const selectedAzs = azsOptions.value.find(o => o.value === event.azsId)
      if (!selectedAzs) return

      const now = new Date()
      const to2 = (n: number) => String(n).padStart(2, '0')
      const slotDate = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`
      const slotHHmm = `${to2(now.getUTCHours())}${to2(now.getUTCMinutes())}`

      await apiStore.createManualReport({
        candidates: [{
          azsId: event.azsId,
          adminUserId: selectedAzs.adminUserId
        }],
        slotDate,
        slotHHmm
      })

      toast.success('Повторный запрос создан')
      await loadAll()
    } catch (error) {
      console.error('requestReportAgain failed', error)
      toast.error('Не удалось отправить запрос. Проверьте соединение и повторите.')
    }
  })
}

const openPhotoFolder = (item: ReportRow) => {
  if (!portalDomain.value || !item.diskFolderId) {
    return
  }
  const url = `https://${portalDomain.value}/docs/?folderId=${item.diskFolderId}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

const openCrmCard = (item: ReportRow) => {
  if (!portalDomain.value || !item.reportItemId || !reportEntityTypeId.value) {
    return
  }
  const url = `https://${portalDomain.value}/crm/type/${reportEntityTypeId.value}/details/${item.reportItemId}/`
  window.open(url, '_blank', 'noopener,noreferrer')
}

const handleFeedAction = (event: FeedEvent, action: FeedAction) => {
  if (action === 'request-again') {
    void requestReportAgain(event)
    return
  }
  if (action === 'open-photos') {
    openPhotoFolder(event.reportRow)
    return
  }
  if (action === 'open-card') {
    openCrmCard(event.reportRow)
  }
}

// Dispatch plan (RD-6)
type DispatchPlanRow = {
  azsId: string
  azsTitle: string
  adminUserId: number
  baseTime: string
  executeAt: string
  status: string
  reportItemId: number | null
}
const dispatchPlan = ref<DispatchPlanRow[]>([])
const dispatchPlanEnabled = ref(false)

// Resync (#4)
const resyncingIds = ref<Set<number>>(new Set())
const resyncReport = async (reportId: number) => {
  resyncingIds.value = new Set([...resyncingIds.value, reportId])
  try {
    await apiStore.resyncReport(reportId)
    toast.success('Отчёт синхронизирован')
    await loadAll()
  } catch (error) {
    console.error('Ошибка пересинхронизации', error)
    toast.error('Не удалось синхронизировать отчёт. Проверьте соединение и повторите.')
  } finally {
    const next = new Set(resyncingIds.value)
    next.delete(reportId)
    resyncingIds.value = next
  }
}

// Format execute_at for the plan card using the portal timezone (Europe/Moscow).
// getHours() would return the browser's local time — wrong on a UTC server or
// when the user's browser is in a different tz. Intl ensures Moscow wall-clock.
const PLAN_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

const formatPlanTime = (isoString: string): string => {
  try {
    return PLAN_TIME_FORMATTER.format(new Date(isoString))
  } catch {
    // Non-fatal fallback: slice the ISO string (may be off-tz, but safe)
    return String(isoString || '').slice(11, 16) || '—'
  }
}

const loadDispatchPlan = async () => {
  try {
    const response = await apiStore.getDispatchPlan()
    dispatchPlanEnabled.value = Boolean(response.enabled)
    dispatchPlan.value = Array.isArray(response.items) ? response.items : []
  } catch (error) {
    console.warn('Failed to load dispatch plan', error)
    dispatchPlanEnabled.value = false
    dispatchPlan.value = []
  }
}

const planGenerating = ref(false)
const planGenerateMessage = ref('')
const planGenerateError = ref('')

const handleGeneratePlan = async () => {
  planGenerating.value = true
  planGenerateMessage.value = ''
  planGenerateError.value = ''
  try {
    const result = await apiStore.generateDispatchPlan()
    planGenerateMessage.value = `График сформирован: ${result.azsCount} АЗС`
    await loadDispatchPlan()
  } catch (error) {
    planGenerateError.value = extractApiError(error, 'Ошибка при формировании графика')
  } finally {
    planGenerating.value = false
  }
}

const runTimeout = async () => {
  timeoutMessage.value = ''
  try {
    const result = await apiStore.runTimeoutWatcher(200)
    const summaryResult = result.summary as Record<string, unknown>
    timeoutMessage.value = `Просрочки обработаны: total=${String(summaryResult.total || 0)}, expired=${String(summaryResult.expired || 0)}`
    await loadAll()
  } catch (error) {
    timeoutMessage.value = error instanceof Error ? error.message : 'Ошибка'
  }
}

// ── Pending-state helper (S2-02) ────────────────────────────────────────────
// Prevents double-click duplicates and gives visual feedback on any action key.
const pendingActions = ref<Set<string>>(new Set())

async function withPending(key: string, fn: () => Promise<void>): Promise<void> {
  if (pendingActions.value.has(key)) return // guard against double-click
  pendingActions.value = new Set(pendingActions.value).add(key)
  try {
    await fn()
  } finally {
    const next = new Set(pendingActions.value)
    next.delete(key)
    pendingActions.value = next
  }
}
// ────────────────────────────────────────────────────────────────────────────

const scrollToQuickRequest = () => {
  const el = document.getElementById('quick-request-card')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const goBack = () => {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    navigateTo('/')
  }
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
      loadError.value = 'Недостаточно прав'
      return
    }

    await Promise.all([
      loadAzsOptions(),
      loadScheduleSettings()
    ])

    const now = new Date()
    const to2 = (n: number) => String(n).padStart(2, '0')
    manualRequest.scheduleDate = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`
    manualRequest.scheduleTime = `${to2(now.getUTCHours())}:${to2(now.getUTCMinutes())}`

    await $b24.parent.setTitle(PAGE_TITLE)
    await loadAll()
  } catch (error) {
    processErrorGlobal(error)
  }
})
</script>

<template>
  <div class="w-full bg-gray-50 min-h-screen">
    <!-- Alert if no access -->
    <div v-if="!hasReviewerAccess && loadError" class="max-w-[1280px] mx-auto px-4 py-6">
      <B24Alert
        color="air-primary-alert"
        title="Доступ запрещён"
        :description="loadError"
      />
    </div>

    <template v-else>
      <div class="max-w-[1280px] mx-auto px-4 py-6">

        <!-- Header -->
        <header class="mb-6">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex items-start gap-3">
              <button
                aria-label="Назад"
                class="inline-flex items-center justify-center w-9 h-9 rounded-full text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
                @click="goBack"
              >
                ←
              </button>
              <div>
                <div class="flex items-center gap-2">
                  <h1 class="text-2xl font-semibold">Проверка отчётов АЗС</h1>
                  <HelpButton default-role="reviewer" class="w-7 h-7" />
                </div>
                <p class="text-sm text-gray-500 mt-1">{{ getLocaleDate() }}</p>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-wrap">
              <!-- Period switcher -->
              <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm">
                <button
                  :class="[
                    'px-3 py-2 font-medium transition-colors',
                    period === 'today'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="changePeriod('today')"
                >
                  Сегодня
                </button>
                <button
                  :class="[
                    'px-3 py-2 font-medium transition-colors',
                    period === 'yesterday'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="changePeriod('yesterday')"
                >
                  Вчера
                </button>
                <button
                  :class="[
                    'px-3 py-2 font-medium transition-colors',
                    period === 'week'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="changePeriod('week')"
                >
                  Неделя
                </button>
                <button
                  :class="[
                    'px-3 py-2 font-medium transition-colors',
                    period === 'custom'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="changePeriod('custom')"
                >
                  Выбрать дату
                </button>
              </div>

              <!-- Manual refresh -->
              <button
                class="px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium disabled:opacity-50"
                :disabled="isLoading"
                @click="loadAll"
              >
                {{ isLoading ? 'Обновление…' : '↻ Обновить' }}
              </button>

              <!-- Main request button -->
              <button
                class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm"
                @click="scrollToQuickRequest"
              >
                ⚡ Запросить отчёт сейчас
              </button>
            </div>
          </div>

          <!-- Custom date inputs (if custom period selected) -->
          <div v-if="period === 'custom'" class="flex gap-2 mt-4">
            <input
              v-model="customDateFrom"
              type="date"
              class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
              @change="loadAll"
            >
            <span class="text-gray-500">—</span>
            <input
              v-model="customDateTo"
              type="date"
              class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
              @change="loadAll"
            >
          </div>
        </header>

        <!--
          Сетевые ошибки ПЕРВИЧНОЙ инициализации уходят в processErrorGlobal → error.vue (там есть «Обновить»);
          этот блок — для ошибок loadAll() после успешного init.
        -->
        <!-- Load error alert (general network / API errors) -->
        <div v-if="loadError && hasReviewerAccess" class="mb-6 flex flex-col gap-2">
          <B24Alert
            color="air-primary-alert"
            title="Ошибка загрузки"
            :description="loadError"
          />
          <div>
            <button
              class="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium disabled:opacity-50"
              :disabled="isLoading"
              @click="loadAll"
            >
              {{ isLoading ? 'Загрузка…' : '↻ Повторить' }}
            </button>
          </div>
        </div>

        <!-- Summary banner -->
        <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
          <div class="flex items-end justify-between gap-4 flex-wrap mb-4">
            <div>
              <p class="text-sm text-gray-500 uppercase tracking-wide mb-1">{{ getPeriodLabel() }}</p>
              <p class="text-3xl">
                Сдали отчёт <span class="font-bold text-blue-700">{{ doneCount }} из {{ totalCount }}</span> АЗС
              </p>
            </div>
            <div class="text-right">
              <p class="text-4xl font-bold text-blue-600">{{ donePercent }}%</p>
              <p class="text-xs text-gray-500">сдачи</p>
            </div>
          </div>

          <!-- Progress bar -->
          <div class="w-full h-3 bg-gray-100 rounded-full overflow-hidden mb-4 flex">
            <div class="bg-green-500" :style="{ width: progressBar.done + '%' }"/>
            <div class="bg-yellow-400" :style="{ width: progressBar.open + '%' }"/>
            <div class="bg-red-400" :style="{ width: progressBar.failed + '%' }"/>
          </div>

          <!-- Status chips -->
          <div class="flex flex-wrap gap-2">
            <button
              :class="[
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                statusFilter === 'done'
                  ? 'bg-green-100 hover:bg-green-200 text-green-800'
                  : 'bg-green-50 hover:bg-green-100 text-green-800'
              ]"
              @click="statusFilter = statusFilter === 'done' ? '' : 'done'"
            >
              <span class="w-2 h-2 rounded-full bg-green-500"/>
              Сдан — {{ doneCount }}
            </button>
            <button
              :class="[
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                statusFilter === 'open'
                  ? 'bg-yellow-100 hover:bg-yellow-200 text-yellow-800'
                  : 'bg-yellow-50 hover:bg-yellow-100 text-yellow-800'
              ]"
              @click="statusFilter = statusFilter === 'open' ? '' : 'open'"
            >
              <span class="w-2 h-2 rounded-full bg-yellow-500"/>
              В работе — {{ openCount }}
            </button>
            <button
              :class="[
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                statusFilter === 'failed'
                  ? 'bg-red-100 hover:bg-red-200 text-red-800'
                  : 'bg-red-50 hover:bg-red-100 text-red-800'
              ]"
              @click="statusFilter = statusFilter === 'failed' ? '' : 'failed'"
            >
              <span class="w-2 h-2 rounded-full bg-red-500"/>
              Не сдан — {{ failedCount }}
            </button>
            <button
              v-if="statusFilter"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium transition-colors ml-auto"
              @click="statusFilter = ''"
            >
              Показать все {{ totalCount }} АЗС
            </button>
          </div>
        </section>

        <!-- AZS filter bar (#3) -->
        <div class="mb-4 flex items-center gap-3 flex-wrap">
          <div class="flex items-center gap-2 flex-1 min-w-[200px] max-w-xs">
            <label class="text-sm text-gray-500 whitespace-nowrap">Фильтр по АЗС:</label>
            <select
              v-model="azsFilter"
              class="flex-1 px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm"
            >
              <option value="">Все АЗС</option>
              <option v-for="opt in azsOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <button
            v-if="azsFilter"
            class="px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-600 hover:bg-gray-50"
            @click="azsFilter = ''"
          >
            Сбросить
          </button>
        </div>

        <!-- Mini-KPI for selected AZS (#3) -->
        <div v-if="azsFilter && azsFilterKpi" class="mb-4 flex flex-wrap gap-3">
          <div class="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-100 shadow-sm text-sm">
            <span class="text-gray-500">Всего:</span>
            <span class="font-semibold">{{ azsFilterKpi.total }}</span>
          </div>
          <div class="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-50 border border-green-100 text-sm">
            <span class="w-2 h-2 rounded-full bg-green-500" />
            <span class="text-green-700">Сдано:</span>
            <span class="font-semibold text-green-800">{{ azsFilterKpi.done }}</span>
          </div>
          <div class="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-50 border border-red-100 text-sm">
            <span class="w-2 h-2 rounded-full bg-red-500" />
            <span class="text-red-700">Просрочено:</span>
            <span class="font-semibold text-red-800">{{ azsFilterKpi.overdue }}</span>
          </div>
          <div class="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-50 border border-yellow-100 text-sm">
            <span class="w-2 h-2 rounded-full bg-yellow-500" />
            <span class="text-yellow-700">В работе:</span>
            <span class="font-semibold text-yellow-800">{{ azsFilterKpi.inProgress }}</span>
          </div>
        </div>

        <!-- Two-column layout: feed + right panel -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

          <!-- Feed (2/3 width) -->
          <section class="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-100">
            <div class="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 class="text-lg font-semibold">Лента событий</h2>
              <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
                <button
                  :class="[
                    'px-3 py-1.5 font-medium',
                    feedFilterMode === 'all'
                      ? 'bg-gray-100 text-gray-900'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="feedFilterMode = 'all'"
                >
                  Все события
                </button>
                <button
                  :class="[
                    'px-3 py-1.5 font-medium',
                    feedFilterMode === 'problems'
                      ? 'bg-gray-100 text-gray-900'
                      : 'text-gray-600 hover:bg-gray-50 border-l border-gray-200'
                  ]"
                  @click="feedFilterMode = 'problems'"
                >
                  Только проблемы
                </button>
              </div>
            </div>

            <div class="p-5 space-y-4">
              <div
                v-for="event in filteredEvents"
                :key="event.id"
                class="feed-item relative"
              >
                <div class="feed-line">
                  <div class="flex gap-3">
                    <div :class="`flex-shrink-0 w-10 h-10 rounded-full ${getEventBgColor(event)} flex items-center justify-center text-lg`">
                      {{ getEventIcon(event) }}
                    </div>
                    <div class="flex-1 pb-1">
                      <div class="flex items-baseline justify-between gap-3">
                        <p :class="['font-medium', event.type === 'expired' ? 'text-red-900' : '']">
                          {{ getEventTitle(event) }}
                        </p>
                        <span class="text-xs text-gray-500 whitespace-nowrap">{{ formatTime(event.timestamp) }}</span>
                      </div>
                      <p v-if="event.subtitle" class="text-sm text-gray-600 mt-0.5">
                        {{ event.subtitle }}
                      </p>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <template v-if="event.buttons && event.buttons.length > 0">
                          <button
                            v-for="btn in event.buttons"
                            :key="btn.action"
                            :disabled="btn.disabled || (btn.action === 'request-again' && pendingActions.has(`again:${event.azsId}:${event.reportRow.id}`))"
                            :class="[
                              'px-3 py-1 text-xs rounded-md transition-colors',
                              btn.action === 'request-again'
                                ? 'min-w-36 bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50'
                                : 'text-gray-600 hover:bg-gray-50 disabled:opacity-50'
                            ]"
                            @click="handleFeedAction(event, btn.action)"
                          >
                            {{ btn.action === 'request-again' && pendingActions.has(`again:${event.azsId}:${event.reportRow.id}`) ? 'Отправляем…' : btn.label }}
                          </button>
                        </template>
                        <!-- Resync button (#4): always shown on report-bearing items.
                             TODO: show «не синхронизировано» B24Badge only when feed carries syncStatus (follow-up). -->
                        <button
                          v-if="event.reportRow.id"
                          :disabled="resyncingIds.has(event.reportRow.id)"
                          class="min-w-36 px-3 py-1 text-xs rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                          @click="resyncReport(event.reportRow.id)"
                        >
                          {{ resyncingIds.has(event.reportRow.id) ? 'Синхронизация…' : 'Пересинхронизировать' }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="filteredEvents.length === 0" class="text-center py-8 text-gray-500">
                Нет событий за выбранный период
              </div>
            </div>
          </section>

          <!-- Right panel -->
          <aside class="space-y-6">

            <!-- Schedule card -->
            <section class="bg-white rounded-2xl shadow-sm border border-gray-100">
              <div class="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
                <span class="text-lg">📅</span>
                <h2 class="text-base font-semibold">Расписание рассылки</h2>
              </div>
              <div class="p-5 space-y-4">

                <div>
                  <label class="block text-xs text-gray-500 mb-1.5">Время рассылки заданий</label>
                  <div class="flex flex-wrap gap-2">
                    <span
                      v-for="(time, idx) in scheduleSettings.dispatchTimes"
                      :key="time"
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-50 text-blue-800 text-sm"
                    >
                      {{ time }}
                      <button class="text-blue-400 hover:text-blue-700" @click="removeDispatchTime(idx)">×</button>
                    </span>
                    <div class="flex gap-1 flex-1 min-w-[200px]">
                      <B24InputMenu
                        v-model="scheduleSettings.newTimeInput"
                        :items="timeSlots"
                        placeholder="HH:mm"
                        create-item
                        class="flex-1"
                        @keyup.enter="addDispatchTime"
                      />
                      <button
                        class="px-2.5 py-1.5 rounded-md border border-dashed border-gray-300 text-sm text-gray-500 hover:bg-gray-50"
                        @click="addDispatchTime"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <!-- Hint #1 -->
                  <p class="text-xs text-gray-400 mt-2 leading-relaxed">
                    Задаётся один раз. Дальше задания уходят автоматически каждый день в это время — каждый день настраивать не нужно.
                  </p>
                </div>

                <div>
                  <label class="block text-xs text-gray-500 mb-1.5">Случайный разброс ±, мин</label>
                  <div class="flex items-center gap-2">
                    <input
                      v-model.number="scheduleSettings.dispatchJitterMinutes"
                      type="number"
                      class="w-20 px-3 py-1.5 rounded-md border border-gray-200 text-sm"
                    >
                    <span class="text-sm text-gray-600">мин в обе стороны</span>
                  </div>
                  <p class="text-xs text-gray-400 mt-1">Чтобы все АЗС не получили push одновременно</p>
                </div>

                <div>
                  <label class="block text-xs text-gray-500 mb-1.5">Время на сдачу, мин</label>
                  <div class="flex items-center gap-2">
                    <input
                      v-model.number="scheduleSettings.timeoutMinutes"
                      type="number"
                      class="w-20 px-3 py-1.5 rounded-md border border-gray-200 text-sm"
                    >
                    <span class="text-sm text-gray-600">минут</span>
                  </div>
                </div>

                <button
                  class="w-full px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
                  @click="saveSchedule"
                >
                  Сохранить расписание
                </button>

                <B24Alert
                  v-if="saveScheduleSuccess"
                  color="air-primary-success"
                  :description="saveScheduleSuccess"
                />
                <B24Alert
                  v-if="saveScheduleError"
                  color="air-primary-alert"
                  :description="saveScheduleError"
                />
              </div>
            </section>

            <!-- Quick request card -->
            <section id="quick-request-card" class="bg-white rounded-2xl shadow-sm border border-gray-100">
              <div class="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
                <span class="text-lg">⚡</span>
                <h2 class="text-base font-semibold">Запросить отчёт вне расписания</h2>
              </div>
              <div class="p-5 space-y-3">

                <!-- Multi-select АЗС (#2) -->
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
                    <label
                      v-for="opt in filteredAzsOptions"
                      :key="opt.value"
                      class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50"
                      :class="{ 'bg-blue-50': manualRequest.azsIds.includes(opt.value) }"
                    >
                      <input
                        type="checkbox"
                        :value="opt.value"
                        :checked="manualRequest.azsIds.includes(opt.value)"
                        class="rounded border-gray-300 text-blue-600"
                        @change="toggleAzsSelection(opt.value)"
                      >
                      <span :class="manualRequest.azsIds.includes(opt.value) ? 'text-blue-800 font-medium' : 'text-gray-700'">
                        {{ opt.label }}
                      </span>
                    </label>
                    <div v-if="azsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
                      Нет доступных АЗС
                    </div>
                    <div v-else-if="filteredAzsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
                      Ничего не найдено по «{{ azsSearchQuery }}»
                    </div>
                  </div>
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
                </div>

                <div>
                  <label class="block text-xs text-gray-500 mb-1.5">Когда отправить</label>
                  <div class="flex gap-2">
                    <button
                      :class="[
                        'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                        manualRequest.mode === 'now'
                          ? 'bg-blue-50 text-blue-700'
                          : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                      ]"
                      @click="manualRequest.mode = 'now'"
                    >
                      Прямо сейчас
                    </button>
                    <button
                      :class="[
                        'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                        manualRequest.mode === 'schedule'
                          ? 'bg-blue-50 text-blue-700'
                          : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                      ]"
                      @click="manualRequest.mode = 'schedule'"
                    >
                      Запланировать
                    </button>
                  </div>
                </div>

                <div v-if="manualRequest.mode === 'schedule'" class="space-y-2">
                  <div>
                    <label class="block text-xs text-gray-500 mb-1.5">Дата</label>
                    <details class="inline-block w-full">
                      <summary class="w-full px-3 py-2 rounded-md border border-gray-200 text-sm cursor-pointer hover:bg-gray-50">
                        {{ manualRequest.scheduleDate || 'Выберите дату' }}
                      </summary>
                      <div class="mt-2 p-3 border border-gray-200 rounded-md bg-white">
                        <B24Calendar
                          v-model="manualRequest.scheduleDate"
                          @update:model-value="(val) => {
                            if (val) {
                              const d = val as any
                              const year = d.year
                              const month = String(d.month).padStart(2, '0')
                              const day = String(d.day).padStart(2, '0')
                              manualRequest.scheduleDate = `${year}-${month}-${day}`
                            }
                          }"
                        />
                      </div>
                    </details>
                  </div>
                  <div>
                    <label class="block text-xs text-gray-500 mb-1.5">Время</label>
                    <B24InputMenu
                      v-model="manualRequest.scheduleTime"
                      :items="timeSlots"
                      placeholder="Выберите время…"
                      create-item
                    />
                  </div>
                </div>

                <button
                  class="w-full px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium"
                  :disabled="manualRequest.azsIds.length === 0"
                  @click="sendManualRequest"
                >
                  {{ manualRequest.azsIds.length > 0 ? `Запросить у ${manualRequest.azsIds.length} АЗС` : 'Выберите АЗС' }}
                </button>

                <B24Alert
                  v-if="manualSuccess"
                  color="air-primary-success"
                  :description="manualSuccess"
                />
                <B24Alert
                  v-if="manualError"
                  color="air-primary-alert"
                  :description="manualError"
                />
              </div>
            </section>

          </aside>
        </div>

        <!-- Plan section (RD-6) -->
        <section class="mt-6 bg-white rounded-2xl shadow-sm border border-gray-100">
          <div class="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
            <span class="text-lg">🗓</span>
            <h2 class="text-base font-semibold">План отчётов на сегодня</h2>
          </div>
          <div class="p-5">
            <div class="flex items-center gap-3 mb-4">
              <button
                class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm disabled:opacity-50"
                :disabled="planGenerating"
                @click="handleGeneratePlan"
              >
                {{ planGenerating ? 'Формирование…' : 'Сформировать график' }}
              </button>
              <span v-if="planGenerateMessage" class="text-sm text-green-700 font-medium">{{ planGenerateMessage }}</span>
              <span v-if="planGenerateError" class="text-sm text-red-600">{{ planGenerateError }}</span>
            </div>
            <div v-if="!dispatchPlanEnabled" class="text-sm text-gray-400 py-2">
              Случайный план рассылки не включён
            </div>
            <div v-else-if="dispatchPlan.length === 0" class="text-sm text-gray-400 py-2">
              Нет запланированных заданий на сегодня
            </div>
            <div v-else class="overflow-auto">
              <table class="min-w-full text-sm">
                <thead>
                  <tr class="text-left border-b border-gray-200">
                    <th class="py-2 pr-4 font-medium text-gray-600">АЗС</th>
                    <th class="py-2 pr-4 font-medium text-gray-600">Время запроса</th>
                    <th class="py-2 pr-4 font-medium text-gray-600">Ответственный</th>
                    <th class="py-2 font-medium text-gray-600">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, idx) in dispatchPlan"
                    :key="idx"
                    class="border-b border-gray-100 last:border-0"
                  >
                    <td class="py-2 pr-4">{{ row.azsTitle || row.azsId }}</td>
                    <td class="py-2 pr-4 tabular-nums">{{ formatPlanTime(row.executeAt) }}</td>
                    <td class="py-2 pr-4 tabular-nums text-gray-500">{{ row.adminUserId || '—' }}</td>
                    <td class="py-2">
                      <B24Badge
                        :color="row.status === 'dispatched' ? 'air-primary-success' : row.status === 'failed' ? 'air-primary-alert' : 'air-secondary'"
                      >
                        {{
                          row.status === 'planned' ? 'запланирован' :
                          row.status === 'dispatched' ? 'отправлен' :
                          row.status === 'failed' ? 'ошибка' :
                          row.status
                        }}
                      </B24Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- Tech info panel (collapsible) -->
        <details class="mt-8 text-center">
          <summary class="text-xs text-gray-400 hover:text-gray-600 hover:underline cursor-pointer">
            Показать техническую информацию по отчётам
          </summary>
          <div class="mt-4 bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div class="overflow-auto mb-4">
              <table class="min-w-full text-sm">
                <thead>
                  <tr class="text-left border-b border-gray-200">
                    <th class="py-2 pr-3">ID</th>
                    <th class="py-2 pr-3">АЗС</th>
                    <th class="py-2 pr-3">Время рассылки</th>
                    <th class="py-2 pr-3">Срок сдачи</th>
                    <th class="py-2 pr-3">Статус</th>
                    <th class="py-2 pr-3">Папка фото</th>
                    <th class="py-2 pr-3">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in reports" :key="item.id" class="border-b border-gray-100">
                    <td class="py-2 pr-3">{{ item.id }}</td>
                    <td class="py-2 pr-3">{{ item.azsId }}</td>
                    <td class="py-2 pr-3">{{ item.slotKey || '—' }}</td>
                    <td class="py-2 pr-3">{{ item.deadlineAt || '—' }}</td>
                    <td class="py-2 pr-3">
                      <B24Badge
                        :color="item.status === 'done' ? 'air-primary-success' : item.status === 'failed' ? 'air-primary-alert' : 'air-secondary'"
                      >
                        {{
                          item.status === 'done' ? 'Сдан' :
                          item.status === 'in_progress' ? 'В работе' :
                          item.status === 'expired' ? 'Не сдан' :
                          item.status === 'failed' ? 'Ошибка' :
                          'Запланирован'
                        }}
                      </B24Badge>
                    </td>
                    <td class="py-2 pr-3">{{ item.diskFolderId || '—' }}</td>
                    <td class="py-2 pr-3">
                      <div class="flex flex-wrap gap-1">
                        <button
                          class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded"
                          :disabled="!item.diskFolderId"
                          @click="openPhotoFolder(item)"
                        >
                          Папка
                        </button>
                        <!-- Resync button in tech table (#4) -->
                        <button
                          class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded disabled:opacity-50"
                          :disabled="resyncingIds.has(item.id)"
                          @click="resyncReport(item.id)"
                        >
                          {{ resyncingIds.has(item.id) ? '…' : 'Ресинк' }}
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
              @click="runTimeout"
            >
              Проверить просрочки
            </button>
            <B24Alert
              v-if="timeoutMessage"
              color="air-secondary"
              :description="timeoutMessage"
              class="mt-4"
            />
          </div>
        </details>

      </div>
    </template>
  </div>
</template>

<style scoped>
.feed-line::before {
  content: "";
  position: absolute;
  left: 19px;
  top: 40px;
  bottom: -16px;
  width: 2px;
  background: #e5e7eb;
}
.feed-item:last-child .feed-line::before {
  display: none;
}
</style>
