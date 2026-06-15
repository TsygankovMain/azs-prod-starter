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
  deadlineAt: string | null
}

type SlotState = {
  key: string
  title: string
  confirmed: boolean
  uploaded: boolean
  uploading: boolean
  uploadState: 'idle' | 'queued' | 'uploading' | 'uploaded' | 'error'
  uploadTaskId: number
  previewUrl: string
  file: File | null
  fileName: string
  error: string
}

type RequiredPhoto = {
  code: string
  title: string
  sort?: number
}

type UploadTask = {
  id: number
  slotKey: string
  file: File
  sessionId: number
}

const PAGE_TITLE = 'Фотоотчёт АЗС: загрузка'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('AdminReportPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const route = useRoute()
const { errorText, errorDetail } = useErrorText()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const loadErrorDetail = ref('')
const report = ref<ReportRow | null>(null)
const saveError = ref('')
const saveErrorDetail = ref('')
const saveSuccess = ref('')
const activeCameraSlotKey = ref('')
const cameraError = ref('')
const cameraBusy = ref(false)
const cameraVideoEl = ref<HTMLVideoElement | null>(null)
const cameraStream = ref<MediaStream | null>(null)
const isSubmitting = ref(false)
const hasSettingsAccess = ref(false)
const submitError = ref('')
const submitErrorDetail = ref('')

const photoSlots = reactive<SlotState[]>([])
const queueSlotRefs = new Map<string, HTMLElement>()
const queueAnchorEl = ref<HTMLElement | null>(null)
const uploadQueue = reactive<UploadTask[]>([])
const uploadWorker = reactive({
  activeCount: 0,
  maxConcurrency: 2,
  lowModeSuccessStreak: 0,
  sessionId: 1
})
const workerHalted = ref(false)
let nextUploadTaskId = 0

const confirmedCount = computed(() => photoSlots.filter((slot) => slot.confirmed).length)
const uploadedCount = computed(() => photoSlots.filter((slot) => slot.uploaded).length)
const allConfirmed = computed(() => photoSlots.length > 0 && confirmedCount.value === photoSlots.length)
const allUploaded = computed(() => photoSlots.length > 0 && uploadedCount.value === photoSlots.length)
const hasQueued = computed(() => photoSlots.some((slot) => slot.uploadState === 'queued'))
const hasUploading = computed(() => photoSlots.some((slot) => slot.uploadState === 'uploading'))
const hasPendingUploads = computed(() => hasQueued.value || hasUploading.value || uploadWorker.activeCount > 0)
const hasUploadErrors = computed(() => photoSlots.some((slot) => Boolean(slot.error) && slot.confirmed && !slot.uploaded))
const currentSlotIndex = computed(() => {
  const index = photoSlots.findIndex((slot) => !slot.confirmed)
  return index >= 0 ? index : photoSlots.length
})
const activeSlot = computed(() => {
  const index = currentSlotIndex.value
  return index >= 0 && index < photoSlots.length ? photoSlots[index] : null
})
const activeSlotNumber = computed(() => {
  if (!activeSlot.value) return 0
  return currentSlotIndex.value + 1
})

const formatAzsLabel = (row: ReportRow): string => {
  const title = String(row.azsTitle || '').trim()
  return title || `АЗС ${String(row.azsId || '').trim() || '—'}`
}

const formatSlotKeyLabel = (slotKey: string): string => {
  const key = String(slotKey || '').trim()
  if (!key) return '—'

  // Main backend formats:
  // - YYYY-MM-DD:HHmm
  // - manual:YYYY-MM-DD:HHmm
  // Legacy format:
  // - YYYY-MM-DD_HHmm
  const normalized = key.startsWith('manual:') ? key.slice('manual:'.length) : key
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})[:_](\d{2})(\d{2})$/)
  if (m) {
    const [, y, mo, d, hh, mm] = m
    return `${d}.${mo}.${y} ${hh}:${mm}`
  }

  const dt = new Date(key)
  if (!Number.isNaN(dt.getTime())) {
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    // "dd.mm.yyyy, hh:mm" -> "dd.mm.yyyy hh:mm"
    return fmt.format(dt).replace(',', '')
  }

  return key
}

const formatReportStatusLabel = (status: string): string => {
  const s = String(status || '').trim()
  if (s === 'done') return 'Сдан'
  if (s === 'in_progress') return 'В работе'
  if (s === 'expired') return 'Не сдан'
  if (s === 'failed') return 'Ошибка'
  if (!s || s === 'new') return 'Запланирован'
  return s
}

const reportAzsLabel = computed(() => (report.value ? formatAzsLabel(report.value) : '—'))
const reportSlotKeyLabel = computed(() => (report.value ? formatSlotKeyLabel(report.value.slotKey) : '—'))
const reportStatusLabel = computed(() => (report.value ? formatReportStatusLabel(report.value.status) : '—'))
const submitBlockReason = computed(() => {
  if (report.value?.status === 'done') return 'Отчёт уже отправлен'
  if (!allConfirmed.value) return 'Подтвердите все фото'
  if (hasPendingUploads.value) return 'Дождитесь завершения фоновых загрузок'
  if (hasUploadErrors.value) return 'Исправьте ошибки загрузки'
  if (!allUploaded.value) return 'Дождитесь загрузки всех подтверждённых фото'
  return ''
})
const canSubmitReport = computed(() => (
  allConfirmed.value
  && allUploaded.value
  && !hasPendingUploads.value
  && !hasUploadErrors.value
  && !isSubmitting.value
  && report.value?.status !== 'done'
))
const isCameraOpen = computed(() => Boolean(activeCameraSlotKey.value))

const makeSlot = (photo: RequiredPhoto): SlotState => ({
  key: String(photo.code || '').trim().toLowerCase(),
  title: String(photo.title || photo.code || '').trim(),
  confirmed: false,
  uploaded: false,
  uploading: false,
  uploadState: 'idle',
  uploadTaskId: 0,
  previewUrl: '',
  file: null,
  fileName: '',
  error: ''
})

const revokeSlotPreview = (slot: SlotState) => {
  if (slot.previewUrl) {
    URL.revokeObjectURL(slot.previewUrl)
    slot.previewUrl = ''
  }
}

const applyRequiredPhotos = (requiredPhotos: RequiredPhoto[] = []) => {
  for (const slot of photoSlots) {
    revokeSlotPreview(slot)
  }
  const nextSlots = requiredPhotos
    .map(makeSlot)
    .filter((slot) => slot.key)

  photoSlots.splice(0, photoSlots.length, ...nextSlots)
}

const stopCameraStream = () => {
  if (cameraVideoEl.value) {
    cameraVideoEl.value.srcObject = null
  }
  if (cameraStream.value) {
    for (const track of cameraStream.value.getTracks()) {
      track.stop()
    }
    cameraStream.value = null
  }
}

const closeCamera = () => {
  activeCameraSlotKey.value = ''
  cameraError.value = ''
  stopCameraStream()
}

const setCameraVideoRef = (el: Element | null) => {
  cameraVideoEl.value = el instanceof HTMLVideoElement ? el : null
}

const safePlayVideo = async (videoEl: HTMLVideoElement | null) => {
  if (!videoEl) {
    return
  }
  const playFn = (videoEl as HTMLVideoElement & { play?: () => Promise<void> | void }).play
  if (typeof playFn !== 'function') {
    throw new Error('Видео-элемент не поддерживает воспроизведение')
  }
  await Promise.resolve(playFn.call(videoEl))
}

const startCameraForSlot = async (slot: SlotState) => {
  slot.error = ''
  cameraError.value = ''
  cameraBusy.value = true

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Камера недоступна в этом WebView')
    }

    stopCameraStream()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' }
      }
    })

    cameraStream.value = stream
    activeCameraSlotKey.value = slot.key
    await nextTick()
    if (cameraVideoEl.value) {
      cameraVideoEl.value.srcObject = stream
      await safePlayVideo(cameraVideoEl.value).catch(() => undefined)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось открыть камеру'
    cameraError.value = message
    slot.error = message
    closeCamera()
  } finally {
    cameraBusy.value = false
  }
}

const setQueueAnchorRef = (el: Element | null) => {
  queueAnchorEl.value = el instanceof HTMLElement ? el : null
}

const setQueueSlotRef = (slotKey: string, el: Element | null) => {
  const key = String(slotKey || '').trim()
  if (!key) return
  if (el instanceof HTMLElement) {
    queueSlotRefs.set(key, el)
  } else {
    queueSlotRefs.delete(key)
  }
}

const resetUploadWorker = () => {
  uploadWorker.sessionId += 1
  uploadWorker.activeCount = 0
  uploadWorker.maxConcurrency = 2
  uploadWorker.lowModeSuccessStreak = 0
  uploadQueue.splice(0, uploadQueue.length)
}

const isRetryableUploadIssue = ({
  errorCode,
  message
}: {
  errorCode?: string
  message?: string
} = {}): boolean => {
  if (String(errorCode || '').trim().toLowerCase() === 'bitrix_retryable') {
    return true
  }
  return /(OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|HTTP 429|HTTP 504|too many requests|gateway timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network error|timeout)/i
    .test(String(message || ''))
}

const enableLowConcurrencyMode = () => {
  if (uploadWorker.maxConcurrency !== 1) {
    uploadWorker.maxConcurrency = 1
    uploadWorker.lowModeSuccessStreak = 0
    saveSuccess.value = 'Включён бережный режим загрузки (x1) из-за временной перегрузки Bitrix24.'
  }
}

const registerUploadSuccess = () => {
  if (uploadWorker.maxConcurrency !== 1) {
    return
  }
  uploadWorker.lowModeSuccessStreak += 1
  if (uploadWorker.lowModeSuccessStreak >= 10) {
    uploadWorker.maxConcurrency = 2
    uploadWorker.lowModeSuccessStreak = 0
    saveSuccess.value = 'Стабильность восстановлена, возвращаем режим фоновой загрузки x2.'
  }
}

const scrollToQueueAnchor = () => {
  queueAnchorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const scrollToFirstProblemSlot = async () => {
  const firstProblemSlot = photoSlots.find((slot) => {
    if (!slot.confirmed) return true
    if (slot.uploadState === 'queued' || slot.uploadState === 'uploading') return true
    return Boolean(slot.error) && !slot.uploaded
  })

  if (firstProblemSlot) {
    // The "Все слоты" list is collapsed by default (v-if), so its per-slot
    // refs are not mounted. Expand it and wait a tick so setQueueSlotRef has
    // registered the element before we scroll to it.
    showAllSlots.value = true
    await nextTick()
    const el = queueSlotRefs.get(firstProblemSlot.key)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
  }

  scrollToQueueAnchor()
}

const runUploadTask = async (task: UploadTask) => {
  const sessionId = uploadWorker.sessionId
  const slot = photoSlots.find((item) => item.key === task.slotKey)
  if (!slot) {
    return
  }
  if (task.sessionId !== sessionId) {
    return
  }
  if (slot.uploadTaskId !== task.id || slot.file !== task.file || !slot.confirmed) {
    return
  }

  slot.uploading = true
  slot.uploadState = 'uploading'
  slot.error = ''

  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    slot.uploading = false
    slot.uploaded = false
    slot.uploadState = 'error'
    slot.error = 'Некорректный reportId'
    return
  }

  try {
    const response = await apiStore.uploadReportPhoto({
      reportId: id,
      photoCode: slot.key,
      file: task.file
    })

    if (task.sessionId !== uploadWorker.sessionId) {
      return
    }
    if (slot.uploadTaskId !== task.id || slot.file !== task.file) {
      return
    }

    slot.uploaded = true
    slot.uploading = false
    slot.uploadState = 'uploaded'
    slot.error = ''
    const backendFileName = typeof (response.item as Record<string, unknown>)?.fileName === 'string'
      ? String((response.item as Record<string, unknown>).fileName)
      : ''
    slot.fileName = backendFileName || task.file.name
    registerUploadSuccess()
  } catch (error) {
    if (task.sessionId !== uploadWorker.sessionId) {
      return
    }
    if (slot.uploadTaskId !== task.id || slot.file !== task.file) {
      return
    }

    slot.uploaded = false
    slot.uploading = false
    slot.uploadState = 'error'
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
        errorCode?: string
        currentUserId?: number
        expectedAdminUserId?: number
      }
    })?.data
    const accessDetails = responseData?.error === 'forbidden_user'
      ? ` Текущий пользователь: ${String(responseData.currentUserId || '—')}, назначенный админ отчёта: ${String(responseData.expectedAdminUserId || '—')}.`
      : ''
    const retryable = isRetryableUploadIssue({
      errorCode: responseData?.errorCode,
      message: responseData?.message || responseData?.error
    })
    const humanText = errorText(error, 'Не удалось загрузить фото')
    slot.error = `${humanText}${accessDetails}`
    if (retryable) {
      enableLowConcurrencyMode()
    }
    saveError.value = slot.error
    saveErrorDetail.value = errorDetail(error)
  } finally {
    if (task.sessionId === uploadWorker.sessionId) {
      uploadWorker.activeCount = Math.max(0, uploadWorker.activeCount - 1)
      void pumpUploadQueue()
    }
  }
}

const pumpUploadQueue = async () => {
  if (workerHalted.value) {
    return
  }
  const sessionId = uploadWorker.sessionId
  while (uploadWorker.activeCount < uploadWorker.maxConcurrency && uploadQueue.length > 0) {
    const task = uploadQueue.shift()
    if (!task) {
      return
    }
    if (task.sessionId !== sessionId) {
      continue
    }
    uploadWorker.activeCount += 1
    void runUploadTask(task)
  }
}

const queueSlotUpload = (slot: SlotState, file: File) => {
  const reportId = Number(route.params.reportId)
  if (!Number.isFinite(reportId) || reportId <= 0) {
    slot.uploadState = 'error'
    slot.error = 'Некорректный reportId'
    return
  }

  nextUploadTaskId += 1
  slot.uploadTaskId = nextUploadTaskId
  slot.uploadState = 'queued'
  slot.uploading = false
  slot.uploaded = false
  slot.error = ''
  uploadQueue.push({
    id: slot.uploadTaskId,
    slotKey: slot.key,
    file,
    sessionId: uploadWorker.sessionId
  })
  void pumpUploadQueue()
}

const loadReport = async () => {
  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    loadError.value = 'Некорректный reportId в URL'
    return
  }

  isLoading.value = true
  loadError.value = ''
  loadErrorDetail.value = ''
  resetUploadWorker()
  try {
    const response = await apiStore.getReportById(id)
    report.value = response.item as ReportRow
    applyRequiredPhotos(response.requiredPhotos || [])
    const uploaded = new Set((response.photos || []).map((photo) => String(photo.photoCode || '').toLowerCase()))
    for (const slot of photoSlots) {
      const isUploaded = uploaded.has(slot.key)
      slot.confirmed = isUploaded
      slot.uploaded = isUploaded
      if (!slot.uploaded) {
        slot.fileName = ''
      }
      slot.error = ''
      slot.uploading = false
      slot.uploadState = isUploaded ? 'uploaded' : 'idle'
      slot.uploadTaskId = 0
    }
  } catch (error) {
    loadError.value = errorText(error, 'Не удалось загрузить отчёт')
    loadErrorDetail.value = errorDetail(error)
  } finally {
    isLoading.value = false
  }
}

const captureSlotPreview = async (slot: SlotState) => {
  slot.error = ''
  cameraError.value = ''

  const video = cameraVideoEl.value
  if (!video || !cameraStream.value) {
    const message = 'Камера не инициализирована'
    slot.error = message
    cameraError.value = message
    return
  }

  const width = video.videoWidth || 1280
  const height = video.videoHeight || 720
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    const message = 'Не удалось подготовить кадр камеры'
    slot.error = message
    cameraError.value = message
    return
  }

  ctx.drawImage(video, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92)
  })
  if (!blob) {
    const message = 'Не удалось получить фото из камеры'
    slot.error = message
    cameraError.value = message
    return
  }

  const file = new File([blob], `${slot.key}_${Date.now()}.jpg`, { type: 'image/jpeg' })
  revokeSlotPreview(slot)
  slot.file = file
  slot.previewUrl = URL.createObjectURL(file)
  slot.confirmed = false
  slot.uploaded = false
  slot.uploading = false
  slot.uploadState = 'idle'
  slot.uploadTaskId += 1
  slot.fileName = file.name
  closeCamera()
}

const acceptSlotPhoto = (slot: SlotState) => {
  if (!slot.file) {
    slot.error = 'Сначала сделайте фото'
    return
  }

  slot.confirmed = true
  slot.uploaded = false
  slot.uploading = false
  slot.uploadState = 'queued'
  slot.error = ''
  saveError.value = ''
  saveErrorDetail.value = ''
  saveSuccess.value = ''
  if (slot.file.size > 10 * 1024 * 1024) {
    slot.uploadState = 'error'
    slot.error = 'Файл больше 10 МБ'
    return
  }
  queueSlotUpload(slot, slot.file)

  // If the current active slot was confirmed, automatically open the camera for the next one.
  void Promise.resolve().then(() => ensureCameraForActiveSlot())
}

const retakeSlotPhoto = async (slot: SlotState) => {
  revokeSlotPreview(slot)
  slot.file = null
  slot.confirmed = false
  slot.uploaded = false
  slot.uploading = false
  slot.uploadState = 'idle'
  slot.uploadTaskId += 1
  slot.fileName = ''
  slot.error = ''
  await startCameraForSlot(slot)
}

const retrySlotUpload = (slot: SlotState) => {
  if (!slot.file) {
    slot.error = 'Локальный файл недоступен, переснимите фото'
    return
  }
  if (slot.file.size > 10 * 1024 * 1024) {
    slot.uploadState = 'error'
    slot.error = 'Файл больше 10 МБ'
    return
  }
  saveError.value = ''
  saveErrorDetail.value = ''
  slot.error = ''
  slot.confirmed = true
  queueSlotUpload(slot, slot.file)
}

const openCameraForActiveSlot = async () => {
  const slot = activeSlot.value
  if (!slot) {
    closeCamera()
    return
  }
  await startCameraForSlot(slot)
}

const ensureCameraForActiveSlot = async () => {
  const slot = activeSlot.value
  if (!slot) {
    closeCamera()
    return
  }

  // Don't auto-open while user is reviewing a captured preview.
  if (slot.previewUrl) {
    return
  }

  // Don't interrupt manual camera usage for a different slot.
  if (activeCameraSlotKey.value && activeCameraSlotKey.value !== slot.key) {
    return
  }

  if (activeCameraSlotKey.value === slot.key && cameraStream.value) {
    return
  }

  await startCameraForSlot(slot)
}

const submitReport = async () => {
  if (!canSubmitReport.value) {
    submitError.value = submitBlockReason.value || 'Отчёт пока нельзя отправить'
    if (hasPendingUploads.value || hasUploadErrors.value) {
      scrollToFirstProblemSlot()
    }
    return
  }

  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    submitError.value = 'Некорректный reportId'
    return
  }

  isSubmitting.value = true
  submitError.value = ''
  submitErrorDetail.value = ''
  saveSuccess.value = ''
  try {
    await apiStore.submitReport(id)
    saveSuccess.value = 'Отчёт отправлен. Статус переведён в DONE.'
    await loadReport()
  } catch (error) {
    submitError.value = errorText(error, 'Не удалось отправить отчёт')
    submitErrorDetail.value = errorDetail(error)
  } finally {
    isSubmitting.value = false
  }
}

const leaveReport = async () => {
  closeCamera()
  await navigateTo('/')
}

const openSettings = async () => {
  closeCamera()
  await navigateTo('/settings')
}

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
      // Ошибка получения роли — кнопка остаётся скрытой (безопасный дефолт)
    }
    await loadReport()
    await nextTick()
    await ensureCameraForActiveSlot()
  } catch (error) {
    processErrorGlobal(error)
  }
})

watch(currentSlotIndex, () => {
  // Move forward automatically, without requiring scroll/swipe.
  void ensureCameraForActiveSlot()
})

watch(() => route.params.reportId, async (nextValue, prevValue) => {
  if (String(nextValue || '') === String(prevValue || '')) {
    return
  }
  closeCamera()
  await loadReport()
  await nextTick()
  await ensureCameraForActiveSlot()
})

onBeforeUnmount(() => {
  workerHalted.value = true
  resetUploadWorker()
  closeCamera()
  for (const slot of photoSlots) {
    revokeSlotPreview(slot)
  }
  queueSlotRefs.clear()
})

// ── Focus Mode: toggle for the "all slots" list ──────────────────────────────
const showAllSlots = ref(false)

// Авто-раскрытие списка при появлении ошибок загрузки (LOGIC-F2)
watch(hasUploadErrors, (hasErr) => {
  if (hasErr) showAllSlots.value = true
})
</script>

<template>
  <div class="w-full max-w-[600px] mx-auto px-3 py-3 space-y-3">

    <!-- ─── SLIM STICKY HEADER ──────────────────────────────────────────────── -->
    <div class="sticky top-0 z-30">
      <div class="bg-white/95 backdrop-blur-sm border-b border-gray-100 rounded-b-xl shadow-sm px-3 py-2 space-y-2">

        <!-- Row 1: title + nav buttons -->
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-semibold text-gray-800 truncate">Фотоотчёт АЗС</span>
            <HelpButton default-role="admin" />
          </div>
          <div class="flex items-center gap-1.5">
            <B24Button
              color="air-secondary"
              variant="outline"
              size="xs"
              label="Выйти"
              @click="leaveReport"
            />
            <B24Button
              v-if="hasSettingsAccess"
              color="air-primary"
              variant="outline"
              size="xs"
              label="Настройки"
              @click="openSettings"
            />
          </div>
        </div>

        <!-- Row 2: progress stepper (only when slots are loaded) -->
        <template v-if="photoSlots.length > 0">
          <!-- Slot counter + status badges -->
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[13px] font-medium text-gray-700">
                Слот {{ activeSlot ? activeSlotNumber : photoSlots.length }}&nbsp;/&nbsp;{{ photoSlots.length }}
              </span>
              <B24Badge :color="canSubmitReport ? 'air-primary-success' : (hasUploadErrors ? 'air-primary-alert' : 'air-secondary')" size="xs">
                {{ uploadedCount }}/{{ photoSlots.length }} загружено
              </B24Badge>
              <B24Badge v-if="hasPendingUploads" color="air-secondary" size="xs">загрузка...</B24Badge>
              <B24Badge v-if="hasPendingUploads && uploadWorker.maxConcurrency === 1" color="air-secondary" size="xs">бережный режим</B24Badge>
              <B24Badge v-if="hasUploadErrors" color="air-primary-alert" size="xs">есть ошибки</B24Badge>
              <B24Badge v-if="report?.status === 'done'" color="air-primary-success" size="xs">отправлен</B24Badge>
            </div>
            <!-- Submit button always in sticky header -->
            <div class="flex items-center gap-1.5">
              <B24Button
                v-if="!canSubmitReport && (hasPendingUploads || hasUploadErrors)"
                color="air-secondary"
                size="xs"
                label="К проблемам"
                loading-auto
                @click="scrollToFirstProblemSlot"
              />
              <B24Button
                color="air-primary-success"
                size="xs"
                label="Сдать отчёт"
                :disabled="!canSubmitReport"
                loading-auto
                @click="submitReport"
              />
            </div>
          </div>

          <!-- Segmented progress bar -->
          <div class="flex gap-0.5 h-1.5 rounded-full overflow-hidden">
            <div
              v-for="(slot, index) in photoSlots"
              :key="slot.key"
              class="flex-1 rounded-full transition-colors duration-300"
              :class="{
                'bg-green-500': slot.uploaded,
                'bg-yellow-400': slot.confirmed && !slot.uploaded && !slot.error,
                'bg-red-400': slot.error && !slot.uploaded,
                'bg-blue-500': index === currentSlotIndex && !slot.uploaded && !slot.confirmed,
                'bg-gray-200': index > currentSlotIndex && !slot.confirmed
              }"
            />
          </div>

          <!-- Block reason hint -->
          <p v-if="!canSubmitReport && submitBlockReason" class="text-[11px] text-gray-400 leading-tight m-0">
            {{ submitBlockReason }}
          </p>
        </template>
      </div>
    </div>
    <!-- ─── END STICKY HEADER ───────────────────────────────────────────────── -->

    <!-- ─── GLOBAL ALERTS ───────────────────────────────────────────────────── -->
    <div v-if="loadError" class="space-y-1">
      <B24Alert
        color="air-primary-alert"
        title="Ошибка загрузки отчёта"
        :description="loadError"
      />
      <details v-if="loadErrorDetail" class="list-none text-xs text-gray-400">
        <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
        <p class="mt-1 font-mono break-all">{{ loadErrorDetail }}</p>
      </details>
    </div>
    <B24Alert
      v-if="isLoading"
      color="air-secondary"
      title="Загрузка"
      description="Загружаем карточку отчёта..."
    />
    <B24Alert
      v-if="!isLoading && !loadError && photoSlots.length === 0"
      color="air-primary-alert"
      title="Нет обязательных фото"
      description="Для этого отчёта не определён набор обязательных фото. Проверьте настройки и карточку АЗС."
    />
    <B24Alert
      v-if="saveSuccess"
      color="air-primary-success"
      title="Успешно"
      :description="saveSuccess"
    />
    <div v-if="saveError" class="space-y-1">
      <B24Alert
        color="air-primary-alert"
        title="Ошибка загрузки"
        :description="saveError"
      />
      <details v-if="saveErrorDetail" class="list-none text-xs text-gray-400">
        <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
        <p class="mt-1 font-mono break-all">{{ saveErrorDetail }}</p>
      </details>
    </div>
    <!-- Ошибки загрузки фото с перечнем слотов и кнопкой «Повторить» (LOGIC-F2) -->
    <div v-if="hasUploadErrors" class="space-y-2">
      <B24Alert
        color="air-primary-alert"
        title="Не удалось загрузить фото"
        description="Часть фотографий не была загружена на сервер. Используйте кнопку «Повторить загрузку» для каждого проблемного фото ниже."
      />
      <div class="space-y-1.5">
        <div
          v-for="slot in photoSlots.filter(s => s.error && s.confirmed && !s.uploaded)"
          :key="slot.key"
          class="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5"
        >
          <div class="min-w-0 space-y-0.5">
            <p class="text-[13px] font-medium text-red-800 leading-tight">{{ slot.title }}</p>
            <p class="text-[11px] text-red-600 leading-tight break-all">{{ slot.error }}</p>
          </div>
          <B24Button
            color="air-primary"
            variant="outline"
            label="Повторить"
            size="xs"
            class="shrink-0"
            :disabled="slot.uploadState === 'uploading'"
            loading-auto
            @click="retrySlotUpload(slot)"
          />
        </div>
      </div>
    </div>

    <div v-if="submitError" class="space-y-1">
      <B24Alert
        color="air-primary-alert"
        title="Ошибка отправки отчёта"
        :description="submitError"
      />
      <details v-if="submitErrorDetail" class="list-none text-xs text-gray-400">
        <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
        <p class="mt-1 font-mono break-all">{{ submitErrorDetail }}</p>
      </details>
    </div>

    <!-- ─── COMPACT REPORT META ─────────────────────────────────────────────── -->
    <B24Card v-if="report" variant="outline">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
        <span class="font-semibold text-gray-700">Отчёт&nbsp;#{{ report.id }}</span>
        <B24Badge color="air-secondary" size="xs">АЗС: {{ reportAzsLabel }}</B24Badge>
        <B24Badge color="air-secondary" size="xs">Слот: {{ reportSlotKeyLabel }}</B24Badge>
        <B24Badge color="air-secondary" size="xs">{{ reportStatusLabel }}</B24Badge>
        <B24Badge v-if="report.deadlineAt" color="air-secondary" size="xs">до {{ report.deadlineAt }}</B24Badge>
      </div>
    </B24Card>

    <!-- ─── FOCUS ZONE: ACTIVE SLOT ─────────────────────────────────────────── -->
    <B24Card v-if="activeSlot && !isLoading" variant="outline">
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="m-0 text-[15px] font-semibold text-gray-900 leading-tight">
              {{ activeSlot.title }}
            </p>
            <p class="m-0 text-[12px] text-gray-500 mt-0.5 leading-tight">
              Слот {{ activeSlotNumber }}&nbsp;из&nbsp;{{ photoSlots.length }} · Сделайте фото и подтвердите
            </p>
          </div>
          <B24Badge
            :color="activeSlot.uploaded ? 'air-primary-success' : (activeSlot.error ? 'air-primary-alert' : (activeSlot.confirmed ? 'air-secondary' : 'air-secondary'))"
            size="xs"
            class="shrink-0"
          >
            {{
              activeSlot.uploading ? 'загрузка...' :
              activeSlot.uploaded ? 'загружено' :
              activeSlot.confirmed ? 'ожидает загрузки' :
              'ожидает фото'
            }}
          </B24Badge>
        </div>
      </template>

      <div class="space-y-3">

        <!-- Camera live view (shown when camera is open for this slot) -->
        <div v-if="activeCameraSlotKey === activeSlot.key" class="rounded-xl overflow-hidden bg-black aspect-[4/3]">
          <video
            :ref="setCameraVideoRef"
            class="w-full h-full object-cover"
            autoplay
            playsinline
            muted
          />
        </div>

        <!-- Captured preview -->
        <div
          v-if="activeSlot.previewUrl"
          class="rounded-xl overflow-hidden bg-black aspect-[4/3]"
        >
          <img
            :src="activeSlot.previewUrl"
            :alt="activeSlot.title"
            class="w-full h-full object-contain"
          >
        </div>

        <!-- Camera / preview alerts -->
        <B24Alert
          v-if="isCameraOpen && activeCameraSlotKey === activeSlot.key"
          color="air-secondary"
          title="Режим камеры"
          description="Фото берётся только с камеры, выбор файла из галереи отключен."
        />
        <B24Alert
          v-if="cameraError"
          color="air-primary-alert"
          title="Ошибка камеры"
          :description="cameraError"
        />
        <B24Alert
          v-if="activeSlot.error"
          color="air-primary-alert"
          title="Ошибка"
          :description="activeSlot.error"
        />
        <p v-if="activeSlot.fileName && activeSlot.uploaded" class="m-0 text-[11px] text-gray-400">
          Файл: {{ activeSlot.fileName }}
        </p>

        <!-- PRIMARY ACTION BUTTONS — full-width, large touch targets -->
        <div class="flex flex-col gap-2">

          <!-- Open camera (no preview, not confirmed yet) -->
          <B24Button
            v-if="!activeSlot.previewUrl && !activeSlot.confirmed && activeCameraSlotKey !== activeSlot.key"
            color="air-primary"
            variant="solid"
            :label="cameraBusy ? 'Запуск камеры...' : 'Открыть камеру'"
            :disabled="cameraBusy"
            loading-auto
            class="w-full min-h-[48px] text-base"
            @click="openCameraForActiveSlot"
          />

          <!-- Capture photo (camera is live) -->
          <B24Button
            v-if="activeCameraSlotKey === activeSlot.key"
            color="air-primary-success"
            variant="solid"
            label="Сделать фото"
            :disabled="activeSlot.uploading"
            loading-auto
            class="w-full min-h-[48px] text-base"
            @click="captureSlotPreview(activeSlot)"
          />

          <!-- Accept photo (preview ready, not yet confirmed) -->
          <B24Button
            v-if="activeSlot.previewUrl && !activeSlot.confirmed"
            color="air-primary-success"
            variant="solid"
            label="Использовать фото"
            :disabled="activeSlot.uploading"
            loading-auto
            class="w-full min-h-[48px] text-base"
            @click="acceptSlotPhoto(activeSlot)"
          />

          <!-- Retry upload (confirmed but errored) -->
          <B24Button
            v-if="activeSlot.error && activeSlot.confirmed && !activeSlot.uploaded"
            color="air-primary"
            variant="solid"
            label="Повторить загрузку"
            :disabled="activeSlot.uploading"
            loading-auto
            class="w-full min-h-[48px]"
            @click="retrySlotUpload(activeSlot)"
          />

          <!-- Secondary row: retake + close camera -->
          <div class="flex gap-2">
            <B24Button
              v-if="activeSlot.previewUrl && !activeSlot.uploaded"
              color="air-secondary"
              variant="outline"
              label="Переснять"
              :disabled="activeSlot.uploading || cameraBusy"
              loading-auto
              class="flex-1 min-h-[44px]"
              @click="retakeSlotPhoto(activeSlot)"
            />
            <B24Button
              v-if="activeCameraSlotKey === activeSlot.key"
              color="air-secondary"
              variant="outline"
              label="Закрыть камеру"
              :disabled="activeSlot.uploading"
              loading-auto
              class="flex-1 min-h-[44px]"
              @click="closeCamera"
            />
          </div>
        </div>
      </div>
    </B24Card>

    <!-- All slots done — no more active slot -->
    <B24Alert
      v-if="!isLoading && !loadError && photoSlots.length > 0 && !activeSlot"
      color="air-primary-success"
      title="Все фото сделаны"
      description="Все слоты заполнены. Нажмите «Сдать отчёт» в шапке."
    />

    <!-- ─── COLLAPSIBLE ALL-SLOTS LIST ──────────────────────────────────────── -->
    <div :ref="setQueueAnchorRef" />
    <div v-if="photoSlots.length > 0">
      <!-- Toggle button -->
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-left text-[13px] font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        @click="showAllSlots = !showAllSlots"
      >
        <span class="flex items-center gap-2">
          <span>{{ showAllSlots ? 'Скрыть все слоты' : 'Показать все слоты' }}</span>
          <B24Badge :color="allUploaded ? 'air-primary-success' : (hasUploadErrors ? 'air-primary-alert' : 'air-secondary')" size="xs">
            {{ uploadedCount }}/{{ photoSlots.length }}
          </B24Badge>
        </span>
        <span class="text-gray-400 text-[11px]">{{ showAllSlots ? '▲' : '▼' }}</span>
      </button>

      <!-- Slots list (collapsed by default) -->
      <div v-if="showAllSlots" class="mt-2 space-y-2">
        <div
          v-for="(slot, index) in photoSlots"
          :key="slot.key"
          :ref="(el) => setQueueSlotRef(slot.key, el)"
          class="flex flex-col gap-2 rounded-xl border p-3 transition-colors"
          :class="{
            'border-blue-300 bg-blue-50': index === currentSlotIndex,
            'border-green-200 bg-green-50': slot.uploaded,
            'border-red-200 bg-red-50': slot.error && !slot.uploaded,
            'border-gray-100 bg-white': !slot.uploaded && !slot.error && index !== currentSlotIndex
          }"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="m-0 text-[13px] font-medium text-gray-800 leading-tight">
                {{ index + 1 }}. {{ slot.title }}
              </p>
              <p class="m-0 text-[11px] text-gray-500 mt-0.5 leading-tight">
                {{
                  index === currentSlotIndex ? 'Активный слот' :
                  index < currentSlotIndex ? 'Завершён (можно переснять)' :
                  'В очереди'
                }}
              </p>
            </div>
            <B24Badge
              :color="slot.uploaded ? 'air-primary-success' : (slot.error ? 'air-primary-alert' : 'air-secondary')"
              size="xs"
              class="shrink-0"
            >
              {{
                slot.uploading ? 'загрузка...' :
                slot.uploaded ? 'загружено' :
                slot.confirmed ? 'ожидает загрузки' :
                'ожидает фото'
              }}
            </B24Badge>
          </div>

          <!-- Actions for completed/errored slots -->
          <div v-if="index < currentSlotIndex" class="flex flex-wrap gap-2">
            <B24Button
              color="air-secondary"
              variant="outline"
              label="Переснять"
              size="xs"
              :disabled="slot.uploadState === 'uploading' || cameraBusy"
              loading-auto
              @click="retakeSlotPhoto(slot)"
            />
            <B24Button
              v-if="slot.error && slot.confirmed && !slot.uploaded"
              color="air-primary"
              variant="outline"
              label="Повторить загрузку"
              size="xs"
              :disabled="slot.uploadState === 'uploading'"
              loading-auto
              @click="retrySlotUpload(slot)"
            />
          </div>
        </div>
      </div>
    </div>

  </div>
</template>
