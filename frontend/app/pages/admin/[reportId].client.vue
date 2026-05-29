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

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const report = ref<ReportRow | null>(null)
const saveError = ref('')
const saveSuccess = ref('')
const activeCameraSlotKey = ref('')
const cameraError = ref('')
const cameraBusy = ref(false)
const cameraVideoEl = ref<HTMLVideoElement | null>(null)
const cameraStream = ref<MediaStream | null>(null)
const isSubmitting = ref(false)
const submitError = ref('')

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

const scrollToFirstProblemSlot = () => {
  const firstProblemSlot = photoSlots.find((slot) => {
    if (!slot.confirmed) return true
    if (slot.uploadState === 'queued' || slot.uploadState === 'uploading') return true
    return Boolean(slot.error) && !slot.uploaded
  })

  if (firstProblemSlot) {
    const el = queueSlotRefs.get(firstProblemSlot.key)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
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
    const responseMessage = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось загрузить фото')
    const retryable = isRetryableUploadIssue({
      errorCode: responseData?.errorCode,
      message: responseMessage
    })
    slot.error = `${responseMessage}${accessDetails}`
    if (retryable) {
      enableLowConcurrencyMode()
    }
    saveError.value = slot.error
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
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
      }
    })?.data
    loadError.value = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось загрузить отчёт')
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
  saveSuccess.value = ''
  try {
    await apiStore.submitReport(id)
    saveSuccess.value = 'Отчёт отправлен. Статус переведён в DONE.'
    await loadReport()
  } catch (error) {
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
      }
    })?.data
    submitError.value = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось отправить отчёт')
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
</script>

<template>
  <div class="w-full max-w-[920px] mx-auto px-4 py-4 space-y-4">
    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="space-y-2">
            <ProseH2>Экран Администратора АЗС</ProseH2>
            <div class="flex flex-wrap items-center gap-2">
              <B24Button
                color="air-secondary"
                variant="outline"
                label="Выйти из отчёта"
                @click="leaveReport"
              />
              <B24Button
                color="air-primary"
                variant="solid"
                label="В настройки"
                @click="openSettings"
              />
            </div>
          </div>
          <div class="flex items-center gap-2">
            <B24Badge :color="allUploaded ? 'air-primary-success' : 'air-secondary'">
              {{ uploadedCount }}/{{ photoSlots.length }} загружено
            </B24Badge>
            <HelpButton default-role="admin" />
          </div>
        </div>
      </template>

      <B24Alert
        color="air-secondary"
        title="Пошаговый сбор фото"
        description="Сделайте фото, проверьте кадр, подтвердите его. После подтверждения фото загрузится в фоне."
      />
    </B24Card>

    <div
      v-if="photoSlots.length > 0"
      class="sticky top-2 z-20"
    >
      <B24Card variant="outline">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <B24Badge :color="canSubmitReport ? 'air-primary-success' : 'air-secondary'">
              {{ uploadedCount }}/{{ photoSlots.length }} загружено
            </B24Badge>
            <B24Badge color="air-secondary">
              режим загрузки x{{ uploadWorker.maxConcurrency }}
            </B24Badge>
            <B24Badge v-if="hasPendingUploads" color="air-secondary">
              идёт фоновая загрузка
            </B24Badge>
            <B24Badge v-if="hasUploadErrors" color="air-primary-alert">
              есть проблемы
            </B24Badge>
            <B24Badge v-if="report?.status === 'done'" color="air-primary-success">
              отчёт отправлен
            </B24Badge>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <B24Button
              v-if="!canSubmitReport && (hasPendingUploads || hasUploadErrors)"
              color="air-secondary"
              label="Перейти к проблемам"
              loading-auto
              @click="scrollToFirstProblemSlot"
            />
            <B24Button
              color="air-primary-success"
              label="Сдать отчёт"
              :disabled="!canSubmitReport"
              loading-auto
              @click="submitReport"
            />
          </div>
        </div>
        <ProseP v-if="!canSubmitReport && submitBlockReason" class="mt-2 mb-0 text-[13px] text-gray-500">
          {{ submitBlockReason }}
        </ProseP>
      </B24Card>
    </div>

    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Ошибка загрузки отчёта"
      :description="loadError"
    />
    <B24Alert
      v-if="!isLoading && !loadError && photoSlots.length === 0"
      color="air-primary-alert"
      title="Нет обязательных фото"
      description="Для этого отчёта не определён набор обязательных фото. Проверьте настройки и карточку АЗС."
    />
    <B24Alert
      v-if="isLoading"
      color="air-secondary"
      title="Загрузка"
      description="Загружаем карточку отчёта..."
    />
    <B24Alert
      v-if="saveSuccess"
      color="air-primary-success"
      title="Успешно"
      :description="saveSuccess"
    />
    <B24Alert
      v-if="saveError"
      color="air-primary-alert"
      title="Ошибка загрузки"
      :description="saveError"
    />
    <B24Alert
      v-if="submitError"
      color="air-primary-alert"
      title="Ошибка отправки отчёта"
      :description="submitError"
    />

    <B24Card v-if="report">
      <template #header>
        <ProseH3>Отчёт #{{ report.id }}</ProseH3>
      </template>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        <B24Badge color="air-secondary">АЗС: {{ reportAzsLabel }}</B24Badge>
        <B24Badge color="air-secondary">Слот: {{ reportSlotKeyLabel }}</B24Badge>
        <B24Badge color="air-secondary">Статус: {{ reportStatusLabel }}</B24Badge>
        <B24Badge color="air-secondary">Дедлайн: {{ report.deadlineAt || '—' }}</B24Badge>
      </div>
    </B24Card>

    <B24Card v-if="activeSlot" variant="outline">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div>
            <ProseH3>Слот {{ activeSlotNumber }}/{{ photoSlots.length }}: {{ activeSlot.title }}</ProseH3>
            <ProseP class="mb-0 text-[13px] text-gray-500">
              Подтвердите фото, после этого загрузка пойдёт в фоне, а камера автоматически откроется для следующего слота.
            </ProseP>
          </div>
          <B24Badge :color="activeSlot.uploaded ? 'air-primary-success' : (activeSlot.error ? 'air-primary-alert' : 'air-secondary')">
            {{
              activeSlot.uploading ? 'загрузка...' :
              (activeSlot.uploaded ? 'загружено' : (activeSlot.confirmed ? 'ожидает загрузки' : 'ожидает фото'))
            }}
          </B24Badge>
        </div>
      </template>

      <div class="space-y-2">
        <div
          v-if="activeSlot.previewUrl"
          class="rounded overflow-hidden bg-black"
        >
          <img
            :src="activeSlot.previewUrl"
            :alt="activeSlot.title"
            class="w-full max-h-[420px] object-contain"
          >
        </div>

        <div class="flex flex-wrap gap-2">
          <B24Button
            v-if="!activeSlot.previewUrl && !activeSlot.confirmed"
            color="air-primary"
            :label="activeCameraSlotKey === activeSlot.key ? 'Камера активна' : 'Открыть камеру'"
            :disabled="activeSlot.uploading || cameraBusy"
            loading-auto
            @click="openCameraForActiveSlot"
          />
          <B24Button
            v-if="activeCameraSlotKey === activeSlot.key"
            color="air-primary-success"
            label="Сделать фото"
            :disabled="activeSlot.uploading"
            loading-auto
            @click="captureSlotPreview(activeSlot)"
          />
          <B24Button
            v-if="activeCameraSlotKey === activeSlot.key"
            color="air-secondary"
            label="Закрыть камеру"
            :disabled="activeSlot.uploading"
            loading-auto
            @click="closeCamera"
          />
          <B24Button
            v-if="activeSlot.previewUrl && !activeSlot.confirmed"
            color="air-primary-success"
            label="Использовать фото"
            :disabled="activeSlot.uploading"
            loading-auto
            @click="acceptSlotPhoto(activeSlot)"
          />
          <B24Button
            v-if="activeSlot.previewUrl && !activeSlot.uploaded"
            color="air-secondary"
            label="Переснять"
            :disabled="activeSlot.uploading || cameraBusy"
            loading-auto
            @click="retakeSlotPhoto(activeSlot)"
          />
          <B24Button
            v-if="activeSlot.error && activeSlot.confirmed && !activeSlot.uploaded"
            color="air-primary"
            label="Повторить загрузку"
            :disabled="activeSlot.uploading"
            loading-auto
            @click="retrySlotUpload(activeSlot)"
          />
        </div>

        <div v-if="activeCameraSlotKey === activeSlot.key" class="rounded overflow-hidden bg-black">
          <video
            :ref="setCameraVideoRef"
            class="w-full max-h-[420px] object-cover"
            autoplay
            playsinline
            muted
          />
        </div>
        <B24Alert
          v-if="isCameraOpen && activeCameraSlotKey === activeSlot.key"
          color="air-secondary"
          title="Режим камеры"
          description="Фото берётся только с камеры, выбор файла из галереи отключен в интерфейсе приложения."
        />
        <B24Alert
          v-if="cameraError && activeCameraSlotKey === activeSlot.key"
          color="air-primary-alert"
          title="Ошибка камеры"
          :description="cameraError"
        />
        <ProseP v-if="activeSlot.fileName" class="text-[13px]">Файл: {{ activeSlot.fileName }}</ProseP>
        <B24Alert
          v-if="activeSlot.error"
          color="air-primary-alert"
          title="Ошибка файла"
          :description="activeSlot.error"
        />
      </div>
    </B24Card>

    <div :ref="setQueueAnchorRef" />
    <B24Card v-if="photoSlots.length > 0" variant="outline">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div>
            <ProseH3>Очередь и история</ProseH3>
            <ProseP class="mb-0 text-[13px] text-gray-500">
              Активный слот всегда один. Предыдущие слоты можно переснять или повторить загрузку.
            </ProseP>
          </div>
          <B24Badge :color="allUploaded ? 'air-primary-success' : 'air-secondary'">
            {{ uploadedCount }}/{{ photoSlots.length }} загружено
          </B24Badge>
        </div>
      </template>

      <div class="space-y-2">
        <div
          v-for="(slot, index) in photoSlots"
          :key="slot.key"
          :ref="(el) => setQueueSlotRef(slot.key, el)"
          class="flex flex-col gap-2 rounded border border-gray-100 p-3"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <ProseP class="mb-0 font-medium">
                {{ index + 1 }}. {{ slot.title }}
              </ProseP>
              <ProseP class="mb-0 text-[13px] text-gray-500">
                {{
                  index === currentSlotIndex ? 'Активный слот' :
                  index < currentSlotIndex ? 'Завершён (можно переснять)' :
                  'В очереди'
                }}
              </ProseP>
            </div>
            <B24Badge :color="slot.uploaded ? 'air-primary-success' : (slot.error ? 'air-primary-alert' : 'air-secondary')">
              {{
                slot.uploading ? 'загрузка...' :
                (slot.uploaded ? 'загружено' : (slot.confirmed ? 'ожидает загрузки' : 'ожидает фото'))
              }}
            </B24Badge>
          </div>

          <div v-if="index < currentSlotIndex" class="flex flex-wrap gap-2">
            <B24Button
              color="air-secondary"
              label="Переснять"
              :disabled="slot.uploadState === 'uploading' || cameraBusy"
              loading-auto
              @click="retakeSlotPhoto(slot)"
            />
            <B24Button
              v-if="slot.error && slot.confirmed && !slot.uploaded"
              color="air-primary"
              label="Повторить загрузку"
              :disabled="slot.uploadState === 'uploading'"
              loading-auto
              @click="retrySlotUpload(slot)"
            />
          </div>
        </div>
      </div>
    </B24Card>
  </div>
</template>
